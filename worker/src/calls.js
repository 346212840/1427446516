/* Voice and text calls. Media stays on the devices.
   The Worker mints a Gemini ephemeral token and forwards signaling.
   It never receives call audio and never clones a voice. */

import { iceServers } from "./live.js";
import { readFlags } from "./feature-flags.js";
import { blocksEither } from "./social.js";
import { publishToAccount } from "./channel.js";
import { emitNotification } from "./notifications.js";
import { visibleAvatarUrl } from "./profile-media.js";
import { CALL_LANGS, PINNED_LANGS, CALL_MODEL, normalizeLang } from "../../shared/call-langs.js";
import { cleanWho, callDecision, dndActive } from "../../shared/call-privacy.js";
import { normalizeMode } from "../../shared/call-mode.js";
import { liveSetup, rejectsClone, cleanVoice } from "../../shared/call-setup.js";
import { lexiconHint } from "../../shared/call-quality.js";
import { directSocketUrl } from "../../shared/call-gemini.js";

const ACCOUNT = /^\d{12}$/;
const ID = /^[a-f0-9]{32}$/;
const GUEST_ID = /^g[a-f0-9]{16}$/;
const encoder = new TextEncoder();
const TICKET_MS = 2 * 60 * 1000;
const SECRET_CMD = "npx wrangler secret put GEMINI_API_KEY --name viktorych-accounts";

export const CALLS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_sessions (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    peer_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'direct',
    state TEXT NOT NULL DEFAULT 'ringing',
    created_at INTEGER NOT NULL,
    answered_at INTEGER NOT NULL DEFAULT 0,
    ended_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS call_sessions_peer ON call_sessions(peer_id, state, created_at)",
  "CREATE INDEX IF NOT EXISTS call_sessions_host ON call_sessions(host_id, created_at)",
  `CREATE TABLE IF NOT EXISTS call_invites (
    token_hash TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_tickets (
    token_hash TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    peer_id TEXT NOT NULL,
    role TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_prefs (
    public_id TEXT PRIMARY KEY,
    who TEXT NOT NULL DEFAULT 'everyone',
    guests INTEGER NOT NULL DEFAULT 1,
    dnd INTEGER NOT NULL DEFAULT 0,
    dnd_start TEXT NOT NULL DEFAULT '22:00',
    dnd_end TEXT NOT NULL DEFAULT '07:00',
    tz_offset INTEGER NOT NULL DEFAULT 0,
    send_mode TEXT NOT NULL DEFAULT 'voice',
    receive_mode TEXT NOT NULL DEFAULT 'both',
    hear_original INTEGER NOT NULL DEFAULT 1,
    translation_only INTEGER NOT NULL DEFAULT 0,
    subtitles TEXT NOT NULL DEFAULT 'both',
    review_notes INTEGER NOT NULL DEFAULT 0,
    voice TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_guests (
    token_hash TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    guest_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`
];

let schema = null;
function ensure(env) {
  if (!schema) {
    schema = env.DB.batch(CALLS_SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schema = null;
      throw err;
    });
  }
  return schema;
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function b64url(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return hex(new Uint8Array(digest));
}
function configured(env) {
  return !!String((env && env.GEMINI_API_KEY) || "");
}
function mockKey(env) {
  const key = String((env && env.GEMINI_API_KEY) || "");
  return key === "test-key" || String(env && env.CALLS_GEMINI_MOCK || "") === "1";
}
function peerOk(id) {
  return ACCOUNT.test(id) || GUEST_ID.test(id);
}
function cleanName(value) {
  return String(value || "").replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}
function clockOk(value, fallback) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
}

