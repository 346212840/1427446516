/* Call engine. Runs in the browser, in the app and on the guest page.
   WebRTC carries the voices between the two phones. The listener's own
   Gemini Live Translate socket turns the other person's voice into the
   listener's language, so each side hears only the translation. With
   "others hear only my translation" the sender translates instead and
   the listener plays that stream as is. Speech is sent in 100 ms frames,
   silence is skipped, and the Worker only mints the short-lived token. */
import { sameLang, normalizeLang, detectLang } from "./call-langs.js";
import { outputGains, reconnectDelay, MIC_CONSTRAINTS, micConstraints, normalizeVolumes, createTimeline, mergeTranscript } from "./call-audio.js";
import { normalizeMode, transmitOriginal, playTranslatedVoice, noteShouldAutoplay } from "./call-mode.js";
import { createVoiceMatch } from "./call-voice.js";
import { lighterFor, cleanLexicon } from "./call-quality.js";
import { pickBitrate, setAudioSession, createPlayoutLead } from "./call-mobile.js";
import { createLiveSession, MIC_WORKLET, OUTPUT_RATE, CHUNK_MS, shouldKeepAlive, pcmB64, silenceFrame, createUtterance, KEEP_ALIVE_MS } from "./call-gemini.js";
import { createDiarizer } from "./call-speakers.js";
import { createChatOutbox, CHAT_FAIL_MS } from "./call-chat.js";

const IDLE_LINE_MS = 1500;
const DIRECT_WAIT_MS = 3500;
const RACE_AFTER_DIRECT_MS = 900;
const RACE_AFTER_RELAY_MS = 1500;
const RACE_AFTER_KNOWN_MS = 2500;
const RELAY_HOST_WAIT_MS = 4500;
const RELAY_HOST_STAGGER_MS = 1600;
const ROTATE_MS = 8 * 60 * 1000;
const NOTE_CHUNK = 16384;

function toB64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
function fromB64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function floatsOf(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}
function now() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}

/* One Gemini Live Translate socket. It is direct first and falls back to
   our Worker relay when Google cannot be reached from this network. */
/* An AudioWorklet module is added once per audio context, even across calls. */
const workletReady = new WeakSet();

