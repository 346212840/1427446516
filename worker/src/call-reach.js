/* Call the owner and Request a call (calls_owner_reach).
   The public Calls page shows a Call the owner button, enabled only while the
   owner has switched themselves available (and is not in quiet hours), and a
   Request a call form: a time in the visitor's own timezone, a name and an
   optional note. The owner gets a notification and answers from the Requests
   tab: Accept (a scheduled call with calendar file and reminders), Suggest
   another time, or Decline. Nothing about the owner is shown to visitors
   beyond "available" or not. Every public route is rate limited per IP and
   per device, links and phone numbers are refused, and a source can have
   only a few open requests at a time. */

import { readFlags } from "./feature-flags.js";
import { publishToAccount } from "./channel.js";
import { emitNotification } from "./notifications.js";
import { insertSchedule } from "./call-schedule.js";
import { dndActive } from "../../shared/call-privacy.js";
import { rejectsClone } from "../../shared/call-setup.js";
import {
  REQUEST_TOKEN, NAME_MAX, NOTE_MAX, MAX_PENDING_PER_SOURCE, MAX_PENDING_TOTAL,
  looksSpammy, cleanReachText, requestWhenOk, cleanZone
} from "../../shared/call-reach.js";
import { parseStartsAt } from "../../shared/call-schedule.js";