function prefsFrom(row) {
  const mode = normalizeMode({
    send: row && row.send_mode,
    receive: row && row.receive_mode,
    original: !row || Number(row.hear_original) !== 0,
    translationOnly: !!(row && Number(row.translation_only) === 1),
    subtitles: row && row.subtitles,
    reviewNotes: !!(row && Number(row.review_notes) === 1),
    voice: row && row.voice
  });
  return {
    who: cleanWho(row && row.who),
    guests: !row || Number(row.guests) !== 0,
    dnd: !!(row && Number(row.dnd) === 1),
    dndStart: clockOk(row && row.dnd_start, "22:00"),
    dndEnd: clockOk(row && row.dnd_end, "07:00"),
    tz: Number(row && row.tz_offset) || 0,
    send: mode.send,
    receive: mode.receive,
    original: mode.original,
    translationOnly: mode.translationOnly,
    subtitles: mode.subtitles,
    reviewNotes: mode.reviewNotes,
    voice: cleanVoice(mode.voice)
  };
}

async function loadPrefs(env, publicId) {
  await ensure(env);
  const row = await env.DB.prepare("SELECT * FROM call_prefs WHERE public_id = ?").bind(publicId).first();
  return prefsFrom(row);
}

export async function callerMayCall(env, callerId, calleeId) {
  if (!ACCOUNT.test(String(callerId || "")) || !ACCOUNT.test(String(calleeId || ""))) return false;
  if (callerId === calleeId) return false;
  try {
    const off = await readFlags(env);
    if (off.calls) return false;
  } catch (err) { return false; }
  try {
    if (await blocksEither(env, callerId, calleeId)) return false;
    const prefs = await loadPrefs(env, calleeId);
    const follow = await env.DB.prepare("SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(calleeId, "app:" + callerId).first();
    let mutual = false;
    try {
      const friend = await env.DB.prepare("SELECT user_id FROM account_friends WHERE user_id = ? AND friend_id = ?").bind(calleeId, callerId).first();
      mutual = !!friend;
    } catch (err) { mutual = false; }
    const decision = callDecision({
      who: prefs.who,
      follows: !!follow,
      mutual: mutual,
      blocked: false,
      dnd: dndActive(prefs, Date.now()),
      self: false
    });
    return decision.ok;
  } catch (err) {
    return false;
  }
}

async function mintTicket(env, callId, peerId, role) {
  const ticket = "ct1." + b64url(crypto.getRandomValues(new Uint8Array(24)));
  const now = Date.now();
  await env.DB.prepare("DELETE FROM call_tickets WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("INSERT INTO call_tickets (token_hash, call_id, peer_id, role, expires_at) VALUES (?, ?, ?, ?, ?)").bind(
    await sha256Hex(ticket), callId, peerId, role, now + TICKET_MS
  ).run();
  return { ticket: ticket, expiresAt: now + TICKET_MS };
}

function statusBody(env) {
  return {
    configured: configured(env),
    command: SECRET_CMD,
    model: CALL_MODEL,
    languages: CALL_LANGS.map((row) => row[0]),
    pinned: PINNED_LANGS,
    video: false
  };
}

async function member(env, request, deps) {
  const account = await deps.sessionAccount(env, request);
  if (account) return { account: account, guest: null };
  const header = String(request.headers.get("x-call-guest") || "");
  if (!header.startsWith("cg1.") || header.length > 80) return { account: null, guest: null };
  await ensure(env);
  const row = await env.DB.prepare("SELECT call_id, guest_id, expires_at FROM call_guests WHERE token_hash = ?").bind(await sha256Hex(header)).first();
  if (!row || Number(row.expires_at) <= Date.now()) return { account: null, guest: null };
  return { account: null, guest: { callId: row.call_id, guestId: row.guest_id } };
}

async function geminiToken(env, target, voice, hint, source) {
  const setup = liveSetup(target, voice, "", hint, source);
  const textFallback = { mode: "text", direct: true, setup: setup };
  if (mockKey(env)) {
    return { mode: "token", direct: true, token: "test-ephemeral", url: directSocketUrl("test-ephemeral"), setup: setup };
  }
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const fresh = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  let response = null;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uses: 1,
        expireTime: exp,
        newSessionExpireTime: fresh,
        bidiGenerateContentSetup: setup
      })
    });
  } catch (err) {
    return textFallback;
  }
  if (response.status === 429) return Object.assign({ reason: "quota" }, textFallback);
  if (!response.ok) return textFallback;
  const data = await response.json().catch(() => ({}));
  const name = String(data.name || data.token || "");
  const token = name.indexOf("/") >= 0 ? name.slice(name.lastIndexOf("/") + 1) : name;
  const url = directSocketUrl(token);
  if (!url || token === env.GEMINI_API_KEY) return textFallback;
  return { mode: "token", direct: true, token: token, url: url, setup: setup };
}

