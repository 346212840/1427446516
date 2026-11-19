import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const ORIGIN = "https://viktorychgroup.github.io";
let mf;

function workerOptions(extra) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    durableObjects: { ACCOUNT_CHANNEL: { className: "AccountChannel", useSQLite: true } },
    bindings: Object.assign({
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "owner_test",
      ALLOWED_ORIGINS: ORIGIN,
      PBKDF2_ITERATIONS: "1000"
    }, extra || {})
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.40");
  headers.set("Origin", ORIGIN);
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.guest) headers.set("x-call-guest", opts.guest);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function signup(n, name, handle) {
  const res = await call("/v1/signup", { method: "POST", ip: "203.0.113." + n, body: { displayName: name, handle: handle } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test.before(async () => {
  mf = new Miniflare(workerOptions({ GEMINI_API_KEY: "test-key" }));
});
test.after(async () => {
  if (mf) await mf.dispose();
});

test("calls stay off until the owner turns them on, then privacy is enforced", async () => {
  const owner = await call("/v1/signup", { method: "POST", ip: "203.0.113.21", body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  const ada = await signup(22, "Ada Example", "ada_example");
  const bea = await signup(23, "Bea Example", "bea_example");
  assert.equal((await call("/v1/calls/status")).status, 204);
  const on = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "calls", off: false } });
  assert.equal(on.status, 200);
  const status = await call("/v1/calls/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.video, false);
  assert.equal(status.body.languages.includes("ca"), true);
  assert.equal(status.body.languages.includes("sv"), true);
  assert.equal(JSON.stringify(status.body).includes("test-key"), false);

  const closed = await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { who: "nobody", dnd: false, guests: false } });
  assert.equal(closed.status, 200);
  const denied = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(denied.status, 403);

  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { who: "everyone", guests: true } });
  await call("/v1/blocks", { method: "POST", token: bea.token, body: { accountId: ada.account.publicId } });
  const blocked = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(blocked.status, 403);
  await call("/v1/blocks", { method: "DELETE", token: bea.token, body: { accountId: ada.account.publicId } });

  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { dnd: true, dndStart: "00:00", dndEnd: "23:59", tz: 0 } });
  const quiet = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(quiet.status, 403);
  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { dnd: false, who: "everyone", guests: true } });

  const created = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.video, false);
  assert.equal(created.body.call.peerId, bea.account.publicId);

  const minted = await call("/v1/calls/" + created.body.call.id + "/translate", {
    method: "POST",
    token: ada.token,
    body: { target: "sv", source: "en", voice: "Leda", lexicon: [{ word: "Nova", say: "NO-vah" }] }
  });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(minted.body.mode, "token");
  assert.equal(minted.body.direct, true);
  assert.ok(String(minted.body.url).includes("access_token="));
  assert.equal(String(minted.body.url).includes("key="), false);
  assert.equal(JSON.stringify(minted.body).includes("test-key"), false);
  assert.equal(minted.body.setup.generationConfig.translationConfig.targetLanguageCode, "sv");
  assert.ok(minted.body.setup.systemInstruction.parts[0].text.includes("Speaker language: en."));
  assert.ok(minted.body.setup.contextWindowCompression);

  const invite = await call("/v1/calls", { method: "POST", token: ada.token, body: { invite: true } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const guest = await call("/v1/calls/join/" + invite.body.invite, { method: "POST", body: { name: "Guest" } });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  assert.ok(guest.body.guestToken);
  assert.equal(guest.body.video, false);
  const again = await call("/v1/calls/" + invite.body.call.id + "/speak", {
    method: "POST",
    guest: guest.body.guestToken,
    body: { text: "Hold on", target: "es" }
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.video, false);
});
