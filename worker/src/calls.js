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
import { encryptMaterial, decryptMaterial } from "../../shared/owner-keys.js";
import { isOwnerViewer } from "./owner-view.js";

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
  `CREATE TABLE IF NOT EXISTS call_links (
    slug TEXT PRIMARY KEY,
    public_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_names (
    call_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS call_keys (
    public_id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    mask TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_hidden (
    public_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (public_id, call_id)
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
function mockKey(env, key) {
  const value = String(key || "");
  return value === "test-key" || String(env && env.CALLS_GEMINI_MOCK || "") === "1";
}
const KEY_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;
const KEY_SLOT = (id) => "call-key:" + id;

/* The owner's key pays only for calls the owner is really part of: the
   owner hosts it, or the owner is the person called and has answered.
   This reads the call row, never anything the browser says. Everyone else
   uses a key they supplied: their own saved key, a key pasted on this
   device, or the host's saved key. A callee's key never covers a caller. */
async function isOwnerId(env, id) {
  const value = String(id || "");
  if (!ACCOUNT.test(value)) return false;
  const configuredId = String((env && env.OWNER_PUBLIC_ID) || "");
  if (configuredId && configuredId === value) return true;
  try { return await isOwnerViewer(env, value); } catch (err) { return false; }
}
async function ownerInCall(env, row, self) {
  if (!row) return false;
  if (await isOwnerId(env, row.host_id)) return true;
  if (row.peer_id && (row.state === "active" || self === row.peer_id) && await isOwnerId(env, row.peer_id)) return true;
  return false;
}
async function storedKey(env, publicId) {
  if (!ACCOUNT.test(String(publicId || "")) || !String((env && env.KEYS_ENC_KEY) || "").trim()) return "";
  try {
    const row = await env.DB.prepare("SELECT ciphertext, iv FROM call_keys WHERE public_id = ?").bind(publicId).first();
    if (!row) return "";
    return String(await decryptMaterial(env.KEYS_ENC_KEY, KEY_SLOT(publicId), row.iv, row.ciphertext) || "");
  } catch (err) { return ""; }
}
async function pickKey(env, row, who, self, body) {
  if (row.kind === "link" && row.state === "ringing" && self !== row.host_id) return { key: "", source: "ringing" };
  if (await ownerInCall(env, row, self)) {
    return configured(env) ? { key: String(env.GEMINI_API_KEY), source: "owner" } : { key: "", source: "none" };
  }
  if (who && who.account) {
    const mine = await storedKey(env, who.account.public_id);
    if (mine) return { key: mine, source: "own" };
  }
  const pasted = String((body && body.key) || "");
  if (pasted && KEY_SHAPE.test(pasted)) return { key: pasted, source: "own" };
  if (self !== row.host_id) {
    const host = await storedKey(env, row.host_id);
    if (host) return { key: host, source: "host" };
  }
  if (row.peer_id && row.state !== "active" && self !== row.peer_id && await isOwnerId(env, row.peer_id)) return { key: "", source: "ringing" };
  return { key: "", source: "none" };
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

/* Countries where Google is blocked or throttled. Their callers go through
   the relay first, so the browser never has to reach Google at all. */
const RELAY_FIRST_COUNTRIES = new Set(["RU", "BY", "IR", "CN", "TM"]);
export function relayHint(request) {
  const cf = (request && request.cf) || {};
  let code = String(cf.country || "");
  if (!code && request && request.headers) code = String(request.headers.get("CF-IPCountry") || "");
  code = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return {};
  return RELAY_FIRST_COUNTRIES.has(code) ? { country: code, prefer: "relay" } : { country: code };
}

async function geminiToken(env, key, target, voice, hint, source, resume) {
  const setup = liveSetup(target, voice, resume, hint, source);
  const textFallback = { mode: "text", direct: true, setup: setup };
  if (mockKey(env, key)) {
    return { mode: "token", direct: true, token: "test-ephemeral", url: directSocketUrl("test-ephemeral"), setup: setup };
  }
  const exp = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const fresh = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  let response = null;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=" + encodeURIComponent(key), {
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
  if (response.status === 400 || response.status === 401 || response.status === 403) return Object.assign({ reason: "badkey" }, textFallback);
  if (!response.ok) return textFallback;
  const data = await response.json().catch(() => ({}));
  const name = String(data.name || data.token || "");
  const token = name.indexOf("/") >= 0 ? name.slice(name.lastIndexOf("/") + 1) : name;
  const url = directSocketUrl(token);
  if (!url || token === key) return textFallback;
  return { mode: "token", direct: true, token: token, url: url, setup: setup };
}

const TEXT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
async function translateText(env, key, text, target, hint) {
  const lang = normalizeLang(target) || "en";
  const clipped = String(text || "").slice(0, 500);
  const note = String(hint || "").slice(0, 800);
  if (mockKey(env, key)) return { text: clipped, translation: clipped, lang: lang, fallback: "speech" };
  /* Models get retired (gemini-2.5-flash now answers 404), so walk a short list and never mistake a dead model for a translation. */
  const prompt = (note ? note + "\n" : "") + "Translate into " + lang + ". Reply with only the translation.\n\n" + clipped;
  let hardError = "";
  for (const model of TEXT_MODELS) {
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      if (response.status === 429) return { error: "quota" };
      if (response.status === 401 || response.status === 403) return { error: "badkey" };
      if (response.status === 400) { hardError = "badkey"; continue; }
      if (!response.ok) continue;
      const data = await response.json().catch(() => ({}));
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const out = (parts || []).map((part) => (part && part.text) || "").join("").trim();
      if (out) return { text: clipped, translation: out.slice(0, 800), lang: lang, fallback: "speech" };
    } catch (err) { /* try the next model */ }
  }
  if (hardError) return { error: hardError };
  return { text: clipped, translation: clipped, lang: lang, fallback: "speech", untranslated: true };
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



const SLUG = /^[a-z0-9][a-z0-9-]{2,29}$/;
const RESERVED_SLUGS = new Set(["admin", "owner", "api", "calls", "call", "guest", "help", "login", "signup", "settings", "support", "test", "new", "regenerate"]);
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}
function viewLink(row) {
  return row ? { slug: row.slug, enabled: Number(row.enabled) === 1, createdAt: Number(row.created_at) } : null;
}

/* Free relay for networks that block UDP. Cloudflare Realtime TURN has a free
   monthly allowance; its credentials are minted here and last a day. The
   optional public relay is a last resort on TLS port 443. Media stays
   encrypted end to end between the two phones. */
let turnCache = { at: 0, list: null };
async function callIceServers(env) {
  const base = iceServers(env);
  const keyId = String((env && env.CF_TURN_KEY_ID) || "");
  const token = String((env && env.CF_TURN_API_TOKEN) || "");
  let extra = [];
  if (keyId && token) {
    if (turnCache.list && Date.now() - turnCache.at < 50 * 60 * 1000) extra = turnCache.list;
    else {
      try {
        const res = await fetch("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(keyId) + "/credentials/generate-ice-servers", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ ttl: 86400 })
        });
        if (res.ok) {
          const data = await res.json();
          extra = (Array.isArray(data.iceServers) ? data.iceServers : []).filter((row) => row && row.urls && row.credential);
          turnCache = { at: Date.now(), list: extra };
        }
      } catch (err) { extra = []; }
    }
  }
  const out = base.concat(extra);
  if (String((env && env.CALLS_PUBLIC_TURN) || "on") !== "off" && !extra.length) {
    out.push({ urls: ["turns:openrelay.metered.ca:443?transport=tcp", "turn:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" });
  }
  return out;
}

/* Google can be unreachable from some networks. The browser then opens this
   socket instead. It forwards frames to Gemini Live and keeps nothing. The
   token is the short-lived one this Worker minted; the key never leaves. */
async function relayLive(request, env, url, deps) {
  if (String(request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return deps.json(426, { error: "upgrade" });
  const token = String(url.searchParams.get("t") || "");
  if (!/^[A-Za-z0-9_.~-]{8,400}$/.test(token) || token === String(env.GEMINI_API_KEY || "-")) return deps.json(400, { error: "token" });
  const ip = String(request.headers.get("CF-Connecting-IP") || "0");
  const paced = await deps.rateHit(env, "callrelay:" + ip, 60, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  let upstream = null;
  try {
    upstream = await fetch("https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=" + encodeURIComponent(token), { headers: { Upgrade: "websocket" } });
  } catch (err) { return deps.json(502, { error: "upstream" }); }
  const up = upstream && upstream.webSocket;
  if (!up) return deps.json(502, { error: "upstream" });
  up.accept();
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  server.addEventListener("message", (event) => { try { up.send(event.data); } catch (err) { /* closed */ } });
  up.addEventListener("message", (event) => { try { server.send(event.data); } catch (err) { /* closed */ } });
  const closeBoth = (code) => {
    try { server.close(code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000); } catch (err) { /* closed */ }
    try { up.close(1000); } catch (err) { /* closed */ }
  };
  server.addEventListener("close", (event) => closeBoth(event.code));
  up.addEventListener("close", (event) => closeBoth(event.code));
  server.addEventListener("error", () => closeBoth(1011));
  up.addEventListener("error", () => closeBoth(1011));
  return new Response(null, { status: 101, webSocket: client });
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

  if (path === "/v1/calls/live" && request.method === "GET") return relayLive(request, env, url, deps);

  if (path === "/v1/calls/key") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const id = who.account.public_id;
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT mask, updated_at FROM call_keys WHERE public_id = ?").bind(id).first();
      return deps.json(200, { saved: !!row, mask: row ? row.mask : "", ready: !!String(env.KEYS_ENC_KEY || "").trim(), owner: id === String(env.OWNER_PUBLIC_ID || "") });
    }
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM call_keys WHERE public_id = ?").bind(id).run();
      return deps.json(200, { saved: false });
    }
    if (request.method === "PUT") {
      if (!String(env.KEYS_ENC_KEY || "").trim()) return deps.json(503, { error: "not_configured" });
      const paced = await deps.rateHit(env, "callkey:" + id, 10, 60 * 60 * 1000);
      if (!paced.ok) return deps.limited(paced);
      const body = await deps.readJson(request, 1000);
      const value = String((body && body.key) || "").trim();
      if (!KEY_SHAPE.test(value)) return deps.json(400, { error: "bad_key" });
      if (!mockKey(env, value)) {
        let check = null;
        try { check = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": value } }); } catch (err) { check = null; }
        if (!check || !check.ok) return deps.json(400, { error: "bad_key" });
      }
      const sealed = await encryptMaterial(env.KEYS_ENC_KEY, KEY_SLOT(id), value);
      if (!sealed) return deps.json(503, { error: "not_configured" });
      const mask = value.slice(0, 4) + "…" + value.slice(-4);
      await env.DB.prepare("INSERT INTO call_keys (public_id, ciphertext, iv, mask, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, mask = excluded.mask, updated_at = excluded.updated_at").bind(id, sealed.ciphertext, sealed.iv, mask, Date.now()).run();
      return deps.json(200, { saved: true, mask: mask });
    }
    return deps.json(405, { error: "method" });
  }

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
    const me = who.account.public_id;
    const listed = await env.DB.prepare("SELECT s.*, a.handle AS other_handle, COALESCE(NULLIF(a.display_name, ''), n.name, '') AS other_name FROM call_sessions s LEFT JOIN accounts a ON a.public_id = CASE WHEN s.host_id = ? THEN s.peer_id ELSE s.host_id END LEFT JOIN call_names n ON n.call_id = s.id WHERE (s.host_id = ? OR s.peer_id = ?) AND NOT EXISTS (SELECT 1 FROM call_hidden h WHERE h.public_id = ? AND h.call_id = s.id) ORDER BY s.created_at DESC LIMIT 40").bind(me, me, me, me).all();
    const calls = ((listed && listed.results) || []).map((row) => {
      const item = viewCall(row);
      item.handle = String(row.other_handle || "");
      item.name = String(row.other_name || "");
      item.incoming = row.kind === "link" ? row.host_id === me : row.host_id !== me;
      item.missed = row.state === "missed" || (row.state === "ended" && !row.answered_at && (row.kind === "link" ? row.host_id : row.peer_id) === who.account.public_id);
      item.duration = row.answered_at && row.ended_at ? Math.max(0, row.ended_at - row.answered_at) : 0;
      return item;
    });
    return deps.json(200, { calls: calls });
  }

  /* Editing your call history only hides rows for you. The other person's history and the call itself stay. */
  if ((path === "/v1/calls/history/hide" || path === "/v1/calls/history/unhide" || path === "/v1/calls/history/clear") && request.method === "POST") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const me = who.account.public_id;
    const paced = await deps.rateHit(env, "callhist:" + me, 60, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 8000);
    if (body && body.error) return deps.json(400, { error: body.error });
    if (path === "/v1/calls/history/clear") {
      const mine = await env.DB.prepare("SELECT s.id FROM call_sessions s WHERE (s.host_id = ? OR s.peer_id = ?) AND NOT EXISTS (SELECT 1 FROM call_hidden h WHERE h.public_id = ? AND h.call_id = s.id) ORDER BY s.created_at DESC LIMIT 500").bind(me, me, me).all();
      const ids = ((mine && mine.results) || []).map((row) => String(row.id));
      const now = Date.now();
      for (const id of ids) await env.DB.prepare("INSERT OR IGNORE INTO call_hidden (public_id, call_id, hidden_at) VALUES (?, ?, ?)").bind(me, id, now).run();
      return deps.json(200, { ids: ids });
    }
    const wanted = (Array.isArray(body && body.ids) ? body.ids : []).map((id) => String(id || "")).filter((id) => /^[a-f0-9]{16,64}$/.test(id)).slice(0, 100);
    if (!wanted.length) return deps.json(400, { error: "ids" });
    const done = [];
    for (const id of wanted) {
      if (path === "/v1/calls/history/hide") {
        const owned = await env.DB.prepare("SELECT id FROM call_sessions WHERE id = ? AND (host_id = ? OR peer_id = ?)").bind(id, me, me).first();
        if (!owned) continue;
        await env.DB.prepare("INSERT OR IGNORE INTO call_hidden (public_id, call_id, hidden_at) VALUES (?, ?, ?)").bind(me, id, Date.now()).run();
      } else {
        await env.DB.prepare("DELETE FROM call_hidden WHERE public_id = ? AND call_id = ?").bind(me, id).run();
      }
      done.push(id);
    }
    return deps.json(200, { ids: done });
  }

  if (path === "/v1/calls/incoming" && request.method === "GET") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const listed = await env.DB.prepare("SELECT * FROM call_sessions WHERE ((peer_id = ? AND kind != 'link') OR (host_id = ? AND kind = 'link')) AND state = 'ringing' AND expires_at > ? ORDER BY created_at DESC LIMIT 5").bind(who.account.public_id, who.account.public_id, Date.now()).all();
    return deps.json(200, { calls: ((listed && listed.results) || []).map(viewCall) });
  }

  if (path === "/v1/calls" && request.method === "POST") {
    const who = await member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
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
      return deps.json(201, { call: viewCall(await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first()), invite: invite, ticket: ticket.ticket, expiresAt: now + ttl, iceServers: await callIceServers(env), video: false });
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
    return deps.json(201, { call: { id: id, hostId: who.account.public_id, peerId: peer.public_id, kind: "direct", state: "ringing", video: false }, ticket: ticket.ticket, iceServers: await callIceServers(env), video: false });
  }

  const linkRoute = path.match(/^\/v1\/calls\/link(?:\/([a-z0-9-]{3,30})(\/join)?|\/(regenerate))?$/);
  if (linkRoute) {
    const regen = linkRoute[1] === "regenerate" && !linkRoute[2];
    const slug = regen ? "" : (linkRoute[1] || "");
    const joining = !!linkRoute[2];
    const ip = String(request.headers.get("CF-Connecting-IP") || "0");
    /* Manage my own link. */
    if (!slug) {
      const who = await member(env, request, deps);
      if (!who.account) return deps.json(401, { error: "unauthorized" });
      const id = who.account.public_id;
      const mine = await env.DB.prepare("SELECT * FROM call_links WHERE public_id = ?").bind(id).first();
      if (request.method === "GET") return deps.json(200, { link: viewLink(mine) });
      if (request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM call_links WHERE public_id = ?").bind(id).run();
        return deps.json(200, { link: null });
      }
      if ((request.method === "PUT" && !regen) || (request.method === "POST" && regen)) {
        const paced = await deps.rateHit(env, "linkedit:" + id, 20, 60 * 60 * 1000);
        if (!paced.ok) return deps.limited(paced);
        const body = regen ? {} : await deps.readJson(request, 1000);
        const wanted = String((body && body.slug) || "").trim().toLowerCase();
        const enabled = body && typeof body.enabled === "boolean" ? (body.enabled ? 1 : 0) : (mine ? Number(mine.enabled) : 1);
        let next = mine ? mine.slug : "";
        if (wanted) {
          if (!SLUG.test(wanted) || RESERVED_SLUGS.has(wanted) || /--/.test(wanted) || wanted.endsWith("-")) return deps.json(400, { error: "bad_slug" });
          next = wanted;
        } else if (regen || !next) next = randomSlug();
        const taken = await env.DB.prepare("SELECT public_id FROM call_links WHERE slug = ?").bind(next).first();
        if (taken && taken.public_id !== id) return deps.json(409, { error: "slug_taken" });
        const now = Date.now();
        await env.DB.prepare("DELETE FROM call_links WHERE public_id = ?").bind(id).run();
        await env.DB.prepare("INSERT INTO call_links (slug, public_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(next, id, enabled, mine && next === mine.slug ? Number(mine.created_at) : now, now).run();
        return deps.json(200, { link: viewLink(await env.DB.prepare("SELECT * FROM call_links WHERE slug = ?").bind(next).first()) });
      }
      return deps.json(405, { error: "method" });
    }
    /* Anyone may read whether a link is open. Only the name is shown. */
    const row = await env.DB.prepare("SELECT l.slug, l.public_id, l.enabled, a.display_name AS name FROM call_links l LEFT JOIN accounts a ON a.public_id = l.public_id WHERE l.slug = ?").bind(slug).first();
    if (!joining && request.method === "GET") {
      const paced = await deps.rateHit(env, "linkinfo:" + ip, 120, 60 * 60 * 1000);
      if (!paced.ok) return deps.limited(paced);
      if (!row || Number(row.enabled) !== 1) return deps.json(404, { error: "not_found" });
      const prefs = await loadPrefs(env, row.public_id);
      const open = prefs.guests && prefs.who === "everyone" && !dndActive(prefs, Date.now());
      return deps.json(200, { name: String(row.name || ""), open: open, reason: open ? "" : (prefs.dnd && dndActive(prefs, Date.now()) ? "quiet" : "closed") });
    }
    if (joining && request.method === "POST") {
      const paced = await deps.rateHit(env, "linkjoin:" + ip, 12, 60 * 60 * 1000);
      if (!paced.ok) return deps.limited(paced);
      const bySlug = await deps.rateHit(env, "linkslug:" + slug, 40, 60 * 60 * 1000);
      if (!bySlug.ok) return deps.limited(bySlug);
      const body = await deps.readJson(request, 2000);
      if (rejectsClone(body)) return deps.json(400, { error: "clone" });
      if (!row || Number(row.enabled) !== 1) return deps.json(404, { error: "not_found" });
      const owner = row.public_id;
      const prefs = await loadPrefs(env, owner);
      const visitor = await deps.sessionAccount(env, request);
      if (visitor && visitor.public_id === owner) return deps.json(403, { error: "calls_closed" });
      if (!prefs.guests && !visitor) return deps.json(403, { error: "guests" });
      if (visitor) {
        if (!(await callerMayCall(env, visitor.public_id, owner))) return deps.json(403, { error: "calls_closed" });
      } else {
        if (prefs.who !== "everyone") return deps.json(403, { error: "calls_closed" });
        if (dndActive(prefs, Date.now())) return deps.json(403, { error: "calls_closed" });
      }
      const now = Date.now();
      const id = hex(crypto.getRandomValues(new Uint8Array(16)));
      const peerId = visitor ? visitor.public_id : "g" + hex(crypto.getRandomValues(new Uint8Array(8)));
      const displayName = cleanName(body && body.name) || (visitor ? String(visitor.display_name || "") : "") || "Guest";
      await env.DB.prepare("INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, ?, 'link', 'ringing', ?, 0, 0, ?)").bind(id, owner, peerId, now, now + 60 * 1000).run();
      await env.DB.prepare("INSERT INTO call_names (call_id, name) VALUES (?, ?)").bind(id, displayName).run();
      let guestToken = "";
      if (!visitor) {
        guestToken = "cg1." + b64url(crypto.getRandomValues(new Uint8Array(18)));
        await env.DB.prepare("INSERT INTO call_guests (token_hash, call_id, guest_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(guestToken), id, peerId, now + 2 * 60 * 60 * 1000).run();
      }
      const ticket = await mintTicket(env, id, peerId, "guest");
      try { await publishToAccount(env, owner, "calls", { op: "ring", id: id, name: displayName, handle: visitor ? String(visitor.handle || "") : "", avatar: "", guest: !visitor }, id); } catch (err) { /* history still shows it */ }
      return deps.json(200, { call: { id: id, hostId: owner, peerId: peerId, kind: "link", state: "ringing", video: false }, guestId: peerId, guestToken: guestToken, name: displayName, ticket: ticket.ticket, iceServers: await callIceServers(env), ringing: true, video: false });
    }
    return deps.json(405, { error: "method" });
  }

  const join = path.match(/^\/v1\/calls\/join\/(ci1\.[A-Za-z0-9_-]{8,80})$/);
  if (join && request.method === "POST") {
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
    return deps.json(200, { call: viewCall(await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(row.id).first()), guestId: guestId, guestToken: guestToken, name: cleanName(body && body.name) || "Guest", ticket: ticket.ticket, iceServers: await callIceServers(env), video: false });
  }

  const one = path.match(/^\/v1\/calls\/([a-f0-9]{32})(\/answer|\/decline|\/end|\/ticket|\/translate|\/speak|\/preview|\/signal|\/return|\/state)?$/);
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
    const linkHost = row.kind === "link" && self === row.host_id;
    if (self !== row.peer_id && !linkHost) return deps.json(403, { error: "calls_closed" });
    if (row.state !== "ringing" && row.state !== "active") return deps.json(404, { error: "not_found" });
    const now = Date.now();
    await env.DB.prepare("UPDATE call_sessions SET state = 'active', answered_at = ? WHERE id = ?").bind(now, id).run();
    const ticket = await mintTicket(env, id, self, linkHost ? "host" : "guest");
    return deps.json(200, { call: viewCall(await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first()), ticket: ticket.ticket, iceServers: await callIceServers(env), video: false });
  }
  if (action === "/state" && request.method === "GET") {
    return deps.json(200, { state: row.state, answered: !!row.answered_at, ended: row.state === "ended" || row.state === "missed" });
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
    return deps.json(200, { ticket: ticket.ticket, iceServers: await callIceServers(env), video: false });
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
    const paced = await deps.rateHit(env, "calltok:" + self, 40, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 8000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "clone" });
    const target = normalizeLang(body.target);
    if (!target) return deps.json(400, { error: "lang" });
    const picked = await pickKey(env, row, who, self, body);
    if (!picked.key) return deps.json(200, { mode: "text", direct: false, reason: picked.source === "ringing" ? "ringing" : "nokey" });
    const minted = await geminiToken(env, picked.key, target, body.voice, lexiconHint(body.lexicon), body.source, typeof body.resume === "string" ? body.resume : "");
    minted.keySource = picked.source;
    Object.assign(minted, relayHint(request));
    if (minted.reason === "quota" || minted.mode === "text") return deps.json(200, minted);
    const packed = JSON.stringify(minted);
    if (packed.includes(picked.key)) return deps.json(500, { error: "unavailable" });
    return deps.json(200, minted);
  }
  if (action === "/preview" && request.method === "POST") {
    const paced = await deps.rateHit(env, "callprev:" + self, 90, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 8000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "clone" });
    const target = normalizeLang(body.target);
    const source = normalizeLang(body.source);
    if (!target) return deps.json(400, { error: "lang" });
    const text = String(body.text || "").trim().slice(0, 500);
    if (!text) return deps.json(400, { error: "text" });
    const picked = await pickKey(env, row, who, self, body);
    if (!picked.key) return deps.json(200, { text: text, translation: text, back: "", lang: target, reason: picked.source === "ringing" ? "ringing" : "nokey", untranslated: true });
    const hint = lexiconHint(body.lexicon);
    const said = await translateText(env, picked.key, text, target, hint);
    if (said.error === "quota") return deps.json(429, { error: "quota" });
    if (said.error === "badkey") return deps.json(200, { text: text, translation: text, back: "", lang: target, reason: "badkey", untranslated: true });
    let back = "";
    if (source && !said.untranslated && said.translation && said.translation !== text) {
      const again = await translateText(env, picked.key, said.translation, source, "");
      if (!again.error && !again.untranslated) back = String(again.translation || "").slice(0, 800);
    }
    return deps.json(200, { text: text, translation: said.translation, back: back, lang: target, untranslated: !!said.untranslated });
  }
  if (action === "/speak" && request.method === "POST") {
    const paced = await deps.rateHit(env, "callsay:" + self, 40, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 8000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "clone" });
    const target = normalizeLang(body.target);
    if (!target) return deps.json(400, { error: "lang" });
    const picked = await pickKey(env, row, who, self, body);
    if (!picked.key) return deps.json(200, { text: String(body.text || "").slice(0, 500), translation: String(body.text || "").slice(0, 500), lang: target, reason: picked.source === "ringing" ? "ringing" : "nokey", video: false });
    const said = await translateText(env, picked.key, body.text, target, lexiconHint(body.lexicon));
    if (said.error === "quota") return deps.json(429, { error: "quota" });
    if (said.error === "badkey") return deps.json(200, { text: String(body.text || "").slice(0, 500), translation: String(body.text || "").slice(0, 500), lang: target, reason: "badkey", video: false });
    said.voice = cleanVoice(body.voice);
    said.video = false;
    return deps.json(200, said);
  }
  return deps.json(404, { error: "not_found" });
}