async function translateText(env, text, target, hint) {
  const lang = normalizeLang(target) || "en";
  const clipped = String(text || "").slice(0, 500);
  const note = String(hint || "").slice(0, 800);
  if (mockKey(env)) return { text: clipped, translation: clipped, lang: lang, fallback: "speech" };
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: (note ? note + "\n" : "") + "Translate into " + lang + ". Reply with only the translation.\n\n" + clipped }] }]
      })
    });
    if (response.status === 429) return { error: "quota" };
    const data = await response.json().catch(() => ({}));
    const out = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
    return { text: clipped, translation: String(out || clipped).slice(0, 800), lang: lang, fallback: "speech" };
  } catch (err) {
    return { text: clipped, translation: clipped, lang: lang, fallback: "speech" };
  }
}

function viewCall(row) {
  return {
    id: row.id,
    hostId: row.host_id,
    peerId: row.peer_id || "",
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    answeredAt: row.answered_at || 0,
    endedAt: row.ended_at || 0,
    video: false
  };
}

export function isCallName(name) {
  return /^call:[a-f0-9]{32}$/.test(String(name || ""));
}
function socketsOf(room) {
  try { return room.ctx.getWebSockets() || []; }
  catch (err) { return []; }
}
function attachment(ws) {
  try { return ws.deserializeAttachment() || {}; }
  catch (err) { return {}; }
}
function send(ws, body) {
  try { ws.send(JSON.stringify(body)); }
  catch (err) { /* the socket can close while we answer */ }
}

