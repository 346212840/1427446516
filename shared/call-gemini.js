/* Gemini Live is opened by the browser with an ephemeral token.
   Audio never passes through the Worker. Speech is sent in 100 ms
   chunks, and only when the local voice detector hears someone. */

export const GEMINI_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;
export const CHUNK_MS = 100;
export const CHUNK_SAMPLES = 1600;
export const SESSION_REFRESH_MS = 8 * 60 * 1000;

/* The worklet resamples to 16 kHz and posts one 100 ms PCM16 frame.
   It does not talk to the network. */
export const MIC_WORKLET = [
  "class CallMic extends AudioWorkletProcessor {",
  "  constructor() { super(); this.ratio = sampleRate / 16000; this.acc = 0; this.sum = 0; this.n = 0; this.buf = new Int16Array(1600); this.i = 0; }",
  "  process(inputs) {",
  "    var ch = inputs[0]; if (!ch || !ch.length) return true;",
  "    var x = ch[0];",
  "    for (var k = 0; k < x.length; k++) {",
  "      this.sum += x[k]; this.n++; this.acc += 1;",
  "      if (this.acc >= this.ratio) {",
  "        this.acc -= this.ratio;",
  "        var v = this.n ? this.sum / this.n : 0; this.sum = 0; this.n = 0;",
  "        v = v < -1 ? -1 : v > 1 ? 1 : v;",
  "        this.buf[this.i++] = v < 0 ? v * 32768 : v * 32767;",
  "        if (this.i === 1600) { this.port.postMessage(this.buf.buffer, [this.buf.buffer]); this.buf = new Int16Array(1600); this.i = 0; }",
  "      }",
  "    }",
  "    return true;",
  "  }",
  "}",
  "registerProcessor('call-mic', CallMic);"
].join("\n");

export function directSocketUrl(token) {
  const value = String(token || "");
  if (value.length < 8 || value.indexOf("key=") >= 0) return "";
  return GEMINI_WS + "?access_token=" + encodeURIComponent(value);
}

export function proxiesAudio() {
  return false;
}

export function needsResume(ageMs, goAway) {
  if (goAway) return true;
  return Number(ageMs) >= SESSION_REFRESH_MS;
}

function levelOf(samples) {
  const data = samples && samples.length ? samples : [];
  if (!data.length) return 0;
  let energy = 0;
  /* PCM16 is always scaled. Guessing per sample counted a quiet input's 0, 1 and -1 steps as full scale. */
  const pcm16 = data instanceof Int16Array;
  for (let i = 0; i < data.length; i++) {
    const x = pcm16 ? data[i] / 32768 : (data[i] > 1 || data[i] < -1 ? data[i] / 32768 : data[i]);
    energy += x * x;
  }
  return Math.sqrt(energy / data.length);
}

/* The old gate was a fixed level (about -34 dBFS), so a whisper or a soft
   voice never reached the translator. The detector now follows the room:
   it tracks the noise floor, opens a little above it, boosts quiet speech
   toward a normal level with a limiter, and keeps 300 ms before the gate
   opened so a soft word start is not clipped. Nothing for the person to set.
   strict = true (the translation or the other person is playing aloud, or
   the feature is off) puts the old fixed gate back, so the speaker's own
   echo never opens it. */
export const LOUD_GATE = 0.02;
export const MIN_GATE = 0.0025;
export const SPEECH_OVER_FLOOR = 3;
export const BOOST_TARGET = 0.08;
export const MAX_BOOST = 24;
export const PRE_ROLL = 3;

