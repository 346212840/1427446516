/* The unlock list from PR #207: the TIKTOK_UNLOCKED secret, then
   owner/tiktok-unlocked.json in R2. One reader. Callers decide what to hide.
   Moved here so notifications can use it without importing the worker entry. */

function rememberHandle(found, seen, name) {
  const clean = String(name || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{2,24}$/.test(clean)) return;
  const key = clean.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  found.push(clean);
}

async function readText(env, key) {
  if (!env || !env.DATA || typeof env.DATA.get !== "function" || !key) return "";
  try {
    const object = await env.DATA.get(key);
    return object && typeof object.text === "function" ? await object.text() : "";
  } catch (err) {
    return "";
  }
}

async function readJsonObject(env, key) {
  let text = await readText(env, key);
  if (!String(text || "").trim()) text = await readText(env, "lastgood/" + key);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
}

export async function unlockedHandles(env) {
  const found = [];
  const seen = new Set();
  String((env && env.TIKTOK_UNLOCKED) || "").split(/[\s,]+/).forEach((part) => rememberHandle(found, seen, part));
  const doc = await readJsonObject(env, "owner/tiktok-unlocked.json");
  const list = doc && (doc.handles || doc.unlocked || []);
  if (Array.isArray(list)) {
    list.forEach((item) => rememberHandle(found, seen, typeof item === "string" ? item : item && item.handle));
  }
  return found;
}

export function tiktokAudienceAll(env) {
  return String((env && env.TIKTOK_AUDIENCE) || "owner") === "all";
}

/* Handles from the TIKTOK_UNLOCKED secret. The app cannot lock these again;
   only the owner can change that secret. */
export function fixedUnlocked(env) {
  const found = [];
  const seen = new Set();
  String((env && env.TIKTOK_UNLOCKED) || "").split(/[\s,]+/).forEach((part) => rememberHandle(found, seen, part));
  return found;
}

const UNLOCK_KEY = "owner/tiktok-unlocked.json";
export const UNLOCK_CAP = 200;

/* Unlock or lock one handle in owner/tiktok-unlocked.json. Returns
   { ok, error } where error is "fixed" (in the secret) or "full". */
export async function setUnlocked(env, handle, on) {
  const clean = String(handle || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{2,24}$/.test(clean)) return { ok: false, error: "bad_handle" };
  const key = clean.toLowerCase();
  if (!on && fixedUnlocked(env).some((name) => name.toLowerCase() === key)) return { ok: false, error: "fixed" };
  const doc = await readJsonObject(env, UNLOCK_KEY) || {};
  const raw = Array.isArray(doc.handles) ? doc.handles : (Array.isArray(doc.unlocked) ? doc.unlocked : []);
  const list = [];
  const seen = new Set();
  raw.forEach((item) => rememberHandle(list, seen, typeof item === "string" ? item : item && item.handle));
  const next = list.filter((name) => name.toLowerCase() !== key);
  if (on) {
    if (next.length >= UNLOCK_CAP) return { ok: false, error: "full" };
    next.push(clean);
  }
  const body = JSON.stringify({ handles: next, updatedAt: new Date().toISOString() });
  const meta = { httpMetadata: { contentType: "application/json; charset=utf-8" } };
  await env.DATA.put(UNLOCK_KEY, body, meta);
  try { await env.DATA.put("lastgood/" + UNLOCK_KEY, body, meta); } catch (err) { /* the primary copy is stored */ }
  return { ok: true };
}
