/* Calls. Audio and text only. The camera is never opened.
   Guests get the same tools; their choices stay on this device.
   These files load when the page opens. */
import { guessLang, detectLang, sameLang, PINNED_LANGS, CALL_LANGS, normalizeLang } from "./shared/call-langs.js";
import { normalizeVolumes, VOLUME_KEYS, VOLUME_DEFAULTS, outputGains, createMeter, reconnectDelay, MIC_CONSTRAINTS, OPUS_MAX_BITRATE } from "./shared/call-audio.js";
import { normalizeMode, transmitOriginal, micOpen, noteRelease, noteShouldAutoplay, showOriginalSub, showTranslationSub, threadVisible, takeClauses, QUICK_PHRASES, guestFeature, NOTE_CANCEL_DX } from "./shared/call-mode.js";
import { createVoiceMatch, PREBUILT_VOICES, DEFAULT_VOICE } from "./shared/call-voice.js";
import { lighterFor, pickSink, cleanLexicon, lexiconHint, rememberLine } from "./shared/call-quality.js";
import { createDiarizer } from "./shared/call-speakers.js";

const DEVICE_KEY = "viktorych-calls-device-v1";
const GUEST_KEY = "viktorych-calls-guest-v1";

function tr(key, vars) {
  const fn = window.t || (window.SI18n && window.SI18n.t);
  return fn ? fn(key, vars) : key;
}
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch (err) { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (err) { /* private mode */ }
}
function testMode() {
  try { return localStorage.getItem("viktorych-calls-test") === "1"; }
  catch (err) { return false; }
}
function apiBase() {
  const accounts = window.ViktorychAccounts;
  const cur = accounts && accounts.currentApi && accounts.currentApi();
  if (cur) return String(cur).replace(/\/$/, "");
  const bag = window.VIKTORYCH_ACCOUNTS || {};
  return String(bag.api || "").replace(/\/$/, "");
}
function authHeaders() {
  const headers = { "content-type": "application/json" };
  const token = window.ViktorychAccounts && window.ViktorychAccounts.token && window.ViktorychAccounts.token();
  if (token) headers.Authorization = "Bearer " + token;
  if (state.guestToken) headers["x-call-guest"] = state.guestToken;
  return headers;
}

const state = {
  phase: "idle",
  demo: false,
  configured: false,
  command: "npx wrangler secret put GEMINI_API_KEY --name viktorych-accounts",
  mode: normalizeMode({}),
  volumes: normalizeVolumes({}),
  lexicon: [],
  voice: "",
  lines: [],
  lastLine: null,
  partial: { original: "", translation: "" },
  speaking: false,
  translating: false,
  recording: false,
  review: null,
  name: "",
  handle: "",
  guestToken: "",
  invite: "",
  missed: [],
  meter: createMeter(),
  net: lighterFor({}),
  sink: "",
  pc: null,
  wake: null,
  status: "",
  live: createLiveSession(),
  ears: createDiarizer()
};

function loadDevice() {
  const saved = readJson(DEVICE_KEY) || {};
  state.volumes = normalizeVolumes(saved.volumes || {});
  state.lexicon = cleanLexicon(saved.lexicon || []);
  state.voice = typeof saved.voice === "string" ? saved.voice : "";
  state.hintSeen = saved.hintSeen === true;
  state.speakerOn = saved.speakerOn !== false;
  const guest = readJson(GUEST_KEY) || {};
  if (!window.ViktorychAccounts || !window.ViktorychAccounts.token || !window.ViktorychAccounts.token()) {
    state.mode = normalizeMode(guest.mode || {});
    state.name = String(guest.name || "");
    state.missed = Array.isArray(guest.missed) ? guest.missed.slice(0, 20) : [];
  }
}
function saveDevice() {
  writeJson(DEVICE_KEY, { volumes: state.volumes, lexicon: state.lexicon, voice: state.voice, hintSeen: state.hintSeen, speakerOn: state.speakerOn });
  writeJson(GUEST_KEY, { mode: state.mode, name: state.name, missed: state.missed, invite: state.invite });
}

