/* Owner-only voice notes. TELEGRAM_VOICE_BOT_TOKEN is used when set;
   otherwise TELEGRAM_BOT_TOKEN. Each bot has its own chats and update cursor.
   The token is never returned. */

const MAX_BYTES = 20 * 1024 * 1024;
const CAPTION_MAX = 1024;
const SEND_LIMIT = 20;
const SEND_WINDOW = 60 * 60 * 1000;
const SYNC_LIMIT = 6;
const LIST_LIMIT = 60;
const LIST_WINDOW = 10 * 60 * 1000;
const HOOK_LIMIT = 120;

let schemaReady = null;

function maxBytes(env) {
  const set = Number(env && env.TELEGRAM_VOICE_MAX_BYTES);
  if (set > 0 && set < MAX_BYTES) return set;
  return MAX_BYTES;
}

export function resetVoiceSchema() {
  schemaReady = null;
}

export function activeBot(env) {
  const voice = String(env && env.TELEGRAM_VOICE_BOT_TOKEN || "").trim();
  const main = String(env && env.TELEGRAM_BOT_TOKEN || "").trim();
  if (voice) return { token: voice, kind: "voice" };
  if (main) return { token: main, kind: "main" };
  return { token: "", kind: "" };
}

export async function botScope(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("viktorych-voice-bot:" + token));
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensureSchema(env) {
  if (!env || !env.DB) return;
  if (!schemaReady) {
    schemaReady = env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_voice_chats (bot_scope TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unavailable INTEGER NOT NULL DEFAULT 0, last_sent_at INTEGER NOT NULL DEFAULT 0, owner_chat INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bot_scope, chat_id))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_voice_state (bot_scope TEXT PRIMARY KEY, update_offset INTEGER NOT NULL DEFAULT 0, bot_username TEXT NOT NULL DEFAULT '')"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS telegram_voice_invites (bot_scope TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', self INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bot_scope, code))")
    ]).catch((err) => { schemaReady = null; throw err; });
  }
  await schemaReady;
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function chatIdOk(value) {
  return /^-?\d{1,20}$/.test(String(value || ""));
}

export function personFromChat(chat) {
  if (!chat || chat.type !== "private" || !chatIdOk(chat.id)) return null;
  const name = cleanText((cleanText(chat.first_name, 64) + " " + cleanText(chat.last_name, 64)).trim(), 128);
  const username = cleanText(String(chat.username || "").replace(/^@/, ""), 32).replace(/[^\w]/g, "");
  return { id: String(chat.id), name, username };
}

export function isOpusVoice(bytes) {
  if (!bytes || bytes.length < 48) return false;
  if (bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) return false;
  const limit = Math.min(bytes.length, 8192);
  const mark = [79, 112, 117, 115, 72, 101, 97, 100];
  for (let i = 0; i + 19 < limit; i += 1) {
    let found = true;
    for (let j = 0; j < 8; j += 1) if (bytes[i + j] !== mark[j]) { found = false; break; }
    if (!found) continue;
    const channels = bytes[i + 9];
    const rate = bytes[i + 12] | (bytes[i + 13] << 8) | (bytes[i + 14] << 16) | (bytes[i + 15] << 24);
    return channels === 1 && rate === 48000;
  }
  return false;
}

function apiUrl(token, method) {
  return "https://api.telegram.org/bot" + token + "/" + method;
}

async function readTelegram(res) {
  try { return await res.json(); }
  catch (err) { return null; }
}

async function upsertChat(env, scope, person, unavailable, started, ownerChat) {
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT started_at FROM telegram_voice_chats WHERE bot_scope = ? AND chat_id = ?").bind(scope, person.id).first();
  if (!existing && !started && !unavailable) return;
  const startedAt = existing ? Number(existing.started_at) || now : now;
  await env.DB.prepare("INSERT INTO telegram_voice_chats (bot_scope, chat_id, name, username, started_at, updated_at, unavailable, last_sent_at, owner_chat) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(bot_scope, chat_id) DO UPDATE SET name = excluded.name, username = excluded.username, updated_at = excluded.updated_at, unavailable = excluded.unavailable, owner_chat = CASE WHEN excluded.owner_chat = 1 THEN 1 ELSE telegram_voice_chats.owner_chat END")
    .bind(scope, person.id, person.name, person.username, startedAt, now, unavailable ? 1 : 0, ownerChat ? 1 : 0).run();
}

async function markInvite(env, scope, code, person) {
  if (!code) return false;
  const invite = await env.DB.prepare("SELECT self FROM telegram_voice_invites WHERE bot_scope = ? AND code = ?").bind(scope, code).first();
  if (!invite) return false;
  await env.DB.prepare("UPDATE telegram_voice_invites SET used_at = ? WHERE bot_scope = ? AND code = ?").bind(Date.now(), scope, code).run();
  if (Number(invite.self) === 1) {
    await env.DB.prepare("UPDATE telegram_voice_chats SET owner_chat = 0 WHERE bot_scope = ?").bind(scope).run();
    await upsertChat(env, scope, person, false, true, true);
  }
  return true;
}

