import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

let mf;
let ipN = 40;
const OLD = "https://viktorych" + "group.github.io";
const NEW_SITE = "https://346212840.github.io/1427446516/";

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
      ALLOWED_ORIGINS: "https://346212840.github.io," + OLD + ",http://127.0.0.1:8080",
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
  if (opts.origin) headers.set("Origin", opts.origin);
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



function codeOf(url) {
  assert.ok(url.startsWith(NEW_SITE + "#/moved="), url);
  return url.slice((NEW_SITE + "#/moved=").length);
}

test("app moved: old origin gets a moved post, a note and the address; new origin does not", async () => {
  const member = await signup("movedreader", "Moved Reader");
  const token = member.token;
  const bucket = await mf.getR2Bucket("DATA");
  await bucket.put("feeds.json", JSON.stringify({
    feeds: [{ id: "x:one", platform: "x", configured: true }],
    posts: [{ id: "p1", feedId: "x:one", platform: "x", text: "hello", date: "2026-11-01T00:00:00Z" }]
  }));

  const features = await call("/v1/features", { origin: OLD });
  assert.equal(features.status, 200);
  assert.equal(features.body.moved.url, NEW_SITE);
  const fresh = await call("/v1/features", { origin: "https://346212840.github.io" });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.moved, undefined);

  const feed = await call("/v1/data/feeds.json", { token, origin: OLD });
  assert.equal(feed.status, 200);
  assert.equal(feed.body.feeds[0].id, "app:moved");
  assert.equal(feed.body.feeds[0].configured, true);
  const post = feed.body.posts[0];
  assert.equal(post.feedId, "app:moved");
  assert.match(post.id, /^app-moved-\d+$/);
  assert.equal(post.links.length, 1);
  assert.equal(post.links[0].expanded, post.links[0].url);
  const code = codeOf(post.links[0].url);
  assert.ok(feed.body.posts.some((p) => p.id === "p1"), "the real posts stay");

  const again = await call("/v1/data/feeds.json", { token, origin: OLD });
  assert.equal(again.body.posts[0].id, post.id, "one post per hour keeps old clients' list stable");
  assert.equal(codeOf(again.body.posts[0].links[0].url), code);

  const plain = await call("/v1/data/feeds.json", { token, origin: "https://346212840.github.io" });
  assert.equal(plain.status, 200);
  assert.ok(!plain.body.posts.some((p) => p.feedId === "app:moved"));

  const notes = await call("/v1/notifications", { token, origin: OLD });
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
  const list = notes.body.items || notes.body.notifications || [];
  assert.ok(list.some((n) => n.id === "app-moved"), JSON.stringify(notes.body).slice(0, 300));
  const newNotes = await call("/v1/notifications", { token, origin: "https://346212840.github.io" });
  const newList = newNotes.body.items || newNotes.body.notifications || [];
  assert.ok(!newList.some((n) => n.id === "app-moved"));

  const ex = await call("/v1/moved/exchange", { method: "POST", body: { code } });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.account.publicId, member.account.publicId);
  const session = await call("/v1/session", { token: ex.body.token });
  assert.equal(session.status, 200);
  const reuse = await call("/v1/moved/exchange", { method: "POST", body: { code } });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error, "handoff_used");

  const forged = code.slice(0, -4) + (code.slice(-4) === "0000" ? "1111" : "0000");
  const bad = await call("/v1/moved/exchange", { method: "POST", body: { code: forged } });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, "handoff_invalid");
});

test("app moved: a signed-in tap mints a link; signed-out cannot", async () => {
  const member = await signup("movedtapper", "Moved Tapper");
  const none = await call("/v1/moved/handoff", { method: "POST", body: {} });
  assert.equal(none.status, 401);
  const res = await call("/v1/moved/handoff", { method: "POST", token: member.token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const code = codeOf(res.body.url);
  assert.ok(res.body.expiresIn > 0);
  const ex = await call("/v1/moved/exchange", { method: "POST", body: { code } });
  assert.equal(ex.status, 200);
  assert.equal(ex.body.account.publicId, member.account.publicId);
});

test("app moved: an expired code is refused", async () => {
  const mod = await import("../src/moved.js");
  const enc = new TextEncoder();
  const hmacHex = async (secret, text) => {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
    return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  };
  const env = { ACCOUNT_PEPPER: "pepper-test" };
  const deps = { hmacHex, timingEqual: (a, b) => a === b };
  const past = Date.now() - 6 * 60 * 60 * 1000;
  const old = await mod.mintHandoff(env, "123456789012", deps, past);
  const read = await mod.readHandoff(env, old.code || old, deps, Date.now());
  assert.ok(read && read.expired, JSON.stringify(read));
  const now = await mod.mintHandoff(env, "123456789012", deps, Date.now());
  const ok = await mod.readHandoff(env, now.code || now, deps, Date.now());
  assert.equal(ok.publicId, "123456789012");
});