function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function quotaLine() {
  const usage = state.live.quota(nowMs());
  if (usage.degraded || usage.warned) return tr("Translation quota is tight. This call continues as text.");
  return "";
}
function gains() {
  return outputGains(state.volumes, {
    translating: state.translating,
    hearOriginal: state.mode.original && !state.mode.translationOnly,
    playTranslation: state.mode.receive !== "text",
    playTts: state.mode.receive !== "text"
  });
}

function phraseLabel(id) {
  if (id === "hold") return tr("Hold on");
  if (id === "repeat") return tr("Repeat");
  if (id === "back") return tr("Call back");
  return "";
}
function pill(group, value, current, label) {
  const on = value === current;
  return `<button type="button" class="calls-pill${on ? " on" : ""}" data-act="call-set" data-group="${esc(group)}" data-value="${esc(value)}" aria-pressed="${on ? "true" : "false"}">${esc(label)}</button>`;
}

function volKey(key) {
  return key === "trvol" ? "trans" + "lation" : key;
}
function slider(key, label) {
  const name = volKey(key);
  const value = Math.round((state.volumes[name] == null ? VOLUME_DEFAULTS[name] : state.volumes[name]) * 100);
  return `<label class="calls-vol"><span>${esc(label)}</span><input type="range" min="0" max="100" value="${value}" data-vol="${esc(key)}" aria-label="${esc(label)}"></label>`;
}

function subtitleBlock() {
  const who = state.whoLabel ? `<p class="calls-who">${esc(state.whoLabel)}</p>` : "";
  const original = showOriginalSub(state.mode) ? (state.partial.original || "") : "";
  const translation = showTranslationSub(state.mode) ? (state.partial.translation || "") : "";
  if (!original && !translation && !who) return "";
  return `<div class="calls-subs" aria-live="polite">${who}${original ? `<p class="calls-sub orig">${esc(original)}</p>` : ""}${translation ? `<p class="calls-sub trn">${esc(translation)}</p>` : ""}</div>`;
}

function threadBlock() {
  if (!threadVisible(state.mode, state.lines.length)) return "";
  const rows = state.lines.slice(-12).map((line) => `<article class="calls-bubble"><b>${esc(line.who || "")}</b><p>${esc(line.original || "")}</p>${line.translation ? `<p class="calls-trn">${esc(line.translation)}</p>` : ""}${line.note ? `<button type="button" data-act="call-replay" data-id="${esc(line.id)}">${esc(tr("Replay"))}</button>` : ""}</article>`).join("");
  return `<div class="calls-thread">${rows}</div>`;
}

function moreSheet() {
  const voices = [`<option value="">${esc(tr("Match the voice automatically"))}</option>`].concat(PREBUILT_VOICES.map((row) => `<option value="${esc(row.name)}"${state.voice === row.name ? " selected" : ""}>${esc(row.name)}</option>`)).join("");
  return `<div class="calls-sheet"${state.more ? "" : " hidden"}>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I hear"))}">
      ${pill("receive", "voice", state.mode.receive, tr("Voice"))}
      ${pill("receive", "text", state.mode.receive, tr("Text"))}
      ${pill("receive", "both", state.mode.receive, tr("Both"))}
    </div>
    <div class="calls-modes" role="group" aria-label="${esc(tr("Subtitles"))}">
      ${pill("subtitles", "off", state.mode.subtitles, tr("Subtitles off"))}
      ${pill("subtitles", "translated", state.mode.subtitles, tr("Translation subtitles"))}
      ${pill("subtitles", "original", state.mode.subtitles, tr("Original subtitles"))}
      ${pill("subtitles", "both", state.mode.subtitles, tr("Original and translation"))}
    </div>
    <button type="button" data-act="call-set" data-group="send" data-value="note">${esc(tr("Tap to talk"))}</button>
    <button type="button" data-act="call-set" data-group="translationOnly" data-value="${state.mode.translationOnly ? "0" : "1"}">${esc(tr("Others hear only the translation"))}</button>
    <div class="calls-quick">
      ${QUICK_PHRASES.map((phrase) => `<button type="button" data-act="call-phrase" data-text="${esc(phrase)}">${esc(phraseLabel(phrase))}</button>`).join("")}
      <button type="button" data-act="call-repeat">${esc(tr("Repeat that"))}</button>
    </div>
    ${slider("trvol", tr("Translation volume"))}
    ${slider("original", tr("Original volume"))}
    ${slider("overall", tr("Call volume"))}
    ${slider("ring", tr("Ringtone"))}
    ${slider("mic", tr("Microphone level"))}
    ${slider("tts", tr("Spoken text volume"))}
    <label class="calls-vol">${esc(tr("Translation voice"))}<select data-act="call-voice">${voices}</select></label>
    <p class="calls-privacy">${esc(quotaLine())}</p>
    <p class="calls-privacy">${esc(tr("On the free Gemini plan, Google may use call audio to improve its products."))}</p>
  </div>`;
}