const ACCOUNT = /^\d{12}$/;
const ID = /^[a-f0-9]{32}$/;
const DEVICE = /^[A-Za-z0-9_-]{8,64}$/;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const CALL_REACH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_reach (
    owner_id TEXT PRIMARY KEY,
    available INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS call_requests (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    visitor_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT '',
    starts_at INTEGER NOT NULL,
    suggested_at INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    schedule_id TEXT NOT NULL DEFAULT '',
    source_hash TEXT NOT NULL DEFAULT '',
    device_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_call_requests_token ON call_requests(token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_call_requests_owner ON call_requests(owner_id, state, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_call_requests_source ON call_requests(source_hash, state)`
];

async function ownerId(env) {
  const configured = String((env && env.OWNER_PUBLIC_ID) || "");
  if (ACCOUNT.test(configured)) return configured;
  try {
    const row = await env.DB.prepare("SELECT public_id FROM accounts WHERE owner = 1 LIMIT 1").first();
    return row && ACCOUNT.test(String(row.public_id)) ? String(row.public_id) : "";
  } catch (err) { return ""; }
}

async function availableFlag(env, owner) {
  const row = await env.DB.prepare("SELECT available FROM call_reach WHERE owner_id = ?").bind(owner).first();
  return !!(row && Number(row.available) === 1);
}

/* Reachable now for this visitor: the owner switched available, allows guests from everyone, and is not in quiet hours. */
async function reachable(env, h, owner, visitor) {
  if (!owner) return false;
  if (!(await availableFlag(env, owner))) return false;
  const prefs = await h.loadPrefs(env, owner);
  if (dndActive(prefs, Date.now())) return false;
  if (visitor) return h.callerMayCall(env, visitor.public_id, owner);
  return !!(prefs.guests && prefs.who === "everyone");
}

function viewForVisitor(row, invite) {
  return {
    state: row.state,
    startsAt: Number(row.starts_at),
    suggestedAt: Number(row.suggested_at) || 0,
    name: row.name,
    invite: row.state === "accepted" ? String(invite || "") : ""
  };
}

function viewForOwner(row) {
  return {
    id: row.id,
    state: row.state,
    name: row.name,
    note: row.note,
    zone: row.zone,
    startsAt: Number(row.starts_at),
    suggestedAt: Number(row.suggested_at) || 0,
    member: !!row.visitor_id,
    scheduleId: row.schedule_id || "",
    createdAt: Number(row.created_at)
  };
}

async function sourceOf(request, h, body) {
  const ip = String(request.headers.get("CF-Connecting-IP") || "0");
  const device = DEVICE.test(String((body && body.device) || "")) ? String(body.device) : "";
  return { ip: ip, ipHash: await h.sha256Hex("reach-ip:" + ip), deviceHash: device ? await h.sha256Hex("reach-dev:" + device) : "" };
}

async function inviteFor(env, row) {
  if (!row.schedule_id) return "";
  const s = await env.DB.prepare("SELECT guest_token FROM call_schedules WHERE id = ?").bind(row.schedule_id).first();
  return s ? String(s.guest_token || "") : "";
}

async function accept(env, h, row, at) {
  const schedule = await insertSchedule(env, h, {
    hostId: row.owner_id,
    peerId: row.visitor_id || "",
    startsAt: at,
    durationMin: 30,
    title: cleanReachText(row.name, NAME_MAX),
    note: row.note || "",
    peerRsvp: "yes"
  });
  const now = Date.now();
  await env.DB.prepare("UPDATE call_requests SET state = 'accepted', starts_at = ?, schedule_id = ?, updated_at = ? WHERE id = ?").bind(at, schedule ? schedule.id : "", now, row.id).run();
  return schedule;
}

async function tellVisitor(env, row, kind) {
  if (!ACCOUNT.test(String(row.visitor_id || ""))) return;
  try {
    await emitNotification(env, {
      publicId: row.visitor_id,
      kind: kind,
      subject: row.id,
      idempotencyKey: kind + ":" + row.id + ":" + Date.now(),
      actorId: row.owner_id,
      name: "",
      handle: "",
      hash: "#/calls?tab=scheduled",
      platform: "app"
    });
  } catch (err) { /* the request page shows it too */ }
}

export async function handleCallReach(request, env, path, url, deps, h) {
  if (!path.startsWith("/v1/calls/reach")) return null;
  const off = await readFlags(env);
  if (off.calls || off.calls_owner_reach) {
    const read = request.method === "GET" || request.method === "HEAD";
    return new Response(null, { status: read ? 204 : 404, headers: { "x-feature-off": "1" } });
  }
  const owner = await ownerId(env);
  const ip = String(request.headers.get("CF-Connecting-IP") || "0");

  /* Public: is the owner reachable now? Only a yes or no, never who or why. */
  if (path === "/v1/calls/reach" && request.method === "GET") {
    const paced = await deps.rateHit(env, "reachinfo:" + ip, 240, HOUR);
    if (!paced.ok) return deps.limited(paced);
    const visitor = await deps.sessionAccount(env, request);
    const self = !!(visitor && owner && visitor.public_id === owner);
    const available = !self && owner ? await reachable(env, h, owner, visitor) : false;
    return deps.json(200, { available: available, requests: !!owner && !self, self: self });
  }

  /* Public: one tap rings the owner. The call uses the owner's key once answered. */
  if (path === "/v1/calls/reach/call" && request.method === "POST") {
    const body = await deps.readJson(request, 2000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "bad_call" });
    const src = await sourceOf(request, h, body);
    const byIp = await deps.rateHit(env, "reachcall:" + src.ipHash, 10, HOUR);
    if (!byIp.ok) return deps.limited(byIp);
    if (src.deviceHash) {
      const byDev = await deps.rateHit(env, "reachcalld:" + src.deviceHash, 8, HOUR);
      if (!byDev.ok) return deps.limited(byDev);
    }
    const all = await deps.rateHit(env, "reachcallall", 60, HOUR);
    if (!all.ok) return deps.limited(all);
    const visitor = await deps.sessionAccount(env, request);
    if (!owner || (visitor && visitor.public_id === owner)) return deps.json(403, { error: "calls_closed" });
    if (!(await reachable(env, h, owner, visitor))) return deps.json(403, { error: "not_available" });
    const now = Date.now();
    const id = h.hex(crypto.getRandomValues(new Uint8Array(16)));
    const peerId = visitor ? visitor.public_id : "g" + h.hex(crypto.getRandomValues(new Uint8Array(8)));
    const displayName = h.cleanName(body && body.name) || (visitor ? String(visitor.display_name || "") : "") || "Guest";
    await env.DB.prepare(
      "INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, ?, 'link', 'ringing', ?, 0, 0, ?)"
    ).bind(id, owner, peerId, now, now + 60 * 1000).run();
    await env.DB.prepare("INSERT INTO call_names (call_id, name) VALUES (?, ?)").bind(id, displayName).run();
    let guestToken = "";
    if (!visitor) {
      guestToken = "cg1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
      await env.DB.prepare("INSERT INTO call_guests (token_hash, call_id, guest_id, expires_at) VALUES (?, ?, ?, ?)").bind(await h.sha256Hex(guestToken), id, peerId, now + 2 * HOUR).run();
    }
    const ticket = await h.mintTicket(env, id, peerId, "guest");
    try { await publishToAccount(env, owner, "calls", { op: "ring", id: id, name: displayName, handle: visitor ? String(visitor.handle || "") : "", avatar: "", guest: !visitor }, id); } catch (err) { /* history still shows it */ }
    try {
      await emitNotification(env, {
        publicId: owner, kind: "call", subject: visitor ? visitor.public_id : owner, idempotencyKey: "call:" + id,
        actorId: visitor ? visitor.public_id : owner, name: displayName, handle: visitor ? String(visitor.handle || "") : "",
        hash: "#/calls/" + id, platform: "app"
      });
    } catch (err) { /* ringing still works in the open app */ }
    return deps.json(200, {
      call: { id: id, hostId: "", peerId: peerId, kind: "link", state: "ringing", video: false },
      guestId: peerId, guestToken: guestToken, guestExpiresAt: guestToken ? now + 2 * HOUR : 0,
      ticket: ticket.ticket, iceServers: await h.callIceServers(env, deps, { id: id, self: peerId, state: "ringing" }),
      ringing: true, video: false
    });
  }

  /* Public: ask for a call at a time. */
  if (path === "/v1/calls/reach/request" && request.method === "POST") {
    const body = await deps.readJson(request, 3000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "bad_request" });
    const src = await sourceOf(request, h, body);
    const byIp = await deps.rateHit(env, "reachreq:" + src.ipHash, 5, DAY);
    if (!byIp.ok) return deps.limited(byIp);
    if (src.deviceHash) {
      const byDev = await deps.rateHit(env, "reachreqd:" + src.deviceHash, 5, DAY);
      if (!byDev.ok) return deps.limited(byDev);
    }
    const all = await deps.rateHit(env, "reachreqall", 80, DAY);
    if (!all.ok) return deps.limited(all);
    /* A hidden field people never see: bots fill it in. */
    if (String((body && body.website) || "")) return deps.json(400, { error: "bad_request" });
    const visitor = await deps.sessionAccount(env, request);
    if (!owner || (visitor && visitor.public_id === owner)) return deps.json(403, { error: "calls_closed" });
    if (visitor && !(await h.callerMayCall(env, visitor.public_id, owner))) return deps.json(403, { error: "calls_closed" });
    const name = cleanReachText((body && body.name) || (visitor && visitor.display_name), NAME_MAX);
    const note = cleanReachText(body && body.note, NOTE_MAX);
    if (!name) return deps.json(400, { error: "name" });
    if (looksSpammy(name) || looksSpammy(note)) return deps.json(400, { error: "spam" });
    const startsAt = parseStartsAt(body && body.startsAt);
    const now = Date.now();
    if (!requestWhenOk(startsAt, now)) return deps.json(400, { error: "when" });
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM call_requests WHERE (source_hash = ? OR (device_hash != '' AND device_hash = ?)) AND state IN ('pending','suggested')").bind(src.ipHash, src.deviceHash || "-").first();
    if (open && Number(open.n) >= MAX_PENDING_PER_SOURCE) return deps.json(429, { error: "too_many_requests" });
    const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM call_requests WHERE owner_id = ? AND state = 'pending'").bind(owner).first();
    if (total && Number(total.n) >= MAX_PENDING_TOTAL) return deps.json(429, { error: "too_many_requests" });
    const id = h.hex(crypto.getRandomValues(new Uint8Array(16)));
    const token = "cq1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
    await env.DB.prepare(
      "INSERT INTO call_requests (id, owner_id, token_hash, visitor_id, name, note, zone, starts_at, suggested_at, state, schedule_id, source_hash, device_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', '', ?, ?, ?, ?)"
    ).bind(id, owner, await h.sha256Hex(token), visitor ? visitor.public_id : "", name, note, cleanZone(body && body.zone), startsAt, src.ipHash, src.deviceHash, now, now).run();
    try {
      await emitNotification(env, {
        publicId: owner, kind: "call_request", subject: id, idempotencyKey: "call_request:" + id,
        actorId: visitor ? visitor.public_id : owner, name: name, handle: "", hash: "#/calls?tab=requests", platform: "app"
      });
    } catch (err) { /* the Requests tab still lists it */ }
    try { await publishToAccount(env, owner, "calls", { op: "request", id: id }, "req:" + id); } catch (err) { /* listed on open */ }
    const row = await env.DB.prepare("SELECT * FROM call_requests WHERE id = ?").bind(id).first();
    return deps.json(201, { token: token, request: viewForVisitor(row, "") });
  }

  /* Public with the request's own token: its status, take a suggested time, or withdraw it. */
  if (path === "/v1/calls/reach/request" || path === "/v1/calls/reach/request/take" || path === "/v1/calls/reach/request/cancel") {
    const paced = await deps.rateHit(env, "reachreqread:" + ip, 240, HOUR);
    if (!paced.ok) return deps.limited(paced);
    const body = request.method === "POST" ? await deps.readJson(request, 1000) : null;
    const token = String(url.searchParams.get("token") || (body && body.token) || "");
    if (!REQUEST_TOKEN.test(token)) return deps.json(404, { error: "not_found" });
    const row = await env.DB.prepare("SELECT * FROM call_requests WHERE token_hash = ?").bind(await h.sha256Hex(token)).first();
    if (!row) return deps.json(404, { error: "not_found" });
    if (path === "/v1/calls/reach/request" && request.method === "GET") return deps.json(200, { request: viewForVisitor(row, await inviteFor(env, row)) });
    if (request.method !== "POST") return deps.json(405, { error: "method" });
    if (path.endsWith("/take")) {
      if (row.state !== "suggested" || !requestWhenOk(row.suggested_at, Date.now() - 14 * 60 * 1000)) return deps.json(409, { error: "state" });
      await accept(env, h, row, Number(row.suggested_at));
    } else {
      if (row.state !== "pending" && row.state !== "suggested") return deps.json(409, { error: "state" });
      await env.DB.prepare("UPDATE call_requests SET state = 'cancelled', updated_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
    }
    const next = await env.DB.prepare("SELECT * FROM call_requests WHERE id = ?").bind(row.id).first();
    return deps.json(200, { request: viewForVisitor(next, await inviteFor(env, next)) });
  }

  /* Owner only from here. */
  const who = await h.member(env, request, deps);
  if (!who.account) return deps.json(401, { error: "unauthorized" });
  if (!owner || who.account.public_id !== owner) return deps.json(403, { error: "owner_only" });

  if (path === "/v1/calls/reach/availability" && (request.method === "GET" || request.method === "PUT")) {
    if (request.method === "PUT") {
      const body = await deps.readJson(request, 500);
      const on = !!(body && body.available === true);
      await env.DB.prepare("INSERT INTO call_reach (owner_id, available, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET available = excluded.available, updated_at = excluded.updated_at").bind(owner, on ? 1 : 0, Date.now()).run();
    }
    const prefs = await h.loadPrefs(env, owner);
    return deps.json(200, { available: await availableFlag(env, owner), guests: !!(prefs.guests && prefs.who === "everyone"), quiet: dndActive(prefs, Date.now()) });
  }

  if (path === "/v1/calls/reach/requests" && request.method === "GET") {
    const listed = await env.DB.prepare("SELECT * FROM call_requests WHERE owner_id = ? ORDER BY CASE WHEN state = 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 50").bind(owner).all();
    const rows = (listed && listed.results) || [];
    return deps.json(200, { requests: rows.map(viewForOwner), pending: rows.filter((r) => r.state === "pending").length });
  }

  const one = path.match(/^\/v1\/calls\/reach\/requests\/([a-f0-9]{32})\/(accept|decline|suggest)$/);
  if (one && request.method === "POST") {
    if (!ID.test(one[1])) return deps.json(404, { error: "not_found" });
    const row = await env.DB.prepare("SELECT * FROM call_requests WHERE id = ? AND owner_id = ?").bind(one[1], owner).first();
    if (!row) return deps.json(404, { error: "not_found" });
    if (row.state !== "pending" && row.state !== "suggested") return deps.json(409, { error: "state" });
    const body = await deps.readJson(request, 500);
    const now = Date.now();
    if (one[2] === "accept") {
      /* After Suggest another time the visitor holds the choice: an owner Accept
         would book the old time the visitor was just told was off. */
      if (row.state === "suggested") return deps.json(409, { error: "waiting_for_visitor" });
      if (Number(row.starts_at) < now) return deps.json(400, { error: "when" });
      const schedule = await accept(env, h, row, Number(row.starts_at));
      await tellVisitor(env, row, "call_scheduled");
      const next = await env.DB.prepare("SELECT * FROM call_requests WHERE id = ?").bind(row.id).first();
      return deps.json(200, { request: viewForOwner(next), scheduleId: schedule ? schedule.id : "" });
    }
    if (one[2] === "suggest") {
      const at = parseStartsAt(body && body.startsAt);
      if (!requestWhenOk(at, now)) return deps.json(400, { error: "when" });
      await env.DB.prepare("UPDATE call_requests SET state = 'suggested', suggested_at = ?, updated_at = ? WHERE id = ?").bind(at, now, row.id).run();
    } else {
      await env.DB.prepare("UPDATE call_requests SET state = 'declined', updated_at = ? WHERE id = ?").bind(now, row.id).run();
      await tellVisitor(env, row, "call_declined");
    }
    const next = await env.DB.prepare("SELECT * FROM call_requests WHERE id = ?").bind(row.id).first();
    return deps.json(200, { request: viewForOwner(next) });
  }

  return deps.json(404, { error: "not_found" });
}