function boosted(samples, gain) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i] / 32768 * gain;
    /* Soft limiter: linear to 0.7, then a smooth knee that never passes 0.98. */
    const a = v < 0 ? -v : v;
    if (a > 0.7) v = (v < 0 ? -1 : 1) * (0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

/* Keep a tail after speech: Live Translate finishes the last words about
   a second after the speaker stops, and cuts them if audio stops at once.
   Longer silence is not sent. */
export function createVad() {
  let hang = 0;
  let sent = 0;
  let skipped = 0;
  let floor = 0.003;
  let seen = 0;
  let gain = 1;
  let lastGate = LOUD_GATE;
  const pre = [];
  const api = {
    out: [],
    gate(samples, strict) {
      const level = levelOf(samples);
      let gate = LOUD_GATE;
      if (!strict) {
        /* Quiet frames pull the floor down fast; louder ones raise it only slowly, so speech does not become the noise. */
        seen += 1;
        if (seen <= 20) floor += (level - floor) * 0.15;
        else if (level < floor * 1.5) floor += (level - floor) * 0.05;
        else floor += (level - floor) * 0.002;
        floor = Math.min(0.03, Math.max(0.0004, floor));
        gate = Math.min(LOUD_GATE, Math.max(MIN_GATE, floor * SPEECH_OVER_FLOOR));
      }
      lastGate = gate;
      const speech = level >= gate;
      const wasOpen = hang > 0;
      const keep = speech || hang > 0;
      if (speech) hang = 12;
      else if (hang > 0) hang -= 1;
      if (strict) gain = 1;
      else if (speech) {
        const want = Math.min(MAX_BOOST, Math.max(1, BOOST_TARGET / Math.max(level, gate)));
        gain = want < gain || !wasOpen ? want : gain + (want - gain) * 0.35;
      }
      api.out = [];
      if (keep) {
        sent += CHUNK_MS;
        const g = strict ? 1 : gain;
        if (!wasOpen) pre.forEach((old) => api.out.push(g > 1.05 ? boosted(old, g) : old));
        pre.length = 0;
        api.out.push(g > 1.05 ? boosted(samples, g) : samples);
      } else {
        skipped += CHUNK_MS;
        if (!strict) {
          pre.push(samples);
          if (pre.length > PRE_ROLL) pre.shift();
        } else pre.length = 0;
      }
      return keep;
    },
    stats() {
      return { sentMs: sent, skippedMs: skipped, floor: floor, gate: lastGate, gain: gain };
    }
  };
  return api;
}

/* Estimated speech tokens, not a bill. Crossing the local budget
   switches the call to text instead of closing it. */
export function createQuota() {
  const marks = [];
  let warned = false;
  let degraded = false;
  function windowMs(now) {
    let sum = 0;
    for (let i = marks.length - 1; i >= 0; i--) {
      if (now - marks[i].t > 60000) break;
      sum += marks[i].ms;
    }
    return sum;
  }
  return {
    add(ms, now) {
      marks.push({ t: now, ms: ms });
      const recent = windowMs(now);
      if (recent >= 20000) warned = true;
      if (recent >= 32000) degraded = true;
    },
    fail() {
      warned = true;
      degraded = true;
    },
    report(now, callStart) {
      let speech = 0;
      marks.forEach((item) => { speech += item.ms; });
      const span = Math.max(60000, (Number(now) || 0) - (Number(callStart) || 0));
      return {
        speechMs: speech,
        perMinute: Math.round(speech * 60000 / span),
        warned: warned,
        degraded: degraded,
        mode: degraded ? "text" : "voice"
      };
    }
  };
}

export function createLiveSession() {
  const vad = createVad();
  const quota = createQuota();
  let phase = "idle";
  let warmedAt = 0;
  let handle = "";
  let openedAt = 0;
  return {
    ring(now) {
      if (phase === "idle") {
        phase = "warming";
        warmedAt = now;
      }
    },
    ready(now) {
      phase = "ready";
      openedAt = now;
    },
    phase() {
      return phase;
    },
    url(token) {
      return directSocketUrl(token);
    },
    /* True when the socket was already set up while the phone was ringing. */
    warm() {
      return phase === "ready" || phase === "live";
    },
    onSpeech(samples, now, strict) {
      if (phase === "text") return { send: false, reason: "text" };
      if (!vad.gate(samples, strict)) return { send: false, reason: "vad" };
      quota.add(CHUNK_MS, now);
      const usage = quota.report(now, openedAt || warmedAt || now);
      if (usage.degraded) {
        phase = "text";
        return { send: false, reason: "quota", usage: usage };
      }
      if (phase === "ready") phase = "live";
      return { send: true, reason: "speech", usage: usage, bytes: CHUNK_SAMPLES * 2, chunks: vad.out };
    },
    resumeHandle(value) {
      if (typeof value === "string" && value.length < 400) handle = value;
      return handle;
    },
    handle() {
      return handle;
    },
    shouldResume(now, goAway) {
      return needsResume((Number(now) || 0) - (openedAt || 0), goAway);
    },
    quota(now) {
      return quota.report(now, openedAt || warmedAt || now);
    },
    vad: vad
  };
}