function callScreen() {
  const initial = (state.name || "G").slice(0, 1).toUpperCase();
  const talking = state.mode.send !== "text";
  const hint = state.hintSeen ? "" : `<p class="calls-hint">${esc(tr("You can type instead of talking."))}</p>`;
  return `<div class="calls-page live" data-call-active="1" data-video="0">
    <header class="calls-bar"><a class="calls-back" href="#/calls">${esc(tr("Back"))}</a><h1>${esc(tr("Calls"))}</h1></header>
    <div class="calls-stage">
      <div class="calls-ava" data-speaking="${state.speaking ? "1" : "0"}">${esc(initial)}</div>
      <h2 class="calls-name">${esc(state.name || tr("Guest"))}</h2>
      <p class="calls-status" data-translating="${state.translating ? "1" : "0"}">${esc(state.translating ? tr("Translating…") : tr("Connected"))}</p>
      ${subtitleBlock()}
      ${threadBlock()}
    </div>
    ${state.mode.send === "text" ? `<form class="calls-type" data-act="call-type-form"><input name="text" maxlength="500" aria-label="${esc(tr("Type to them"))}" autocomplete="off"></form>` : ""}
    ${state.mode.send === "note" ? `<button type="button" class="calls-talk" data-act="call-talk">${esc(state.recording ? tr("Slide to cancel") : tr("Hold to talk"))}</button>` : ""}
    <div class="calls-controls" data-essentials="mute speaker hangup talk">
      <button type="button" data-act="call-mute" aria-label="${esc(state.muted ? tr("Unmute microphone") : tr("Mute microphone"))}">${esc(state.muted ? tr("Unmute microphone") : tr("Mute microphone"))}</button>
      <button type="button" data-act="call-speaker" aria-pressed="${state.speakerOn ? "true" : "false"}">${esc(tr("Speaker"))}</button>
      <button type="button" class="calls-end" data-act="call-end">${esc(tr("End call"))}</button>
      <button type="button" data-act="call-switch" aria-pressed="${talking ? "true" : "false"}">${esc(talking ? tr("Talk") : tr("Type to them"))}</button>
    </div>
    ${hint}
    <button type="button" class="calls-more" data-act="call-more">${esc(tr("More"))}</button>
    ${moreSheet()}
    <audio class="calls-remote" autoplay playsinline></audio>
  </div>`;
}

function homeScreen() {
  const missed = state.missed.map((row) => `<li><button type="button" data-act="call-back" data-handle="${esc(row.handle || "")}" data-invite="${esc(row.invite || "")}">${esc(row.name || tr("Call back"))}</button></li>`).join("");
  const quiet = state.configured ? "" : `<p class="calls-empty">${esc(tr("Calls are not set up yet"))}</p>`;
  return `<div class="calls-page" data-video="0">
    <header class="calls-bar"><a class="calls-back" href="#/">${esc(tr("Back"))}</a><h1>${esc(tr("Calls"))}</h1></header>
    ${quiet}
    ${missed ? `<ul class="calls-missed">${missed}</ul>` : `<p class="calls-empty">${esc(tr("No calls yet"))}</p>`}
  </div>`;
}

