/* R2 spending guard. R2 has no spending cap in Cloudflare, so the app stops
   itself before the free monthly allowance runs out:

     Class A (put, list, multipart): 1,000,000 a month
     Class B (get, head):           10,000,000 a month
     Storage:                        10 GB

   Every R2 call the Worker makes goes through meterEnv(), which counts it
   and checks the budget first. Counts are kept per isolate and added to one
   D1 row per billing cycle (r2_meter) at most every 30 seconds, so the meter
   itself costs no R2 operations. Every ten minutes the cron also reads
   Cloudflare's R2 analytics, which include writes from GitHub Actions and
   the Render backup, and the larger of the two numbers wins.

   Levels (percent of the free allowance, the highest of A and storage for
   writes, B for reads):
     soft  >= 70%   low-priority keys stop (backups, lastgood, caches, live buffers)
     hard  >= 85%   normal keys stop too; user uploads and deletions still work
     stop  >= 95%   everything stops (fail closed)
   The owner switch spend_kill_switch forces at least "hard" at once. The
   switch r2_caps off lifts soft and hard; "stop" always applies.

   Active when the Worker var R2_CAPS is "on". Tests leave it unset. */

import { readFlags } from "./feature-flags.js";

export const FREE = { classA: 1000000, classB: 10000000, storageBytes: 10 * 1000 * 1000 * 1000 };
export const LEVELS = { soft: 70, hard: 85, stop: 95 };
const RANK = { ok: 0, soft: 1, hard: 2, stop: 3 };
const FLUSH_MS = 30 * 1000;
const FLUSH_OPS = 200;
const LOAD_MS = 60 * 1000;
const STALE_MS = 6 * 60 * 60 * 1000;
const DEDUPE_MS = 15 * 60 * 1000;
const DEDUPE_MAX_BYTES = 1024 * 1024;
const DEDUPE_KEYS = 400;

export const HIGH = [
  /^backup\/tg-forget\//, /^deletions\.json$/, /^media\//, /^post-media\//, /^srv\//, /^uploads\//,
  /^users\//, /^accounts\//, /^sealed\//, /^exports\//, /^stories\/(?!telegram\/)/, /^profile_banners\//,
  /^highlights\//, /^cnotes\//, /^newsletter/, /^follows\//, /^lists\//
];
export const LOW = [
  /^backups?\//, /^lastgood\//, /^live-buf\//, /^ops\//, /^x-cache\//, /^unfurl\//, /^sync\//,
  /^pulse\//, /^comments\//, /^data\/communities\//, /^discord\//, /^archive\//, /^ytm?\//, /^vsr\//,
  /^snap\//, /^loop\//, /^tg\//, /^stories\/telegram\//, /^owner\/tiktok-watch\.json$/,
  /^owner\/live-(watch|marks|jobs-beat|upload)/
];

export function keyPriority(key) {
  const k = String(key || "");
  if (HIGH.some((re) => re.test(k))) return "high";
  if (LOW.some((re) => re.test(k))) return "low";
  return "normal";
}

/* The billing cycle that holds `now`: starts on `day` (default the 21st). */
export function cycleStart(now, day) {
  const d = Math.min(28, Math.max(1, Math.floor(Number(day) || 21)));
  const t = new Date(Number(now) || Date.now());
  let y = t.getUTCFullYear();
  let m = t.getUTCMonth();
  if (t.getUTCDate() < d) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  return Date.UTC(y, m, d);
}

export function cycleKey(now, day) {
  return new Date(cycleStart(now, day)).toISOString().slice(0, 10);
}

function pctOf(n, limit) {
  return Math.round((Math.max(0, Number(n) || 0) / limit) * 1000) / 10;
}

function levelFor(pct) {
  if (pct >= LEVELS.stop) return "stop";
  if (pct >= LEVELS.hard) return "hard";
  if (pct >= LEVELS.soft) return "soft";
  return "ok";
}

