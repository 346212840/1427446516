/* Scheduled call invites. Tokens, join window, and a calendar file
   with a 15-minute alarm and an at-start alarm. The Worker and the
   Calls page share this so the file matches what the reminder uses. */

export const SCHEDULE_TOKEN = /^cs1\.[A-Za-z0-9_-]{8,80}$/;
export const JOIN_EARLY_MS = 10 * 60 * 1000;
export const REMIND_MS = 15 * 60 * 1000;
export const MIN_AHEAD_MS = 60 * 1000;
export const MAX_AHEAD_MS = 180 * 24 * 60 * 60 * 1000;
export const MIN_DURATION = 5;
export const MAX_DURATION = 180;
export const DEFAULT_DURATION = 30;

export function parseStartsAt(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d{13}$/.test(text)) return Number(text);
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : 0;
}

export function clipDuration(value) {
  const n = Math.floor(Number(value) || DEFAULT_DURATION);
  if (n < MIN_DURATION) return DEFAULT_DURATION;
  if (n > MAX_DURATION) return MAX_DURATION;
  return n;
}

export function endsAt(startsAt, durationMin) {
  return Number(startsAt) + clipDuration(durationMin) * 60 * 1000;
}

export function canJoin(startsAt, durationMin, now) {
  const start = Number(startsAt) || 0;
  const at = Number(now) || 0;
  if (!start || !at) return false;
  return at >= start - JOIN_EARLY_MS && at <= endsAt(start, durationMin);
}

/* Which reminder or miss flag should flip for this row at `at`. */
export function remindPlan(row, at) {
  const start = Number(row && row.starts_at) || 0;
  const state = String((row && row.state) || "");
  const dur = clipDuration(row && row.duration_min);
  const now = Number(at) || 0;
  if (!start || state !== "scheduled") return { remind15: false, remindStart: false, miss: false };
  const in15 = start - REMIND_MS;
  return {
    remind15: !Number(row.reminded_15) && now >= in15 && now < start,
    remindStart: !Number(row.reminded_start) && now >= start && now < start + 2 * 60 * 1000,
    miss: !row.call_id && now > endsAt(start, dur)
  };
}

function icsEscape(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function icsStamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function icsForSchedule(info) {
  const start = Number(info && info.startsAt) || Date.now();
  const end = endsAt(start, info && info.durationMin);
  const title = String((info && info.title) || "");
  const url = String((info && info.url) || "");
  const desc = [info && info.description, url].filter(Boolean).join("\\n");
  const uid = String((info && info.uid) || ("cs-" + start)) + "@viktorych";
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Viktorych//Calls//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + uid,
    "DTSTAMP:" + icsStamp(Date.now()),
    "DTSTART:" + icsStamp(start),
    "DTEND:" + icsStamp(end),
    "SUMMARY:" + icsEscape(title),
    "DESCRIPTION:" + icsEscape(desc.replace(/\\n/g, "\n")),
    url ? "URL:" + icsEscape(url) : "",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:" + icsEscape("Call starts in 15 minutes"),
    "TRIGGER:-PT15M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:" + icsEscape("Call starting"),
    "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ].filter((line) => line !== "").join("\r\n");
}