export function createPipe(env, opts) {
  const pipe = {
    id: opts.id,
    target: opts.target,
    voice: opts.voice || "",
    out: opts.out,
    ready: false,
    closed: false,
    handle: "",
    openedAt: 0,
    via: "",
    bytes: 0,
    lead: createPlayoutLead({ immediate: !!opts.immediatePlay })
  };
  let ws = null;
  let nextAt = 0;
  const sources = [];
  let attempt = 0;
  let idle = null;
  let partial = { original: "", translation: "" };
  let sentSince = false;
  let connecting = false;
  let lastAct = 0;
  const touch = () => { lastAct = Date.now(); };

  function finishLine() {
    clearTimeout(idle);
    idle = null;
    const line = { original: partial.original.trim(), translation: partial.translation.trim() };
    partial = { original: "", translation: "" };
    if (opts.onTurn) opts.onTurn(pipe);
    if (pipe.oneShot && pipe.onShotDone) pipe.onShotDone(true);
    if (line.original || line.translation) opts.onLine(pipe, line);
  }
  function armIdle() {
    clearTimeout(idle);
    idle = setTimeout(finishLine, IDLE_LINE_MS);
  }
  function play(b64) {
    const ac = env.ac;
    if (!ac || !pipe.out) return;
    const bytes = fromB64(b64);
    const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (!view.length) return;
    let energy = 0;
    const floats = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) {
      floats[i] = view[i] / 32768;
      energy += floats[i] * floats[i];
    }
    const level = Math.sqrt(energy / view.length);
    const buffer = ac.createBuffer(1, floats.length, OUTPUT_RATE);
    buffer.copyToChannel(floats, 0);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    src.connect(pipe.out);
    const t = ac.currentTime;
    /* The model streams at real time, so a pile-up is stale audio. The lead
       grows when the audio runs dry mid-phrase and shrinks on a calm link. */
    const slot = pipe.lead.plan(t, nextAt, buffer.duration);
    if (!slot) return;
    src.start(slot.start);
    sources.push(src);
    src.onended = () => { const i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
    if (opts.onPlay) opts.onPlay(pipe, now() + Math.max(0, slot.start - t) * 1000, buffer.duration * 1000);
    nextAt = slot.next;
    pipe.bytes += bytes.byteLength;
    opts.onOut(pipe, level, nextAt - t);
  }
  function onMessage(raw) {
    let msg = null;
    try { msg = JSON.parse(raw); } catch (err) { return; }
    if (msg.setupComplete) {
      pipe.ready = true;
      pipe.openedAt = Date.now();
      attempt = 0;
      touch();
      opts.onState(pipe, "ready");
      if (pipe.pending && pipe.pending.length) {
        const held = pipe.pending;
        pipe.pending = null;
        held.forEach((c) => pipe.send(c));
        pipe.flush();
      }
      return;
    }
    if (msg.goAway) { opts.onGoAway(pipe); return; }
    if (msg.sessionResumptionUpdate && msg.sessionResumptionUpdate.newHandle) pipe.handle = String(msg.sessionResumptionUpdate.newHandle);
    const sc = msg.serverContent;
    if (!sc) return;
    touch();
    ((sc.modelTurn && sc.modelTurn.parts) || []).forEach((part) => {
      if (part.inlineData && part.inlineData.data) { if (opts.onByte) opts.onByte(pipe, "audio"); play(part.inlineData.data); }
    });
    if (sc.inputTranscription && sc.inputTranscription.text) {
      if (opts.onByte) opts.onByte(pipe, "text");
      partial.original = mergeTranscript(partial.original, sc.inputTranscription.text);
      opts.onPartial(pipe, partial);
      armIdle();
    }
    if (sc.outputTranscription && sc.outputTranscription.text) {
      if (opts.onByte) opts.onByte(pipe, "text");
      partial.translation = mergeTranscript(partial.translation, sc.outputTranscription.text);
      opts.onPartial(pipe, partial);
      armIdle();
    }
    if (sc.turnComplete) finishLine();
  }
  async function connect() {
    if (pipe.closed || connecting) return;
    connecting = true;
    try { await connectOnce(); } finally { connecting = false; }
  }
  async function connectOnce() {
    if (pipe.closed) return;
    let minted = null;
    try {
      minted = await opts.token({ target: pipe.target, voice: pipe.voice, resume: pipe.handle, source: opts.source });
    } catch (err) { minted = null; }
    if (pipe.closed) return;
    if (minted && minted.reason === "ringing") { setTimeout(connect, 2500); return; }
    if (!minted || minted.mode !== "token" || !minted.url) {
      const why = minted && minted.reason;
      opts.onState(pipe, why === "quota" || why === "nokey" || why === "badkey" ? why : "text");
      return;
    }
    const hinted = minted.prefer === "relay";
    const order = hinted || env.relayFirst() ? ["relay", "direct"] : ["direct", "relay"];
    const known = hinted || env.relayFirst() || env.routeKnown();
    const won = await race(order, minted, known);
    if (won) return;
    scheduleRetry();
  }
  /* The first route starts at once. If it is slow the second starts beside
     it with a fresh token (tokens are single use), and the first socket to
     finish setup wins. The loser is closed. */
  function race(order, first, known) {
    return new Promise((resolve) => {
      const group = { winner: null, sockets: [] };
      let settled = false;
      let started = 0;
      let failed = 0;
      let timer = null;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        group.sockets.forEach((sock) => { if (sock !== group.winner) { try { sock.close(); } catch (err) { /* closed */ } } });
        resolve(ok);
      };
      const run = async (route, minted) => {
        const ok = route === "relay" ? await openRelay(minted, group) : await open(route, minted, group, minted.url);
        if (settled) return;
        if (ok) { env.noteRoute(route); settle(true); return; }
        failed += 1;
        if (pipe.closed) { settle(false); return; }
        if (started < 2) second(); else if (failed >= started) settle(false);
      };
      const second = async () => {
        if (started >= 2 || settled || pipe.closed) return;
        started = 2;
        clearTimeout(timer);
        let again = null;
        try { again = await opts.token({ target: pipe.target, voice: pipe.voice, resume: pipe.handle, source: opts.source }); } catch (err) { again = null; }
        if (settled || pipe.closed) return;
        if (!again || again.mode !== "token" || !again.url) again = first;
        run(order[1], again);
      };
      started = 1;
      run(order[0], first);
      timer = setTimeout(second, order[0] === "relay" ? (known ? RACE_AFTER_KNOWN_MS : RACE_AFTER_RELAY_MS) : (known ? RACE_AFTER_KNOWN_MS : RACE_AFTER_DIRECT_MS));
    });
  }
  /* Several relay hosts: the next one starts beside a slow one, so a blocked
     hostname costs under two seconds instead of its whole timeout. */
  function openRelay(minted, group) {
    const urls = env.relayUrls ? env.relayUrls(minted.token) : [env.relayUrl ? env.relayUrl(minted.token) : ""];
    const list = urls.filter(Boolean);
    return new Promise((resolve) => {
      let next = 0;
      let pending = 0;
      let done = false;
      let timer = null;
      const launch = () => {
        clearTimeout(timer);
        if (done || group.winner || pipe.closed || next >= list.length) return;
        const url = list[next++];
        pending += 1;
        open("relay", minted, group, url, list.length > 1 ? RELAY_HOST_WAIT_MS : 6000).then((ok) => {
          pending -= 1;
          if (done) return;
          if (ok) { done = true; clearTimeout(timer); resolve(true); return; }
          if (next < list.length) launch();
          else if (!pending) { done = true; resolve(false); }
        });
        if (next < list.length) timer = setTimeout(launch, RELAY_HOST_STAGGER_MS);
      };
      if (!list.length) { resolve(false); return; }
      launch();
    });
  }
  function open(route, minted, group, url, wait) {
    return new Promise((resolve) => {
      let socket = null;
      let done = false;
      if (!url) { resolve(false); return; }
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!ok && socket) { try { socket.close(); } catch (err) { /* closed */ } }
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), wait || (route === "direct" ? DIRECT_WAIT_MS : 6000));
      try { socket = new WebSocket(url); } catch (err) { finish(false); return; }
      group.sockets.push(socket);
      socket.onopen = () => { try { socket.send(JSON.stringify({ setup: minted.setup })); } catch (err) { finish(false); } };
      socket.onmessage = (event) => {
        const read = typeof event.data === "string" ? Promise.resolve(event.data) : (event.data && event.data.text ? event.data.text() : Promise.resolve(""));
        read.then((text) => {
          if (!done) {
            if (text.indexOf("setupComplete") >= 0) {
              if (group.winner || pipe.closed) { finish(false); return; }
              group.winner = socket;
              ws = socket;
              pipe.via = route;
              finish(true);
            }
          }
          if (ws === socket) onMessage(text);
        });
      };
      socket.onerror = () => { /* close follows */ };
      socket.onclose = () => {
        if (!done) { finish(false); return; }
        if (ws === socket) {
          ws = null;
          pipe.ready = false;
          if (!pipe.closed) { opts.onState(pipe, "lost"); scheduleRetry(); }
        }
      };
    });
  }
  function scheduleRetry() {
    if (pipe.closed) return;
    attempt += 1;
    if (attempt > 6) { opts.onState(pipe, "failed"); return; }
    setTimeout(connect, reconnectDelay(attempt));
  }
  pipe.open = connect;
  /* True while translated speech is still playing aloud on this device. */
  pipe.playing = () => !!(env.ac && nextAt > 0 && nextAt + 0.45 > env.ac.currentTime);
  /* Drop queued and playing translation so a new phrase can start at once. */
  pipe.cut = () => {
    sources.forEach((src) => { try { src.stop(); } catch (err) { /* already ended */ } });
    sources.length = 0;
    nextAt = 0;
    if (pipe.lead && pipe.lead.reset) pipe.lead.reset();
    if (opts.onCut) opts.onCut(pipe);
  };
  /* The network came back or changed: do not wait out the back-off. */
  pipe.nudge = () => {
    if (pipe.closed || connecting) return;
    if (ws && ws.readyState === 1 && pipe.ready) return;
    attempt = 0;
    connect();
  };
  pipe.send = (pcm) => {
    if (!ws || ws.readyState !== 1 || !pipe.ready) return false;
    try {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: toB64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), mimeType: "audio/pcm;rate=16000" } } }));
      sentSince = true;
      touch();
      if (opts.onSent) opts.onSent(pipe);
      return true;
    } catch (err) { return false; }
  };
  /* A pause longer than a second: tell the model so it finishes the phrase. */
  pipe.flush = () => {
    if (!ws || ws.readyState !== 1 || !pipe.ready || !sentSince) return;
    sentSince = false;
    try { ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (err) { /* closed */ }
  };
  pipe.close = () => {
    pipe.closed = true;
    pipe.ready = false;
    if (pipe.cut) pipe.cut();
    clearTimeout(idle);
    const socket = ws;
    ws = null;
    if (socket) { try { socket.close(1000); } catch (err) { /* closed */ } }
  };
  pipe.finish = finishLine;
  pipe.maybeKeepAlive = (t) => {
    if (!opts.keepAlive || pipe.closed || !pipe.ready || !ws || ws.readyState !== 1 || sentSince) return false;
    const at = t == null ? Date.now() : t;
    if (!shouldKeepAlive(lastAct, at, false)) return false;
    try {
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: pcmB64(silenceFrame()), mimeType: "audio/pcm;rate=16000" } } }));
      lastAct = at;
      if (opts.onKeepAlive) opts.onKeepAlive(pipe);
      return true;
    } catch (err) { return false; }
  };
  return pipe;
}