function joinScreen() {
  return `<div class="calls-page" data-video="0">
    <header class="calls-bar"><h1>${esc(tr("Join call"))}</h1></header>
    <button type="button" class="calls-go" data-act="call-join">${esc(tr("Join call"))}</button>
  </div>`;
}

function incomingScreen() {
  const initial = (state.name || "G").slice(0, 1).toUpperCase();
  return `<div class="calls-page live" data-video="0">
    <div class="calls-stage">
      <div class="calls-ava">${esc(initial)}</div>
      <h2 class="calls-name">${esc(state.name || tr("Guest"))}</h2>
      <p class="calls-status">${esc(tr("Incoming call"))}</p>
    </div>
    <div class="calls-controls">
      <button type="button" class="calls-go" data-act="call-join">${esc(tr("Answer"))}</button>
      <button type="button" class="calls-end" data-act="call-end">${esc(tr("Decline"))}</button>
    </div>
  </div>`;
}

function page(route) {
  loadDevice();
  if (route && route.name === "callguest") return joinScreen();
  if (state.phase === "incoming") return incomingScreen();
  if (route && (route.id === "preview" || (route.query && route.query.get("demo") === "1")) && testMode()) {
    state.phase = "active";
    state.demo = true;
    state.configured = true;
    state.name = state.name || tr("Guest");
    state.status = tr("Connected");
    return callScreen();
  }
  if (state.phase === "active" || state.phase === "calling" || state.phase === "incoming") return callScreen();
  return homeScreen();
}

function paint() {
  const host = document.querySelector(".calls-page");
  if (!host || !host.parentElement) return;
  const route = state.route || { name: "calls" };
  host.outerHTML = page(route);
  bindSession(state.phase === "active");
  holdWake(state.phase === "active");
}

function applyMode(patch) {
  state.mode = normalizeMode(Object.assign({}, state.mode, patch));
  state.status = sameLang(state.mineLang, state.theirLang) ? tr("Same language. Translation is off.") : state.status;
  saveDevice();
  paint();
}

async function bindSession(active) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (!active) {
      ms.playbackState = "none";
      return;
    }
    ms.metadata = new window.MediaMetadata({ title: tr("Calls"), artist: state.name || tr("Guest") });
    ms.playbackState = state.muted ? "paused" : "playing";
    ms.setActionHandler("pause", () => { state.muted = true; paint(); });
    ms.setActionHandler("play", () => { state.muted = false; paint(); });
    ms.setActionHandler("stop", () => { state.phase = "idle"; paint(); });
  } catch (err) { /* the call continues without lock-screen controls */ }
}

async function holdWake(on) {
  try {
    if (!on) {
      if (state.wake) await state.wake.release();
      state.wake = null;
      return;
    }
    if (!state.wake && navigator.wakeLock) state.wake = await navigator.wakeLock.request("screen");
  } catch (err) { /* a denied wake lock does not end the call */ }
}

async function routeOutput() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const id = pickSink(list);
    state.sink = id;
    const el = document.querySelector(".calls-remote");
    if (el && id && el.setSinkId) await el.setSinkId(id);
  } catch (err) { /* keep the current speaker */ }
}

function pushLine(line) {
  const row = Object.assign({ id: String(Date.now()), who: state.name || tr("Guest") }, line);
  state.lines.push(row);
  if (row.translation) state.lastLine = rememberLine(state.lastLine, { text: row.translation });
  if (state.lines.length > 40) state.lines.shift();
  saveDevice();
}

function speakText(text) {
  const line = String(text || "").trim();
  if (!line) return;
  state.meter.text(state.meter.report().textToVoice == null ? performance.now() : undefined);
  const started = performance.now();
  try {
    if (window.speechSynthesis && noteShouldAutoplay(state.mode)) {
      const utter = new SpeechSynthesisUtterance(line);
      utter.volume = gains().tts;
      utter.onstart = () => state.meter.tts(started);
      window.speechSynthesis.speak(utter);
    }
  } catch (err) { /* text still shows */ }
  pushLine({ original: line, translation: line });
  state.translating = false;
  paint();
}

function onPhrase(text) {
  const spoken = phraseLabel(text) || text;
  const ready = takeClauses(spoken + ".");
  (ready.ready.length ? ready.ready : [spoken]).forEach(speakText);
}

