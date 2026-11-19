import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const sent = [];

function opusBytes() {
  const bytes = new Uint8Array(64);
  bytes.set([0x4f, 0x67, 0x67, 0x53], 0);
  const at = 28;
  bytes.set([79, 112, 117, 115, 72, 101, 97, 100], at);
  bytes[at + 9] = 1;
  const rate = 48000;
  bytes[at + 12] = rate & 255;
  bytes[at + 13] = (rate >> 8) & 255;
  bytes[at + 14] = (rate >> 16) & 255;
  bytes[at + 15] = (rate >> 24) & 255;
  return bytes;
}

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "owner_test",
      ALLOWED_ORIGINS: "https://example.com",
      PBKDF2_ITERATIONS: "1000",
      TELEGRAM_BOT_TOKEN: "main-test-token",
      TELEGRAM_WEBHOOK_SECRET: "main-hook-secret",
      TELEGRAM_VOICE_BOT_TOKEN: "voice-test-token",
      TELEGRAM_VOICE_WEBHOOK_SECRET: "voice-hook-secret"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      sent.push(url.pathname);
      if (url.pathname.endsWith("/getMe")) {
        const voice = url.pathname.includes("voice-test-token");
        return new Response(JSON.stringify({ ok: true, result: { username: voice ? "VoiceHelperBot" : "MainHelperBot" } }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/sendVoice")) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
      }
      return new Response("no", { status: 404 });
    }
  };
}

let mf;
function multipart(fields, file) {
  const boundary = "voicebound";
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + value + "\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + file.name + "\"\r\nContent-Type: " + file.type + "\r\n\r\n"));
  chunks.push(Buffer.from(file.bytes));
  chunks.push(Buffer.from("\r\n--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), type: "multipart/form-data; boundary=" + boundary };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.json) headers.set("content-type", "application/json");
  if (opts.multipart) headers.set("content-type", opts.multipart.type);
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.multipart ? opts.multipart.body : (opts.json ? JSON.stringify(opts.json) : opts.body)
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(buf)); } catch (err) { body = null; }
  return { status: res.status, body };
}

test.before(async () => { mf = new Miniflare(workerOptions()); });
test.after(async () => { if (mf) await mf.dispose(); });

test("voice notes stay on the voice bot, not the main bot", async () => {
  const owner = await call("/v1/signup", { method: "POST", ip: "203.0.113.81", json: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(owner.status, 201);
  const start = {
    update_id: 1,
    message: { message_id: 1, text: "/start", chat: { id: 4242, type: "private", first_name: "Ada", username: "ada_example" } }
  };
  const voiceHook = await call("/tg/voice-hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "voice-hook-secret" },
    json: start
  });
  assert.equal(voiceHook.status, 200, JSON.stringify(voiceHook.body));
  const mainHook = await call("/tg/voice-hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "main-hook-secret" },
    json: { update_id: 2, message: { message_id: 2, text: "/start", chat: { id: 7777, type: "private", first_name: "Bea", username: "bea_example" } } }
  });
  assert.equal(mainHook.status, 200);
  const status = await call("/v1/owner/telegram-voice", { token: owner.body.token });
  assert.equal(status.body.botKind, "voice");
  assert.equal(status.body.bot, "VoiceHelperBot");
  const chats = await call("/v1/owner/telegram-voice/chats", { token: owner.body.token });
  assert.deepEqual(chats.body.chats.map((row) => row.id), ["4242"]);
  const sentVoice = await call("/tg/voice", {
    method: "POST",
    token: owner.body.token,
    multipart: multipart({ chat_id: "4242" }, { name: "voice.ogg", type: "audio/ogg", bytes: opusBytes() })
  });
  assert.equal(sentVoice.status, 200, JSON.stringify(sentVoice.body));
  assert.equal(sentVoice.body.ok, true);
  assert.equal(JSON.stringify(sent).includes("voice-test-token"), true);
  assert.equal(JSON.stringify(sent).includes("main-test-token/sendVoice"), false);
});