function maxLevel(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

/* Effective use: the larger of the Worker's own count and the analytics
   total plus what the Worker counted since that analytics read. */
export function effective(row, pend) {
  const r = row || {};
  const p = pend || {};
  const own = (n) => Math.max(0, Number(n) || 0);
  const a = Math.max(own(r.a), own(r.ext_a) + Math.max(0, own(r.a) - own(r.ext_local_a))) + own(p.a);
  const b = Math.max(own(r.b), own(r.ext_b) + Math.max(0, own(r.b) - own(r.ext_local_b))) + own(p.b);
  return { a, b, storage: own(r.storage) };
}

/* The budget for a row: percentages and the write/read levels. */
export function budgetFor(row, pend, opts) {
  const o = opts || {};
  const e = effective(row, pend);
  const pctA = pctOf(e.a, FREE.classA);
  const pctB = pctOf(e.b, FREE.classB);
  const pctS = pctOf(e.storage, FREE.storageBytes);
  let write = maxLevel(levelFor(pctA), levelFor(pctS));
  let read = levelFor(pctB);
  const extAt = Number(row && row.ext_at) || 0;
  const stale = !extAt || (Number(o.now) || Date.now()) - extAt > STALE_MS;
  // Without a fresh analytics total the Worker cannot see GitHub or Render
  // writes, so low-priority work waits until the next good read.
  if (stale) write = maxLevel(write, "soft");
  if (o.kill) { write = maxLevel(write, "hard"); read = maxLevel(read, "hard"); }
  if (o.capsOff) {
    write = write === "stop" ? "stop" : "ok";
    read = read === "stop" ? "stop" : "ok";
  }
  return { classA: e.a, classB: e.b, storage: e.storage, pctA, pctB, pctS, write, read, stale, kill: !!o.kill, capsOff: !!o.capsOff };
}

/* Does a call at `priority` go ahead at `level`? */
export function allowed(level, priority) {
  if (level === "stop") return false;
  if (level === "hard") return priority === "high";
  if (level === "soft") return priority !== "low";
  return true;
}

export class R2BudgetError extends Error {
  constructor(key, level) {
    super("r2_budget");
    this.code = "r2_budget";
    this.level = level;
    this.key = String(key || "").slice(0, 40);
  }
}

/* ---------- isolate state ---------- */

const state = {
  row: null,
  loadedAt: 0,
  pend: { a: 0, b: 0 },
  flushedAt: 0,
  flushing: null,
  ctx: null,
  flags: { kill: false, capsOff: false },
  digests: new Map(),
  blocked: { a: 0, b: 0 }
};

export function resetMeter() {
  state.row = null;
  state.loadedAt = 0;
  state.pend = { a: 0, b: 0 };
  state.flushedAt = 0;
  state.flushing = null;
  state.ctx = null;
  state.flags = { kill: false, capsOff: false };
  state.digests = new Map();
  state.blocked = { a: 0, b: 0 };
  schema = null;
}

export function meterOn(env) {
  return String((env && env.R2_CAPS) || "") === "on";
}

function cycleDay(env) {
  return Number(env && env.R2_CYCLE_DAY) || 21;
}

let schema = null;
function ensureSchema(env) {
  if (!schema) {
    schema = env.DB.prepare("CREATE TABLE IF NOT EXISTS r2_meter (cycle TEXT PRIMARY KEY, a INTEGER NOT NULL DEFAULT 0, b INTEGER NOT NULL DEFAULT 0, ext_a INTEGER NOT NULL DEFAULT 0, ext_b INTEGER NOT NULL DEFAULT 0, ext_local_a INTEGER NOT NULL DEFAULT 0, ext_local_b INTEGER NOT NULL DEFAULT 0, ext_at INTEGER NOT NULL DEFAULT 0, storage INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)").run()
      .catch((err) => { schema = null; throw err; });
  }
  return schema;
}

async function loadRow(env, now, force) {
  const cycle = cycleKey(now, cycleDay(env));
  if (!force && state.row && state.row.cycle === cycle && now - state.loadedAt < LOAD_MS) return state.row;
  if (!env || !env.DB) return state.row || { cycle };
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare("SELECT * FROM r2_meter WHERE cycle = ?").bind(cycle).first();
    state.row = row || { cycle, a: 0, b: 0 };
    state.loadedAt = now;
  } catch (err) {
    // Keep the last known row; with none, the budget reads as stale (soft).
    if (!state.row || state.row.cycle !== cycle) state.row = { cycle, a: 0, b: 0 };
  }
  return state.row;
}

export async function flushMeter(env, now) {
  const at = Number(now) || Date.now();
  const a = state.pend.a;
  const b = state.pend.b;
  if ((!a && !b) || !env || !env.DB) return null;
  state.pend = { a: 0, b: 0 };
  state.flushedAt = at;
  const cycle = cycleKey(at, cycleDay(env));
  try {
    await ensureSchema(env);
    const row = await env.DB.prepare(
      "INSERT INTO r2_meter (cycle, a, b, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(cycle) DO UPDATE SET a = a + excluded.a, b = b + excluded.b, updated_at = excluded.updated_at RETURNING *"
    ).bind(cycle, a, b, at).first();
    if (row) { state.row = row; state.loadedAt = at; }
    return row;
  } catch (err) {
    // Put the counts back so the next flush carries them.
    state.pend.a += a;
    state.pend.b += b;
    return null;
  }
}

function maybeFlush(env) {
  const now = Date.now();
  if (state.flushing) return;
  if (now - state.flushedAt < FLUSH_MS && state.pend.a + state.pend.b < FLUSH_OPS) return;
  const run = flushMeter(env, now).catch(() => null).finally(() => { state.flushing = null; });
  state.flushing = run;
  const ctx = state.ctx;
  if (ctx && typeof ctx.waitUntil === "function") {
    try { ctx.waitUntil(run); } catch (err) { /* the promise still runs */ }
  }
}

