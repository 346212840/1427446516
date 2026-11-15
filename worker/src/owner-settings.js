/* Owner-managed member settings (switch owner_user_settings).
   The site owner (accounts.owner = 1, checked here on the server) can change
   another account's synced settings and lock any of them. A locked setting
   keeps the owner's value: every /v1/sync read and write of that account
   passes through enforceLocks(), so a device, an old app or a hand-made
   request cannot change it. Unlocking gives the choice back to the member.
   Only plain, well-known settings from settings-registry.js are listed
   (look, feed, media, privacy protections, language); never lists, blocks,
   follows, history, messages or anything secret. Other accounts that are
   owners cannot be managed. Each change writes an owner_access_log row.

   GET /v1/owner/user-settings/:id   settings, locks and the schema
   PUT /v1/owner/user-settings/:id   { values: { key: value }, locks: { key: true|false } } */

import { logOwnerView } from "./owner-view.js";

export const LOCKS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS owner_setting_locks (public_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, owner_id TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', PRIMARY KEY (public_id, key))",
  "CREATE TABLE IF NOT EXISTS owner_setting_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, owner_id TEXT NOT NULL, public_id TEXT NOT NULL, key TEXT NOT NULL, old_value TEXT NOT NULL DEFAULT '', new_value TEXT NOT NULL DEFAULT '', change TEXT NOT NULL)"
];

const bool = (key, label, def, group) => ({ key, type: "bool", label, def, group });
const pick = (key, label, values, valueLabels, def, group) => ({ key, type: "enum", label, values, valueLabels, def, group });

/* Same ids, types, labels and defaults as settings-registry.js, and at least
   its values (Theme also has the app's Auto); worker/test/owner-settings.test.mjs
   fails when they drift. */
export const MANAGED = [
  pick("appearance", "Theme", ["lightsout", "dim", "default", "auto"], { lightsout: "Lights out", dim: "Dim", "default": "Light", auto: "Auto" }, "lightsout", "look"),
  pick("accent", "Color", ["blue", "yellow", "pink", "purple", "orange", "green"], { blue: "Blue", yellow: "Yellow", pink: "Pink", purple: "Purple", orange: "Orange", green: "Green" }, "blue", "look"),
  { key: "fontSize", type: "number", label: "Font size", values: [14, 15, 16, 17, 18], def: 15, group: "look" },
  pick("density", "Density", ["compact", "default", "comfy"], { compact: "Compact", "default": "Default", comfy: "Comfortable" }, "default", "look"),
  bool("reduceMotion", "Reduce motion", false, "look"),
  pick("showPictures", "Profile pictures", ["show", "default", "none"], { show: "Show", "default": "Default", none: "None" }, "show", "look"),
  pick("showBanners", "Banners", ["show", "default", "none"], { show: "Show", "default": "Default", none: "None" }, "show", "look"),
  pick("avatarShape", "Profile picture shape", ["round", "square"], { round: "Round", square: "Square" }, "round", "look"),
  bool("haptics", "Haptics", true, "look"),
  bool("aiFab", "Local AI button", false, "look"),
  bool("homePills", "Live pills row", true, "feed"),
  bool("stories", "Stories", true, "feed"),
  bool("storyNotes", "Story notes", true, "feed"),
  bool("forYouReposts", "Show reposts", true, "feed"),
  bool("forYouReplies", "Show replies in tab", true, "feed"),
  pick("followingSort", "Following options", ["recent", "popular"], { recent: "Recent", popular: "Popular" }, "recent", "feed"),
  bool("friendsRail", "Friends panel", true, "feed"),
  pick("autoplay", "Autoplay videos", ["all", "wifi", "never"], { all: "On cellular or Wi-Fi", wifi: "Only on Wi-Fi", never: "Never" }, "all", "media"),
  pick("livePreview", "Live previews", ["auto", "on", "off"], { auto: "Automatic", on: "On", off: "Off" }, "auto", "media"),
  bool("privacyEmbedShield", "Third-party embed shield", false, "privacy"),
  bool("privacyWebRTC", "WebRTC leak protection", true, "privacy"),
  bool("privacyNoReferrer", "Strict no-referrer", true, "privacy"),
  bool("privacyStripTrackers", "Strip tracking parameters", true, "privacy"),
  bool("privacyAntiFingerprint", "Fingerprint resistance", true, "privacy"),
  pick("lang", "Display language", ["en", "es", "ru", "hi"], { en: "English", es: "Español", ru: "Русский", hi: "हिन्दी" }, "en", "language"),
  pick("translateTo", "Translate to", ["ui", "en", "es", "ru", "hi", "fr", "de", "pt", "it"], null, "ui", "language"),
  bool("translateAuto", "Automatically translate posts", true, "language"),
  pick("postAlign", "Alignment", ["left", "justify"], { left: "Left", justify: "Justified" }, "left", "look"),
  bool("postWrapAvatar", "Wrap around profile picture", false, "look"),
  bool("notify", "Push notifications", false, "notifications"),
  pick("reactionsData", "Reactions", ["auto", "full", "lite"], { auto: "Automatic", full: "Full", lite: "Light" }, "auto", "media"),
  pick("communityNotesData", "Community Notes", ["auto", "full", "lite"], { auto: "Automatic", full: "Full", lite: "Light" }, "auto", "media")
];
export const GROUPS = ["look", "feed", "media", "privacy", "language", "notifications"];
const BY_KEY = new Map(MANAGED.map((row) => [row.key, row]));
const NO_STORE = { "cache-control": "private, no-store" };

