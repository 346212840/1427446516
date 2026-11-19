/* Who may place a call. The Worker uses the same decision as the tests.
   A block wins over every other choice. Invite links follow the host's
   guest switch and ignore "who can call me". */

export const WHO = ["everyone", "circle", "nobody"];

export function cleanWho(value) {
  return WHO.indexOf(value) >= 0 ? value : "everyone";
}

export function minutesOf(clock) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock || ""));
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/* tz is minutes east of UTC, the offset the browser reports. */
export function dndActive(prefs, nowMs) {
  if (!prefs || !prefs.dnd) return false;
  const start = minutesOf(prefs.dndStart || "22:00");
  const end = minutesOf(prefs.dndEnd || "07:00");
  if (start == null || end == null) return false;
  const offset = Number(prefs.tz) || 0;
  const local = new Date((Number(nowMs) || 0) + offset * 60000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (start === end) return true;
  if (start < end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

export function callDecision(input) {
  const row = input || {};
  if (row.self) return { ok: false, reason: "self" };
  if (row.blocked) return { ok: false, reason: "blocked" };
  if (row.invite) {
    if (row.guests === false) return { ok: false, reason: "guests" };
    return { ok: true, reason: "invite" };
  }
  if (row.dnd) return { ok: false, reason: "dnd" };
  const who = cleanWho(row.who);
  if (who === "nobody") return { ok: false, reason: "nobody" };
  if (who === "circle" && !row.follows && !row.mutual) return { ok: false, reason: "circle" };
  return { ok: true, reason: "ok" };
}
