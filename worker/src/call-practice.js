/* Optional AI practice partner. A signed-in person starts a solo call
   from Calls home; after they speak or type, the Worker returns a short
   reply in the partner language, then the existing test-call path
   translates and speaks it. */

import { readFlags } from "./feature-flags.js";
import { practiceTalk, practiceGreet, PRACTICE_LIMIT } from "../../shared/call-practice.js";

export async function handleCallPractice(request, env, path, url, deps, h) {
  if (path !== "/v1/calls/practice") return null;
  const off = await readFlags(env);
  if (off.calls || off.calls_practice) {
    const read = request.method === "GET" || request.method === "HEAD";
    return new Response(null, { status: read ? 204 : 404, headers: { "x-feature-off": "1" } });
  }
  if (request.method !== "POST") return deps.json(405, { error: "method" });

  const who = await h.member(env, request, deps);
  if (!who.account && !(who.guest && who.guest.callId)) return deps.json(401, { error: "unauthorized" });
  const body = await deps.readJson(request, 8000);
  if (body.error) return deps.json(400, { error: "clone" });
  const id = String((body && body.id) || "");
  if (!/^[a-f0-9]{32}$/.test(id)) return deps.json(400, { error: "not_found" });
  const row = await env.DB.prepare("SELECT * FROM call_sessions WHERE id = ?").bind(id).first();
  if (!row) return deps.json(404, { error: "not_found" });
  const self = who.account ? who.account.public_id : who.guest.guestId;
  const inCall = (who.account && (self === row.host_id || self === row.peer_id)) || (who.guest && who.guest.callId === id);
  if (!inCall || row.kind !== "practice") return deps.json(403, { error: "calls_closed" });
  if (row.state !== "ringing" && row.state !== "active") return deps.json(404, { error: "not_found" });

  const paced = await deps.rateHit(env, "callpractice:" + (who.account ? who.account.public_id : who.guest.guestId), PRACTICE_LIMIT, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);

  const greet = body && body.greet === true;
  const heard = greet ? "" : String((body && body.text) || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!heard && !greet) return deps.json(400, { error: "text" });
  const lang = h.normalizeLang(body.lang) || "en";
  const turns = Array.isArray(body.turns) ? body.turns.slice(-6) : [];
  const prompt = greet ? practiceGreet(lang) : practiceTalk(heard, lang, turns, body.typed === true);
  const picked = await h.pickKey(env, row, who, self, body);
  if (!picked.key) return deps.json(200, { text: heard, reply: "", lang: lang, reason: picked.source === "ringing" ? "ringing" : "nokey" });
  const out = await h.generateText(env, picked.key, prompt);
  if (out && out.error === "quota") return deps.json(200, { text: heard, reply: "", lang: lang, reason: "quota" });
  if (out && out.error === "badkey") return deps.json(200, { text: heard, reply: "", lang: lang, reason: "badkey" });
  const reply = String((out && (out.translation || out.text)) || "").replace(/\s+/g, " ").trim().slice(0, 400);
  let voice = { audio: "", mime: "" };
  if (reply && body.voice === true && h.generateSpeech) voice = await h.generateSpeech(env, picked.key, reply);
  const packed = JSON.stringify({ reply: reply, lang: lang, reason: "" });
  if (picked.key && (packed.includes(picked.key) || voice.mime.includes(picked.key))) return deps.json(500, { error: "unavailable" });
  return deps.json(200, { text: heard, reply: reply, lang: lang, reason: reply ? "" : "unavailable", audio: voice.audio || "", audioMime: voice.audio ? voice.mime : "" });
}

export async function startPracticeSession(env, request, deps, h) {
  const off = await readFlags(env);
  if (off.calls_practice) return deps.json(404, { error: "not_found" });
  const who = await h.member(env, request, deps);
  if (!who.account) return deps.json(401, { error: "unauthorized" });
  const paced = await deps.rateHit(env, "callpracticeStart:" + who.account.public_id, 30, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const now = Date.now();
  const id = h.hex(crypto.getRandomValues(new Uint8Array(16)));
  const invite = "ci1." + h.b64url(crypto.getRandomValues(new Uint8Array(18)));
  await env.DB.prepare(
    "INSERT INTO call_sessions (id, host_id, peer_id, kind, state, created_at, answered_at, ended_at, expires_at) VALUES (?, ?, '', 'practice', 'ringing', ?, 0, 0, ?)"
  ).bind(id, who.account.public_id, now, now + 30 * 60 * 1000).run();
  await env.DB.prepare("INSERT INTO call_invites (token_hash, call_id, expires_at) VALUES (?, ?, ?)").bind(await h.sha256Hex(invite), id, now + 30 * 60 * 1000).run();
  const ticket = await h.mintTicket(env, id, who.account.public_id, "host");
  return deps.json(201, {
    call: { id: id, hostId: who.account.public_id, peerId: "", kind: "practice", state: "ringing", video: false },
    invite: invite,
    ticket: ticket.ticket,
    iceServers: await h.callIceServers(env, deps, { id: id, self: who.account.public_id, state: "ringing" }),
    practice: true,
    video: false
  });
}
