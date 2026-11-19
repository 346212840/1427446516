/* Ear mode helpers. Browsers have no proximity sensor, so the phone raised upright to the ear is
   approximated from DeviceOrientation, and the touch-locking overlay is told apart from a cheek
   by contact size and by how many fingers land at once. Pure logic, no DOM, so it can be tested. */

const UPRIGHT_MIN = 72;
const UPRIGHT_MAX = 115;
const SIDE_MAX = 50;
const VIEWING_MAX = 65;
const HOLD_MS = 600;
const RAISE_WINDOW_MS = 2500;
const SETTLE_MS = 400;
const SETTLE_SPREAD = 6;
const LOWER_BETA = 45;
const LOWER_MS = 800;

export const EAR_VOLUME_CAP = 0.55;

export function isUpright(beta, gamma) {
  return Number.isFinite(beta) && Number.isFinite(gamma) && beta >= UPRIGHT_MIN && beta <= UPRIGHT_MAX && Math.abs(gamma) <= SIDE_MAX;
}

/* feed({ beta, gamma, t }) returns "ear" once the phone is raised to the ear, "away" when a phone
   that went into ear mode by itself is lowered again, or "" the rest of the time. */
export function createRaiseDetector() {
  let uprightSince = 0;
  let lastViewing = -Infinity;
  let inEar = false;
  let lowSince = 0;
  let samples = [];
  const api = {
    feed(row) {
      const beta = Number(row && row.beta);
      const gamma = Number(row && row.gamma);
      const t = Number(row && row.t);
      if (!Number.isFinite(beta) || !Number.isFinite(gamma) || !Number.isFinite(t)) return "";
      samples.push([t, beta]);
      while (samples.length && t - samples[0][0] > SETTLE_MS) samples.shift();
      if (inEar) {
        if (beta < LOWER_BETA) {
          if (!lowSince) lowSince = t;
          if (t - lowSince >= LOWER_MS) { inEar = false; lowSince = 0; uprightSince = 0; lastViewing = -Infinity; return "away"; }
        } else lowSince = 0;
        return "";
      }
      if (beta < VIEWING_MAX) lastViewing = t;
      if (!isUpright(beta, gamma)) { uprightSince = 0; return ""; }
      if (!uprightSince) uprightSince = t;
      if (t - uprightSince < HOLD_MS) return "";
      if (uprightSince - lastViewing > RAISE_WINDOW_MS) return "";
      const lo = Math.min.apply(null, samples.map((s) => s[1]));
      const hi = Math.max.apply(null, samples.map((s) => s[1]));
      if (hi - lo > SETTLE_SPREAD) return "";
      inEar = true;
      lowSince = 0;
      return "ear";
    },
    markEar(on) { inEar = !!on; lowSince = 0; uprightSince = 0; if (!on) lastViewing = -Infinity; },
    reset() { uprightSince = 0; lastViewing = -Infinity; inEar = false; lowSince = 0; samples = []; }
  };
  return api;
}

/* The earpiece output, when the browser lists one. Never a Bluetooth or wired output. */
export function earSinkId(devices) {
  const outs = (Array.isArray(devices) ? devices : []).filter((item) => item && item.kind === "audiooutput");
  const hit = outs.find((item) => /earpiece|receiver|handset|telephone/i.test(String(item.label || "")) && !/bluetooth|headset|buds|airpod/i.test(String(item.label || "")));
  return hit && hit.deviceId ? String(hit.deviceId) : "";
}

/* A cheek or a palm: a wide contact, or more than one finger at the same time. */
export function cheekLike(ev) {
  const w = Number(ev && ev.width) || 0;
  const h = Number(ev && ev.height) || 0;
  return Math.max(w, h) > 40;
}

/* Touch-lock gestures. Only a double tap or a deliberate swipe up unlocks.
   Feed it down/move/up with a pointer id, position, time and contact size. */
export function createUnlocker() {
  const DOUBLE_MS = 400;
  const DOUBLE_PX = 70;
  const TAP_MS = 250;
  const TAP_PX = 14;
  const SWIPE_PX = 120;
  const SWIPE_MS = 900;
  const SWIPE_SIDE = 100;
  const down = {};
  let tainted = false;
  let lastTap = null;
  const api = {
    down(id, x, y, t, ev) {
      if (Object.keys(down).length >= 1) tainted = true;
      if (cheekLike(ev)) tainted = true;
      down[id] = { x, y, t, px: x, py: y };
    },
    move(id, x, y) { if (down[id]) { down[id].px = x; down[id].py = y; } },
    up(id, x, y, t) {
      const d = down[id];
      if (!d) return "";
      delete down[id];
      const wasTainted = tainted;
      if (!Object.keys(down).length) tainted = false;
      if (wasTainted) { lastTap = null; return ""; }
      const dx = x - d.x;
      const dy = y - d.y;
      const dt = t - d.t;
      if (dy <= -SWIPE_PX && Math.abs(dx) <= SWIPE_SIDE && dt <= SWIPE_MS) { lastTap = null; return "unlock"; }
      if (dt <= TAP_MS && Math.hypot(dx, dy) <= TAP_PX) {
        if (lastTap && t - lastTap.t <= DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLE_PX) { lastTap = null; return "unlock"; }
        lastTap = { x, y, t };
      } else lastTap = null;
      return "";
    },
    cancel(id) { delete down[id]; if (!Object.keys(down).length) tainted = false; },
    reset() { Object.keys(down).forEach((k) => delete down[k]); tainted = false; lastTap = null; }
  };
  return api;
}
