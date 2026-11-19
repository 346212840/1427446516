/* Telegram backup auto-delete. A channel that deletes messages after one
   year makes getFile say the file is gone. That is not a crash, and the
   date alone does not delete a row. */

export const TELEGRAM_KEEP_MS = 365 * 24 * 60 * 60 * 1000;
export const TELEGRAM_SOON_MS = 30 * 24 * 60 * 60 * 1000;

export function telegramStampMs(value) {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/* Telegram's own wording when a file_id no longer has bytes. A temporary
   outage is not expiry. */
export function telegramFileGone(payload) {
  if (!payload || payload.ok === true) return false;
  const desc = String(payload.description || "").toLowerCase();
  if (!desc || desc.indexOf("temporarily unavailable") >= 0) return false;
  if (desc.indexOf("file not found") >= 0) return true;
  if (desc.indexOf("permanently unavailable") >= 0) return true;
  if (desc.indexOf("wrong file identifier") >= 0) return true;
  return desc.indexOf("file") >= 0 && desc.indexOf("expired") >= 0;
}

export function expiryHint(uploadedAt, now) {
  const uploaded = telegramStampMs(uploadedAt);
  if (!uploaded) return null;
  const at = Number(now) || 0;
  const expiresAt = uploaded + TELEGRAM_KEEP_MS;
  const left = at ? expiresAt - at : TELEGRAM_KEEP_MS;
  return {
    uploadedAt: uploaded,
    expiresAt: expiresAt,
    soon: at > 0 && left > 0 && left <= TELEGRAM_SOON_MS,
    past: at > 0 && left <= 0
  };
}

export function expiredBody(uploadedAt, now) {
  const hint = expiryHint(uploadedAt, now || Date.now());
  return {
    error: "expired",
    uploadedAt: hint ? hint.uploadedAt : 0,
    expiresAt: hint ? hint.expiresAt : 0
  };
}