export function managedKey(key) { return BY_KEY.has(String(key || "")); }

/* { ok, value } for a value the owner may set; ok false otherwise. */
export function cleanValue(key, value) {
  const row = BY_KEY.get(String(key || ""));
  if (!row) return { ok: false };
  if (row.type === "bool") return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (row.type === "number") {
    const n = Number(value);
    return typeof value === "number" && row.values.indexOf(n) >= 0 ? { ok: true, value: n } : { ok: false };
  }
  return typeof value === "string" && row.values.indexOf(value) >= 0 ? { ok: true, value } : { ok: false };
}

let ready = null;
function ensureSchema(env) {
  if (!ready) ready = (async () => {
    await env.DB.batch(LOCKS_SCHEMA.map((sql) => env.DB.prepare(sql)));
    try { await env.DB.prepare("ALTER TABLE owner_setting_locks ADD COLUMN note TEXT NOT NULL DEFAULT ''").run(); } catch (err) { /* the column is already there */ }
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

export function lockNotes(locks) {
  const out = {};
  Object.keys(locks || {}).forEach((key) => { if (locks[key] && locks[key].note) out[key] = locks[key].note; });
  return out;
}

function clipNote(value) {
  return String(value || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 140);
}

function auditValue(value) {
  return JSON.stringify(value == null ? null : value).slice(0, 200);
}

/* { key: { value, at } } for one account. Missing table: no locks. */
export async function readLocks(env, publicId) {
  const out = {};
  if (!env || !env.DB || !publicId) return out;
  let rows = [];
  try { await ensureSchema(env); } catch (err) { /* a missing table still reads as no locks */ }
  try {
    const res = await env.DB.prepare("SELECT key, value, at, note FROM owner_setting_locks WHERE public_id = ?").bind(String(publicId)).all();
    rows = (res && res.results) || [];
  } catch (err) {
    try {
      const res = await env.DB.prepare("SELECT key, value, at FROM owner_setting_locks WHERE public_id = ?").bind(String(publicId)).all();
      rows = (res && res.results) || [];
    } catch (again) { return out; }
  }
  rows.forEach((row) => {
    let value;
    try { value = JSON.parse(row.value); } catch (err) { return; }
    const clean = cleanValue(row.key, value);
    if (clean.ok) out[row.key] = { value: clean.value, at: Number(row.at) || 0, note: String(row.note || "").slice(0, 140) };
  });
  return out;
}

/* Puts every locked value into a sync payload (and its prefsAt stamp, so
   last-write-wins merging on devices never prefers an older local value).
   Returns the keys that were changed. */
export function enforceLocks(payload, locks) {
  const changed = [];
  if (!payload || typeof payload !== "object" || !locks) return changed;
  Object.keys(locks).forEach((key) => {
    const lock = locks[key];
    if (!lock || !managedKey(key)) return;
    if (JSON.stringify(payload[key]) !== JSON.stringify(lock.value)) changed.push(key);
    payload[key] = lock.value;
    if (key === "lang") return;
    if (!payload.prefsAt || typeof payload.prefsAt !== "object" || Array.isArray(payload.prefsAt)) payload.prefsAt = {};
    payload.prefsAt[key] = Math.max(Number(payload.prefsAt[key]) || 0, lock.at || 0);
  });
  return changed;
}

/* What the member's devices get with /v1/sync: { key: value }. */
export function lockValues(locks) {
  const out = {};
  Object.keys(locks || {}).forEach((key) => { out[key] = locks[key].value; });
  return out;
}

async function loadPayload(env, id, deps) {
  const row = await env.DB.prepare("SELECT payload, updated_at FROM sync_state WHERE public_id = ?").bind(id).first();
  if (!row) return { payload: {}, updatedAt: 0, exists: false };
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch (err) { payload = null; }
  payload = await deps.openPayload(env, payload);
  return { payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, updatedAt: Number(row.updated_at) || 0, exists: true };
}

function currentValues(payload) {
  const out = {};
  MANAGED.forEach((row) => {
    const clean = cleanValue(row.key, payload[row.key]);
    out[row.key] = clean.ok ? clean.value : null;
  });
  return out;
}

function schemaOut() {
  return MANAGED.map((row) => {
    const out = { key: row.key, type: row.type, label: row.label, def: row.def, group: row.group };
    if (row.values) out.values = row.values.slice();
    if (row.valueLabels) out.valueLabels = Object.assign({}, row.valueLabels);
    return out;
  });
}

export async function handleOwnerUserSettings(request, env, path, deps) {
  const gate = await deps.requireOwner(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  const ownerId = String(gate.row.public_id);
  const write = request.method === "PUT" || request.method === "POST";
  if (request.method !== "GET" && !write) return deps.json(405, { error: "method_not_allowed" });
  const hit = await deps.rateHit(env, "owner-user-settings:" + (write ? "w:" : "r:") + ownerId, write ? 300 : 600, 10 * 60 * 1000);
  if (!hit.ok) return deps.limited(hit);
  try { await ensureSchema(env); } catch (err) { return deps.json(503, { error: "not_configured" }); }
  if (path === "/v1/owner/user-settings/bulk") return handleBulk(request, env, deps, ownerId);
  const m = path.match(/^\/v1\/owner\/user-settings\/([A-Za-z0-9_-]{1,64})$/);
  if (!m) return deps.json(404, { error: "not_found" });

  const target = await env.DB.prepare("SELECT public_id, handle, owner FROM accounts WHERE public_id = ?").bind(m[1]).first();
  if (!target) return deps.json(404, { error: "not_found" });
  const id = String(target.public_id);
  if (Number(target.owner) === 1) return deps.json(403, { error: "owner_account" });

  if (!write) {
    const saved = await loadPayload(env, id, deps);
    const locks = await readLocks(env, id);
    enforceLocks(saved.payload, locks);
    const audit = await readAudit(env, id);
    return deps.json(200, { id, handle: target.handle, settings: currentValues(saved.payload), locks: lockValues(locks), notes: lockNotes(locks), schema: schemaOut(), groups: GROUPS, audit, updatedAt: saved.updatedAt }, NO_STORE);
  }

  const body = await deps.readJson(request, 8000);
  if (body.error) return deps.json(400, { error: body.error });
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  const lockAsk = body.locks && typeof body.locks === "object" && !Array.isArray(body.locks) ? body.locks : {};
  const noteAsk = body.notes && typeof body.notes === "object" && !Array.isArray(body.notes) ? body.notes : {};
  const setKeys = Object.keys(values);
  const lockKeys = Object.keys(lockAsk);
  if (!setKeys.length && !lockKeys.length) return deps.json(400, { error: "nothing_to_change" });
  const cleaned = {};
  for (const key of setKeys) {
    const clean = cleanValue(key, values[key]);
    if (!clean.ok) return deps.json(400, { error: "bad_value", key: String(key).slice(0, 40) });
    cleaned[key] = clean.value;
  }
  for (const key of lockKeys) {
    if (!managedKey(key) || typeof lockAsk[key] !== "boolean") return deps.json(400, { error: "bad_lock", key: String(key).slice(0, 40) });
  }

  const now = Date.now();
  const saved = await loadPayload(env, id, deps);
  const payload = saved.payload;
  const locks = await readLocks(env, id);
  enforceLocks(payload, locks);
  if (!payload.prefsAt || typeof payload.prefsAt !== "object" || Array.isArray(payload.prefsAt)) payload.prefsAt = {};
  const stmts = [];
  Object.keys(cleaned).forEach((key) => {
    const before = payload[key];
    payload[key] = cleaned[key];
    if (key !== "lang") payload.prefsAt[key] = now;
    if (JSON.stringify(before) !== JSON.stringify(cleaned[key])) stmts.push(auditStmt(env, ownerId, id, key, before, cleaned[key], "set", now));
  });
  // A locked key keeps the value it has now (or its default when the member never set it).
  lockKeys.forEach((key) => {
    if (lockAsk[key]) {
      const row = BY_KEY.get(key);
      const clean = cleanValue(key, payload[key]);
      const value = clean.ok ? clean.value : row.def;
      const before = locks[key] ? locks[key].value : payload[key];
      payload[key] = value;
      if (key !== "lang") payload.prefsAt[key] = now;
      const note = clipNote(noteAsk[key] != null ? noteAsk[key] : (locks[key] && locks[key].note));
      locks[key] = { value, at: now, note };
      stmts.push(env.DB.prepare("INSERT INTO owner_setting_locks (public_id, key, value, owner_id, at, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(public_id, key) DO UPDATE SET value = excluded.value, owner_id = excluded.owner_id, at = excluded.at, note = excluded.note").bind(id, key, JSON.stringify(value), ownerId, now, note));
      stmts.push(auditStmt(env, ownerId, id, key, before, value, "lock", now));
    } else {
      const previous = locks[key] ? locks[key].value : null;
      delete locks[key];
      stmts.push(env.DB.prepare("DELETE FROM owner_setting_locks WHERE public_id = ? AND key = ?").bind(id, key));
      stmts.push(auditStmt(env, ownerId, id, key, previous, null, "unlock", now));
    }
  });
  // A new value for a key that stays locked moves the lock with it.
  Object.keys(cleaned).forEach((key) => {
    if (!locks[key] || lockAsk[key] === false) return;
    locks[key] = { value: cleaned[key], at: now };
    if (lockAsk[key] === true) return;
    stmts.push(env.DB.prepare("UPDATE owner_setting_locks SET value = ?, owner_id = ?, at = ? WHERE public_id = ? AND key = ?").bind(JSON.stringify(cleaned[key]), ownerId, now, id, key));
  });
  const text = JSON.stringify(await deps.sealPayload(env, payload));
  stmts.push(env.DB.prepare("INSERT INTO sync_state (public_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").bind(id, text, now));
  await env.DB.batch(stmts);
  await logOwnerView(env, ownerId, id, "settings");
  // The member's open devices pull the change right away.
  try { if (deps.publish) await deps.publish(env, id, "sync", { updatedAt: now, device: "owner" }, id); } catch (err) { /* they check on return */ }
  return deps.json(200, { id, handle: target.handle, settings: currentValues(payload), locks: lockValues(locks), notes: lockNotes(locks), audit: await readAudit(env, id), updatedAt: now }, NO_STORE);
}

function auditStmt(env, ownerId, id, key, oldValue, newValue, change, now) {
  return env.DB.prepare("INSERT INTO owner_setting_audit (at, owner_id, public_id, key, old_value, new_value, change) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(now, ownerId, id, key, auditValue(oldValue), auditValue(newValue), change);
}

async function readAudit(env, id) {
  try {
    const res = await env.DB.prepare("SELECT at, key, old_value, new_value, change FROM owner_setting_audit WHERE public_id = ? ORDER BY at DESC LIMIT 40").bind(id).all();
    return ((res && res.results) || []).map((row) => ({ at: Number(row.at) || 0, key: row.key, from: row.old_value, to: row.new_value, change: row.change }));
  } catch (err) { return []; }
}

async function handleBulk(request, env, deps, ownerId) {
  if (request.method !== "POST") return deps.json(405, { error: "method_not_allowed" });
  const body = await deps.readJson(request, 8000);
  if (body.error) return deps.json(400, { error: body.error });
  const locks = body.locks && typeof body.locks === "object" && !Array.isArray(body.locks) ? body.locks : {};
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  const keys = Object.keys(locks);
  if (!keys.length) return deps.json(400, { error: "nothing_to_change" });
  for (const key of keys) {
    if (!managedKey(key) || typeof locks[key] !== "boolean") return deps.json(400, { error: "bad_lock", key: String(key).slice(0, 40) });
  }
  const listed = await env.DB.prepare("SELECT public_id FROM accounts WHERE owner = 0 ORDER BY public_id LIMIT 500").all();
  const ids = ((listed && listed.results) || []).map((row) => String(row.public_id));
  if (body.confirm !== "apply") return deps.json(200, { preview: true, count: ids.length, keys }, NO_STORE);
  if (Number(body.count) !== ids.length) return deps.json(409, { error: "preview_stale", count: ids.length });
  const cleaned = {};
  for (const key of keys) {
    if (!locks[key]) continue;
    const clean = cleanValue(key, values[key]);
    if (!clean.ok) return deps.json(400, { error: "bad_value", key: String(key).slice(0, 40) });
    cleaned[key] = clean.value;
  }
  const now = Date.now();
  for (const id of ids) {
    const saved = await loadPayload(env, id, deps);
    const payload = saved.payload;
    const have = await readLocks(env, id);
    enforceLocks(payload, have);
    const stmts = [];
    if (!payload.prefsAt || typeof payload.prefsAt !== "object" || Array.isArray(payload.prefsAt)) payload.prefsAt = {};
    keys.forEach((key) => {
      if (locks[key]) {
        const value = cleaned[key];
        payload[key] = value;
        if (key !== "lang") payload.prefsAt[key] = now;
        stmts.push(env.DB.prepare("INSERT INTO owner_setting_locks (public_id, key, value, owner_id, at, note) VALUES (?, ?, ?, ?, ?, '') ON CONFLICT(public_id, key) DO UPDATE SET value = excluded.value, owner_id = excluded.owner_id, at = excluded.at").bind(id, key, JSON.stringify(value), ownerId, now));
        stmts.push(auditStmt(env, ownerId, id, key, have[key] ? have[key].value : null, value, "lock", now));
      } else if (have[key]) {
        stmts.push(env.DB.prepare("DELETE FROM owner_setting_locks WHERE public_id = ? AND key = ?").bind(id, key));
        stmts.push(auditStmt(env, ownerId, id, key, have[key].value, null, "unlock", now));
      }
    });
    const text = JSON.stringify(await deps.sealPayload(env, payload));
    stmts.push(env.DB.prepare("INSERT INTO sync_state (public_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").bind(id, text, now));
    await env.DB.batch(stmts);
    try { if (deps.publish) await deps.publish(env, id, "sync", { updatedAt: now, device: "owner" }, id); } catch (err) { /* they check on return */ }
  }
  return deps.json(200, { preview: false, count: ids.length, keys }, NO_STORE);
}
