import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE, LEVELS, allowed, budgetFor, classOf, cycleKey, cycleStart, effective, keyPriority,
  meterEnv, resetMeter, syncR2Usage, totalsFrom, currentBudget, flushMeter, meterStats
} from "../src/r2-meter.js";
import { forgetFlags } from "../src/feature-flags.js";

// A D1 stand-in for the r2_meter row and the feature_flags table.
function fakeDb(start, flags) {
  const rows = new Map();
  if (start) rows.set(start.cycle, Object.assign({ a: 0, b: 0, ext_a: 0, ext_b: 0, ext_local_a: 0, ext_local_b: 0, ext_at: 0, storage: 0 }, start));
  const writes = [];
  const stmt = (sql, args) => ({
    bind: (...a) => stmt(sql, a),
    async run() { return { meta: {} }; },
    async all() {
      if (/FROM feature_flags/.test(sql)) return { results: (flags || []).map((name) => ({ name, off: 0 })) };
      return { results: [] };
    },
    async first() {
      if (/SELECT \* FROM r2_meter/.test(sql)) return rows.get(args[0]) || null;
      if (/INSERT INTO r2_meter \(cycle, a, b/.test(sql)) {
        writes.push(args);
        const [cycle, a, b, at] = args;
        const row = rows.get(cycle) || { cycle, a: 0, b: 0, ext_a: 0, ext_b: 0, ext_local_a: 0, ext_local_b: 0, ext_at: 0, storage: 0 };
        row.a += a; row.b += b; row.updated_at = at;
        rows.set(cycle, row);
        return Object.assign({}, row);
      }
      if (/INSERT INTO r2_meter \(cycle, ext_a/.test(sql)) {
        const [cycle, ea, eb, at, storage] = args;
        const row = rows.get(cycle) || { cycle, a: 0, b: 0, ext_a: 0, ext_b: 0, ext_local_a: 0, ext_local_b: 0, ext_at: 0, storage: 0 };
        row.ext_local_a = row.a; row.ext_local_b = row.b;
        row.ext_a = ea; row.ext_b = eb; row.ext_at = at; row.storage = storage;
        rows.set(cycle, row);
        return Object.assign({}, row);
      }
      return null;
    }
  });
  return { DB: { prepare: (sql) => stmt(sql, []), batch: async () => [], exec: async () => ({}) }, rows, writes };
}

function fakeBucket() {
  const store = new Map();
  const calls = [];
  return {
    calls,
    store,
    async put(key, value) { calls.push(["put", key]); store.set(key, value); return { key }; },
    async get(key) { calls.push(["get", key]); return store.has(key) ? { key, text: async () => String(store.get(key)) } : null; },
    async head(key) { calls.push(["head", key]); return store.has(key) ? { key } : null; },
    async list() { calls.push(["list"]); return { objects: [...store.keys()].map((key) => ({ key })), truncated: false }; },
    async delete(key) { calls.push(["delete", key]); store.delete(key); }
  };
}

const NOW = Date.UTC(2026, 10, 25, 12, 0);
const CYCLE = "2026-11-21";

function setup(row, flags) {
  resetMeter();
  forgetFlags();
  const db = fakeDb(row ? Object.assign({ cycle: CYCLE }, row) : null, flags);
  const DATA = fakeBucket();
  const env = meterEnv({ DB: db.DB, DATA, R2_CAPS: "on", R2_CYCLE_DAY: "21" }, null);
  return { db, DATA, env };
}

test("the billing cycle starts on the 21st", () => {
  assert.equal(cycleKey(Date.UTC(2026, 10, 25), 21), "2026-11-21");
  assert.equal(cycleKey(Date.UTC(2026, 10, 20, 23, 59), 21), "2026-10-21");
  assert.equal(cycleKey(Date.UTC(2026, 0, 3), 21), "2025-12-21");
  assert.equal(cycleStart(Date.UTC(2026, 10, 21), 21), Date.UTC(2026, 10, 21));
});

test("keys are sorted into low, normal and high priority", () => {
  assert.equal(keyPriority("backup/telegram-manifest.json"), "low");
  assert.equal(keyPriority("lastgood/comments/1.json"), "low");
  assert.equal(keyPriority("live-buf/0/a/1/1/seg.m4s"), "low");
  assert.equal(keyPriority("owner/tiktok-watch.json"), "low");
  assert.equal(keyPriority("owner/tiktok.json"), "normal");
  assert.equal(keyPriority("media/avatars/1/x.webp"), "high");
  assert.equal(keyPriority("backup/tg-forget/x-1.json"), "high", "a deletion record is never held back");
});

test("levels stop low work first and everything before the free limit", () => {
  assert.ok(LEVELS.soft < LEVELS.hard && LEVELS.hard < LEVELS.stop && LEVELS.stop < 100);
  const fresh = { ext_at: NOW };
  const at = (n) => budgetFor(Object.assign({ a: n }, fresh), null, { now: NOW });
  assert.equal(at(100000).write, "ok");
  assert.equal(at(FREE.classA * 0.7).write, "soft");
  assert.equal(at(FREE.classA * 0.85).write, "hard");
  assert.equal(at(FREE.classA * 0.95).write, "stop");
  assert.equal(allowed("soft", "low"), false);
  assert.equal(allowed("soft", "normal"), true);
  assert.equal(allowed("hard", "normal"), false);
  assert.equal(allowed("hard", "high"), true);
  assert.equal(allowed("stop", "high"), false, "fail closed at the stop level");
  assert.equal(budgetFor({ b: FREE.classB * 0.96, ext_at: NOW }, null, { now: NOW }).read, "stop");
  assert.equal(budgetFor({ storage: FREE.storageBytes * 0.9, ext_at: NOW }, null, { now: NOW }).write, "hard");
});

test("analytics totals win over the Worker's own count, plus what it counted since", () => {
  const e = effective({ a: 500, ext_a: 900000, ext_local_a: 400, b: 10, ext_b: 5, ext_local_b: 0 }, { a: 7, b: 1 });
  assert.equal(e.a, 900000 + 100 + 7);
  assert.equal(e.b, 5 + 10 + 1);
});

test("without a fresh analytics read, low-priority writes wait", () => {
  assert.equal(budgetFor({ a: 0 }, null, { now: NOW }).write, "soft");
  assert.equal(budgetFor({ a: 0, ext_at: NOW - 7 * 3600 * 1000 }, null, { now: NOW }).write, "soft");
  assert.equal(budgetFor({ a: 0, ext_at: NOW - 600000 }, null, { now: NOW }).write, "ok");
});

test("the kill switch and the caps switch", () => {
  assert.equal(budgetFor({ ext_at: NOW }, null, { now: NOW, kill: true }).write, "hard");
  assert.equal(budgetFor({ a: FREE.classA * 0.9, ext_at: NOW }, null, { now: NOW, capsOff: true }).write, "ok");
  assert.equal(budgetFor({ a: FREE.classA * 0.96, ext_at: NOW }, null, { now: NOW, capsOff: true }).write, "stop", "turning caps off never lifts the stop");
});

test("R2 action types map to their billing class", () => {
  assert.equal(classOf("PutObject"), "a");
  assert.equal(classOf("ListObjects"), "a");
  assert.equal(classOf("UploadPart"), "a");
  assert.equal(classOf("GetObject"), "b");
  assert.equal(classOf("HeadObject"), "b");
  assert.equal(classOf("DeleteObject"), "");
  const t = totalsFrom({
    ops: [{ sum: { requests: 10 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 4 }, dimensions: { actionType: "GetObject" } }, { sum: { requests: 9 }, dimensions: { actionType: "DeleteObject" } }],
    size: [
      { max: { payloadSize: 100, metadataSize: 1 }, dimensions: { bucketName: "one", datetime: "2" } },
      { max: { payloadSize: 50, metadataSize: 0 }, dimensions: { bucketName: "one", datetime: "1" } },
      { max: { payloadSize: 30, metadataSize: 0 }, dimensions: { bucketName: "two", datetime: "2" } }
    ]
  });
  assert.deepEqual(t, { a: 10, b: 4, storage: 131 });
});

test("a metered bucket counts calls and flushes them to one D1 row", async () => {
  const { db, DATA, env } = setup({ ext_at: Date.now() });
  await env.DATA.put("owner/x.json", "1");
  await env.DATA.get("owner/x.json");
  await env.DATA.head("owner/x.json");
  await env.DATA.list({ prefix: "owner/" });
  await env.DATA.delete("owner/x.json");
  await new Promise((r) => setTimeout(r, 0));
  await flushMeter(env);
  assert.deepEqual(meterStats().pending, { a: 0, b: 0 });
  const row = db.rows.get(cycleKey(Date.now(), 21));
  assert.equal(row.a, 2);
  assert.equal(row.b, 2);
  assert.equal(DATA.calls.length, 5);
});

test("an unchanged write is skipped without an R2 call", async () => {
  const { DATA, env } = setup({ ext_at: Date.now() });
  await env.DATA.put("owner/state.json", JSON.stringify({ a: 1 }));
  await env.DATA.put("owner/state.json", JSON.stringify({ a: 1 }));
  await env.DATA.put("owner/state.json", JSON.stringify({ a: 2 }));
  assert.equal(DATA.calls.filter((c) => c[0] === "put").length, 2);
  await env.DATA.delete("owner/state.json");
  await env.DATA.put("owner/state.json", JSON.stringify({ a: 2 }));
  assert.equal(DATA.calls.filter((c) => c[0] === "put").length, 3, "after a delete the same body is written again");
});

test("over the soft level a backup write is dropped and a normal write goes ahead", async () => {
  const cycle = cycleKey(Date.now(), 21);
  resetMeter();
  forgetFlags();
  const db = fakeDb({ cycle, a: 0, ext_a: FREE.classA * 0.75, ext_at: Date.now() });
  const DATA = fakeBucket();
  const env = meterEnv({ DB: db.DB, DATA, R2_CAPS: "on" }, null);
  assert.equal(await env.DATA.put("backup/telegram-manifest.json", "x"), null);
  assert.ok(await env.DATA.put("owner/tiktok.json", "y"));
  assert.deepEqual(DATA.calls.map((c) => c[1]), ["owner/tiktok.json"]);
  assert.equal(meterStats().blocked.a, 1);
});

test("at the stop level every write fails closed and reads return nothing", async () => {
  const cycle = cycleKey(Date.now(), 21);
  resetMeter();
  forgetFlags();
  const db = fakeDb({ cycle, ext_a: FREE.classA * 0.96, ext_b: FREE.classB * 0.96, ext_at: Date.now() });
  const DATA = fakeBucket();
  DATA.store.set("media/a.jpg", "z");
  const env = meterEnv({ DB: db.DB, DATA, R2_CAPS: "on" }, null);
  await assert.rejects(() => env.DATA.put("media/b.jpg", "z"), (err) => err.code === "r2_budget");
  assert.equal(await env.DATA.get("media/a.jpg"), null);
  assert.deepEqual(await env.DATA.list({ prefix: "media/" }), { objects: [], truncated: false, delimitedPrefixes: [] });
  await env.DATA.delete("media/a.jpg");
  assert.deepEqual(DATA.calls.map((c) => c[0]), ["delete"], "only the free delete reached R2");
});

test("the owner's spending freeze stops normal writes at once", async () => {
  const cycle = cycleKey(Date.now(), 21);
  resetMeter();
  forgetFlags();
  const db = fakeDb({ cycle, ext_at: Date.now() }, ["spend_kill_switch"]);
  const DATA = fakeBucket();
  const env = meterEnv({ DB: db.DB, DATA, R2_CAPS: "on" }, null);
  await assert.rejects(() => env.DATA.put("owner/tiktok.json", "1"), (err) => err.code === "r2_budget");
  assert.ok(await env.DATA.put("media/up.jpg", "1"), "uploads still work");
  const budget = await currentBudget(env, Date.now());
  assert.equal(budget.kill, true);
  assert.equal(budget.write, "hard");
});

test("without R2_CAPS the env is untouched", () => {
  resetMeter();
  const raw = { DATA: fakeBucket() };
  assert.equal(meterEnv(raw, null), raw);
});

test("the cron reads this cycle's totals from analytics", async () => {
  const cycle = cycleKey(NOW, 21);
  resetMeter();
  forgetFlags();
  const db = fakeDb({ cycle, a: 40 });
  const env = meterEnv({ DB: db.DB, DATA: fakeBucket(), R2_CAPS: "on", CF_ANALYTICS_TOKEN: "t", CF_ACCOUNT_ID: "acct" }, null);
  let sent = null;
  const fetcher = async (url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{
      ops: [{ sum: { requests: 180000 }, dimensions: { actionType: "PutObject" } }, { sum: { requests: 470000 }, dimensions: { actionType: "GetObject" } }],
      size: [{ max: { payloadSize: 6000000000, metadataSize: 0 }, dimensions: { bucketName: "one", datetime: "x" } }]
    }] } } }), { status: 200 });
  };
  const totals = await syncR2Usage(env, NOW, fetcher);
  assert.deepEqual(totals, { a: 180000, b: 470000, storage: 6000000000 });
  assert.equal(sent.variables.start, "2026-11-21T00:00:00.000Z");
  const row = db.rows.get(cycle);
  assert.equal(row.ext_a, 180000);
  assert.equal(row.ext_local_a, 40);
  const budget = budgetFor(row, null, { now: NOW });
  assert.equal(budget.write, "ok");
  assert.equal(budget.pctA, 18);
  assert.equal(budget.pctS, 60);
});

test("GET /v1/r2-budget shows levels to anyone and no counts", async () => {
  const worker = await import("../src/index.js");
  const cycle = cycleKey(Date.now(), 21);
  resetMeter();
  forgetFlags();
  const db = fakeDb({ cycle, a: 12, ext_a: 800000, ext_local_a: 12, ext_at: Date.now() });
  const env = { DB: db.DB, DATA: fakeBucket(), R2_CAPS: "on", ALLOWED_ORIGINS: "https://app.example.test" };
  const res = await worker.default.fetch(new Request("https://api.example.test/v1/r2-budget"), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.on, true);
  assert.equal(body.write, "soft");
  assert.equal(body.pctA, 80);
  assert.equal(body.classA, undefined, "raw counts stay owner-only");
});
