/* Call audio math. No browser, no network: gains, the jitter buffer,
   reconnect delays, and the three latency clocks the call screen reports. */

export const VOLUME_DEFAULTS = {
  translation: 0.85,
  original: 0.35,
  overall: 1,
  ring: 0.7,
  mic: 1,
  tts: 0.85
};

/* How far the original voice drops while a translation is playing. */
export const DUCK_RATIO = 0.5;

export const VOLUME_KEYS = Object.keys(VOLUME_DEFAULTS);

/* Audio only. There is no camera path. */
export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1
};
/* Browser noise suppression treats a whisper (no pitch, just breath) as noise and removes it before the call ever hears
   it. With quiet voice on, suppression is left to the call itself: echo cancellation and gain control stay on, and the
   adaptive floor and lift in createVad handle room noise. */
export function micConstraints(quiet) {
  return quiet ? Object.assign({}, MIC_CONSTRAINTS, { noiseSuppression: false }) : MIC_CONSTRAINTS;
}
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
  /* v.original is the original voice between phrases, always under the
     translation by default. While the translation plays it ducks to half,
     unless the calls_duck switch leaves it up. */
  let original = v.original;
  if (original > 0 && flags.translating && flags.duck !== false) original = original * DUCK_RATIO;
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

/* One translated phrase, start to finish. Times are wall-clock ms (performance.now).
   speech: first and last frame that passed the voice gate. sent: first frame handed to the socket.
   byte: first thing the model sent back (audio or text). play: first translated sound scheduled to the speaker.
   The call is streamed, so the model often answers before the speaker stops: the "after you stop" numbers can be negative. */
export function createTimeline(cap) {
  const keep = Math.max(5, Number(cap) || 30);
  const rows = [];
  let cur = null;
  let dropped = 0;
  const num = (v) => (v == null ? null : Math.round(v));
  const gap = (a, b) => (a == null || b == null ? null : Math.round(b - a));
  function finish() {
    if (!cur) return;
    const u = cur;
    cur = null;
    if (u.byte == null && u.play == null) { dropped += 1; return; }
    rows.push({
      at: num(u.start),
      speechMs: gap(u.start, u.end),
      toSent: gap(u.start, u.sent),
      toByte: gap(u.start, u.byte),
      toPlay: gap(u.start, u.play),
      stopToByte: gap(u.end, u.byte),
      stopToPlay: gap(u.end, u.play),
      byteToPlay: gap(u.byte, u.play),
      playMs: gap(u.play, u.lastPlay)
    });
    if (rows.length > keep) rows.shift();
  }
  return {
    speech(t) {
      if (!Number.isFinite(t)) return;
      if (cur && cur.play != null && t - cur.end > 2500) finish();
      if (!cur) cur = { start: t, end: t, sent: null, byte: null, play: null, lastPlay: null };
      cur.end = t;
    },
    sent(t) { if (cur && cur.sent == null && Number.isFinite(t)) cur.sent = t; },
    byte(t) { if (cur && cur.byte == null && Number.isFinite(t)) cur.byte = t; },
    play(t, len) {
      if (!cur || !Number.isFinite(t)) return;
      if (cur.play == null) cur.play = t;
      cur.lastPlay = t + (Number(len) || 0);
    },
    turn() { finish(); },
    list() { return rows.slice(); },
    open() { return !!cur; },
    dropped() { return dropped; },
    summary() {
      const col = (key) => rows.map((r) => r[key]).filter((v) => v != null).sort((a, b) => a - b);
      const pick = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : null);
      const stop = col("stopToPlay");
      return {
        n: rows.length,
        dropped: dropped,
        stopToPlay: { p50: pick(stop, 0.5), p95: pick(stop, 0.95) },
        toPlay: { p50: pick(col("toPlay"), 0.5) },
        toByte: { p50: pick(col("toByte"), 0.5) },
        byteToPlay: { p50: pick(col("byteToPlay"), 0.5) },
        last: rows.length ? rows[rows.length - 1] : null
      };
    }
  };
}

/* Live transcription may arrive as a delta or as the whole line so far. */
export function mergeTranscript(prev, next) {
  const a = String(prev || "");
  const b = String(next || "");
  if (!b) return a;
  if (!a) return b;
  if (b.indexOf(a) === 0) return b;
  if (a.indexOf(b) === 0) return a;
  const max = Math.min(a.length, b.length);
  for (let n = max; n > 0; n--) {
    if (a.slice(-n) === b.slice(0, n)) return a + b.slice(n);
  }
  return a + b;
}

/* Split a live caption into words, keeping the spaces on the word they follow. */
export function transcriptWords(text) {
  const s = String(text || "");
  if (!s) return [];
  const out = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    buf += s[i];
    if (s[i] === " " || s[i] === "\t" || s[i] === "\n") {
      if (i + 1 >= s.length || (s[i + 1] !== " " && s[i + 1] !== "\t" && s[i + 1] !== "\n")) {
        out.push(buf);
        buf = "";
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}
