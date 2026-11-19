/* Call audio math. No browser, no network: gains, the jitter buffer,
   reconnect delays, and the three latency clocks the call screen reports. */

export const VOLUME_DEFAULTS = {
  translation: 0.85,
  original: 0.28,
  overall: 1,
  ring: 0.7,
  mic: 1,
  tts: 0.85
};

export const VOLUME_KEYS = Object.keys(VOLUME_DEFAULTS);

/* Audio only. There is no camera path. */
export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1
};
export const OPUS_MAX_BITRATE = 510000;

const PCM_MS = 100;
const MAX_JITTER = 4;
const SOAK_CAP = 6;

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function normalizeVolumes(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  VOLUME_KEYS.forEach((key) => { out[key] = clamp01(src[key], VOLUME_DEFAULTS[key]); });
  return out;
}

/* original is the ducked level the listener chose. Between phrases it
   restores upward. overall scales the call, not the ringtone or the mic.
   TTS has its own slider. Missing streams stay at 0 so a mode change
   does not pop a buffer that should be silent. */
export function outputGains(volumes, state) {
  const v = normalizeVolumes(volumes);
  const flags = state || {};
  let original = v.original;
  if (!flags.translating && original > 0) original = Math.min(1, Math.max(original, original / 0.35));
  if (!flags.hearOriginal) original = 0;
  return {
    original: original * v.overall,
    translation: flags.playTranslation ? v.translation * v.overall : 0,
    tts: flags.playTts ? v.tts : 0,
    mic: v.mic,
    ring: v.ring
  };
}

export function reconnectDelay(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(15000, 500 * (2 ** Math.min(n, 5)));
}

/* Plays the first chunk immediately. Grows the target only after an
   underrun, and drops stale audio so a long call cannot pile up. */
export function createJitter(nowFn) {
  const now = nowFn || (() => 0);
  const queue = [];
  let target = 0;
  let underruns = 0;
  let dropped = 0;
  let played = 0;
  let firstIn = 0;
  let firstOut = 0;
  let bytes = 0;
  return {
    push(chunk, at) {
      const size = chunk && chunk.byteLength ? chunk.byteLength : (chunk && chunk.length) || 1;
      queue.push({ size: size, at: at == null ? now() : at });
      bytes += size;
      if (!firstIn) firstIn = at == null ? now() : at;
      while (queue.length > MAX_JITTER) {
        const gone = queue.shift();
        bytes -= gone.size;
        dropped += 1;
      }
    },
    pull(at) {
      if (!queue.length) {
        underruns += 1;
        if (target < MAX_JITTER) target += 1;
        return null;
      }
      if (queue.length < target && played) return null;
      const item = queue.shift();
      bytes -= item.size;
      played += 1;
      if (!firstOut) firstOut = at == null ? now() : at;
      if (target > 0 && underruns === 0) target -= 0;
      return item;
    },
    stats() {
      return {
        depth: queue.length,
        target: target,
        underruns: underruns,
        dropped: dropped,
        played: played,
        bytes: bytes,
        firstIn: firstIn,
        firstOut: firstOut,
        startDelay: firstIn && firstOut ? firstOut - firstIn : null
      };
    }
  };
}

/* 30 minutes of 100 ms chunks must not retain more than a few frames. */
export function soakJitter(chunks) {
  const n = Math.max(0, Number(chunks) || 0);
  let clock = 0;
  const buf = createJitter(() => clock);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    clock += PCM_MS;
    buf.push({ byteLength: 3200 }, clock);
    if (i % 2 === 1) buf.pull(clock);
    const depth = buf.stats().depth;
    if (depth > peak) peak = depth;
  }
  while (buf.pull(clock)) { /* drain */ }
  return { peak: peak, capped: peak <= SOAK_CAP, stats: buf.stats(), ms: PCM_MS };
}

export function createMeter() {
  const marks = {};
  function stamp(name, t) {
    if (marks[name] == null && Number.isFinite(t)) marks[name] = t;
  }
  function delta(from, to) {
    if (marks[from] == null || marks[to] == null) return null;
    return marks[to] - marks[from];
  }
  return {
    mic(t) { stamp("mic", t); },
    partial(t) { stamp("partial", t); },
    translationAudio(t) { stamp("translationAudio", t); },
    text(t) { stamp("text", t); },
    tts(t) { stamp("tts", t); },
    note(t) { stamp("note", t); },
    notePlay(t) { stamp("notePlay", t); },
    report() {
      return {
        voiceToVoice: delta("mic", "translationAudio"),
        voiceToText: delta("mic", "partial"),
        textToVoice: delta("text", "tts"),
        noteToVoice: delta("note", "notePlay")
      };
    }
  };
}
