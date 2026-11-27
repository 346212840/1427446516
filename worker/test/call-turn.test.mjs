import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { monthKey, capBytes, estimateBytes, turnUsage, mintTurn, TURN_SCHEMA, ACTIVE_RESERVE, RING_RESERVE, TURN_TTL_SECONDS, DEFAULT_CAP_BYTES, BYTES_PER_SECOND } from "../src/call-turn.js";

const ORIGIN = "https://346212840.github.io";
const KEY_ID = "keyid-" + "a".repeat(20);
const API_TOKEN = "tok-" + "b".repeat(30);
const SECRET = "mock-credential-value";

function boot(extra, hits) {
  return new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    durableObjects: { ACCOUNT_CHANNEL: { className: "AccountChannel", useSQLite: true } },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "rtc.live.cloudflare.com") {
        const body = await request.json().catch(() => ({}));
        hits.push({ path: url.pathname, ttl: body.ttl, auth: request.headers.get("authorization") });
        return Response.json({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u-mock", credential: SECRET }] });
      }
      return new Response("{}", { status: 200 });
    },
    bindings: Object.assign({
      ACCOUNT_PEPPER: "pepper-test", OWNER_CLAIM_CODE: "claim-test", OWNER_HANDLE: "owner_test", ALLOWED_ORIGINS: ORIGIN, PBKDF2_ITERATIONS: "1000",
      GEMINI_API_KEY: "test-key", CALLS_GEMINI_MOCK: "1", KEYS_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      CF_TURN_KEY_ID: KEY_ID, CF_TURN_API_TOKEN: API_TOKEN
    }, extra || {})
  });
}

function client(mf, base) {
  return async function call(path, opts) {
    opts = opts || {};
    const headers = new Headers();
    headers.set("CF-Connecting-IP", opts.ip || base);
    headers.set("Origin", ORIGIN);
    if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
    if (opts.guest) headers.set("x-call-guest", opts.guest);
    if (opts.body) headers.set("content-type", "application/json");
    const res = await mf.dispatchFetch("https://accounts.test" + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
    return { status: res.status, body, text };
  };
}
const cf = (servers) => (servers || []).filter((s) => JSON.stringify(s).includes("turn.cloudflare.com"));
const free = (servers) => (servers || []).some((s) => JSON.stringify(s).includes("openrelay"));

async function people(call, n) {
  const owner = await call("/v1/signup", { method: "POST", ip: "198.51.100." + n, body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  assert.equal((await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "calls", off: false } })).status, 200);
  const ada = (await call("/v1/signup", { method: "POST", ip: "198.51.100." + (n + 1), body: { displayName: "Ada", handle: "ada_turn" } })).body;
  const bea = (await call("/v1/signup", { method: "POST", ip: "198.51.100." + (n + 2), body: { displayName: "Bea", handle: "bea_turn" } })).body;
  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { who: "everyone", guests: true, dnd: false } });
  return { owner: owner.body, ada, bea };
}

test("pure rules: month key, cap bounds, estimate", () => {
  assert.equal(monthKey(Date.UTC(2026, 10, 30, 23, 59)), "2026-11");
  assert.equal(monthKey(Date.UTC(2026, 11, 1, 0, 0)), "2026-12");
  assert.equal(capBytes({}), DEFAULT_CAP_BYTES);
  assert.equal(DEFAULT_CAP_BYTES, 300e9, "the soft cap is 300 GB, well under the 1,000 GB free tier");
  assert.equal(capBytes({ CALLS_TURN_CAP_GB: "5000" }) <= 600e9, true, "the cap can never be raised toward the free tier limit");
  assert.equal(capBytes({ CALLS_TURN_CAP_GB: "nope" }), DEFAULT_CAP_BYTES);
  assert.equal(estimateBytes(60000), 60 * BYTES_PER_SECOND);
  assert.equal(estimateBytes(-5), 0);
  assert.equal(TURN_TTL_SECONDS, 7200);
});

