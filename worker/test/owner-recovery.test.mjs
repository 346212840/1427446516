import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

let mf;
let ipN = 40;

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
      OWNER_HANDLE: "ownertest",
      OWNER_RECOVERY_CODE: "TESTOWNERRECOVERY2345ABCDEFGH",
      ALLOWED_ORIGINS: "https://346212840.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      SIGNUP_GUARD: "on"
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || ("203.0.113." + (ipN++)));
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body && !opts.raw) headers.set("content-type", "application/json");
  if (opts.type) headers.set("content-type", opts.type);
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.raw || (opts.body ? JSON.stringify(opts.body) : undefined)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: true }; }
  return { status: res.status, body, bytes: new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0))) };
}

async function callBytes(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || ("203.0.113." + (ipN++)));
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.type) headers.set("content-type", opts.type);
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.raw
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, bytes, type: res.headers.get("content-type") || "" };
}

function zeroBits(bytes) {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0) { count += 8; continue; }
    for (let bit = 7; bit >= 0; bit--) {
      if ((byte >> bit) & 1) return count;
      count += 1;
    }
  }
  return count;
}

async function solve(ch) {
  const enc = new TextEncoder();
  const bits = Number(ch.bits) || 12;
  for (let n = 0; n < 3000000; n++) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(ch.id + ":" + ch.nonce + ":" + n)));
    if (zeroBits(digest) >= bits) return { id: ch.id, counter: n };
  }
  throw new Error("pow");
}

async function challenge() {
  const res = await call("/v1/signup/challenge");
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.id, "string");
  return res.body;
}

async function signup(handle, name, extra) {
  const ch = await challenge();
  const pow = await solve(ch);
  const started = Date.now();
  const wait = Math.max(0, 1100 - (Date.now() - started));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const res = await call("/v1/signup", {
    method: "POST",
    body: Object.assign({ displayName: name, handle: handle, pow: pow, fax: "" }, extra || {})
  });
  assert.equal(res.status, 201);
  return res.body;
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});


test("owner recovery: the Worker secret signs in to the owner once, then never again", async () => {
  const none = await call("/v1/recovery/owner", { method: "POST", body: { code: "TESTOWNERRECOVERY2345ABCDEFGH" } });
  assert.equal(none.status, 401, "no owner account yet");
  const owner = await signup("ownertest", "Owner Reader", { claimCode: "claim-test" });
  const member = await signup("memberreader", "Member Reader");
  const wrong = await call("/v1/recovery/owner", { method: "POST", body: { code: "WRONGOWNERRECOVERY2345ABCDEFG" } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, "recovery_invalid");
  const ok = await call("/v1/recovery/owner", { method: "POST", body: { code: "testownerrecovery 2345abcdefgh" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.account.publicId, owner.account.publicId);
  assert.notEqual(ok.body.account.publicId, member.account.publicId);
  assert.match(ok.body.accountNumber, /^\d{16}$/);
  assert.equal(ok.body.recoveryCodes.length, 10);
  const session = await call("/v1/session", { token: ok.body.token });
  assert.equal(session.status, 200);
  const login = await call("/v1/login", { method: "POST", body: { accountNumber: ok.body.accountNumber } });
  assert.equal(login.status, 200, "the new account number signs in");
  const again = await call("/v1/recovery/owner", { method: "POST", body: { code: "TESTOWNERRECOVERY2345ABCDEFGH" } });
  assert.equal(again.status, 401, "a used value works only once");
  const ip = "198.51.100.77";
  let last;
  for (let i = 0; i < 6; i++) last = await call("/v1/recovery/owner", { method: "POST", ip, body: { code: "WRONGOWNERRECOVERY2345ABCDEFG" } });
  assert.equal(last.status, 429, "tries are rate limited per address");
});
