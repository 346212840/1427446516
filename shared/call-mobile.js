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