test("credentials: only to people in a live call, two hour lifetime, usage tracked and settled", async () => {
  const hits = [];
  const mf = boot({}, hits);
  try {
    const call = client(mf, "198.51.100.10");
    const { owner, ada, bea } = await people(call, 20);
    hits.length = 0;

    assert.equal((await call("/v1/calls", { method: "POST", body: { handle: "bea_turn" } })).status, 401);
    assert.equal(hits.length, 0, "no credentials for someone who is not signed in");

    const created = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_turn" } });
    assert.equal(created.status, 201, created.text);
    const id = created.body.call.id;
    assert.equal(cf(created.body.iceServers).length, 1, "the caller gets a Cloudflare TURN server");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].ttl, 7200, "credentials last two hours");
    assert.equal(hits[0].path.includes(KEY_ID), true);
    assert.equal(hits[0].auth, "Bearer " + API_TOKEN);
    assert.equal(created.body.iceServers.some((s) => JSON.stringify(s).includes("stun:")), true, "direct and STUN candidates stay first");
    assert.equal(free(created.body.iceServers), false, "the free public relay is only the fallback");

    const outsider = await call("/v1/calls/" + id + "/ticket", { method: "POST", token: owner.token });
    assert.equal(outsider.status, 403, "not a participant");
    assert.equal(hits.length, 1);

    const answered = await call("/v1/calls/" + id + "/answer", { method: "POST", token: bea.token });
    assert.equal(answered.status, 200, answered.text);
    assert.equal(cf(answered.body.iceServers).length, 1, "the callee gets TURN too");
    assert.equal(hits.length, 2);

    let status = await call("/v1/calls/turn-status", { token: owner.token });
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.usedBytes, ACTIVE_RESERVE, "an answered call reserves twenty minutes");
    assert.equal(status.body.capBytes, 300e9);
    assert.equal(status.body.configured, true);
    assert.equal(status.body.estimate, true);
    assert.equal(status.text.includes(SECRET) || status.text.includes(KEY_ID) || status.text.includes(API_TOKEN), false, "the status never shows a credential");
    assert.notEqual((await call("/v1/calls/turn-status", { token: ada.token })).status, 200, "owner only");
    assert.notEqual((await call("/v1/calls/turn-status")).status, 200);

    /* Spamming credentials for one call stops at the per-call limit and falls back to the free relay. */
    let denied = null;
    for (let i = 0; i < 10 && !denied; i++) {
      const t = await call("/v1/calls/" + id + "/ticket", { method: "POST", token: ada.token });
      assert.equal(t.status, 200);
      if (!cf(t.body.iceServers).length) denied = t.body.iceServers;
    }
    assert.ok(denied, "the per-call limit kicked in");
    assert.equal(free(denied), true, "and the free 443 relay is offered instead");
    assert.ok(hits.length <= 8, "at most eight credentials per call and hour, got " + hits.length);

    const ended = await call("/v1/calls/" + id + "/end", { method: "POST", token: ada.token });
    assert.equal(ended.status, 200);
    status = await call("/v1/calls/turn-status", { token: owner.token });
    assert.ok(status.body.usedBytes < ACTIVE_RESERVE, "ending a short call settles its estimate down to its real length");

    /* A call that is never answered gives its reservation back. */
    const spare = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_turn" } });
    const before = (await call("/v1/calls/turn-status", { token: owner.token })).body.usedBytes;
    assert.equal(before >= RING_RESERVE, true);
    await call("/v1/calls/" + spare.body.call.id + "/decline", { method: "POST", token: bea.token });
    const after = (await call("/v1/calls/turn-status", { token: owner.token })).body.usedBytes;
    assert.equal(after, before - RING_RESERVE, "a declined call costs nothing");
  } finally { await mf.dispose(); }
});

test("monthly cap: no more credentials at the cap, free relay instead, resets next month, owner can lift it", async () => {
  const hits = [];
  const mf = boot({ CALLS_TURN_CAP_GB: "0.00001" }, hits);
  try {
    const call = client(mf, "198.51.100.60");
    const { owner, ada, bea } = await people(call, 70);
    hits.length = 0;
    const first = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_turn" } });
    assert.equal(first.status, 201);
    assert.equal(cf(first.body.iceServers).length, 1, "under the cap credentials are issued");
    const second = await call("/v1/calls", { method: "POST", token: bea.token, body: { handle: "ada_turn" } });
    assert.equal(second.status, 201, second.text);
    assert.equal(cf(second.body.iceServers).length, 0, "at the cap no Cloudflare credentials are issued");
    assert.equal(free(second.body.iceServers), true, "the call still has the free 443 relay");
    assert.equal(hits.length, 1, "and Cloudflare is not asked at all");
    const status = (await call("/v1/calls/turn-status", { token: owner.token })).body;
    assert.equal(status.capped, true);
    assert.equal(status.usedBytes, RING_RESERVE);

    /* Next month the same database counts from zero. */
    const db = await mf.getD1Database("DB");
    const nextMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2);
    assert.equal((await turnUsage({ DB: db }, nextMonth)).bytes, 0, "the cap resets with the calendar month");
    assert.equal((await turnUsage({ DB: db }, Date.now())).bytes, RING_RESERVE);

    /* The owner's switch lifts only the monthly cap. */
    assert.equal((await call("/v1/owner/features", { method: "POST", token: owner.token, body: { name: "calls_turn_budget", off: true } })).status, 200);
    const lifted = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_turn" } });
    assert.equal(cf(lifted.body.iceServers).length, 1, "off lifts the cap");
    assert.equal((await call("/v1/calls", { method: "POST", body: { handle: "bea_turn" } })).status, 401, "but a stranger still gets nothing");
  } finally { await mf.dispose(); }
});

test("mintTurn refuses without keys, without a call, and for ended calls", async () => {
  const hits = [];
  const mf = boot({}, hits);
  try {
    const db = await mf.getD1Database("DB");
    await db.batch(TURN_SCHEMA.map((sql) => db.prepare(sql)));
    const deps = { rateHit: async () => ({ ok: true }) };
    const env = { DB: db, CF_TURN_KEY_ID: KEY_ID, CF_TURN_API_TOKEN: API_TOKEN };
    assert.equal((await mintTurn({ DB: db }, deps, { id: "c1", self: "a", state: "active" })).reason, "unconfigured");
    assert.equal((await mintTurn(env, deps, null)).reason, "no_call");
    assert.equal((await mintTurn(env, deps, { id: "c1", self: "a", state: "ended" })).reason, "inactive");
    assert.equal((await mintTurn(env, { rateHit: async () => ({ ok: false }) }, { id: "c1", self: "a", state: "active" })).reason, "rate");
    assert.equal(hits.length, 0);
  } finally { await mf.dispose(); }
});
