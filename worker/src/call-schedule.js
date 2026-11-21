/* Scheduled call invites. Created from the Calls page, listed on the
   Scheduled tab, and started when the time is due. Cron in sweepCalls
   sends the 15-minute and at-start reminders. */

import { readFlags } from "./feature-flags.js";
import { publishToAccount } from "./channel.js";
import { emitNotification } from "./notifications.js";
import {
  SCHEDULE_TOKEN, JOIN_EARLY_MS, MIN_AHEAD_MS, MAX_AHEAD_MS,
  clipDuration, canJoin, remindPlan, icsForSchedule, parseStartsAt, endsAt
} from "../../shared/call-schedule.js";

const ACCOUNT = /^\d{12}$/;
const ID = /^[a-f0-9]{32}$/;
const TITLE_MAX = 80;
const NOTE_MAX = 280;

export const CALL_SCHEDULE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_schedules (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    peer_id TEXT NOT NULL DEFAULT '',
    guest_token TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 30,
    title TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    host_rsvp TEXT NOT NULL DEFAULT 'yes',
    peer_rsvp TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'scheduled',
    reminded_15 INTEGER NOT NULL DEFAULT 0,
    reminded_start INTEGER NOT NULL DEFAULT 0,
    call_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_schedules_token ON call_schedules(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_call_schedules_host ON call_schedules(host_id, starts_at)`,
  `CREATE INDEX IF NOT EXISTS idx_call_schedules_peer ON call_schedules(peer_id, starts_at)`,
  `CREATE INDEX IF NOT EXISTS idx_call_schedules_due ON call_schedules(state, starts_at)`
];

function clipText(value, max) {
  return String(value || "").replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function icsResponse(body, filename) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": "attachment; filename=\"" + filename + "\"",
      "cache-control": "no-store"
    }
  });
}

function icsBody(row, names, url) {
  const other = names && (names[row.peer_id] || names[row.host_id]) || {};
  const title = row.title || ("Call" + (other.name || other.handle ? " with " + (other.name || other.handle) : ""));
  return icsForSchedule({
    title: title,
    description: row.note || "",
    startsAt: row.starts_at,
    durationMin: row.duration_min,
    url: url || "",
    uid: row.id
  });
}

async function namesFor(env, ids) {
  const out = {};
  const seen = {};
  for (const id of ids) {
    if (!id || seen[id] || !ACCOUNT.test(id)) continue;
    seen[id] = true;
    const row = await env.DB.prepare("SELECT public_id, handle, display_name FROM accounts WHERE public_id = ?").bind(id).first();
    if (row) out[id] = { handle: String(row.handle || ""), name: String(row.display_name || "") };
  }
  return out;
}

function viewSchedule(row, me, names, now, withToken) {
  const host = names[row.host_id] || {};
  const peer = names[row.peer_id] || {};
  const role = me && me === row.host_id ? "host" : (me && me === row.peer_id ? "peer" : "guest");
  const other = role === "host" ? peer : host;
  const myRsvp = role === "host" ? row.host_rsvp : (role === "peer" ? row.peer_rsvp : "");
  const theirRsvp = role === "host" ? row.peer_rsvp : row.host_rsvp;
  return {
    id: row.id,
    startsAt: Number(row.starts_at),
    durationMin: Number(row.duration_min),
    title: row.title || "",
    note: row.note || "",
    state: row.state,
    role: role,
    hostId: row.host_id,
    peerId: row.peer_id || "",
    name: other.name || "",
    handle: other.handle || "",
    hostName: host.name || "",
    hostHandle: host.handle || "",
    myRsvp: myRsvp || "",
    theirRsvp: theirRsvp || "",
    invite: withToken ? row.guest_token : "",
    callId: row.call_id || "",
    canJoin: (row.state === "scheduled" || row.state === "started") && canJoin(row.starts_at, row.duration_min, now),
    canCancel: (role === "host" || role === "peer") && row.state === "scheduled",
    canRsvp: role === "peer" && row.state === "scheduled"
  };
}

async function loadRow(env, id) {
  if (!ID.test(id)) return null;
  return env.DB.prepare("SELECT * FROM call_schedules WHERE id = ?").bind(id).first();
}

async function loadByToken(env, h, token) {
  if (!SCHEDULE_TOKEN.test(token)) return null;
  return env.DB.prepare("SELECT * FROM call_schedules WHERE token_hash = ?").bind(await h.sha256Hex(token)).first();
}

async function involved(env, row, publicId) {
  return !!(row && publicId && (row.host_id === publicId || row.peer_id === publicId));
}

async function notifyPeople(env, row, kind, actorId, names, hash) {
  const targets = [row.host_id, row.peer_id].filter((id) => ACCOUNT.test(id) && id !== actorId);
  for (const publicId of targets) {
    const otherId = publicId === row.host_id ? row.peer_id : row.host_id;
    const other = (names && (names[otherId] || names[row.host_id])) || {};
    try {
      await emitNotification(env, {
        publicId: publicId,
        kind: kind,
        subject: row.id,
        idempotencyKey: kind + ":" + row.id + ":" + publicId,
        actorId: actorId || otherId || row.host_id,
        name: String(other.name || other.handle || ""),
        handle: String(other.handle || ""),
        hash: hash || "#/calls?tab=scheduled",
        platform: "app"
      });
    } catch (err) { /* the row is still there */ }
  }
}

export async function sweepSchedules(env, at) {
  if (!env || !env.DB) return;
  try {
    const off = await readFlags(env);
    if (off.calls || off.calls_schedule) return;
  } catch (err) { return; }
  const now = Number(at) || Date.now();
  let rows = [];
  try {
    const listed = await env.DB.prepare(
      "SELECT * FROM call_schedules WHERE state = 'scheduled' AND starts_at <= ? ORDER BY starts_at ASC LIMIT 40"
    ).bind(now + 16 * 60 * 1000).all();
    rows = (listed && listed.results) || [];
  } catch (err) { return; }
  for (const row of rows) {
    const plan = remindPlan(row, now);
    if (plan.miss) {
      try {
        await env.DB.prepare("UPDATE call_schedules SET state = 'missed', updated_at = ? WHERE id = ? AND state = 'scheduled' AND call_id = ''").bind(now, row.id).run();
      } catch (err) { /* next minute */ }
      continue;
    }
    if (plan.remind15) {
      try {
        await env.DB.prepare("UPDATE call_schedules SET reminded_15 = 1, updated_at = ? WHERE id = ? AND reminded_15 = 0").bind(now, row.id).run();
        const names = await namesFor(env, [row.host_id, row.peer_id]);
        await notifyPeople(env, row, "call_remind", "", names, "#/calls?tab=scheduled");
      } catch (err) { /* next minute */ }
    }
    if (plan.remindStart) {
      try {
        await env.DB.prepare("UPDATE call_schedules SET reminded_start = 1, updated_at = ? WHERE id = ? AND reminded_start = 0").bind(now, row.id).run();
        const names = await namesFor(env, [row.host_id, row.peer_id]);
        await notifyPeople(env, row, "call_starting", "", names, "#/calls?tab=scheduled");
      } catch (err) { /* next minute */ }
    }
  }
}

async function startExisting(env, deps, h, call, joiner, row) {
  if (!call || call.state === "ended" || call.state === "missed") return deps.json(410, { error: "ended" });
  const now = Date.now();
  let self = "";
  let role = "guest";
  let guestToken = "";
  if (joiner.account && joiner.account.public_id === call.host_id) {
    self = call.host_id;
    role = "host";
  } else if (joiner.account && (joiner.account.public_id === call.peer_id || joiner.account.public_id === row.peer_id)) {
    self = joiner.account.public_id;
    role = "guest";
    if (!call.peer_id) {
      await env.DB.prepare("UPDATE call_sessions SET peer_id = ? WHERE id = ? AND peer_id = ''").bind(self, call.id).run();
    }
  } else if (joiner.guest || (!joiner.account)) {
    if (call.peer_id && !String(call.peer_id).startsWith("g")) return deps.json(403, { error: "calls_closed" });
    if (call.peer_id && String(call.peer_id).startsWith("g")) {
      const existing = await env.DB.prepare("SELECT guest_id, token_hash, expires_at FROM call_guests WHERE call_id = ? AND expires_at > ?").bind(call.id, now).first();
      if (existing) {
        self = existing.guest_id;
        role = "guest";
      }
    }
    if (!self) {
      self = "g" + h.hex(crypto.getRandomValues(new Uint8Array(8)));
      guestToken = "cg1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
      await env.DB.prepare("INSERT INTO call_guests (token_hash, call_id, guest_id, expires_at) VALUES (?, ?, ?, ?)").bind(await h.sha256Hex(guestToken), call.id, self, endsAt(row.starts_at, row.duration_min) + JOIN_EARLY_MS).run();
      if (!call.peer_id) await env.DB.prepare("UPDATE call_sessions SET peer_id = ? WHERE id = ?").bind(self, call.id).run();
    }
  } else {
    return deps.json(403, { error: "calls_closed" });
  }
  const ticket = await h.mintTicket(env, call.id, self, role);
  const fresh = await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(call.id).first();
  return deps.json(200, {
    call: h.viewCall(fresh),
    ticket: ticket.ticket,
    iceServers: await h.callIceServers(env, deps, { id: call.id, self: self, state: fresh.state }),
    guestToken: guestToken,
    guestId: role === "guest" ? self : "",
    video: false
  });
}

async function createAndJoin(env, deps, h, row, joiner) {
  const now = Date.now();
  const id = h.hex(crypto.getRandomValues(new Uint8Array(16)));
  const exp = Math.max(now + 60 * 1000, endsAt(row.starts_at, row.duration_min) + JOIN_EARLY_MS);
  const isHost = !!(joiner.account && joiner.account.public_id === row.host_id);
  const isPeer = !!(joiner.account && row.peer_id && joiner.account.public_id === row.peer_id);
  let kind = "scheduled";
  let peerId = row.peer_id || "";
  let self = "";
  let role = "guest";
  let guestToken = "";
  let ringTo = "";
  let ringName = "";
  let ringHandle = "";
  let ringGuest = false;

  if (isHost) {
    self = row.host_id;
    role = "host";
    kind = peerId ? "direct" : "invite";
    if (peerId) ringTo = peerId;
    const host = joiner.account;
    ringName = String(host.display_name || "");
    ringHandle = String(host.handle || "");
  } else if (isPeer) {
    self = row.peer_id;
    role = "guest";
    kind = "link";
    peerId = row.peer_id;
    ringTo = row.host_id;
    ringName = String(joiner.account.display_name || "");
    ringHandle = String(joiner.account.handle || "");
  } else {
    self = "g" + h.hex(crypto.getRandomValues(new Uint8Array(8)));
    role = "guest";
    kind = "link";
    peerId = self;
    guestToken = "cg1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
    ringTo = row.host_id;
    ringName = h.cleanName(joiner.name) || "Guest";
    ringGuest = true;
  }

  await env.DB.prepare(
    "INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, ?, ?, 'ringing', ?, 0, 0, ?)"
  ).bind(id, row.host_id, peerId, kind, now, exp).run();
  if (guestToken) {
    await env.DB.prepare("INSERT INTO call_guests (token_hash, call_id, guest_id, expires_at) VALUES (?, ?, ?, ?)").bind(await h.sha256Hex(guestToken), id, self, exp).run();
    if (ringName) await env.DB.prepare("INSERT INTO call_names (call_id, name) VALUES (?, ?)").bind(id, ringName).run();
  }
  await env.DB.prepare("UPDATE call_schedules SET state = 'started', call_id = ?, updated_at = ? WHERE id = ? AND (call_id = '' OR call_id = ?)").bind(id, now, row.id, id).run();
  const ticket = await h.mintTicket(env, id, self, role);
  if (ringTo && ACCOUNT.test(ringTo)) {
    try { await publishToAccount(env, ringTo, "calls", { op: "ring", id: id, name: ringName, handle: ringHandle, avatar: "", guest: ringGuest }, id); } catch (err) { /* history still shows it */ }
    try {
      await emitNotification(env, {
        publicId: ringTo,
        kind: "call",
        subject: row.host_id,
        idempotencyKey: "call:" + id,
        actorId: isHost || isPeer ? joiner.account.public_id : row.host_id,
        name: ringName,
        handle: ringHandle,
        hash: "#/calls/" + id,
        platform: "app"
      });
    } catch (err) { /* ringing still works in the open app */ }
  }
  const fresh = await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first();
  return deps.json(201, {
    call: h.viewCall(fresh),
    ticket: ticket.ticket,
    iceServers: await h.callIceServers(env, deps, { id: id, self: self, state: "ringing" }),
    guestToken: guestToken,
    guestId: role === "guest" ? self : "",
    video: false
  });
}

async function startSchedule(env, deps, h, row, joiner) {
  const now = Date.now();
  if (row.state === "cancelled") return deps.json(410, { error: "cancelled" });
  if (row.state === "missed") return deps.json(410, { error: "missed" });
  if (row.state !== "scheduled" && row.state !== "started") return deps.json(409, { error: "state" });
  if (!canJoin(row.starts_at, row.duration_min, now)) return deps.json(403, { error: "not_due" });
  if (row.call_id) {
    const call = await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(row.call_id).first();
    return startExisting(env, deps, h, call, joiner, row);
  }
  return createAndJoin(env, deps, h, row, joiner);
}

export async function handleCallSchedule(request, env, path, url, deps, h) {
  if (!path.startsWith("/v1/calls/schedule")) return null;
  const off = await readFlags(env);
  if (off.calls || off.calls_schedule) {
    const read = request.method === "GET" || request.method === "HEAD";
    return new Response(null, { status: read ? 204 : 404, headers: { "x-feature-off": "1" } });
  }

  const guestPath = path === "/v1/calls/schedule/guest" || path === "/v1/calls/schedule/guest/ics" || path === "/v1/calls/schedule/guest/start";
  if (guestPath) {
    let body = null;
    if (request.method === "POST") body = await deps.readJson(request, 2000);
    const token = String(url.searchParams.get("token") || (body && body.token) || "");
    const row = await loadByToken(env, h, token);
    if (!row) return deps.json(404, { error: "not_found" });
    const ip = String(request.headers.get("CF-Connecting-IP") || "0");
    const paced = await deps.rateHit(env, "callschg:" + ip, 40, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const names = await namesFor(env, [row.host_id, row.peer_id]);
    if (path === "/v1/calls/schedule/guest" && request.method === "GET") {
      return deps.json(200, { schedule: viewSchedule(row, "", names, Date.now(), false) });
    }
    if (path === "/v1/calls/schedule/guest/ics" && request.method === "GET") {
      return icsResponse(icsBody(row, names, ""), "call.ics");
    }
    if (path === "/v1/calls/schedule/guest/start" && request.method === "POST") {
      return startSchedule(env, deps, h, row, { name: body && body.name });
    }
    return deps.json(405, { error: "method" });
  }

  if (path === "/v1/calls/schedule" && request.method === "GET") {
    const who = await h.member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const me = who.account.public_id;
    const listed = await env.DB.prepare(
      "SELECT * FROM call_schedules WHERE host_id = ? OR peer_id = ? ORDER BY starts_at DESC LIMIT 40"
    ).bind(me, me).all();
    const rows = (listed && listed.results) || [];
    const ids = [];
    rows.forEach((row) => { ids.push(row.host_id, row.peer_id); });
    const names = await namesFor(env, ids);
    const now = Date.now();
    return deps.json(200, { schedules: rows.map((row) => viewSchedule(row, me, names, now, row.host_id === me)) });
  }

  if (path === "/v1/calls/schedule" && request.method === "POST") {
    const who = await h.member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const me = who.account.public_id;
    const paced = await deps.rateHit(env, "callsch:" + me, 20, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: "bad_call" });
    const startsAt = parseStartsAt(body.startsAt);
    const now = Date.now();
    if (!startsAt || startsAt < now + MIN_AHEAD_MS || startsAt > now + MAX_AHEAD_MS) return deps.json(400, { error: "when" });
    const durationMin = clipDuration(body.durationMin);
    const title = clipText(body.title, TITLE_MAX);
    const note = clipText(body.note, NOTE_MAX);
    let peerId = "";
    let peer = null;
    const handle = String(body.handle || "").replace(/^@/, "").trim().toLowerCase();
    if (handle) {
      if (!/^[a-z0-9_]{1,30}$/.test(handle)) return deps.json(400, { error: "bad_call" });
      peer = await env.DB.prepare("SELECT public_id, handle, display_name FROM accounts WHERE lower(handle) = ?").bind(handle).first();
      if (!peer) return deps.json(404, { error: "not_found" });
      if (peer.public_id === me) return deps.json(400, { error: "bad_call" });
      if (!(await h.callerMayCall(env, me, peer.public_id))) return deps.json(403, { error: "calls_closed" });
      peerId = peer.public_id;
    }
    const id = h.hex(crypto.getRandomValues(new Uint8Array(16)));
    const token = "cs1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
    const hash = await h.sha256Hex(token);
    await env.DB.prepare(
      "INSERT INTO call_schedules (id, host_id, peer_id, guest_token, token_hash, starts_at, duration_min, title, note, host_rsvp, peer_rsvp, state, reminded_15, reminded_start, call_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'yes', '', 'scheduled', 0, 0, '', ?, ?)"
    ).bind(id, me, peerId, token, hash, startsAt, durationMin, title, note, now, now).run();
    const row = await loadRow(env, id);
    const names = await namesFor(env, [me, peerId]);
    if (peer) {
      await notifyPeople(env, row, "call_scheduled", me, names, "#/calls?tab=scheduled");
    }
    return deps.json(201, { schedule: viewSchedule(row, me, names, now, true) });
  }

  const one = path.match(/^\/v1\/calls\/schedule\/([a-f0-9]{32})(\/ics|\/rsvp|\/cancel|\/start)?$/);
  if (!one) return deps.json(404, { error: "not_found" });
  const who = await h.member(env, request, deps);
  if (!who.account) return deps.json(401, { error: "unauthorized" });
  const me = who.account.public_id;
  const row = await loadRow(env, one[1]);
  if (!row || !(await involved(env, row, me))) return deps.json(404, { error: "not_found" });
  const action = one[2] || "";
  const names = await namesFor(env, [row.host_id, row.peer_id]);
  const now = Date.now();

  if (!action && request.method === "GET") {
    return deps.json(200, { schedule: viewSchedule(row, me, names, now, row.host_id === me) });
  }
  if (action === "/ics" && request.method === "GET") {
    return icsResponse(icsBody(row, names, ""), "call.ics");
  }
  if (action === "/rsvp" && request.method === "POST") {
    if (me !== row.peer_id || row.state !== "scheduled") return deps.json(403, { error: "rsvp" });
    const body = await deps.readJson(request, 1000);
    const rsvp = String((body && body.rsvp) || "").toLowerCase();
    if (rsvp !== "yes" && rsvp !== "no") return deps.json(400, { error: "rsvp" });
    await env.DB.prepare("UPDATE call_schedules SET peer_rsvp = ?, updated_at = ? WHERE id = ?").bind(rsvp, now, row.id).run();
    const fresh = await loadRow(env, row.id);
    if (rsvp === "no") await notifyPeople(env, fresh, "call_declined", me, names, "#/calls?tab=scheduled");
    return deps.json(200, { schedule: viewSchedule(fresh, me, names, now, false) });
  }
  if (action === "/cancel" && request.method === "POST") {
    if (row.state !== "scheduled") return deps.json(409, { error: "state" });
    await env.DB.prepare("UPDATE call_schedules SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'scheduled'").bind(now, row.id).run();
    const fresh = await loadRow(env, row.id);
    await notifyPeople(env, fresh, "call_cancelled", me, names, "#/calls?tab=scheduled");
    return deps.json(200, { schedule: viewSchedule(fresh, me, names, now, row.host_id === me) });
  }
  if (action === "/start" && request.method === "POST") {
    return startSchedule(env, deps, h, row, { account: who.account });
  }
  return deps.json(405, { error: "method" });
}