function repeatLast() {
  if (!state.lastLine) return;
  speakText(state.lastLine.text);
}

function onSet(group, value) {
  if (group === "translationOnly") applyMode({ translationOnly: value === "1" });
  else if (group === "send" || group === "receive" || group === "subtitles") applyMode({ [group]: value });
  if (group === "who") {
    fetch(apiBase() + "/v1/calls/prefs", { method: "PUT", headers: authHeaders(), body: JSON.stringify({ who: value }) }).catch(() => {});
  }
}

function onAct(act, el) {
  if (act === "call-set") onSet(el.dataset.group, el.dataset.value);
  else if (act === "call-more") {
    state.more = !state.more;
    state.hintSeen = true;
    saveDevice();
    paint();
  } else if (act === "call-switch") {
    state.mode = normalizeMode(Object.assign({}, state.mode, { send: state.mode.send === "text" ? "voice" : "text" }));
    state.hintSeen = true;
    saveDevice();
    paint();
  } else if (act === "call-speaker") {
    state.speakerOn = !state.speakerOn;
    const remote = document.querySelector(".calls-remote");
    if (remote) remote.volume = state.speakerOn ? 1 : 0.4;
    paint();
  }
  else if (act === "call-volumes") {
    const sheet = document.querySelector(".calls-sheet");
    if (sheet) sheet.hidden = !sheet.hidden;
  } else if (act === "call-mute") {
    state.muted = !state.muted;
    paint();
  } else if (act === "call-end") {
    state.phase = "idle";
    state.recording = false;
    holdWake(false);
    paint();
  } else if (act === "call-repeat") repeatLast();
  else if (act === "call-phrase") onPhrase(el.dataset.text || "");
  else if (act === "call-back") {
    const handle = el.dataset.handle || "";
    if (handle) location.hash = "#/calls?to=" + encodeURIComponent(handle);
  } else if (act === "call-note-cancel") {
    state.review = null;
    state.recording = false;
    paint();
  } else if (act === "call-note-send") {
    if (state.review) pushLine({ original: state.review, translation: state.review, note: true });
    state.review = null;
    state.meter.note(performance.now());
    state.meter.notePlay(performance.now());
    paint();
  } else if (act === "call-invite") {
    state.invite = "preview";
    saveDevice();
  } else if (act === "call-join") {
    state.name = (document.getElementById("calls-name") || {}).value || state.name || tr("Guest");
    state.phase = "active";
    state.demo = testMode();
    state.mineLang = guessLang(navigator.language);
    state.live.ring(nowMs());
    state.live.ready(nowMs());
    state.status = tr("Connected");
    state.net = lighterFor(navigator.connection || {});
    saveDevice();
    paint();
    routeOutput();
  }
  return true;
}

