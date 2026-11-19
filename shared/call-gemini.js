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
  for (let i = 0; i < data.length; i++) {
    const x = data[i] > 1 || data[i] < -1 ? data[i] / 32768 : data[i];
    energy += x * x;
  }
  return Math.sqrt(energy / data.length);
}

/* Keep a tail after speech: Live Translate finishes the last words about
   a second after the speaker stops, and cuts them if audio stops at once.
   Longer silence is not sent. */
export function createVad() {
  let hang = 0;
  let sent = 0;
  let skipped = 0;
  return {
    gate(samples) {
      const speech = levelOf(samples) >= 0.02;
      const keep = speech || hang > 0;
      if (speech) hang = 12;
      else if (hang > 0) hang -= 1;
      if (keep) sent += CHUNK_MS;
      else skipped += CHUNK_MS;
      return keep;
    },
    stats() {
      return { sentMs: sent, skippedMs: skipped };
    }
  };
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
    onSpeech(samples, now) {
      if (phase === "text") return { send: false, reason: "text" };
      if (!vad.gate(samples)) return { send: false, reason: "vad" };
      quota.add(CHUNK_MS, now);
      const usage = quota.report(now, openedAt || warmedAt || now);
      if (usage.degraded) {
        phase = "text";
        return { send: false, reason: "quota", usage: usage };
      }
      if (phase === "ready") phase = "live";
      return { send: true, reason: "speech", usage: usage, bytes: CHUNK_SAMPLES * 2 };
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
