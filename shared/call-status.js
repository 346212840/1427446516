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

/* ICE is clearly down; a signaling reopen must not show Connected. */
export function iceClearlyDown(state) {
  return state === "failed" || state === "disconnected" || state === "closed";
}

export function signalOpenRestores(iceState, peerJoined) {
  if (iceClearlyDown(iceState)) return false;
  return !!(peerJoined || iceAlreadyUp(iceState));
}

/* Fresh TURN / STUN from a later ticket replace the current set. */
export function iceConfigWithServers(current, iceServers) {
  if (!Array.isArray(iceServers) || !iceServers.length) return null;
  const base = current && typeof current === "object" ? Object.assign({}, current) : { bundlePolicy: "max-bundle" };
  return Object.assign({}, base, { iceServers: iceServers });
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

/* After the phone was locked or backgrounded, a Live socket can still look
   open (readyState 1) while it is dead. Refresh it when the tab was hidden
   long enough, or when it has been idle longer than a keep-alive. */
export const FOREGROUND_PIPE_MS = 8000;
export const LIVE_PIPE_IDLE_MS = 60 * 1000;

export function shouldRefreshLivePipe(hiddenMs, lastAct, now, hiddenLimit, idleLimit) {
  if ((Number(hiddenMs) || 0) >= (hiddenLimit == null ? FOREGROUND_PIPE_MS : hiddenLimit)) return true;
  return (Number(now) || 0) - (Number(lastAct) || 0) >= (idleLimit == null ? LIVE_PIPE_IDLE_MS : idleLimit);
}

/* A getUserMedia stream is only usable while at least one audio track is live. */
export function micTrackLive(stream) {
  if (!stream || typeof stream.getAudioTracks !== "function") return false;
  return stream.getAudioTracks().some((track) => track && track.readyState === "live");
}