export async function ingestUpdate(env, scope, update) {
  if (!update || typeof update !== "object") return false;
  const member = update.my_chat_member;
  if (member && member.chat && member.new_chat_member) {
    const person = personFromChat(member.chat);
    if (!person) return false;
    const status = String(member.new_chat_member.status || "");
    const gone = status === "kicked" || status === "left";
    await upsertChat(env, scope, person, gone, !gone, false);
    return true;
  }
  const msg = update.message;
  if (!msg || !msg.chat) return false;
  const person = personFromChat(msg.chat);
  if (!person) return false;
  const text = String(msg.text || "");
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
  if (!start) return false;
  await upsertChat(env, scope, person, false, true, false);
  await markInvite(env, scope, start[1] || "", person);
  return true;
}

async function username(env, fetchImpl, token, scope) {
  const row = await env.DB.prepare("SELECT bot_username FROM telegram_voice_state WHERE bot_scope = ?").bind(scope).first();
  if (row && /^[A-Za-z0-9_]{4,32}$/.test(String(row.bot_username || ""))) return String(row.bot_username);
  const res = await fetchImpl(apiUrl(token, "getMe"), { method: "GET" });
  const body = await readTelegram(res);
  const name = body && body.ok && body.result && String(body.result.username || "");
  if (!/^[A-Za-z0-9_]{4,32}$/.test(name)) return "";
  await env.DB.prepare("INSERT INTO telegram_voice_state (bot_scope, update_offset, bot_username) VALUES (?, 0, ?) ON CONFLICT(bot_scope) DO UPDATE SET bot_username = excluded.bot_username").bind(scope, name).run();
  return name;
}

async function ownerChat(env, scope) {
  const secret = String(env.TELEGRAM_OWNER_CHAT_ID || "").trim();
  if (chatIdOk(secret)) return secret;
  const row = await env.DB.prepare("SELECT chat_id FROM telegram_voice_chats WHERE bot_scope = ? AND owner_chat = 1 LIMIT 1").bind(scope).first();
  return row ? String(row.chat_id) : "";
}

function blockedText(description) {
  return /blocked|kicked|deactivated|chat not found|bot was blocked/i.test(String(description || ""));
}

async function sendVoice(env, fetchImpl, token, scope, chatId, bytes, duration, caption) {
  const form = new FormData();
  form.set("chat_id", chatId);
  if (duration > 0) form.set("duration", String(duration));
  if (caption) form.set("caption", caption);
  form.set("voice", new Blob([bytes], { type: "audio/ogg" }), "voice.ogg");
  const res = await fetchImpl(apiUrl(token, "sendVoice"), { method: "POST", body: form });
  const body = await readTelegram(res);
  if (res.status === 403 || (body && blockedText(body.description))) {
    await env.DB.prepare("UPDATE telegram_voice_chats SET unavailable = 1, updated_at = ? WHERE bot_scope = ? AND chat_id = ?").bind(Date.now(), scope, chatId).run();
    return { status: 403, error: "blocked" };
  }
  if (!res.ok || !body || body.ok !== true) return { status: 502, error: "telegram_failed" };
  await env.DB.prepare("UPDATE telegram_voice_chats SET last_sent_at = ?, unavailable = 0 WHERE bot_scope = ? AND chat_id = ?").bind(Date.now(), scope, chatId).run();
  return { status: 200, ok: true };
}