export function createEngine(cfg) {
  const E = {};
  const emit = (type, data) => { try { if (cfg.onEvent) cfg.onEvent(type, data || {}); } catch (err) { /* the call keeps going */ } };
  const live = createLiveSession();
  const sendLive = createLiveSession();
  const ears = createDiarizer();
  const voiceMatch = createVoiceMatch("");
  const peer = { id: "", name: "", lang: "", pre: false, degraded: false, joined: false };
  const route = { via: "direct" };
  let ac = null;
  let shared = false;
  const taps = [];
  let master = null;
  let origOut = null;
  let transOut = null;
  let micStream = null;
  let micLevel = null;
  let origToSend = null;
  let transToSend = null;
  let sendDest = null;
  let remoteBus = null;
  let remoteSrc = null;
  let remoteEl = null;
  let pc = null;
  let dc = null;
  let sig = null;
  let call = null;
  let ended = false;
  let rx = null;
  let rxOld = null;
  let tx = null;
  let translatingUntil = 0;
  let lastSpeechAt = 0;
  let lastRotate = 0;
  let wantVoice = "";
  let degraded = false;
  let sigAttempt = 0;
  let timers = [];
  let recorder = null;
  let noteChunks = [];
  let noteIn = null;
  const notes = new Map();
  let lastTranslating = false;
  let lastTxSpeech = 0;
  let txFlushed = true;
  let rxFlushed = true;
  let speaking = false;
  let ownMic = true;
  const timeline = { rx: createTimeline(), tx: createTimeline() };
  const fallback = { rx: false, tx: false, rxBuf: createUtterance(), txBuf: createUtterance(), rxBusy: false, txBusy: false };
  const liveStreamOn = () => !!(cfg.liveStream && cfg.liveStream());
  const metrics = { firstAudio: null, endLag: null, speechStart: 0, lastLoud: 0, lastVoiced: 0, waiting: false, pendingEnd: false };

  const mode = () => normalizeMode(cfg.getMode());
  const volumes = () => normalizeVolumes(cfg.getVolumes());
  const mineLang = () => normalizeLang(cfg.getLang()) || "en";
  const env = {
    get ac() { return ac; },
    relayFirst: () => !!(cfg.relayFirst && cfg.relayFirst()),
    relayUrl: (token) => (cfg.relayUrl ? cfg.relayUrl(token) : ""),
    relayUrls: (token) => (cfg.relayUrls ? cfg.relayUrls(token) : [cfg.relayUrl ? cfg.relayUrl(token) : ""]),
    routeKnown: () => !!(cfg.routeKnown && cfg.routeKnown()),
    noteRoute: (via) => { route.via = via; if (cfg.onRoute) cfg.onRoute(via); emit("route", { via: via }); }
  };
  function every(ms, fn) { const id = setInterval(fn, ms); timers.push(id); return id; }

  /* ---------- gains ---------- */
  function translating() { return now() < translatingUntil; }
  function applyGains() {
    if (!ac) return;
    const m = mode();
    const pre = peer.pre;
    const translated = !!(rx && rx.ready) || pre;
    const g = outputGains(volumes(), {
      translating: translating() && translated && !degraded,
      hearOriginal: !pre && (!translated || degraded ? true : m.original),
      duck: !(cfg.duckOriginal) || cfg.duckOriginal(),
      playTranslation: m.receive !== "text",
      playTts: m.receive !== "text"
    });
    const t = ac.currentTime;
    const original = !translated || degraded ? Math.min(1, volumes().overall) : g.original;
    origOut.gain.setTargetAtTime(Math.min(1, original), t, 0.05);
    const trans = pre ? volumes().overall : g.translation;
    transOut.gain.setTargetAtTime(Math.min(1, trans), t, 0.03);
    master.gain.setTargetAtTime(cfg.speakerOn && !cfg.speakerOn() ? 0.4 : 1, t, 0.05);
    if (micLevel) micLevel.gain.setTargetAtTime(volumes().mic, t, 0.05);
    const live = transmitOriginal(m) && !muted;
    origToSend.gain.setTargetAtTime(live && !(tx && tx.ready) ? 1 : 0, t, 0.03);
    transToSend.gain.setTargetAtTime(live || (m.translationOnly && m.send === "voice" && !muted) ? (tx && tx.ready ? 1 : 0) : 0, t, 0.03);
    if (remoteEl) remoteEl.volume = 0;
  }
  let muted = false;

  /* ---------- signalling ---------- */
  function signal(data) {
    if (sig && sig.readyState === 1) { try { sig.send(JSON.stringify({ op: "signal", data: data })); return true; } catch (err) { return false; } }
    return false;
  }
  const chatOut = createChatOutbox({ send: (data) => signal(data), now: now, failMs: CHAT_FAIL_MS });
  let chatTimer = 0;
  function flushChat() {
    if (ended) return;
    chatOut.flush().forEach((row) => emit("chat-sent", { id: row.id, original: row.data.text }));
    chatOut.expire().forEach((row) => emit("chat-failed", { id: row.id, original: row.data.text }));
    clearTimeout(chatTimer);
    chatTimer = 0;
    const left = chatOut.queued();
    if (!left.length) return;
    const wait = Math.max(250, (left[0].at + CHAT_FAIL_MS) - now());
    chatTimer = setTimeout(flushChat, wait);
  }
  function modePacket() {
    const m = mode();
    return {
      kind: "mode",
      name: cfg.getName(),
      lang: mineLang(),
      pre: !!(m.translationOnly && m.send === "voice" && tx),
      send: m.send,
      degraded: degraded,
      voice: ""
    };
  }
  function announce() { signal(modePacket()); }
  E.announce = announce;

  async function connectSignal() {
    if (ended || !call) return;
    const base = cfg.apiBase().replace(/^http/i, "ws");
    let ticket = call.ticket;
    call.ticket = "";
    if (!ticket) {
      const res = await cfg.api("/v1/calls/" + call.id + "/ticket", { method: "POST", body: "{}" }).catch(() => null);
      ticket = res && res.ok && res.data && res.data.ticket;
      if (res && res.data && res.data.iceServers && pc) { /* keep current ICE servers */ }
    }
    if (!ticket) { scheduleSignal(); return; }
    let ws = null;
    try { ws = new WebSocket(base + "/v1/calls/" + call.id + "/signal?ticket=" + encodeURIComponent(ticket)); } catch (err) { scheduleSignal(); return; }
    sig = ws;
    ws.onopen = () => { sigAttempt = 0; flushChat(); };
    ws.onmessage = (event) => onSignal(String(event.data || ""));
    ws.onclose = () => {
      if (sig === ws) sig = null;
      if (!ended) { emit("status", { code: "reconnecting" }); scheduleSignal(); }
    };
    ws.onerror = () => { /* close follows */ };
  }
  function scheduleSignal() {
    if (ended) return;
    sigAttempt += 1;
    if (sigAttempt > 8) { emit("status", { code: "lost" }); return; }
    setTimeout(connectSignal, reconnectDelay(sigAttempt));
  }
  async function onSignal(text) {
    let msg = null;
    try { msg = JSON.parse(text); } catch (err) { return; }
    if (!msg) return;
    if (msg.op === "welcome") {
      announce();
      if ((msg.peers || []).length) { peer.id = msg.peers[0]; peer.joined = true; if (call.role === "host") await offer(false); }
      return;
    }
    if (msg.op === "join") {
      peer.id = msg.peer;
      peer.joined = true;
      emit("status", { code: "joined" });
      announce();
      if (call.role === "host") await offer(false);
      return;
    }
    if (msg.op === "leave") {
      peer.joined = false;
      emit("status", { code: "left" });
      return;
    }
    if (msg.op !== "signal" || !msg.data) return;
    const d = msg.data;
    if (d.kind === "offer") {
      await pc.setRemoteDescription({ type: "offer", sdp: d.sdp });
      const answer = await pc.createAnswer();
      answer.sdp = tuneOpus(answer.sdp);
      await pc.setLocalDescription(answer);
      signal({ kind: "answer", sdp: answer.sdp });
    } else if (d.kind === "answer") {
      try { await pc.setRemoteDescription({ type: "answer", sdp: d.sdp }); } catch (err) { /* stale answer */ }
    } else if (d.kind === "ice") {
      try { await pc.addIceCandidate(d.candidate); } catch (err) { /* late candidate */ }
    } else if (d.kind === "restart") {
      if (call.role === "host") await offer(true);
    } else if (d.kind === "mode") {
      onPeerMode(d);
    } else if (d.kind === "chat") {
      if (chatOut.incoming(d)) onChat(d);
    }
  }
  function tuneOpus(sdp) {
    const lighter = lighterFor(cfg.connection ? cfg.connection() : {});
    const bits = lighter.lighter ? lighter.bitrate : 64000;
    return String(sdp).replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (all, pt, rest) => {
      if (rest.indexOf("minptime") < 0 && rest.indexOf("useinbandfec") < 0) return all;
      let out = rest;
      if (out.indexOf("useinbandfec") < 0) out += ";useinbandfec=1";
      if (out.indexOf("maxaveragebitrate") < 0) out += ";maxaveragebitrate=" + bits;
      if (out.indexOf("stereo") < 0) out += ";stereo=0";
      return "a=fmtp:" + pt + " " + out;
    });
  }
  async function offer(restart) {
    if (!pc || pc.signalingState !== "stable") return;
    const o = await pc.createOffer({ iceRestart: !!restart });
    o.sdp = tuneOpus(o.sdp);
    await pc.setLocalDescription(o);
    signal({ kind: "offer", sdp: o.sdp });
  }

  /* ---------- peer state ---------- */
  function onPeerMode(d) {
    const before = peer.lang + "|" + peer.pre;
    peer.name = String(d.name || "").slice(0, 40) || peer.name;
    peer.lang = normalizeLang(d.lang) || peer.lang;
    peer.pre = d.pre === true;
    const was = peer.degraded;
    peer.degraded = d.degraded === true;
    emit("peer", { name: peer.name, lang: peer.lang, send: d.send, degraded: peer.degraded, pre: peer.pre });
    if (peer.degraded && !was) emit("peerQuota", {});
    if (before !== peer.lang + "|" + peer.pre) { ensureRx(); ensureTx(); applyGains(); }
  }
  function needRx() {
    if (peer.pre || degraded) return false;
    if (peer.lang && sameLang(peer.lang, mineLang())) return false;
    return true;
  }
  function pipeCallbacks(isTx) {
    return {
      token: (p) => mintToken(p),
      onState: (p, state) => onPipeState(p, state, isTx),
      onGoAway: (p) => rotate(isTx),
      onOut: (p, level) => {
        if (level > 0.008) {
          translatingUntil = now() + 450;
          if (!isTx) {
            metrics.lastVoiced = now();
            if (metrics.waiting) { metrics.firstAudio = now() - metrics.speechStart; metrics.waiting = false; }
          }
        }
      },
      onSent: () => timeline[isTx ? "tx" : "rx"].sent(now()),
      onByte: () => timeline[isTx ? "tx" : "rx"].byte(now()),
      onPlay: (p, at, len) => timeline[isTx ? "tx" : "rx"].play(at, len),
      onTurn: () => timeline[isTx ? "tx" : "rx"].turn(),
      onPartial: (p, part) => emit("partial", { mine: isTx, original: part.original, translation: part.translation, speaker: isTx ? "" : currentSpeaker() }),
      onLine: (p, line) => emit("line", { mine: isTx, original: line.original, translation: line.translation, speaker: isTx ? "" : currentSpeaker() }),
      source: isTx ? mineLang() : peer.lang
    };
  }
  async function mintToken(p) {
    const res = await cfg.api("/v1/calls/" + call.id + "/translate", {
      method: "POST",
      body: JSON.stringify({ target: p.target, source: p.source || undefined, voice: p.voice || undefined, resume: p.resume || undefined, key: (cfg.getKey && cfg.getKey()) || undefined, lexicon: cleanLexicon(cfg.getLexicon()) })
    });
    if (!res || !res.ok) {
      E._mint = { ok: false, status: res ? res.status : 0, reason: res && res.status === 429 ? "quota" : "http", source: "", at: now() };
      return { mode: "text", reason: res && res.status === 429 ? "quota" : "" };
    }
    E._mint = { ok: true, status: res.status, reason: String((res.data && res.data.reason) || ""), source: String((res.data && res.data.keySource) || ""), mode: String((res.data && res.data.mode) || ""), at: now() };
    return res.data;
  }
  function makePipe(isTx, target, voice, out) {
    const cb = pipeCallbacks(isTx);
    const p = createPipe(env, Object.assign({ id: (isTx ? "tx" : "rx") + Date.now(), target: target, voice: voice, out: out, keepAlive: liveStreamOn(), immediatePlay: !!(cfg.streamPlay && cfg.streamPlay()) }, cb));
    p.lead.floor(link.level);
    livePipes.add(p);
    return p;
  }
  function onPipeState(p, state, isTx) {
    if (state === "ready") { emit("status", { code: "translating-ready", mine: isTx }); applyGains(); }
    if (state === "nokey" || state === "badkey") { emit("needKey", { reason: state }); degrade("key"); return; }
    if (state === "quota" || state === "text") { degrade("quota"); return; }
    if (state === "failed") {
      if (liveStreamOn() && !p.oneShot) {
        fallback[isTx ? "tx" : "rx"] = true;
        emit("fallback", { on: true, mine: isTx });
        return;
      }
      degrade("network");
      return;
    }
    if (state === "lost") emit("status", { code: "translator-reconnecting" });
  }
  function currentSpeaker() {
    const list = ears.speakers();
    return list.length > 1 && E._lastSpeaker ? E._lastSpeaker : "";
  }
  function ensureRx() {
    if (!ac || ended) return;
    if (needRx()) {
      if (!rx) {
        rx = makePipe(false, mineLang(), cfg.voiceOverride() || wantVoice, transOut);
        rx.open();
        rxFlushed = true;
      } else if (rx.target !== mineLang()) rotate(false);
    } else if (rx) {
      const gone = rx;
      rx = null;
      gone.finish();
      gone.close();
    }
    applyGains();
  }
  function ensureTx() {
    if (!ac || ended) return;
    const m = mode();
    const want = m.translationOnly && m.send === "voice" && peer.lang && !sameLang(peer.lang, mineLang()) && !degraded;
    if (want && !tx) {
      tx = makePipe(true, peer.lang, cfg.voiceOverride(), transToSend);
      tx.open();
      txFlushed = true;
    } else if (!want && tx) {
      const gone = tx;
      tx = null;
      gone.finish();
      gone.close();
    }
    announce();
    applyGains();
  }
  function rotate(isTx) {
    if (ended) return;
    const old = isTx ? tx : rx;
    if (!old || old.rotating) return;
    old.rotating = true;
    lastRotate = Date.now();
    const next = makePipe(isTx, old.target, isTx ? cfg.voiceOverride() : (cfg.voiceOverride() || wantVoice), isTx ? transToSend : transOut);
    next.handle = old.handle;
    const originalState = next.open;
    const origCb = next;
    const timer = setInterval(() => {
      if (next.ready) {
        clearInterval(timer);
        if (isTx) tx = next; else rx = next;
        setTimeout(() => { old.finish(); old.close(); }, 1500);
        applyGains();
      } else if (next.closed) clearInterval(timer);
    }, 80);
    setTimeout(() => clearInterval(timer), 15000);
    originalState.call(origCb);
  }

  /* ---------- audio taps ---------- */
  async function tapNode(onFrame) {
    const url = URL.createObjectURL(new Blob([MIC_WORKLET], { type: "text/javascript" }));
    if (!workletReady.has(ac)) {
      await ac.audioWorklet.addModule(url);
      workletReady.add(ac);
    }
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ac, "call-mic", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (event) => onFrame(new Int16Array(event.data));
    const mute = ac.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ac.destination);
    taps.push(node, mute);
    return node;
  }
  function onRemoteFrame(pcm) {
    const floats = floatsOf(pcm);
    let sum = 0;
    for (let i = 0; i < floats.length; i++) sum += floats[i] * floats[i];
    if (Math.sqrt(sum / floats.length) >= 0.02) {
      if (now() - metrics.lastLoud > 1500) { metrics.speechStart = now(); metrics.waiting = true; }
      metrics.lastLoud = now();
      metrics.pendingEnd = true;
    }
    const heard = ears.push(floats, 16000, "");
    if (heard && heard.speaker) E._lastSpeaker = ears.speakers().length > 1 ? heard.speaker.name : "";
    const match = voiceMatch.push(floats, 16000);
    const diarVoice = heard && heard.speaker && ears.speakers().length > 1 ? heard.speaker.voice : "";
    const picked = cfg.voiceOverride() || diarVoice || (match.source === "pitch" ? match.voice : "");
    if (picked) wantVoice = picked;
    /* In a test call these frames came out of this device's own microphone, so while its translation plays aloud they
       carry that sound back. Only clearly louder speech may open the gate then, or the call translates itself. */
    const loop = cfg.micLoop && rx && rx.playing && rx.playing() ? "loop" : quietOff();
    shortEosOn();
    if ((!rx || !rx.ready) && !fallback.rx) { live.onSpeech(pcm, now(), loop); return; }
    if (heard && heard.overlap) return;
    const d = live.onSpeech(pcm, now(), loop);
    if (d.send) {
      if (live.vad.spoke) timeline.rx.speech(now());
      const bits = d.chunks && d.chunks.length ? d.chunks : [pcm];
      if (fallback.rx) bits.forEach((c) => fallback.rxBuf.push(c));
      else bits.forEach((c) => rx.send(c));
      lastSpeechAt = now();
      rxFlushed = false;
      if (!speaking) {
        speaking = true;
        if (bargeOn() && rx && rx.playing && rx.playing() && rx.cut) rx.cut();
        emit("speaking", { who: "peer", on: true });
      }
    } else {
      if (d.reason === "quota") { degrade("quota", true); return; }
      if (speaking) { speaking = false; emit("speaking", { who: "peer", on: false }); }
      if (!rxFlushed && lastSpeechAt && (shortEosOn() || now() - lastSpeechAt > 1800)) {
        rxFlushed = true;
        if (fallback.rx) kickTurn(false, fallback.rxBuf.drain());
        else { rx.flush(); maybeSwapVoice(); }
      }
    }
  }
  function maybeSwapVoice() {
    if (!rx || cfg.voiceOverride()) return;
    if (wantVoice && wantVoice !== rx.voice && Date.now() - lastRotate > 8000 && !translating()) {
      rx.voice = wantVoice;
      rotate(false);
    }
  }
  function kickTurn(isTx, chunks) {
    if (!chunks || !chunks.length || ended) return;
    const busy = isTx ? "txBusy" : "rxBusy";
    if (fallback[busy]) return;
    fallback[busy] = true;
    const p = makePipe(isTx, isTx ? peer.lang : mineLang(), isTx ? cfg.voiceOverride() : (cfg.voiceOverride() || wantVoice), isTx ? transToSend : transOut);
    p.oneShot = true;
    p.pending = chunks;
    if (isTx) tx = p; else rx = p;
    const done = (ok) => {
      if (p._shotDone) return;
      p._shotDone = true;
      fallback[busy] = false;
      if (!ok) degrade("network");
    };
    const timer = setTimeout(() => { if (!p._shotDone) { p.close(); done(false); } }, 12000);
    p.onShotDone = () => {
      clearTimeout(timer);
      const wait = () => {
        if (p.playing && p.playing()) return false;
        clearInterval(id);
        p.close();
        done(true);
        return true;
      };
      const id = setInterval(wait, 200);
      timers.push(id);
      setTimeout(wait, 400);
    };
    p.open();
  }
  let ownSpeaking = false;
  /* Quiet-voice help is automatic: the gate follows the room's noise floor and soft speech is lifted. It is off for the
     owner switch calls_quiet_voice, and strict (the old fixed gate) while sound is playing aloud, so an echo never opens it. */
  function quietOff() { return !!(cfg.quietVoice && !cfg.quietVoice()); }
  function bargeOn() { return !!(cfg.bargeIn && cfg.bargeIn()); }
  function shortEosOn() {
    const on = !!(cfg.shortEos && cfg.shortEos());
    live.vad.shortOn(on);
    sendLive.vad.shortOn(on);
    return on;
  }
  function onOwnFrame(pcm) {
    const loop = !!(cfg.otherPlaying && cfg.otherPlaying());
    const aloud = speaking || (rx && rx.playing && rx.playing());
    shortEosOn();
    const d = sendLive.onSpeech(pcm, now(), loop ? "loop" : (quietOff() || !!aloud));
    const on = !!d.send;
    if (on !== ownSpeaking) { ownSpeaking = on; emit("speaking", { who: "me", on: on }); }
    if ((!tx || !tx.ready) && !fallback.tx) return;
    if (d.send) {
      if (sendLive.vad.spoke) timeline.tx.speech(now());
      const bits = d.chunks && d.chunks.length ? d.chunks : [pcm];
      if (fallback.tx) bits.forEach((c) => fallback.txBuf.push(c));
      else bits.forEach((c) => tx.send(c));
      lastTxSpeech = now();
      txFlushed = false;
    } else if (!txFlushed && lastTxSpeech && (shortEosOn() || now() - lastTxSpeech > 1800)) {
      txFlushed = true;
      if (fallback.tx) kickTurn(true, fallback.txBuf.drain());
      else tx.flush();
    }
  }

  /* ---------- start / stop ---------- */
  E.start = async function start(info) {
    call = { id: info.id, ticket: info.ticket, role: info.role === "host" ? "host" : "guest" };
    ended = false;
    shared = !!(cfg.audioContext && cfg.audioContext());
    ac = shared ? cfg.audioContext() : new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    setAudioSession(navigator, "play-and-record");
    if (ac.state !== "running") ac.resume().catch(() => {});
    master = ac.createGain();
    master.connect(ac.destination);
    origOut = ac.createGain();
    transOut = ac.createGain();
    origOut.connect(master);
    transOut.connect(master);
    remoteBus = ac.createGain();
    remoteBus.connect(origOut);
    sendDest = ac.createMediaStreamDestination();
    origToSend = ac.createGain();
    transToSend = ac.createGain();
    origToSend.connect(sendDest);
    transToSend.connect(sendDest);
    /* No microphone, or permission denied: the call still starts and typed text still works. */
    try {
      micStream = cfg.getMic ? await cfg.getMic() : await navigator.mediaDevices.getUserMedia({ audio: micConstraints(!quietOff()), video: false });
    } catch (err) {
      micStream = null;
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      emit("nomic", { reason: denied ? "denied" : "none" });
    }
    ownMic = !cfg.getMic;
    if (micStream) {
      const micSrc = ac.createMediaStreamSource(micStream);
      micLevel = ac.createGain();
      micSrc.connect(micLevel);
      micLevel.connect(origToSend);
      const ownTap = await tapNode(onOwnFrame);
      micLevel.connect(ownTap);
    }
    pc = new RTCPeerConnection({ iceServers: info.iceServers || [], bundlePolicy: "max-bundle" });
    sendDest.stream.getAudioTracks().forEach((track) => pc.addTrack(track, sendDest.stream));
    pc.onicecandidate = (event) => { if (event.candidate) signal({ kind: "ice", candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate }); };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") { emit("status", { code: "connected" }); applyBitrate(); }
      else if (s === "disconnected") { emit("status", { code: "reconnecting" }); setTimeout(() => { if (pc && pc.iceConnectionState === "disconnected" && call.role === "host") offer(true); }, 2500); }
      else if (s === "failed") { emit("status", { code: "reconnecting" }); if (call.role === "host") offer(true); }
    };
    pc.ontrack = async (event) => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      remoteEl = document.createElement("audio");
      remoteEl.muted = true;
      remoteEl.autoplay = true;
      remoteEl.srcObject = stream;
      try { await remoteEl.play(); } catch (err) { /* autoplay is allowed after a tap */ }
      remoteSrc = ac.createMediaStreamSource(stream);
      remoteSrc.connect(remoteBus);
      const tap = await tapNode(onRemoteFrame);
      remoteBus.connect(tap);
      E.remoteTap = tap;
    };
    if (call.role === "host") dc = setupChannel(pc.createDataChannel("calls", { ordered: true }));
    else pc.ondatachannel = (event) => { dc = setupChannel(event.channel); };
    every(30000, () => { if (rx && rx.openedAt && Date.now() - rx.openedAt > ROTATE_MS) rotate(false); if (tx && tx.openedAt && Date.now() - tx.openedAt > ROTATE_MS) rotate(true); });
    every(10000, () => { if (rx && rx.maybeKeepAlive) rx.maybeKeepAlive(); if (tx && tx.maybeKeepAlive) tx.maybeKeepAlive(); });
    every(120, () => {
      const t = translating();
      if (t !== lastTranslating) {
        lastTranslating = t;
        if (!t && metrics.pendingEnd && now() - metrics.lastLoud > 800 && metrics.lastVoiced >= metrics.speechStart) {
          metrics.endLag = Math.max(0, metrics.lastVoiced - metrics.lastLoud);
          metrics.pendingEnd = false;
        }
        emit("translating", { on: t });
        applyGains();
      }
    });
    document.addEventListener("visibilitychange", onVisible);
    /* iOS also reports "interrupted" (a phone call, Siri, the lock screen). */
    ac.onstatechange = () => { if (ac && ac.state !== "running" && ac.state !== "closed" && !ended) ac.resume().catch(() => {}); };
    ["pageshow", "focus"].forEach((name) => window.addEventListener(name, onVisible));
    window.addEventListener("online", onNetwork);
    try { if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener("change", onNetwork); } catch (err) { /* no Network Information API */ }
    every(2000, () => { if (ac && ac.state !== "running" && ac.state !== "closed" && document.visibilityState !== "hidden") ac.resume().catch(() => {}); });
    every(4000, adaptLink);
    /* A pause from the local speech budget lifts by itself once the last minute is quiet. */
    every(2500, () => {
      if (!degraded || !localPause || ended) return;
      const t = now();
      const a = live.recover(t);
      const b = sendLive.recover(t);
      if ((a || live.phase() !== "text") && (b || sendLive.phase() !== "text")) { localPause = false; E.retryTranslation(); }
    });
    applyGains();
    await connectSignal();
    ensureRx();
    ensureTx();
  };
  function onVisible() { if (ac && ac.state !== "running" && ac.state !== "closed") ac.resume().catch(() => {}); }
  /* A switch from Wi-Fi to mobile data (or back) leaves the old paths dead. */
  let netTimer = null;
  function onNetwork() {
    if (ended) return;
    clearTimeout(netTimer);
    netTimer = setTimeout(() => { if (!ended) E.nudge(); }, 400);
  }
  E.nudge = function nudge() {
    if (ended || !call) return;
    sigAttempt = 0;
    if (!sig) connectSignal();
    const st = pc ? pc.iceConnectionState : "";
    if (pc && st !== "connected" && st !== "completed") {
      emit("status", { code: "reconnecting" });
      if (call.role === "host") offer(true); else signal({ kind: "restart" });
    } else if (pc && call.role === "host") {
      /* The addresses may have changed even though the old path still reads connected. */
      offer(true);
    }
    [rx, tx].forEach((p) => { if (p && p.nudge) p.nudge(); });
  };
  let link = { level: 0, good: 0 };
  const livePipes = new Set();
  let lastSent = 0;
  let lastLost = 0;
  async function adaptLink() {
    if (!pc || ended) return;
    let rtt = 0;
    let loss = 0;
    try {
      const stats = await pc.getStats();
      stats.forEach((row) => {
        if (row.type === "remote-inbound-rtp" && row.kind === "audio") {
          if (typeof row.roundTripTime === "number") rtt = row.roundTripTime;
          if (typeof row.fractionLost === "number") loss = row.fractionLost;
        }
      });
    } catch (err) { return; }
    const next = pickBitrate(link, { loss: loss, rtt: rtt });
    const changed = next.level !== link.level;
    link = next;
    livePipes.forEach((p) => { if (p.closed) livePipes.delete(p); else p.lead.floor(next.level); });
    if (changed) { applyBitrate(next.bitrate); emit("link", { level: next.level, bitrate: next.bitrate, loss: loss, rtt: rtt }); }
  }
  function applyBitrate(forced) {
    try {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (!sender || !sender.getParameters) return;
      const lighter = lighterFor(cfg.connection ? cfg.connection() : {});
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const base = lighter.lighter ? lighter.bitrate : 64000;
      params.encodings[0].maxBitrate = forced ? Math.min(forced, base) : Math.min(base, link.level ? pickBitrate({ level: link.level, good: 0 }, { loss: 0, rtt: 0 }).bitrate : base);
      sender.setParameters(params).catch(() => {});
    } catch (err) { /* the default bitrate is fine */ }
  }
  E.prewarm = function prewarm() { ensureRx(); };

  /* The mic was allowed after the call started: wire it in without touching the peer connection. */
  E.attachMic = async function attachMic(stream) {
    if (micStream || !ac || !stream) return false;
    micStream = stream;
    ownMic = true;
    const micSrc = ac.createMediaStreamSource(stream);
    micLevel = ac.createGain();
    micSrc.connect(micLevel);
    micLevel.connect(origToSend);
    const tapMic = await tapNode(onOwnFrame);
    micLevel.connect(tapMic);
    stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    applyGains();
    return true;
  };
  E.setMuted = (on) => {
    muted = !!on;
    if (micStream) micStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    applyGains();
  };
  E.refresh = () => {
    const m = mode();
    if (micStream && m.send !== "voice") micStream.getAudioTracks().forEach((t) => { t.enabled = !!(recorder && recorder.state === "recording"); });
    else if (micStream) micStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    ensureTx();
    ensureRx();
    applyGains();
  };
  E.setSink = async (id) => {
    try { if (ac && ac.setSinkId && id != null) await ac.setSinkId(id); } catch (err) { /* keep the speaker */ }
  };
  E.degraded = () => degraded;
  E.playing = () => !!(rx && rx.playing && rx.playing());
  /* After a key is saved: try translation again without ending the call. */
  E.retryTranslation = () => {
    if (!degraded || ended) { ensureRx(); ensureTx(); return; }
    degraded = false;
    announce();
    ensureRx();
    ensureTx();
    applyGains();
  };
  let localPause = false;
  function degrade(reason, local) {
    if (degraded) return;
    degraded = true;
    localPause = !!local;
    if (rx) { rx.finish(); rx.close(); rx = null; }
    if (tx) { tx.finish(); tx.close(); tx = null; }
    announce();
    applyGains();
    emit("quota", { reason: reason });
  }
  E.stats = () => ({ via: route.via, rx: !!rx && rx.ready, tx: !!tx && tx.ready, peer: peer, usage: live.quota(now()), speakers: ears.speakers() });
  E.mintInfo = () => E._mint || null;
  E.turn = () => !!(fallback.rx || fallback.tx);
  E.timings = () => ({ rx: timeline.rx.list(), tx: timeline.tx.list(), rxSummary: timeline.rx.summary(), txSummary: timeline.tx.summary() });
  E.metrics = () => ({ firstAudio: metrics.firstAudio, endLag: metrics.endLag });
  E.micClone = () => {
    if (!micStream) return null;
    const copy = micStream.clone();
    copy.getAudioTracks().forEach((t) => { t.enabled = false; });
    return copy;
  };
  E.netStats = async () => {
    const out = { media: "", jitter: null, lost: null, rtt: null };
    if (!pc) return out;
    try {
      const report = await pc.getStats();
      const byId = {};
      report.forEach((row) => { byId[row.id] = row; });
      report.forEach((row) => {
        if (row.type === "inbound-rtp" && (row.kind === "audio" || row.mediaType === "audio")) {
          if (row.jitter != null) out.jitter = row.jitter * 1000;
          if (row.packetsLost != null) out.lost = row.packetsLost;
        }
        if (row.type === "candidate-pair" && (row.nominated || row.state === "succeeded") && row.currentRoundTripTime != null) {
          out.rtt = row.currentRoundTripTime * 1000;
          const l = byId[row.localCandidateId];
          const r = byId[row.remoteCandidateId];
          if (l && r) out.media = (l.candidateType || "?") + " / " + (r.candidateType || "?") + (l.candidateType === "relay" || r.candidateType === "relay" ? " (relay)" : "");
        }
      });
    } catch (err) { /* stats are optional */ }
    return out;
  };
  E.renameSpeaker = (id, name) => ears.rename(id, name);
  E.peer = peer;

  /* ---------- text, phrases, notes ---------- */
  async function translateLine(text, source) {
    if (!text) return "";
    if (sameLang(source, mineLang()) && source) return text;
    const res = await cfg.api("/v1/calls/" + call.id + "/speak", { method: "POST", body: JSON.stringify({ text: text, target: mineLang(), source: source || undefined, key: (cfg.getKey && cfg.getKey()) || undefined, lexicon: cleanLexicon(cfg.getLexicon()) }) }).catch(() => null);
    if (res && res.ok && res.data && (res.data.reason === "nokey" || res.data.reason === "badkey")) { emit("needKey", { reason: res.data.reason }); return text; }
    if (res && res.ok && res.data && res.data.translation) return String(res.data.translation);
    return text;
  }
  E.sendText = (text, reuseId) => {
    const posted = chatOut.post(text, mineLang(), reuseId);
    if (!posted) return false;
    if (reuseId) emit("chat-sending", { id: posted.id, original: posted.original });
    else emit("line", { mine: true, original: posted.original, translation: "", typed: true, id: posted.id, sent: posted.sent });
    if (posted.sent) emit("chat-sent", { id: posted.id, original: posted.original });
    else flushChat();
    return true;
  };
  async function onChat(d) {
    const text = String(d.text || "").slice(0, 500);
    if (!text) return;
    const lang = normalizeLang(d.lang) || peer.lang || detectLang(text, "en").code;
    const started = now();
    const tr = await translateLine(text, lang);
    emit("line", { mine: false, original: text, translation: tr, typed: true, speakText: playTranslatedVoice(mode()), lang: mineLang(), took: now() - started });
  }

  function setupChannel(ch) {
    ch.binaryType = "arraybuffer";
    ch.onmessage = (event) => {
      if (typeof event.data === "string") {
        let head = null;
        try { head = JSON.parse(event.data); } catch (err) { return; }
        if (head && head.t === "note" && head.size > 0 && head.size <= 4000000) noteIn = { id: head.id, mime: head.mime || "audio/webm", size: head.size, got: 0, parts: [], lang: head.lang };
        return;
      }
      if (!noteIn) return;
      noteIn.parts.push(event.data);
      noteIn.got += event.data.byteLength;
      if (noteIn.got >= noteIn.size) {
        const done = noteIn;
        noteIn = null;
        const blob = new Blob(done.parts, { type: done.mime });
        notes.set(done.id, blob);
        emit("note", { id: done.id, mine: false, lang: done.lang, autoplay: noteShouldAutoplay(mode()) });
        if (noteShouldAutoplay(mode())) E.playNote(done.id);
      }
    };
    return ch;
  }
  E.noteStart = () => {
    if (!micStream || recorder) return false;
    noteChunks = [];
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
    try { recorder = new MediaRecorder(micStream, mime ? { mimeType: mime } : undefined); } catch (err) { recorder = null; return false; }
    micStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    recorder.ondataavailable = (event) => { if (event.data && event.data.size) noteChunks.push(event.data); };
    recorder.start(250);
    return true;
  };
  E.noteStop = () => new Promise((resolve) => {
    const r = recorder;
    if (!r) { resolve(null); return; }
    r.onstop = () => {
      recorder = null;
      if (mode().send !== "voice") micStream.getAudioTracks().forEach((t) => { t.enabled = false; });
      resolve(new Blob(noteChunks, { type: r.mimeType || "audio/webm" }));
    };
    try { r.stop(); } catch (err) { recorder = null; resolve(null); }
  });
  E.noteSend = async (blob) => {
    if (!blob || !blob.size || !dc || dc.readyState !== "open") return false;
    const id = String(Date.now());
    const buf = await blob.arrayBuffer();
    dc.send(JSON.stringify({ t: "note", id: id, mime: blob.type, size: buf.byteLength, lang: mineLang() }));
    for (let i = 0; i < buf.byteLength; i += NOTE_CHUNK) {
      while (dc.bufferedAmount > 1000000) await new Promise((r) => setTimeout(r, 30));
      dc.send(buf.slice(i, i + NOTE_CHUNK));
    }
    notes.set(id, blob);
    emit("note", { id: id, mine: true });
    return true;
  };
  E.playNote = async (id) => {
    const blob = notes.get(id);
    if (!blob || !ac) return;
    try {
      const data = await ac.decodeAudioData(await blob.arrayBuffer());
      const src = ac.createBufferSource();
      src.buffer = data;
      src.connect(remoteBus);
      if (E.remoteTap) { /* the bus feeds the translation tap */ }
      src.start();
      emit("noteplay", { id: id, ms: Math.round(data.duration * 1000) });
    } catch (err) { /* a clip the browser cannot decode stays as a bubble */ }
  };

  E.end = async (silent) => {
    if (ended) return;
    ended = true;
    clearTimeout(chatTimer);
    chatTimer = 0;
    timers.forEach(clearInterval);
    timers = [];
    document.removeEventListener("visibilitychange", onVisible);
    ["pageshow", "focus"].forEach((name) => window.removeEventListener(name, onVisible));
    window.removeEventListener("online", onNetwork);
    try { if (navigator.connection && navigator.connection.removeEventListener) navigator.connection.removeEventListener("change", onNetwork); } catch (err) { /* nothing bound */ }
    clearTimeout(netTimer);
    setAudioSession(navigator, "auto");
    if (!silent && call) { try { await cfg.api("/v1/calls/" + call.id + "/end", { method: "POST", body: "{}" }); } catch (err) { /* the row expires */ } }
    [rx, tx].forEach((p) => { if (p) { p.finish(); p.close(); } });
    rx = null;
    tx = null;
    try { if (sig) sig.close(); } catch (err) { /* closed */ }
    try { if (dc) dc.close(); } catch (err) { /* closed */ }
    try { if (pc) pc.close(); } catch (err) { /* closed */ }
    if (micStream && (ownMic || true)) micStream.getTracks().forEach((t) => t.stop());
    if (remoteEl) { remoteEl.srcObject = null; }
    if (ac && shared) {
      /* The unlocked context outlives the call, so only this call's graph goes. */
      ac.onstatechange = null;
      [master, origOut, transOut, remoteBus, remoteSrc, origToSend, transToSend, micLevel].concat(taps).forEach((node) => { try { if (node) node.disconnect(); } catch (err) { /* gone */ } });
    } else {
      try { if (ac) await ac.close(); } catch (err) { /* closed */ }
    }
    ac = null;
    pc = null;
    sig = null;
    emit("ended", {});
  };
  E.id = () => (call ? call.id : "");
  return E;
}

/* The same check the UI and the tests use: how a received line is shown. */
export function describeRoute(via) {
  return via === "relay" ? "relay" : "direct";
}
