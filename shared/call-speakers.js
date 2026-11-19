/* On-device speaker turns. Embeddings are a short voice sketch computed
   from audio the mic already captured. They run in a worker so the call
   never waits. Gemini Live Translate cannot pull two voices apart when
   they speak at the same time, so overlapping audio is not sent as one
   translation. The next person is a new turn. */

import { detectLang } from "./call-langs.js";
import { estimatePitch, matchVoice } from "./call-voice.js";

export const SPEAKER_LIMIT = 3;
export const OVERLAP_LIMIT = "Gemini Live Translate does not separate overlapping voices. A mix of two people is not sent as one translation. Each person is translated on their own turn after the other pauses. Audio already handed to the model cannot be pulled back.";

const LETTERS = ["A", "B", "C"];

function rms(data) {
  let energy = 0;
  for (let i = 0; i < data.length; i++) energy += data[i] * data[i];
  return Math.sqrt(energy / (data.length || 1));
}

function bandEnergy(data, rate, low, high) {
  /* A coarse energy sketch. It is not a neural embedding and it does not
     wait on a model download. */
  const step = Math.max(1, Math.floor(rate / 4000));
  let sum = 0;
  let n = 0;
  const period = rate / ((low + high) / 2);
  for (let i = 0; i < data.length; i += step) {
    const phase = (i % period) / period;
    sum += data[i] * data[i] * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2 * (high / 1000)));
    n++;
  }
  return n ? sum / n : 0;
}

export function frameEmbedding(samples, sampleRate, hz) {
  const data = samples && samples.length ? samples : [];
  const rate = Number(sampleRate) || 16000;
  const level = rms(data);
  const bands = [
    bandEnergy(data, rate, 80, 250),
    bandEnergy(data, rate, 250, 500),
    bandEnergy(data, rate, 500, 1000),
    bandEnergy(data, rate, 1000, 2000)
  ];
  const max = Math.max(level, ...bands, 1e-6);
  const pitch = Math.max(0, Math.min(1, (Number(hz) || 0) / 320));
  return [pitch * 4, level / max].concat(bands.map((value) => value / max));
}

function lagError(data, lag) {
  const n = Math.min(data.length - lag, 800);
  if (n < 16) return Infinity;
  let err = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - data[i + lag];
    err += d * d;
  }
  return err / n;
}

/* Two pitches that are not harmonics of each other. A pure tone has one
   peak. A mix of two voices has two. */
export function overlappingPitches(samples, sampleRate) {
  const data = samples && samples.length ? samples : [];
  const rate = Number(sampleRate) || 16000;
  if (data.length < Math.floor(rate * 0.08) || rms(data) < 0.01) return [];
  const n = Math.min(data.length, 2048);
  const peaks = [];
  for (let hz = 80; hz <= 300; hz += 10) {
    const w = (2 * Math.PI * hz) / rate;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 2) {
      re += data[i] * Math.cos(w * i);
      im -= data[i] * Math.sin(w * i);
    }
    peaks.push({ hz: hz, mag: re * re + im * im });
  }
  peaks.sort((a, b) => b.mag - a.mag);
  const top = peaks[0];
  if (!top || top.mag <= 0) return [];
  function harmonic(a, b) {
    const ratio = Math.max(a, b) / Math.min(a, b);
    return [2, 3, 4].some((k) => Math.abs(ratio - k) < 0.15);
  }
  const second = peaks.find((item) => Math.abs(item.hz - top.hz) > 40 && !harmonic(item.hz, top.hz));
  if (!second || second.mag < top.mag * 0.35) return [];
  return [top.hz, second.hz].sort((a, b) => a - b);
}

function distance(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function defaultName(index) {
  return "Speaker " + (LETTERS[index] || "?");
}

export function createDiarizer() {
  const speakers = [];
  const names = {};
  const turns = [];
  let open = null;

  function label(id) {
    return names[id] || defaultName(speakers.findIndex((item) => item.id === id));
  }

  function closeTurn() {
    if (!open) return;
    turns.push(open);
    open = null;
  }

  function ensure(embed, hz) {
    let best = null;
    let gap = 0.55;
    speakers.forEach((item) => {
      const next = distance(embed, item.embed);
      if (next < gap) {
        gap = next;
        best = item;
      }
    });
    if (best) {
      best.embed = best.embed.map((value, i) => value * 0.7 + embed[i] * 0.3);
      if (hz) best.hz = best.hz ? best.hz * 0.7 + hz * 0.3 : hz;
      best.voice = matchVoice(best.hz);
      return best;
    }
    if (speakers.length >= SPEAKER_LIMIT) return speakers[0];
    const created = {
      id: "s" + (speakers.length + 1),
      hz: hz || 0,
      embed: embed.slice(),
      voice: matchVoice(hz),
      lang: ""
    };
    speakers.push(created);
    return created;
  }

  return {
    /* Synchronous and side-effect only on this object. Callers that care
       about the main thread post the same samples to the worker and do
       not wait for the reply before playing audio. */
    push(samples, sampleRate, text) {
      const pitches = overlappingPitches(samples, sampleRate);
      if (pitches.length >= 2) {
        return { send: false, overlap: true, queued: true, speaker: null, turn: null };
      }
      const heardPitch = estimatePitch(samples, sampleRate);
      const hz = heardPitch.confident ? heardPitch.hz : 0;
      const embed = frameEmbedding(samples, sampleRate, hz);
      const speaker = ensure(embed, hz);
      const heard = String(text || "").trim();
      if (heard) {
        const detected = detectLang(heard, speaker.lang || "en");
        if (detected.confidence >= 0.72) speaker.lang = detected.code;
      }
      if (!open || open.id !== speaker.id) {
        closeTurn();
        open = { id: speaker.id, name: label(speaker.id), lang: speaker.lang, voice: speaker.voice, text: "" };
      }
      if (heard && open.text.indexOf(heard) < 0) open.text = (open.text + " " + heard).trim();
      open.lang = speaker.lang;
      open.voice = speaker.voice;
      open.name = label(speaker.id);
      return {
        send: true,
        overlap: false,
        queued: false,
        speaker: { id: speaker.id, name: label(speaker.id), lang: speaker.lang, voice: speaker.voice },
        turn: open
      };
    },
    rename(id, name) {
      const clean = String(name || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 24);
      if (!clean) return;
      names[id] = clean;
      if (open && open.id === id) open.name = clean;
    },
    finish() {
      closeTurn();
      const done = turns.slice();
      turns.length = 0;
      return done;
    },
    speakers() {
      return speakers.map((item) => ({
        id: item.id,
        name: label(item.id),
        lang: item.lang,
        voice: item.voice
      }));
    }
  };
}