function hookBot(env, header) {
  const voice = String(env.TELEGRAM_VOICE_BOT_TOKEN || "").trim();
  const main = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const voiceSecret = String(env.TELEGRAM_VOICE_WEBHOOK_SECRET || "").trim();
  const mainSecret = String(env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  if (voice && voiceSecret && header === voiceSecret) return { token: voice, kind: "voice" };
  if (main && mainSecret && header === mainSecret) return { token: main, kind: "main" };
  if ((voiceSecret || mainSecret) && header === (voiceSecret || mainSecret)) {
    const active = activeBot(env);
    return active.token ? active : null;
  }
  return null;
}

export async function handleTelegramVoice(request, env, path, deps) {
  const json = deps.json;
  if (!env || !env.DB) return json(503, { error: "not_configured" });
  await ensureSchema(env);
  const fetchImpl = typeof deps.fetch === "function" ? deps.fetch : fetch;

  if (path === "/tg/voice-hook" && request.method === "POST") {
    const chosen = hookBot(env, request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "");
    if (!chosen) return json(401, { error: "unauthorized" });
    const hit = await deps.rateHit(env, "tgvoice:hook", HOOK_LIMIT, LIST_WINDOW);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 65536);
    if (body && body.error) return json(400, { error: "bad_update" });
    const scope = await botScope(chosen.token);
    await ingestUpdate(env, scope, body || {});
    return json(200, { ok: true });
  }

  const gate = await deps.requireOwner(request, env);
  if (gate.error) return gate.error;
  const ownerId = String(gate.row.public_id || "owner");
  const bot = activeBot(env);

  if ((path === "/v1/owner/telegram-voice" || path === "/tg/voice") && request.method === "GET") {
    if (!bot.token) return json(200, { configured: false, bot: "", ownerReady: false, botKind: "" });
    const scope = await botScope(bot.token);
    const name = await username(env, fetchImpl, bot.token, scope);
    const ready = !!(await ownerChat(env, scope));
    return json(200, { configured: true, bot: name, ownerReady: ready, botKind: bot.kind });
  }

  if (!bot.token) return json(503, { error: "not_configured" });
  const scope = await botScope(bot.token);

  if (path === "/v1/owner/telegram-voice/chats" && request.method === "GET") {
    const hit = await deps.rateHit(env, "tgvoice:list:" + ownerId, LIST_LIMIT, LIST_WINDOW);
    if (!hit.ok) return deps.limited(hit);
    const q = cleanText(new URL(request.url).searchParams.get("q") || "", 64).replace(/[\\%_]/g, "");
    const rows = q
      ? await env.DB.prepare("SELECT chat_id, name, username, started_at, unavailable, last_sent_at FROM telegram_voice_chats WHERE bot_scope = ? AND (name LIKE ? OR username LIKE ?) ORDER BY last_sent_at DESC, updated_at DESC LIMIT 40").bind(scope, "%" + q + "%", "%" + q + "%").all()
      : await env.DB.prepare("SELECT chat_id, name, username, started_at, unavailable, last_sent_at FROM telegram_voice_chats WHERE bot_scope = ? ORDER BY last_sent_at DESC, updated_at DESC LIMIT 40").bind(scope).all();
    const chats = ((rows && rows.results) || []).map((row) => ({
      id: String(row.chat_id),
      name: String(row.name || ""),
      username: String(row.username || ""),
      startedAt: Number(row.started_at) || 0,
      lastSentAt: Number(row.last_sent_at) || 0,
      unavailable: Number(row.unavailable) === 1
    }));
    return json(200, { configured: true, chats });
  }

  if (path === "/v1/owner/telegram-voice/invite" && request.method === "POST") {
    const hit = await deps.rateHit(env, "tgvoice:invite:" + ownerId, SEND_LIMIT, SEND_WINDOW);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 1000);
    const name = await username(env, fetchImpl, bot.token, scope);
    if (!name) return json(503, { error: "not_configured" });
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
    const self = body && body.self === true ? 1 : 0;
    await env.DB.prepare("INSERT INTO telegram_voice_invites (bot_scope, code, label, self, created_at, used_at) VALUES (?, ?, ?, ?, ?, 0)").bind(scope, code, cleanText(body && body.label, 40), self, Date.now()).run();
    return json(200, { url: "https://t.me/" + name + "?start=" + code, bot: name, code });
  }

  if (path === "/tg/voice" && request.method === "POST") {
    const hit = await deps.rateHit(env, "tgvoice:send:" + ownerId, SEND_LIMIT, SEND_WINDOW);
    if (!hit.ok) return deps.limited(hit);
    let form;
    try { form = await request.formData(); }
    catch (err) { return json(400, { error: "bad_audio" }); }
    let chatId = String(form.get("chat_id") || "");
    let forward = false;
    if (chatId === "owner") {
      forward = true;
      chatId = await ownerChat(env, scope);
      if (!chatId) return json(409, { error: "no_owner_chat", bot: await username(env, fetchImpl, bot.token, scope) });
    } else if (!chatIdOk(chatId)) return json(400, { error: "bad_chat" });
    const row = await env.DB.prepare("SELECT unavailable FROM telegram_voice_chats WHERE bot_scope = ? AND chat_id = ?").bind(scope, chatId).first();
    if (!row && !forward) return json(404, { error: "bad_chat" });
    if (row && Number(row.unavailable) === 1) return json(403, { error: "blocked" });
    const file = form.get("file") || form.get("voice");
    if (!file || typeof file.arrayBuffer !== "function") return json(400, { error: "bad_audio" });
    if (Number(file.size) > maxBytes(env)) return json(413, { error: "too_large" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > maxBytes(env) || !isOpusVoice(bytes)) return json(400, { error: "bad_audio" });
    const duration = Math.round(Number(form.get("duration")) || 0);
    const caption = cleanText(form.get("caption") || "", CAPTION_MAX);
    const sent = await sendVoice(env, fetchImpl, bot.token, scope, chatId, bytes, duration > 0 && duration <= 86400 ? duration : 0, caption);
    if (!sent.ok) return json(sent.status, { error: sent.error });
    const name = forward ? await username(env, fetchImpl, bot.token, scope) : "";
    return json(200, forward ? { ok: true, forward: true, bot: name } : { ok: true });
  }

  return json(405, { error: "method" });
}
