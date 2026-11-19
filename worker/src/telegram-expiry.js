/* Marks a Telegram-backed row when getFile says the bytes are gone.
   The row stays. file_id is not returned to the browser. */

import { safeTelegramPath } from "./telegram.js";
import { telegramFileGone, telegramStampMs } from "../../shared/telegram-expiry.js";

let columnsReady = null;

export function ensureTelegramExpiryColumns(env) {
  if (!env || !env.DB) return Promise.resolve();
  if (!columnsReady) {
    columnsReady = applyColumns(env).catch((err) => {
      columnsReady = null;
      throw err;
    });
  }
  return columnsReady;
}

async function applyColumns(env) {
  const statements = [
    "ALTER TABLE telegram_files ADD COLUMN expired_at INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE drive_chunks ADD COLUMN expired_at INTEGER NOT NULL DEFAULT 0"
  ];
  for (let i = 0; i < statements.length; i++) {
    try {
      await env.DB.prepare(statements[i]).run();
    } catch (err) {
      const message = String(err && err.message || err);
      if (!/duplicate column|no such table/i.test(message)) throw err;
    }
  }
}

/* A later index write means the file id may have been replaced. One more
   getFile is allowed. The same row is not asked again after that. */
export function freshExpired(row) {
  const marked = Number(row && row.expired_at) || 0;
  if (marked <= 0) return false;
  const touched = telegramStampMs(row && row.updated_at);
  return !(touched > marked);
}

export async function markTelegramExpired(env, row, now) {
  if (!env || !env.DB || !row || !row.object_key) return 0;
  await ensureTelegramExpiryColumns(env);
  const at = Number(now) || Date.now();
  await env.DB.prepare(
    "UPDATE telegram_files SET expired_at = ? WHERE object_key = ? AND kind = ? AND part_index = ?"
  ).bind(at, row.object_key, row.kind, row.part_index).run();
  row.expired_at = at;
  return at;
}

export async function markDriveChunkExpired(env, itemId, part, now) {
  if (!env || !env.DB || !itemId) return 0;
  await ensureTelegramExpiryColumns(env);
  const at = Number(now) || Date.now();
  await env.DB.prepare(
    "UPDATE drive_chunks SET expired_at = ? WHERE item_id = ? AND part_index = ?"
  ).bind(at, itemId, Math.floor(Number(part) || 0)).run();
  return at;
}

async function probe(env, fileId) {
  const token = String(env && env.TELEGRAM_BOT_TOKEN || "");
  if (!token || !fileId) return { error: "unavailable" };
  let data = null;
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + encodeURIComponent(fileId));
    data = await res.json();
  } catch (err) {
    return { error: "unavailable" };
  }
  if (telegramFileGone(data)) return { error: "expired" };
  const path = safeTelegramPath(data && data.ok && data.result && data.result.file_path);
  if (!path) return { error: "unavailable" };
  return { token: token, path: path };
}

async function downloadPath(token, path) {
  try {
    const upstream = await fetch("https://api.telegram.org/file/bot" + token + "/" + path);
    if (upstream.status === 404) return { missing: true };
    if (!upstream.ok) return { error: "unavailable" };
    return { bytes: new Uint8Array(await upstream.arrayBuffer()) };
  } catch (err) {
    return { error: "unavailable" };
  }
}

/* One getFile, and one more only when the file URL itself is missing.
   A temporary failure is not expiry. */
export async function readTelegramBytes(env, fileId) {
  const first = await probe(env, fileId);
  if (first.error) return first;
  const got = await downloadPath(first.token, first.path);
  if (got.bytes) return { bytes: got.bytes };
  if (!got.missing) return { error: got.error || "unavailable" };
  const second = await probe(env, fileId);
  if (second.error === "expired") return { error: "expired" };
  if (second.error || !second.path) return { error: second.error || "unavailable" };
  const again = await downloadPath(second.token, second.path);
  if (again.bytes) return { bytes: again.bytes };
  if (again.missing) return { error: "expired" };
  return { error: again.error || "unavailable" };
}
