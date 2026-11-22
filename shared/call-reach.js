/* Call the owner and Request a call (calls_owner_reach). Shared by the
   Worker and the Calls page so both apply the same limits. */

export const REQUEST_TOKEN = /^cq1\.[A-Za-z0-9_-]{8,80}$/;
export const REQUEST_STATES = ["pending", "accepted", "suggested", "declined", "cancelled"];
export const NAME_MAX = 40;
export const NOTE_MAX = 280;
export const REQUEST_MIN_AHEAD_MS = 15 * 60 * 1000;
export const REQUEST_MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_PER_SOURCE = 3;
export const MAX_PENDING_TOTAL = 40;

/* Links, e-mail addresses and phone-number runs are the usual spam payload: a request is a name, a time and a short note. */
export function looksSpammy(text) {
  const t = String(text || "");
  return /(https?:\/\/|www\.|\.[a-z]{2,6}\/|@[a-z0-9-]+\.[a-z]{2,}|\+?\d[\d\s().-]{8,}\d)/i.test(t);
}

export function cleanReachText(value, max) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/* A start time the visitor picked in their own timezone arrives as UTC ms. */
export function requestWhenOk(startsAt, now) {
  const at = Number(startsAt) || 0;
  const t = Number(now) || Date.now();
  return at >= t + REQUEST_MIN_AHEAD_MS && at <= t + REQUEST_MAX_AHEAD_MS;
}

export function cleanZone(value) {
  const z = String(value || "").trim();
  return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(z) && z.length <= 48 ? z : "";
}
