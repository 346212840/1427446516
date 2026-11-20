/* Phone details that do not belong to one call: unlocking audio on iOS,
   keeping the screen awake where the Wake Lock API is missing, and moving
   the Opus bitrate when the link gets worse. Nothing here touches the network. */

/* A 1 s black 16x16 clip. A looping muted video keeps iOS from dimming the
   screen when navigator.wakeLock is missing (older iOS, some installed apps). */
export const NOSLEEP_MP4 = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMAEDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABRoAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAAAgAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAACgwAAAAoAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjEuNy4xMDMAAAAIZnJlZQAAApVtZGF0AAACcAYF//9s3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAAtliIQFPJigAD+/gAAAAAZBmjgJeoA=";

export const BITRATES = [64000, 32000, 24000, 16000];

/* One step per sample, with hysteresis: worse quickly, better slowly.
   prev = { level, good }. sample = { loss (0..1), rtt (seconds) }. */
export function pickBitrate(prev, sample) {
  const p = prev || { level: 0, good: 0 };
  const loss = Number(sample && sample.loss) || 0;
  const rtt = Number(sample && sample.rtt) || 0;
  let level = p.level;
  let good = p.good;
  const bad = loss >= 0.1 ? 3 : loss >= 0.04 || rtt >= 0.6 ? 2 : loss >= 0.015 || rtt >= 0.35 ? 1 : 0;
  if (bad > level) { level = bad; good = 0; }
  else if (bad < level) { good += 1; if (good >= 3) { level -= 1; good = 0; } }
  else good = 0;
  return { level: level, good: good, bitrate: BITRATES[level] };
}

/* How far ahead of "now" a translated chunk is scheduled. A short lead keeps
   the first sound quick on a good link. When chunks arrive late (the audio ran
   dry in the middle of a phrase) the lead grows, so mobile data with 300 ms of
   round trip and a few percent loss plays smoothly. After 20 s without a gap
   it shrinks again. floor() takes the link level from pickBitrate. */
export const LEAD_MIN = 0.06;
export const LEAD_MAX = 0.5;
const LEAD_FLOOR = [0.06, 0.1, 0.16, 0.24];
export function createPlayoutLead() {
  let lead = LEAD_MIN;
  let floor = LEAD_MIN;
  let calm = 0;
  let gaps = 0;
  return {
    /* t = audio clock now, nextAt = where the previous chunk ends (0 before the first). */
    plan(t, nextAt, dur) {
      if (nextAt - t > 0.9) return null;
      let start = nextAt;
      if (nextAt > 0 && nextAt <= t && t - nextAt < 0.6) {
        gaps += 1;
        calm = 0;
        lead = Math.min(LEAD_MAX, Math.max(lead, floor) + 0.08);
      } else if (nextAt > 0 && nextAt > t) {
        calm += dur;
        if (calm >= 20) { calm = 0; lead = Math.max(floor, lead - 0.04); }
      }
      if (nextAt < t + 0.02) start = t + Math.max(lead, floor);
      return { start: start, next: start + dur };
    },
    floor(level) { floor = LEAD_FLOOR[Math.max(0, Math.min(3, level | 0))]; if (lead < floor) lead = floor; },
    reset() { calm = 0; },
    stats() { return { lead: lead, floor: floor, gaps: gaps }; }
  };
}

/* The audio context is created and resumed inside a tap, because iOS keeps a
   context made later (after a fetch) suspended. The call engine reuses it. */
export function createAudioUnlock(win) {
  const w = win || (typeof window !== "undefined" ? window : {});
  const AC = w.AudioContext || w.webkitAudioContext;
  const api = { ac: null, bound: false };
  function silence(ctx) {
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch (err) { /* the resume below is what matters */ }
  }
  api.unlock = function unlock() {
    if (!AC) return null;
    try {
      if (!api.ac || api.ac.state === "closed") api.ac = new AC({ latencyHint: "interactive" });
      if (api.ac.state !== "running") { const p = api.ac.resume(); if (p && p.catch) p.catch(() => {}); }
      silence(api.ac);
    } catch (err) { /* no audio on this device */ }
    return api.ac;
  };
  /* A context that is still usable, or null. */
  api.get = function get() { return api.ac && api.ac.state !== "closed" ? api.ac : null; };
  api.bind = function bind(doc) {
    if (api.bound || !doc || !doc.addEventListener) return;
    api.bound = true;
    ["pointerdown", "touchend", "click", "keydown"].forEach((name) => doc.addEventListener(name, () => api.unlock(), { capture: true, passive: true }));
  };
  return api;
}

/* The iOS and Safari 16.4+ audio session. play-and-record keeps the
   microphone and speaker live together and lets the call survive the
   ringer switch. Everywhere else this does nothing. */
export function setAudioSession(nav, type) {
  try {
    if (nav && nav.audioSession && typeof nav.audioSession.type === "string") { nav.audioSession.type = type; return true; }
  } catch (err) { /* not supported */ }
  return false;
}

export function createWakeFallback(doc) {
  let el = null;
  return {
    on() {
      try {
        if (!doc || el) return;
        el = doc.createElement("video");
        el.setAttribute("playsinline", "");
        el.setAttribute("muted", "");
        el.muted = true;
        el.loop = true;
        el.setAttribute("aria-hidden", "true");
        el.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;top:0";
        el.src = NOSLEEP_MP4;
        doc.body.appendChild(el);
        const p = el.play();
        if (p && p.catch) p.catch(() => { /* needs a tap; the next tap retries */ });
      } catch (err) { el = null; }
    },
    off() {
      try { if (el) { el.pause(); el.removeAttribute("src"); el.load(); if (el.remove) el.remove(); } } catch (err) { /* gone */ }
      el = null;
    },
    active() { return !!el; }
  };
}

/* Why getUserMedia failed, as the Allow microphone popup needs it.
   perm is the Permissions API state ("prompt", "denied", "granted" or "unknown").
   kind: prompt = ask again, denied = blocked, busy = another app holds it or it
   would not start, none = no microphone. os = the browser says allowed but the
   phone itself blocks it. dismissed = the person closed the prompt. */
export function micFailure(err, perm) {
  const name = String((err && err.name) || "");
  const message = String((err && err.message) || "");
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (/dismiss/i.test(message)) return { kind: "prompt", dismissed: true, os: false };
    if (perm === "granted") return { kind: "denied", dismissed: false, os: true };
    return { kind: "denied", dismissed: false, os: false };
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return { kind: "busy", dismissed: false, os: false };
  return { kind: "none", dismissed: false, os: false };
}

/* Which set of unblock steps fits this device. installed = a home-screen app. */
export function micPlatform(ua, installed) {
  const s = String(ua || "");
  const ios = /iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && /Mobile/.test(s));
  const android = /Android/.test(s);
  if (ios) return "ios";
  if (android) return installed ? "android-app" : "android";
  return "desktop";
}
