/* Pick a Gemini prebuilt voice from the speaker's pitch.
   Detection runs on audio the mic is already sending. It never buffers
   that audio, never clones a voice, and never delays the first sound.
   A saved match or a manual override is used on the same tick. */

export const DEFAULT_VOICE = "Puck";

/* Centers are matching targets, not a claim about a person.
   Lower pitch sits nearer Charon; higher pitch sits nearer Leda. */
export const PREBUILT_VOICES = [
  { name: "Charon", hz: 100 },
  { name: "Fenrir", hz: 115 },
  { name: "Orus", hz: 130 },
  { name: "Puck", hz: 155 },
  { name: "Kore", hz: 190 },
  { name: "Aoede", hz: 205 },
  { name: "Zephyr", hz: 215 },
  { name: "Leda", hz: 235 }
];

const NAMES = new Set(PREBUILT_VOICES.map((row) => row.name));
const READY_FRAMES = 8;

export function isPrebuiltVoice(name) {
  return NAMES.has(String(name || ""));
}

export function matchVoice(hz) {
  const freq = Number(hz);
  if (!Number.isFinite(freq) || freq < 70 || freq > 320) return DEFAULT_VOICE;
  let best = PREBUILT_VOICES[0];
  let gap = Math.abs(freq - best.hz);
  for (let i = 1; i < PREBUILT_VOICES.length; i++) {
    const next = Math.abs(freq - PREBUILT_VOICES[i].hz);
    if (next < gap) {
      gap = next;
      best = PREBUILT_VOICES[i];
    }
  }
  return best.name;
}

/* Difference function on a short window. Returns immediately. */
export function estimatePitch(samples, sampleRate) {
  const rate = Number(sampleRate) || 16000;
  const data = samples && samples.length ? samples : [];
  if (data.length < Math.floor(rate * 0.04)) return { hz: 0, confident: false };
  let energy = 0;
  for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
  const rms = Math.sqrt(energy / data.length);
  if (rms < 0.01) return { hz: 0, confident: false };
  const minLag = Math.max(1, Math.floor(rate / 320));
  const maxLag = Math.min(data.length - 1, Math.floor(rate / 70));
  const limit = Math.min(data.length, 960);
  function lagError(lag) {
    const n = Math.min(limit, data.length - lag);
    if (n < 16) return Infinity;
    let err = 0;
    for (let i = 0; i < n; i++) {
      const d = data[i] - data[i + lag];
      err += d * d;
    }
    return err / n;
  }
  let bestLag = 0;
  let best = Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const err = lagError(lag);
    if (err < best) {
      best = err;
      bestLag = lag;
    }
  }
  if (!bestLag) return { hz: 0, confident: false };
  /* A multiple of the period can score as well as the period. Keep the
     shortest lag that still matches, which is the voice pitch. */
  let lag = bestLag;
  let shrunk = true;
  while (shrunk) {
    shrunk = false;
    for (const div of [2, 3]) {
      const sub = Math.round(lag / div);
      if (sub < minLag) continue;
      if (lagError(sub) <= best * 2.5 + 1e-8) {
        lag = sub;
        shrunk = true;
      }
    }
  }
  const hz = Math.round(rate / lag);
  return { hz: hz, confident: best < rms * rms * 0.8 };
}

/* Synchronous. Override wins. Pitch is used only after it has settled.
   Until then the default voice is returned so playback can start. */
export function resolveVoice(override, hz, settled) {
  if (isPrebuiltVoice(override)) return { voice: override, source: "override", hz: Number(hz) || 0 };
  if (settled && Number(hz) >= 70) return { voice: matchVoice(hz), source: "pitch", hz: Math.round(hz) };
  return { voice: DEFAULT_VOICE, source: "default", hz: Number(hz) || 0 };
}

export function createVoiceMatch(override) {
  let chosen = isPrebuiltVoice(override) ? override : "";
  let hz = 0;
  let frames = 0;
  function current() {
    return resolveVoice(chosen, hz, frames >= READY_FRAMES);
  }
  return {
    setOverride(name) {
      chosen = isPrebuiltVoice(name) ? name : "";
      return current();
    },
    /* Side path. The caller still sends this same frame to Gemini. */
    push(samples, sampleRate) {
      if (chosen) return current();
      const est = estimatePitch(samples, sampleRate);
      if (!est.confident) return current();
      frames += 1;
      hz = hz ? hz * 0.65 + est.hz * 0.35 : est.hz;
      return current();
    },
    current: current
  };
}

/* True only when the next utterance should open with a different voice.
   The current utterance is never cut to apply it. */
export function voiceChanged(previous, next) {
  if (!next || !next.voice) return false;
  if (!previous || !previous.voice) return false;
  return previous.voice !== next.voice;
}
