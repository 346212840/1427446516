import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const calls = [];

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
      FISH_AUDIO_API_KEY: "fish-test-key"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      calls.push(path);
      const auth = request.headers.get("authorization") || "";
      assert.equal(auth.startsWith("Bearer "), true);
      assert.equal(auth.endsWith("fish-test-key"), true);
      assert.equal(path.includes("/v1/tts") && request.method === "GET", false);
      if (path === "/model" && request.method === "GET") {
        assert.equal(url.searchParams.get("self"), "true");
        return new Response(JSON.stringify({
          total: 1,
          items: [{
            _id: "voice-model-1",
            type: "tts",
            title: "Example voice",
            state: "trained",
            tags: [],
            samples: [{ title: "Sample", text: "Hello", task_id: "t1", audio: "https://platform.fish.audio/sample.mp3" }],
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
            visibility: "private",
            like_count: 0,
            mark_count: 0,
            shared_count: 0,
            task_count: 0,
            author: { _id: "author-1", nickname: "hidden", avatar: "" }
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (path === "/v1/tts" && request.method === "POST") {
        const body = await request.json();
        assert.equal(body.reference_id, "voice-model-1");
        assert.equal(body.format, "opus");
        assert.equal(body.latency, "normal");
        assert.equal(body.prosody.speed, 1);
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/ogg" } });
      }
      return new Response("no", { status: 404 });
    }
  };
}

let mf;
async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(buf)); }
  catch (err) { body = null; }
  return { status: res.status, body, buf };
}

test.before(async () => { mf = new Miniflare(workerOptions()); });
test.after(async () => { if (mf) await mf.dispose(); });

test("voice previews are sample urls and only Generate calls TTS", async () => {
  const owner = await call("/v1/signup", { method: "POST", ip: "203.0.113.70", body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(owner.status, 201);
  const on = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "fish_audio", off: false } });
  assert.equal(on.status, 200);
  calls.length = 0;
  const voices = await call("/v1/owner/fish/voices", { token: owner.body.token });
  assert.equal(voices.status, 200);
  assert.equal(voices.body.voices[0].previewUrl, "https://platform.fish.audio/sample.mp3");
  assert.equal(voices.body.voices[0].title, "Example voice");
  assert.equal(JSON.stringify(voices.body).includes("hidden"), false);
  assert.equal(calls.some((path) => path === "/v1/tts"), false);
  assert.ok(calls.every((path) => path === "/model"));
  const tts = await call("/v1/owner/fish/tts", {
    method: "POST",
    token: owner.body.token,
    body: { text: "Hello there", referenceId: "voice-model-1", format: "opus", speed: 1, latency: "normal" }
  });
  assert.equal(tts.status, 200);
  assert.equal(tts.buf.length, 4);
  assert.ok(calls.includes("/v1/tts"));
});