/* The current budget (reads D1 at most once a minute per isolate). */
export async function currentBudget(env, now, force) {
  const at = Number(now) || Date.now();
  const raw = (env && env.__r2Raw) || env;
  const row = await loadRow(raw, at, force);
  try { setMeterFlags(await readFlags(raw, at)); } catch (err) { /* keep the last switches */ }
  return Object.assign({ cycle: row.cycle || cycleKey(at, cycleDay(env)) }, budgetFor(row, state.pend, { now: at, kill: state.flags.kill, capsOff: state.flags.capsOff }));
}

/* Owner switches, read by the caller from feature flags. */
export function setMeterFlags(off) {
  const o = off || {};
  // spend_kill_switch ships default-off; switching it on engages the freeze.
  state.flags = { kill: !o.spend_kill_switch, capsOff: !!o.r2_caps };
}

export function meterStats() {
  return { pending: Object.assign({}, state.pend), blocked: Object.assign({}, state.blocked), dedupeKeys: state.digests.size };
}

/* ---------- unchanged-write skip ---------- */

function bodyBytes(value) {
  if (typeof value === "string") return value.length <= DEDUPE_MAX_BYTES ? new TextEncoder().encode(value) : null;
  if (value instanceof ArrayBuffer) return value.byteLength <= DEDUPE_MAX_BYTES ? new Uint8Array(value) : null;
  if (ArrayBuffer.isView(value)) return value.byteLength <= DEDUPE_MAX_BYTES ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  return null;
}

async function digestOf(value, options) {
  const bytes = bodyBytes(value);
  if (!bytes) return "";
  const meta = options ? JSON.stringify({ h: options.httpMetadata || null, c: options.customMetadata || null }) : "";
  const metaBytes = new TextEncoder().encode(meta);
  const all = new Uint8Array(bytes.byteLength + metaBytes.byteLength + 1);
  all.set(bytes, 0);
  all.set(metaBytes, bytes.byteLength + 1);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", all));
  let hex = "";
  for (let i = 0; i < 12; i++) hex += hash[i].toString(16).padStart(2, "0");
  return hex;
}

function rememberDigest(name, key, digest) {
  if (!digest) return;
  const id = name + "\u0000" + key;
  state.digests.delete(id);
  state.digests.set(id, { digest, at: Date.now() });
  while (state.digests.size > DEDUPE_KEYS) state.digests.delete(state.digests.keys().next().value);
}

function sameDigest(name, key, digest) {
  if (!digest) return false;
  const row = state.digests.get(name + "\u0000" + key);
  return !!(row && row.digest === digest && Date.now() - row.at < DEDUPE_MS);
}

function forgetDigest(name, key) {
  state.digests.delete(name + "\u0000" + key);
}

/* ---------- the wrapped bucket ---------- */

function count(env, kind) {
  state.pend[kind] += 1;
  maybeFlush(env);
}

async function gate(env, kind, key) {
  const budget = await currentBudget(env, Date.now());
  const level = kind === "b" ? budget.read : budget.write;
  const ok = allowed(level, keyPriority(key));
  if (!ok) state.blocked[kind] += 1;
  return { ok, level };
}

