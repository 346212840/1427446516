/* Live-call status line and when the screen may remount.
   A brief ICE or signaling blip must not flash "Reconnecting" or rebuild
   the chat (that drops focus, scroll, and typed text). */

export const RECONNECT_HOLD_MS = 2000;

const HEALTHY = { connected: 1, joined: 1, "translating-ready": 1 };

export function applyStatusCode(prev, code) {
  if (code === "translating-ready") {
    if (!prev || prev === "reconnecting" || prev === "translator-reconnecting") return "connected";
    return prev;
  }
  if (code === "translator-reconnecting") {
    return prev && HEALTHY[prev] ? prev : (prev || "connected");
  }
  return code;
}

export function holdStatus(prev, code, now, heldAt, holdMs) {
  const ms = holdMs == null ? RECONNECT_HOLD_MS : holdMs;
  if (code === "connected" || code === "joined") {
    return { code: code, heldAt: 0 };
  }
  if (code === "reconnecting" && prev && HEALTHY[prev]) {
    if (!heldAt) return { code: prev, heldAt: now };
    if (now - heldAt < ms) return { code: prev, heldAt: heldAt };
  }
  return { code: applyStatusCode(prev, code), heldAt: 0 };
}

export function shouldRemountOnStatus(phase, code) {
  return (code === "joined" || code === "connected") && phase !== "active";
}

export function shouldRemountOnPeer(prev, next) {
  const name = (next && next.name) || "";
  const degraded = !!(next && next.degraded);
  if (!prev) return true;
  return (name !== "" && name !== (prev.name || "")) || degraded !== !!prev.degraded;
}

export function iceAlreadyUp(state) {
  return state === "connected" || state === "completed";
}

export function signalOpenRestores(iceState, peerJoined) {
  return !!(peerJoined || iceAlreadyUp(iceState));
}

/* Distinct peers cap the room at two. A reconnect from the same peer
   replaces its existing socket instead of being rejected as "full". */
export function signalAdmit(open, peer) {
  const list = Array.isArray(open) ? open : [];
  const stale = [];
  const others = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (row && row.peer === peer) stale.push(row);
    else others.push(row);
  }
  if (others.length >= 2) return { ok: false, stale: [], others: others };
  return { ok: true, stale: stale, others: others };
}