export function callFetch(room, request) {
  if (String(request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("not found", { status: 404 });
  const peer = String(request.headers.get("x-call-peer") || "");
  if (!peerOk(peer)) return new Response("peer", { status: 403 });
  const open = socketsOf(room);
  if (open.length >= 2) return new Response("full", { status: 503 });
  const pair = new WebSocketPair();
  room.ctx.acceptWebSocket(pair[1]);
  pair[1].serializeAttachment({ peer: peer, role: request.headers.get("x-call-role") === "host" ? "host" : "guest" });
  send(pair[1], { op: "welcome", self: peer, peers: open.map((ws) => attachment(ws).peer).filter(Boolean) });
  open.forEach((ws) => send(ws, { op: "join", peer: peer }));
  return new Response(null, { status: 101, webSocket: pair[0] });
}

const SIGNAL_KINDS = { offer: 1, answer: 1, ice: 1, mode: 1, chat: 1, typing: 1, note: 1 };

export function callMessage(room, ws, message) {
  if (typeof message !== "string" || message.length > 12000) {
    try { ws.close(1009, "size"); } catch (err) { /* already closed */ }
    return;
  }
  let msg = null;
  try { msg = JSON.parse(message); }
  catch (err) { return; }
  if (!msg || msg.op !== "signal" || !msg.data || typeof msg.data !== "object") return;
  if (!SIGNAL_KINDS[String(msg.data.kind || "")]) return;
  if (rejectsClone(msg.data)) return;
  const from = attachment(ws).peer;
  socketsOf(room).forEach((other) => {
    if (other !== ws) send(other, { op: "signal", from: from, data: msg.data });
  });
}

export function callClose(room, ws) {
  const peer = attachment(ws).peer;
  socketsOf(room).forEach((other) => {
    if (other !== ws) send(other, { op: "leave", peer: peer });
  });
}

export async function sweepCalls(env, at) {
  if (!env || !env.DB) return;
  const now = Number(at) || Date.now();
  try {
    await ensure(env);
    await env.DB.prepare("UPDATE call_sessions SET state = 'missed', ended_at = ? WHERE state = 'ringing' AND created_at < ?").bind(now, now - 45000).run();
    await env.DB.prepare("UPDATE call_sessions SET state = 'ended', ended_at = ? WHERE state = 'active' AND created_at < ?").bind(now, now - 6 * 60 * 60 * 1000).run();
    await env.DB.prepare("DELETE FROM call_tickets WHERE expires_at <= ?").bind(now).run();
    await env.DB.prepare("DELETE FROM call_guests WHERE expires_at <= ?").bind(now).run();
  } catch (err) { /* the next minute tries again */ }
}

export async function handleCalls(request, env, path, url, deps) {
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  await ensure(env);
  if (path === "/v1/calls/status" && request.method === "GET") return deps.json(200, statusBody(env));

  if (path === "/v1/calls/prefs" && (request.method === "GET" || request.method === "PUT")) {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    if (request.method === "GET") return deps.json(200, { prefs: await loadPrefs(env, who.account.public_id) });
    const body = await deps.readJson(request, 4000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "bad_prefs" });
    const prev = await loadPrefs(env, who.account.public_id);
    const mode = normalizeMode(body);
    const next = {
      who: body.who ? cleanWho(body.who) : prev.who,
      guests: typeof body.guests === "boolean" ? body.guests : prev.guests,
      dnd: typeof body.dnd === "boolean" ? body.dnd : prev.dnd,
      dndStart: clockOk(body.dndStart, prev.dndStart),
      dndEnd: clockOk(body.dndEnd, prev.dndEnd),
      tz: Number.isFinite(Number(body.tz)) ? Math.max(-14 * 60, Math.min(14 * 60, Number(body.tz))) : prev.tz,
      send: body.send ? mode.send : prev.send,
      receive: body.receive ? mode.receive : prev.receive,
      original: typeof body.original === "boolean" ? body.original : prev.original,
      translationOnly: typeof body.translationOnly === "boolean" ? body.translationOnly : prev.translationOnly,
      subtitles: body.subtitles ? mode.subtitles : prev.subtitles,
      reviewNotes: typeof body.reviewNotes === "boolean" ? body.reviewNotes : prev.reviewNotes,
      voice: body.voice != null ? cleanVoice(body.voice) : prev.voice
    };
    await env.DB.prepare(
      "INSERT INTO call_prefs (public_id, who, guests, dnd, dnd_start, dnd_end, tz_offset, send_mode, receive_mode, hear_original, translation_only, subtitles, review_notes, voice, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET who = excluded.who, guests = excluded.guests, dnd = excluded.dnd, dnd_start = excluded.dnd_start, dnd_end = excluded.dnd_end, tz_offset = excluded.tz_offset, send_mode = excluded.send_mode, receive_mode = excluded.receive_mode, hear_original = excluded.hear_original, translation_only = excluded.translation_only, subtitles = excluded.subtitles, review_notes = excluded.review_notes, voice = excluded.voice, updated_at = excluded.updated_at"
    ).bind(who.account.public_id, next.who, next.guests ? 1 : 0, next.dnd ? 1 : 0, next.dndStart, next.dndEnd, next.tz, next.send, next.receive, next.original ? 1 : 0, next.translationOnly ? 1 : 0, next.subtitles, next.reviewNotes ? 1 : 0, next.voice, Date.now()).run();
    return deps.json(200, { prefs: next });
  }

  if (path === "/v1/calls/history" && request.method === "GET") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const listed = await env.DB.prepare("SELECT * FROM call_sessions WHERE host_id = ? OR peer_id = ? ORDER BY created_at DESC LIMIT 40").bind(who.account.public_id, who.account.public_id).all();
    const calls = ((listed && listed.results) || []).map((row) => {
      const item = viewCall(row);
      item.missed = row.state === "missed" || (row.state === "ended" && !row.answered_at && row.peer_id === who.account.public_id);
      item.duration = row.answered_at && row.ended_at ? Math.max(0, row.ended_at - row.answered_at) : 0;
      return item;
    });
    return deps.json(200, { calls: calls });
  }

  if (path === "/v1/calls/incoming" && request.method === "GET") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const listed = await env.DB.prepare("SELECT * FROM call_sessions WHERE peer_id = ? AND state = 'ringing' AND expires_at > ? ORDER BY created_at DESC LIMIT 5").bind(who.account.public_id, Date.now()).all();
    return deps.json(200, { calls: ((listed && listed.results) || []).map(viewCall) });
  }

  if (path === "/v1/calls" && request.method === "POST") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    if (!configured(env)) return deps.json(503, { error: "not_configured", command: SECRET_CMD });
    const paced = await deps.rateHit(env, "call:" + who.account.public_id, 10, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 4000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "bad_call" });
    const now = Date.now();
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    if (body.invite === true) {
      const prefs = await loadPrefs(env, who.account.public_id);
      if (!prefs.guests) return deps.json(403, { error: "guests" });
      const ttl = Math.max(5, Math.min(24 * 60, Number(body.ttlMin) || 60)) * 60 * 1000;
      const invite = "ci1." + b64url(crypto.getRandomValues(new Uint8Array(18)));
      await env.DB.prepare("INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, '', 'invite', 'ringing', ?, 0, 0, ?)").bind(id, who.account.public_id, now, now + ttl).run();
      await env.DB.prepare("INSERT INTO call_invites (token_hash, call_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(invite), id, now + ttl).run();
      const ticket = await mintTicket(env, id, who.account.public_id, "host");
      return deps.json(201, { call: viewCall(await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first()), invite: invite, ticket: ticket.ticket, expiresAt: now + ttl, iceServers: iceServers(env), video: false });
    }
    const handle = String(body.handle || "").replace(/^@/, "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,30}$/.test(handle)) return deps.json(400, { error: "bad_call" });
    const peer = await env.DB.prepare("SELECT public_id, handle, display_name FROM accounts WHERE lower(handle) = ?").bind(handle).first();
    if (!peer) return deps.json(404, { error: "not_found" });
    if (!(await callerMayCall(env, who.account.public_id, peer.public_id))) return deps.json(403, { error: "calls_closed" });
    const exp = now + 2 * 60 * 1000;
    await env.DB.prepare("INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, ?, 'direct', 'ringing', ?, 0, 0, ?)").bind(id, who.account.public_id, peer.public_id, now, exp).run();
    const ticket = await mintTicket(env, id, who.account.public_id, "host");
    let avatar = "";
    try { avatar = String(await visibleAvatarUrl(env, request, peer, who.account.handle) || ""); } catch (err) { avatar = ""; }
    const ring = { op: "ring", id: id, name: String(who.account.display_name || ""), handle: String(who.account.handle || ""), avatar: avatar };
    try { await publishToAccount(env, peer.public_id, "calls", ring, id); } catch (err) { /* the row is still there */ }
    try {
      await emitNotification(env, {
        publicId: peer.public_id,
        kind: "call",
        subject: who.account.public_id,
        idempotencyKey: "call:" + id,
        actorId: who.account.public_id,
        name: String(who.account.display_name || ""),
        handle: String(who.account.handle || ""),
        hash: "#/calls/" + id,
        platform: "app"
      });
    } catch (err) { /* ringing still works in the open app */ }
    return deps.json(201, { call: { id: id, hostId: who.account.public_id, peerId: peer.public_id, kind: "direct", state: "ringing", video: false }, ticket: ticket.ticket, iceServers: iceServers(env), video: false });
  }

  const join = path.match(/^\/v1\/calls\/join\/(ci1\.[A-Za-z0-9_-]{8,80})$/);
  if (join && request.method === "POST") {
    if (!configured(env)) return deps.json(503, { error: "not_configured", command: SECRET_CMD });
    const ip = String(request.headers.get("CF-Connecting-IP") || "0");
    const paced = await deps.rateHit(env, "calljoin:" + ip, 20, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 2000);
    if (rejectsClone(body)) return deps.json(400, { error: "clone" });
    const saved = await env.DB.prepare("SELECT call_id, expires_at FROM call_invites WHERE token_hash = ?").bind(await sha256Hex(join[1])).first();
    if (!saved || Number(saved.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
    const row = await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(saved.call_id).first();
    if (!row || row.state === "ended" || row.state === "missed") return deps.json(404, { error: "not_found" });
    const hostPrefs = await loadPrefs(env, row.host_id);
    if (!hostPrefs.guests) return deps.json(403, { error: "guests" });
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM call_guests WHERE call_id = ? AND expires_at > ?").bind(row.id, Date.now()).first();
    if (Number(open && open.n) >= 1 && row.kind === "invite") {
      /* One guest at a time keeps the call 1:1. */
    }
    const guestId = "g" + hex(crypto.getRandomValues(new Uint8Array(8)));
    const guestToken = "cg1." + b64url(crypto.getRandomValues(new Uint8Array(18)));
    const now = Date.now();
    await env.DB.prepare("INSERT INTO call_guests (token_hash, call_id, guest_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(guestToken), row.id, guestId, Number(saved.expires_at)).run();
    if (row.state === "ringing") {
      await env.DB.prepare("UPDATE call_sessions SET state = 'active', answered_at = ?, peer_id = ? WHERE id = ?").bind(now, guestId, row.id).run();
    }
    const ticket = await mintTicket(env, row.id, guestId, "guest");
    return deps.json(200, { call: viewCall(await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(row.id).first()), guestId: guestId, guestToken: guestToken, name: cleanName(body && body.name) || "Guest", ticket: ticket.ticket, iceServers: iceServers(env), video: false });
  }

  const one = path.match(/^\/v1\/calls\/([a-f0-9]{32})(\/answer|\/decline|\/end|\/ticket|\/translate|\/speak|\/signal|\/return)?$/);
  if (!one) return null;
  const id = one[1];
  const action = one[2] || "";
  const row = await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first();
  if (!row) return deps.json(404, { error: "not_found" });

  if (action === "/signal") {
    if (request.method !== "GET") return deps.json(405, { error: "method" });
    if (String(request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return deps.json(426, { error: "upgrade" });
    const ticket = String(url.searchParams.get("ticket") || "");
    if (!ticket.startsWith("ct1.") || ticket.length > 80) return deps.json(401, { error: "ticket" });
    const saved = await env.DB.prepare("SELECT call_id, peer_id, role, expires_at FROM call_tickets WHERE token_hash = ?").bind(await sha256Hex(ticket)).first();
    await env.DB.prepare("DELETE FROM call_tickets WHERE token_hash = ?").bind(await sha256Hex(ticket)).run();
    if (!saved || saved.call_id !== id || Number(saved.expires_at) <= Date.now()) return deps.json(401, { error: "ticket" });
    if (!env.ACCOUNT_CHANNEL) return deps.json(503, { error: "channel" });
    const headers = new Headers(request.headers);
    headers.set("x-call-peer", saved.peer_id);
    headers.set("x-call-role", saved.role === "host" ? "host" : "guest");
    return env.ACCOUNT_CHANNEL.get(env.ACCOUNT_CHANNEL.idFromName("call:" + id)).fetch(new Request(request.url, { method: request.method, headers: headers }));
  }

  const who = await member(env, request, deps);
  const self = who.account ? who.account.public_id : (who.guest && who.guest.callId === id ? who.guest.guestId : "");
  if (!self) return deps.json(401, { error: "unauthorized" });
  const inCall = self === row.host_id || self === row.peer_id;
  if (!inCall && !(who.guest && who.guest.callId === id)) return deps.json(403, { error: "calls_closed" });

  if (action === "/answer" && request.method === "POST") {
    if (self !== row.peer_id) return deps.json(403, { error: "calls_closed" });
    const now = Date.now();
    await env.DB.prepare("UPDATE call_sessions SET state = 'active', answered_at = ? WHERE id = ?").bind(now, id).run();
    const ticket = await mintTicket(env, id, self, "guest");
    return deps.json(200, { call: viewCall(await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first()), ticket: ticket.ticket, iceServers: iceServers(env), video: false });
  }
  if (action === "/decline" && request.method === "POST") {
    await env.DB.prepare("UPDATE call_sessions SET state = 'missed', ended_at = ? WHERE id = ? AND answered_at = 0").bind(Date.now(), id).run();
    return deps.json(200, { ok: true });
  }
  if (action === "/end" && request.method === "POST") {
    const now = Date.now();
    const missed = !row.answered_at;
    await env.DB.prepare("UPDATE call_sessions SET state = ?, ended_at = ? WHERE id = ?").bind(missed ? "missed" : "ended", now, id).run();
    return deps.json(200, { ok: true, duration: row.answered_at ? Math.max(0, now - row.answered_at) : 0 });
  }
  if (action === "/ticket" && request.method === "POST") {
    const ticket = await mintTicket(env, id, self, self === row.host_id ? "host" : "guest");
    return deps.json(200, { ticket: ticket.ticket, iceServers: iceServers(env), video: false });
  }
  if (action === "/return" && request.method === "POST") {
    if (!who.account || who.account.public_id !== row.host_id) return deps.json(403, { error: "calls_closed" });
    const prefs = await loadPrefs(env, row.host_id);
    if (!prefs.guests) return deps.json(403, { error: "guests" });
    const now = Date.now();
    const ttl = now + 60 * 60 * 1000;
    const invite = "ci1." + b64url(crypto.getRandomValues(new Uint8Array(18)));
    await env.DB.prepare("INSERT INTO call_invites (token_hash, call_id, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(invite), id, ttl).run();
    await env.DB.prepare("UPDATE call_sessions SET state = 'ringing', expires_at = ? WHERE id = ?").bind(ttl, id).run();
    return deps.json(200, { invite: invite, expiresAt: ttl, video: false });
  }
  if (action === "/translate" && request.method === "POST") {
    if (!configured(env)) return deps.json(503, { error: "not_configured", command: SECRET_CMD });
    const paced = await deps.rateHit(env, "calltok:" + self, 12, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 8000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "clone" });
    const target = normalizeLang(body.target);
    if (!target) return deps.json(400, { error: "lang" });
    const minted = await geminiToken(env, target, body.voice, lexiconHint(body.lexicon), body.source);
    if (minted.reason === "quota" || minted.mode === "text") return deps.json(200, minted);
    const packed = JSON.stringify(minted);
    if (packed.includes(String(env.GEMINI_API_KEY || "missing-key"))) return deps.json(500, { error: "unavailable" });
    return deps.json(200, minted);
  }
  if (action === "/speak" && request.method === "POST") {
    if (!configured(env)) return deps.json(503, { error: "not_configured", command: SECRET_CMD });
    const paced = await deps.rateHit(env, "callsay:" + self, 40, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 8000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "clone" });
    const target = normalizeLang(body.target);
    if (!target) return deps.json(400, { error: "lang" });
    const said = await translateText(env, body.text, target, lexiconHint(body.lexicon));
    if (said.error === "quota") return deps.json(429, { error: "quota" });
    said.voice = cleanVoice(body.voice);
    said.video = false;
    return deps.json(200, said);
  }
  return deps.json(404, { error: "not_found" });
}
