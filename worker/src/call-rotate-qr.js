/* Rotating QR invites. A fresh cr1. token every two minutes. Scanning
   it starts a call that rings the host like an incoming call. */

import { readFlags } from "./feature-flags.js";
import { publishToAccount } from "./channel.js";
import { emitNotification } from "./notifications.js";
import { ROTATE_TOKEN, ROTATE_MS, ROTATE_REFRESH_MS } from "../../shared/call-rotate-qr.js";
import { dndActive } from "../../shared/call-privacy.js";
import { rejectsClone } from "../../shared/call-setup.js";

export const CALL_ROTATE_QR_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_rotate_qr (
    token_hash TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_call_rotate_qr_owner ON call_rotate_qr(public_id, expires_at)`
];

async function latestToken(env, publicId, now) {
  return env.DB.prepare(
    "SELECT * FROM call_rotate_qr WHERE public_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
  ).bind(publicId, now).first();
}

async function issueToken(env, h, publicId, now) {
  const token = "cr1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
  const expires = now + ROTATE_MS;
  await env.DB.prepare(
    "INSERT INTO call_rotate_qr (token_hash, public_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(await h.sha256Hex(token), publicId, token, expires, now).run();
  await env.DB.prepare("DELETE FROM call_rotate_qr WHERE public_id = ? AND expires_at <= ?").bind(publicId, now).run();
  return { token: token, expiresAt: expires };
}

async function currentToken(env, h, publicId) {
  const now = Date.now();
  const row = await latestToken(env, publicId, now);
  if (row && Number(row.expires_at) - now > ROTATE_REFRESH_MS) {
    return { token: row.token, expiresAt: Number(row.expires_at) };
  }
  return issueToken(env, h, publicId, now);
}

async function ownerOfToken(env, h, token) {
  if (!ROTATE_TOKEN.test(token)) return null;
  const row = await env.DB.prepare("SELECT * FROM call_rotate_qr WHERE token_hash = ?").bind(await h.sha256Hex(token)).first();
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  return row;
}

export async function handleCallRotateQr(request, env, path, url, deps, h) {
  if (!path.startsWith("/v1/calls/qr")) return null;
  const off = await readFlags(env);
  if (off.calls || off.calls_rotate_qr) {
    const read = request.method === "GET" || request.method === "HEAD";
    return new Response(null, { status: read ? 204 : 404, headers: { "x-feature-off": "1" } });
  }

  if ((path === "/v1/calls/qr" || path === "/v1/calls/qr/rotate") && (request.method === "GET" || request.method === "POST")) {
    const who = await h.member(env, request, deps);
    if (!who.account) return deps.json(401, { error: "unauthorized" });
    const paced = await deps.rateHit(env, "callqr:" + who.account.public_id, 40, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const force = request.method === "POST" || path.endsWith("/rotate");
    const now = Date.now();
    const issued = force ? await issueToken(env, h, who.account.public_id, now) : await currentToken(env, h, who.account.public_id);
    return deps.json(force ? 201 : 200, { token: issued.token, expiresAt: issued.expiresAt, rotateMs: ROTATE_MS });
  }

  if (path === "/v1/calls/qr/info" && request.method === "GET") {
    const ip = String(request.headers.get("CF-Connecting-IP") || "0");
    const paced = await deps.rateHit(env, "callqrinfo:" + ip, 120, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const token = String(url.searchParams.get("token") || "");
    const saved = await ownerOfToken(env, h, token);
    if (!saved) return deps.json(404, { error: "not_found" });
    const owner = await env.DB.prepare("SELECT public_id, display_name, handle FROM accounts WHERE public_id = ?").bind(saved.public_id).first();
    if (!owner) return deps.json(404, { error: "not_found" });
    const prefs = await h.loadPrefs(env, owner.public_id);
    const open = prefs.guests && prefs.who === "everyone" && !dndActive(prefs, Date.now());
    return deps.json(200, { name: String(owner.display_name || ""), handle: String(owner.handle || ""), open: open, reason: open ? "" : (prefs.dnd && dndActive(prefs, Date.now()) ? "quiet" : "closed") });
  }

  const join = path.match(/^\/v1\/calls\/qr\/join$/);
  if (join && request.method === "POST") {
    const ip = String(request.headers.get("CF-Connecting-IP") || "0");
    const paced = await deps.rateHit(env, "callqrjoin:" + ip, 20, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 2000);
    if (body.error || rejectsClone(body)) return deps.json(400, { error: "clone" });
    const token = String((body && body.token) || url.searchParams.get("token") || "");
    const saved = await ownerOfToken(env, h, token);
    if (!saved) return deps.json(404, { error: "not_found" });
    const owner = saved.public_id;
    const prefs = await h.loadPrefs(env, owner);
    const visitor = await deps.sessionAccount(env, request);
    if (visitor && visitor.public_id === owner) return deps.json(403, { error: "calls_closed" });
    if (!prefs.guests && !visitor) return deps.json(403, { error: "guests" });
    if (visitor) {
      if (!(await h.callerMayCall(env, visitor.public_id, owner))) return deps.json(403, { error: "calls_closed" });
    } else {
      if (prefs.who !== "everyone") return deps.json(403, { error: "calls_closed" });
      if (dndActive(prefs, Date.now())) return deps.json(403, { error: "calls_closed" });
    }
    const now = Date.now();
    const id = h.hex(crypto.getRandomValues(new Uint8Array(16)));
    const peerId = visitor ? visitor.public_id : "g" + h.hex(crypto.getRandomValues(new Uint8Array(8)));
    const displayName = h.cleanName(body && body.name) || (visitor ? String(visitor.display_name || "") : "") || "Guest";
    await env.DB.prepare(
      "INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, ?, 'qr', 'ringing', ?, 0, 0, ?)"
    ).bind(id, owner, peerId, now, now + 60 * 1000).run();
    await env.DB.prepare("INSERT INTO call_names (call_id, name) VALUES (?, ?)").bind(id, displayName).run();
    let guestToken = "";
    if (!visitor) {
      guestToken = "cg1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
      await env.DB.prepare("INSERT INTO call_guests (token_hash, call_id, guest_id, expires_at) VALUES (?, ?, ?, ?)").bind(await h.sha256Hex(guestToken), id, peerId, now + 2 * 60 * 60 * 1000).run();
    }
    const ticket = await h.mintTicket(env, id, peerId, "guest");
    try { await publishToAccount(env, owner, "calls", { op: "ring", id: id, name: displayName, handle: visitor ? String(visitor.handle || "") : "", avatar: "", guest: !visitor }, id); } catch (err) { /* history still shows it */ }
    try {
      await emitNotification(env, {
        publicId: owner,
        kind: "call",
        subject: visitor ? visitor.public_id : owner,
        idempotencyKey: "call:" + id,
        actorId: visitor ? visitor.public_id : owner,
        name: displayName,
        handle: visitor ? String(visitor.handle || "") : "",
        hash: "#/calls/" + id,
        platform: "app"
      });
    } catch (err) { /* ringing still works in the open app */ }
    return deps.json(200, {
      call: { id: id, hostId: owner, peerId: peerId, kind: "qr", state: "ringing", video: false },
      guestId: peerId,
      guestToken: guestToken,
      name: displayName,
      ticket: ticket.ticket,
      iceServers: await h.callIceServers(env, deps, { id: id, self: peerId, state: "ringing" }),
      ringing: true,
      video: false
    });
  }

  return deps.json(404, { error: "not_found" });
}