function wrapUpload(env, upload) {
  if (!upload || typeof upload !== "object") return upload;
  return new Proxy(upload, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "uploadPart" || prop === "complete") {
        return async (...args) => {
          const g = await gate(env, "a", target.key);
          if (!g.ok) throw new R2BudgetError(target.key, g.level);
          count(env, "a");
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

const EMPTY_LIST = Object.freeze({ objects: [], truncated: false, delimitedPrefixes: [] });

export function wrapBucket(env, bucket, name) {
  if (!bucket || typeof bucket !== "object") return bucket;
  const handlers = {
    async put(key, value, options) {
      const digest = await digestOf(value, options);
      if (sameDigest(name, key, digest)) return { key: String(key), skipped: true, size: 0, etag: "", httpEtag: "", uploaded: new Date() };
      const g = await gate(env, "a", key);
      if (!g.ok) {
        if (keyPriority(key) === "low") return null;
        throw new R2BudgetError(key, g.level);
      }
      count(env, "a");
      const out = await bucket.put(key, value, options);
      if (out) rememberDigest(name, key, digest);
      return out;
    },
    async get(key, options) {
      const g = await gate(env, "b", key);
      if (!g.ok) return null;
      count(env, "b");
      return bucket.get(key, options);
    },
    async head(key) {
      const g = await gate(env, "b", key);
      if (!g.ok) return null;
      count(env, "b");
      return bucket.head(key);
    },
    async list(options) {
      const prefix = options && options.prefix;
      const g = await gate(env, "a", prefix || "");
      if (!g.ok) return EMPTY_LIST;
      count(env, "a");
      return bucket.list(options);
    },
    async delete(keys) {
      // Deletes are free in R2.
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => forgetDigest(name, k));
      return bucket.delete(keys);
    },
    async createMultipartUpload(key, options) {
      const g = await gate(env, "a", key);
      if (!g.ok) throw new R2BudgetError(key, g.level);
      count(env, "a");
      return wrapUpload(env, await bucket.createMultipartUpload(key, options));
    },
    resumeMultipartUpload(key, uploadId) {
      return wrapUpload(env, bucket.resumeMultipartUpload(key, uploadId));
    }
  };
  return new Proxy(bucket, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(handlers, prop) && typeof target[prop] === "function") return handlers[prop];
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

const wrapped = new WeakMap();

/* The env every handler uses: DATA and PULSE metered when R2_CAPS is on. */
export function meterEnv(env, ctx) {
  if (!env || typeof env !== "object" || !meterOn(env)) return env;
  if (ctx) state.ctx = ctx;
  if (env.__r2Metered) return env;
  const hit = wrapped.get(env);
  if (hit) return hit;
  const out = Object.assign(Object.create(Object.getPrototypeOf(env)), env, {
    DATA: wrapBucket(env, env.DATA, "DATA"),
    PULSE: wrapBucket(env, env.PULSE, "PULSE")
  });
  Object.defineProperty(out, "__r2Metered", { value: true });
  Object.defineProperty(out, "__r2Raw", { value: env });
  wrapped.set(env, out);
  return out;
}

/* ---------- analytics sync (cron) ---------- */

const R2_QUERY = `query R($acc: String!, $start: Time!, $end: Time!, $recent: Time!) {
  viewer { accounts(filter: { accountTag: $acc }) {
    ops: r2OperationsAdaptiveGroups(limit: 200, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } dimensions { actionType } }
    size: r2StorageAdaptiveGroups(limit: 200, filter: { datetime_geq: $recent, datetime_lt: $end }, orderBy: [datetime_DESC]) { max { payloadSize metadataSize } dimensions { bucketName datetime } }
  } }
}`;

export function classOf(action) {
  const name = String(action || "");
  if (/^(Delete|Abort)/.test(name)) return "";
  if (/^(Head|Get|UsageSummary)/.test(name)) return "b";
  return "a";
}

export function totalsFrom(acc) {
  let a = 0;
  let b = 0;
  ((acc && acc.ops) || []).forEach((row) => {
    const n = Number(row && row.sum && row.sum.requests) || 0;
    const c = classOf(row && row.dimensions && row.dimensions.actionType);
    if (c === "a") a += n;
    else if (c === "b") b += n;
  });
  const seen = new Set();
  let storage = 0;
  ((acc && acc.size) || []).forEach((row) => {
    const bucket = String(row && row.dimensions && row.dimensions.bucketName || "");
    if (seen.has(bucket)) return;
    seen.add(bucket);
    storage += (Number(row.max && row.max.payloadSize) || 0) + (Number(row.max && row.max.metadataSize) || 0);
  });
  return { a, b, storage };
}

export function syncDue(at) {
  return new Date(Number(at) || Date.now()).getUTCMinutes() % 10 === 1;
}

/* Reads this cycle's R2 totals from Cloudflare analytics into r2_meter. */
export async function syncR2Usage(env, now, fetcher) {
  if (!meterOn(env) || !env.DB || !env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const at = Number(now) || Date.now();
  const start = cycleStart(at, cycleDay(env));
  const res = await (fetcher || fetch)("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + env.CF_ANALYTICS_TOKEN },
    body: JSON.stringify({ query: R2_QUERY, variables: { acc: env.CF_ACCOUNT_ID, start: new Date(start).toISOString(), end: new Date(at + 60000).toISOString(), recent: new Date(at - 86400000).toISOString() } }),
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const acc = body && !((body.errors || []).length) && body.data && body.data.viewer && body.data.viewer.accounts && body.data.viewer.accounts[0];
  if (!acc) return null;
  const t = totalsFrom(acc);
  await flushMeter(env, at);
  const cycle = cycleKey(at, cycleDay(env));
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "INSERT INTO r2_meter (cycle, ext_a, ext_b, ext_at, storage, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cycle) DO UPDATE SET ext_a = excluded.ext_a, ext_b = excluded.ext_b, ext_local_a = a, ext_local_b = b, ext_at = excluded.ext_at, storage = excluded.storage, updated_at = excluded.updated_at RETURNING *"
  ).bind(cycle, t.a, t.b, at, t.storage, at).first();
  if (row) { state.row = row; state.loadedAt = at; }
  return t;
}