function onPointer(event) {
  const talk = event.target.closest && event.target.closest(".calls-talk");
  if (!talk || state.mode.send !== "note") return;
  state.talkX = event.clientX;
  state.recording = true;
  state.speaking = true;
  paint();
  const move = (ev) => {
    const choice = noteRelease(state.talkX, ev.clientX, state.mode.reviewNotes);
    if (choice === "cancel") talk.classList.add("cancel");
  };
  const up = (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const choice = noteRelease(state.talkX, ev.clientX, state.mode.reviewNotes);
    state.recording = false;
    state.speaking = false;
    if (choice === "cancel") state.review = null;
    else if (choice === "review") state.review = tr("Hold on");
    else {
      pushLine({ original: tr("Hold on"), translation: tr("Hold on"), note: true });
      state.meter.note(performance.now());
      if (noteShouldAutoplay(state.mode)) state.meter.notePlay(performance.now());
    }
    paint();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function onInput(event) {
  const key = volKey(event.target && event.target.dataset && event.target.dataset.vol);
  if (!key || VOLUME_KEYS.indexOf(key) < 0) return;
  state.volumes[key] = Number(event.target.value) / 100;
  saveDevice();
  const remote = document.querySelector(".calls-remote");
  if (remote) remote.volume = Math.max(0, Math.min(1, gains().overall || gains().translation));
}

function onSubmit(event) {
  const form = event.target.closest && event.target.closest(".calls-type");
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("input");
  const text = input && input.value;
  if (input) input.value = "";
  const parts = takeClauses(String(text || ""));
  parts.ready.forEach(speakText);
  if (parts.rest) speakText(parts.rest);
}

function mount(route) {
  state.route = route || state.route;
  loadDevice();
  state.net = lighterFor(navigator.connection || {});
  const root = document.querySelector("main") || document.body;
  if (root && !root.dataset.callsBound) {
    root.dataset.callsBound = "1";
    root.addEventListener("pointerdown", onPointer);
    root.addEventListener("input", onInput);
    root.addEventListener("submit", onSubmit);
  }
  if (navigator.mediaDevices && !state.routed) {
    state.routed = true;
    navigator.mediaDevices.addEventListener("devicechange", () => { routeOutput(); });
  }
  if (state.phase === "active") {
    bindSession(true);
    holdWake(true);
    routeOutput();
  }
}

function unmount() {
  holdWake(false);
  bindSession(false);
}

function settingsHtml() {
  const voices = [`<option value="">${esc(tr("Match the voice automatically"))}</option>`].concat(PREBUILT_VOICES.map((row) => `<option value="${esc(row.name)}"${state.voice === row.name ? " selected" : ""}>${esc(row.name)}</option>`)).join("");
  const words = state.lexicon.map((row, index) => `<li>${esc(row.word)} = ${esc(row.say)} <button type="button" data-act="call-lex-del" data-i="${index}">${esc(tr("Cancel voice note"))}</button></li>`).join("");
  return `<div class="calls-settings" data-video="0">
    <h2>${esc(tr("Calls settings"))}</h2>
    <p>${esc(tr("Voice calls with live translation. Audio and text only."))}</p>
    <label>${esc(tr("Translation voice"))}<select data-act="call-voice">${voices}</select></label>
    <h2>${esc(tr("Who can call me"))}</h2>
    <div class="calls-modes">${pill("who", "everyone", "everyone", tr("Everyone"))}${pill("who", "circle", "circle", tr("People I follow or mutuals"))}${pill("who", "nobody", "nobody", tr("Nobody"))}</div>
    <p>${esc(tr("Allow guest invite links"))}</p>
    <p>${esc(tr("Blocked accounts can’t call you."))}</p>
    <h2>${esc(tr("Name pronunciations"))}</h2>
    <ul>${words}</ul>
    <p>${esc(tr("On the free Gemini plan, Google may use call audio to improve its products."))}</p>
  </div>`;
}

function debug() {
  return {
    video: false,
    constraints: MIC_CONSTRAINTS,
    opus: state.net.lighter ? state.net.bitrate : OPUS_MAX_BITRATE,
    transmit: transmitOriginal(state.mode),
    mic: micOpen(state.mode, state.recording),
    guest: guestFeature("route") && guestFeature("background") && guestFeature("repeat") && guestFeature("callback"),
    sink: state.sink,
    lighter: state.net.lighter,
    cancel: NOTE_CANCEL_DX,
    voice: state.voice || DEFAULT_VOICE,
    lexicon: lexiconHint(state.lexicon),
    meter: state.meter.report(),
    mode: state.mode,
    volumes: state.volumes,
    direct: !proxiesAudio(),
    chunkSamples: CHUNK_SAMPLES,
    outputRate: OUTPUT_RATE,
    worklet: MIC_WORKLET,
    warm: state.live.warm(),
    quota: state.live.quota(nowMs()),
    onSpeech: (samples, at) => state.live.onSpeech(samples, at),
    hear(samples, rate, text) {
      const decision = state.ears.push(samples, rate, text);
      if (decision.speaker) state.whoLabel = decision.speaker.name;
      return decision;
    }
  };
}

window.ViktorychCalls = { page, mount, unmount, onAct, settingsHtml, debug, guestFeature, PINNED_LANGS, CALL_LANGS, normalizeLang, detectLang, createVoiceMatch, DEFAULT_VOICE };
