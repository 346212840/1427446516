/* Calls. Audio and text only. The camera is never opened.
   Guests get the same tools; their choices stay on this device.
   This file runs inside the app and on the stand-alone /calls/ page.
   The real work is in shared/call-engine.js: WebRTC between the two
   phones and a Gemini Live Translate socket per listener. */
import { guessLang, sameLang, PINNED_LANGS, CALL_LANGS, normalizeLang, detectLang, langName } from "./shared/call-langs.js";
import { normalizeVolumes, VOLUME_KEYS, VOLUME_DEFAULTS, MIC_CONSTRAINTS, OPUS_MAX_BITRATE } from "./shared/call-audio.js";
import { normalizeMode, transmitOriginal, micOpen, noteRelease, noteShouldAutoplay, showOriginalSub, showTranslationSub, threadVisible, takeClauses, QUICK_PHRASES, guestFeature, NOTE_CANCEL_DX } from "./shared/call-mode.js";
import { createVoiceMatch, PREBUILT_VOICES, DEFAULT_VOICE } from "./shared/call-voice.js";
import { lighterFor, pickSink, cleanLexicon, lexiconHint, rememberLine } from "./shared/call-quality.js";
import { createLiveSession, MIC_WORKLET, OUTPUT_RATE, CHUNK_SAMPLES, proxiesAudio } from "./shared/call-gemini.js";
import { createDiarizer } from "./shared/call-speakers.js";
import { createEngine } from "./shared/call-engine.js";

const DEVICE_KEY = "viktorych-calls-device-v1";
const GUEST_KEY = "viktorych-calls-guest-v1";
const ROUTE_KEY = "viktorych-calls-route-v1";
const GKEY = "viktorych-calls-gkey-v1";
const SESSION_KEYS = ["viktorychapp-account-v1", "superintelapp-account-v1"];

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
function standalone() {
  return window.VIKTORYCH_CALLS_STANDALONE === true;
}
function session() {
  for (let i = 0; i < SESSION_KEYS.length; i++) {
    const row = readJson(SESSION_KEYS[i]);
    if (row && row.token && row.account) return row;
  }
  return null;
}
function token() {
  const accounts = window.ViktorychAccounts;
  const live = accounts && accounts.token && accounts.token();
  if (live) return live;
  const row = session();
  return row ? row.token : "";
}
function signedIn() {
  return !!token();
}
/* Calls always use the main Worker. Signalling needs its Durable Object,
   which the backup host does not have. */
function apiBase() {
  const bag = window.VIKTORYCH_ACCOUNTS || {};
  const main = String(bag.api || "").replace(/\/$/, "");
  if (main) return main;
  const accounts = window.ViktorychAccounts;
  const cur = accounts && accounts.currentApi && accounts.currentApi();
  return cur ? String(cur).replace(/\/$/, "") : "";
}
function authHeaders() {
  const headers = { "content-type": "application/json" };
  const tok = token();
  if (tok) headers.Authorization = "Bearer " + tok;
  if (state.guestToken) headers["x-call-guest"] = state.guestToken;
  return headers;
}
async function api(path, init) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 12000);
  try {
    const res = await fetch(apiBase() + path, Object.assign({ headers: authHeaders(), cache: "no-store", signal: ctrl ? ctrl.signal : undefined }, init || {}));
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  } finally { clearTimeout(timer); }
}

const state = {
  phase: "idle",
  configured: true,
  mode: normalizeMode({}),
  volumes: normalizeVolumes({}),
  lexicon: [],
  voice: "",
  lang: "",
  lines: [],
  lastLine: null,
  partial: { original: "", translation: "" },
  speaking: false,
  meSpeaking: false,
  translating: false,
  recording: false,
  review: null,
  name: "",
  peerName: "",
  guestToken: "",
  invite: "",
  inviteUrl: "",
  history: [],
  incoming: null,
  link: null,
  linkInfo: null,
  linkError: "",
  inviteTtl: 60,
  prefs: null,
  status: "",
  statusCode: "",
  quota: false,
  needKey: "",
  keySaved: false,
  keyMask: "",
  peerQuota: false,
  route: "",
  engine: null,
  partner: null,
  test: null,
  more: false,
  speakerOn: true,
  hintSeen: false,
  muted: false,
  stats: null,
  error: "",
  callId: "",
  startedAt: 0,
  whoLabel: "",
  sink: ""
};

function loadDevice() {
  const saved = readJson(DEVICE_KEY) || {};
  state.volumes = normalizeVolumes(saved.volumes || {});
  state.lexicon = cleanLexicon(saved.lexicon || []);
  state.voice = typeof saved.voice === "string" ? saved.voice : "";
  state.lang = typeof saved.lang === "string" ? saved.lang : "";
  state.hintSeen = saved.hintSeen === true;
  state.speakerOn = saved.speakerOn !== false;
  state.mode = normalizeMode(saved.mode || {});
  const guest = readJson(GUEST_KEY) || {};
  if (!signedIn()) state.name = String(guest.name || state.name || "");
  else {
    const row = session();
    state.name = String((row && row.account && (row.account.displayName || row.account.handle)) || state.name || "");
  }
}
function saveDevice() {
  writeJson(DEVICE_KEY, { volumes: state.volumes, lexicon: state.lexicon, voice: state.voice, lang: state.lang, hintSeen: state.hintSeen, speakerOn: state.speakerOn, mode: state.mode });
  writeJson(GUEST_KEY, { name: state.name });
}
function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function myLang() {
  return normalizeLang(state.lang) || guessLang((navigator.languages && navigator.languages[0]) || navigator.language);
}
function inRegion() {
  /* Same detector the main app uses for Russia and India. */
  return !!(window.__VIKTORYCH_IS_RU || window.__VIKTORYCH_IS_IN || window.__VIKTORYCH_MAX_BYPASS);
}
function relayFirst() {
  let saved = "";
  try { saved = localStorage.getItem(ROUTE_KEY) || ""; } catch (err) { saved = ""; }
  let mode = "auto";
  try { mode = localStorage.getItem("viktorychapp-network-mode") || "auto"; } catch (err) { mode = "auto"; }
  if (mode === "max") return true;
  if (mode === "direct") return false;
  if (saved) {
    try {
      const row = JSON.parse(saved);
      if (row && Date.now() - row.at < 60 * 60 * 1000) return row.via === "relay";
    } catch (err) { /* ignore */ }
  }
  return inRegion();
}
function rememberRoute(via) {
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ via: via, at: Date.now() })); } catch (err) { /* private mode */ }
}

function quotaLine() {
  if (state.needKey) return state.needKey === "badkey" ? tr("That Gemini key was not accepted. Paste a new one.") : tr("Translation needs a free Gemini key. Nobody in this call has added one yet.");
  if (state.quota) return tr("Translation quota is tight. This call continues as text.");
  return "";
}
/* A key pasted on this device (guests, or when the server cannot store it).
   It rides only the request that mints a short-lived token, and is never
   stored by the Worker or shown to the other person. */
function localKey() {
  try { return localStorage.getItem(GKEY) || ""; } catch (err) { return ""; }
}
function validKeyShape(value) {
  return /^[A-Za-z0-9_-]{20,100}$/.test(String(value || ""));
}
function keyPanel() {
  if (!state.needKey) return "";
  const where = signedIn() ? tr("It is saved encrypted on our server, so your calls and your guests can use it. You can remove it any time.") : tr("It stays on this device only.");
  return `<section class="calls-key" data-key role="alert">
    <h3>${esc(tr("Use your free Gemini key"))}</h3>
    <p>${esc(quotaLine())}</p>
    <p>${esc(tr("Translation uses Google's free Gemini. Get a key in a minute, then paste it here."))} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></p>
    <form class="calls-type" data-act="call-key-form"><input name="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${esc(tr("Gemini key"))}" placeholder="${esc(tr("Paste your key"))}"><button type="submit">${esc(tr("Save"))}</button></form>
    <p class="calls-privacy">${esc(where)}</p>
  </section>`;
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
  if (!original && !translation && !who) return `<div class="calls-subs" aria-live="polite"></div>`;
  return `<div class="calls-subs" aria-live="polite">${who}${original ? `<p class="calls-sub orig">${esc(original)}</p>` : ""}${translation ? `<p class="calls-sub trn">${esc(translation)}</p>` : ""}</div>`;
}

function bubble(line) {
  const mine = line.mine ? " mine" : "";
  const note = line.note ? `<button type="button" data-act="call-replay" data-id="${esc(line.id)}">${esc(tr("Replay"))}</button>` : "";
  return `<article class="calls-bubble${mine}"><b>${esc(line.who || "")}</b>${line.original ? `<p>${esc(line.original)}</p>` : ""}${line.translation && line.translation !== line.original ? `<p class="calls-trn">${esc(line.translation)}</p>` : ""}${note}</article>`;
}
function threadBlock() {
  if (!threadVisible(state.mode, state.lines.length)) return `<div class="calls-thread"></div>`;
  return `<div class="calls-thread">${state.lines.slice(-12).map(bubble).join("")}</div>`;
}

function langOptions(current) {
  const pinned = PINNED_LANGS.map((code) => [code, langName(code)]);
  const rest = CALL_LANGS.filter((row) => PINNED_LANGS.indexOf(row[0]) < 0).map((row) => [row[0], langName(row[0])]).sort((a, b) => a[1].localeCompare(b[1]));
  return pinned.concat(rest).map((row) => `<option value="${esc(row[0])}"${row[0] === current ? " selected" : ""}>${esc(row[1])}</option>`).join("");
}

function statsBlock() {
  const s = state.stats;
  if (!s) return `<div class="calls-stats" data-stats></div>`;
  const rows = [
    [tr("Route"), s.route === "relay" ? tr("Through our server") : tr("Direct")],
    [tr("Media path"), s.media || "-"],
    [tr("First translated sound"), s.firstAudio != null ? tr("{ms} ms", { ms: Math.round(s.firstAudio) }) : "-"],
    [tr("After you stop"), s.endLag != null ? tr("{ms} ms", { ms: Math.round(s.endLag) }) : "-"],
    [tr("Jitter"), s.jitter != null ? tr("{ms} ms", { ms: Math.round(s.jitter) }) : "-"],
    [tr("Packets lost"), s.lost != null ? String(s.lost) : "-"],
    [tr("Round trip"), s.rtt != null ? tr("{ms} ms", { ms: Math.round(s.rtt) }) : "-"],
    [tr("Speech sent"), s.speechSec != null ? tr("{n} s", { n: s.speechSec }) : "-"],
    [tr("Per minute"), s.perMinute != null ? tr("{n} s of 32", { n: s.perMinute }) : "-"]
  ];
  return `<dl class="calls-stats" data-stats>${rows.map((row) => `<div><dt>${esc(row[0])}</dt><dd>${esc(row[1])}</dd></div>`).join("")}</dl>`;
}

function moreSheet() {
  const voices = [`<option value="">${esc(tr("Match the voice automatically"))}</option>`].concat(PREBUILT_VOICES.map((row) => `<option value="${esc(row.name)}"${state.voice === row.name ? " selected" : ""}>${esc(row.name)}</option>`)).join("");
  const words = state.lexicon.map((row, index) => `<li>${esc(row.word)} = ${esc(row.say)} <button type="button" data-act="call-lex-del" data-i="${index}">${esc(tr("Remove"))}</button></li>`).join("");
  return `<div class="calls-sheet"${state.more ? "" : " hidden"}>
    <h3>${esc(tr("I hear"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I hear"))}">
      ${pill("receive", "voice", state.mode.receive, tr("Voice"))}
      ${pill("receive", "text", state.mode.receive, tr("Text"))}
      ${pill("receive", "both", state.mode.receive, tr("Both"))}
    </div>
    <h3>${esc(tr("I send"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I send"))}">
      ${pill("send", "voice", state.mode.send, tr("Voice"))}
      ${pill("send", "text", state.mode.send, tr("Text"))}
      ${pill("send", "note", state.mode.send, tr("Tap to talk"))}
    </div>
    <h3>${esc(tr("Subtitles"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("Subtitles"))}">
      ${pill("subtitles", "off", state.mode.subtitles, tr("Subtitles off"))}
      ${pill("subtitles", "translated", state.mode.subtitles, tr("Translation subtitles"))}
      ${pill("subtitles", "original", state.mode.subtitles, tr("Original subtitles"))}
      ${pill("subtitles", "both", state.mode.subtitles, tr("Original and translation"))}
    </div>
    <div class="calls-modes">
      <button type="button" class="calls-pill${state.mode.translationOnly ? " on" : ""}" data-act="call-set" data-group="translationOnly" data-value="${state.mode.translationOnly ? "0" : "1"}" aria-pressed="${state.mode.translationOnly ? "true" : "false"}">${esc(tr("Others hear only the translation"))}</button>
      <button type="button" class="calls-pill${state.mode.original ? " on" : ""}" data-act="call-set" data-group="original" data-value="${state.mode.original ? "0" : "1"}" aria-pressed="${state.mode.original ? "true" : "false"}">${esc(tr("Hear their original voice, quietly"))}</button>
      <button type="button" class="calls-pill${state.mode.reviewNotes ? " on" : ""}" data-act="call-set" data-group="reviewNotes" data-value="${state.mode.reviewNotes ? "0" : "1"}" aria-pressed="${state.mode.reviewNotes ? "true" : "false"}">${esc(tr("Check a voice note before sending"))}</button>
    </div>
    <div class="calls-quick">
      ${QUICK_PHRASES.map((phrase) => `<button type="button" data-act="call-phrase" data-text="${esc(phrase)}">${esc(phraseLabel(phrase))}</button>`).join("")}
      <button type="button" data-act="call-repeat">${esc(tr("Repeat that"))}</button>
    </div>
    <label class="calls-vol"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
    ${slider("trvol", tr("Translation volume"))}
    ${slider("original", tr("Original volume"))}
    ${slider("overall", tr("Call volume"))}
    ${slider("ring", tr("Ringtone"))}
    ${slider("mic", tr("Microphone level"))}
    ${slider("tts", tr("Spoken text volume"))}
    <label class="calls-vol"><span>${esc(tr("Translation voice"))}</span><select data-act="call-voice">${voices}</select></label>
    <h3>${esc(tr("Name pronunciations"))}</h3>
    <ul class="calls-words">${words}</ul>
    <form class="calls-lex" data-act="call-lex-form"><input name="word" maxlength="40" placeholder="${esc(tr("Word"))}" aria-label="${esc(tr("Word"))}"><input name="say" maxlength="60" placeholder="${esc(tr("Say it like"))}" aria-label="${esc(tr("Say it like"))}"><button type="submit">${esc(tr("Add"))}</button></form>
    <h3>${esc(tr("Gemini key"))}</h3>
    ${keyRow()}
    <h3>${esc(tr("Connection"))}</h3>
    ${statsBlock()}
    <p class="calls-privacy" data-quota>${esc(quotaLine())}</p>
    <p class="calls-privacy">${esc(tr("On the free Gemini plan, Google may use call audio to improve its products."))}</p>
  </div>`;
}

function keyRow() {
  const has = state.keySaved || !!localKey();
  if (has) return `<p class="calls-privacy">${esc(tr("Your Gemini key is saved."))} ${esc(state.keyMask || "")}</p><button type="button" class="calls-pill" data-act="call-key-remove">${esc(tr("Remove my key"))}</button>`;
  return `<button type="button" class="calls-pill" data-act="call-key-add">${esc(tr("Add your free Gemini key"))}</button>`;
}

function statusText() {
  const code = state.statusCode;
  if (state.error) return state.error;
  if (code === "calling") return tr("Calling…");
  if (code === "waiting") return tr("Waiting for them to join…");
  if (code === "reconnecting") return tr("Reconnecting…");
  if (code === "left") return tr("They left the call.");
  if (code === "lost") return tr("The connection was lost.");
  if (state.translating) return tr("Translating…");
  if (code === "connected" || code === "joined" || code === "translating-ready") return tr("Connected");
  return state.status || "";
}

function testPanel() {
  if (!state.test) return "";
  const t = state.test;
  const replies = (PARTNER_REPLIES[t.lang] || PARTNER_REPLIES.en).map((text) => `<button type="button" data-act="call-test-reply" data-text="${esc(text)}">${esc(text)}</button>`).join("");
  const lines = t.lines.slice(-6).map((line) => `<article class="calls-bubble${line.mine ? " mine" : ""}"><b>${esc(line.who)}</b>${line.original ? `<p>${esc(line.original)}</p>` : ""}${line.translation ? `<p class="calls-trn">${esc(line.translation)}</p>` : ""}</article>`).join("");
  return `<section class="calls-test" data-test>
    <h3>${esc(tr("Test partner"))}</h3>
    <label class="calls-vol"><span>${esc(tr("Partner speaks"))}</span><select data-act="call-test-lang">${langOptions(t.lang)}</select></label>
    <button type="button" class="calls-pill${t.hear ? " on" : ""}" data-act="call-test-hear" aria-pressed="${t.hear ? "true" : "false"}">${esc(tr("Hear the partner side (use headphones)"))}</button>
    <div class="calls-thread">${lines}</div>
    <div class="calls-quick">${replies}</div>
    <form class="calls-type" data-act="call-test-form"><input name="text" maxlength="500" aria-label="${esc(tr("Reply as the partner"))}" placeholder="${esc(tr("Reply as the partner"))}" autocomplete="off"></form>
    <p class="calls-privacy">${esc(tr("This test uses a real call: your voice goes to a partner in this page and is translated by Gemini."))}</p>
  </section>`;
}

const PARTNER_REPLIES = {
  en: ["Yes, I can hear you.", "Could you say that again?", "Thank you, that works."],
  es: ["Sí, te escucho.", "¿Puedes repetirlo?", "Gracias, me parece bien."],
  ru: ["Да, я вас слышу.", "Повторите, пожалуйста.", "Спасибо, всё понятно."],
  sv: ["Ja, jag hör dig.", "Kan du säga det igen?", "Tack, det fungerar."],
  ca: ["Sí, et sento.", "Pots repetir-ho?", "Gràcies, em va bé."]
};

function callScreen() {
  const name = state.peerName || (state.statusCode === "calling" || state.statusCode === "waiting" ? "" : tr("Guest"));
  const initial = (name || "G").slice(0, 1).toUpperCase();
  const talking = state.mode.send !== "text";
  const hint = state.hintSeen ? "" : `<p class="calls-hint">${esc(tr("You can type instead of talking."))}</p>`;
  const back = standalone() ? "" : `<a class="calls-back" href="#/calls">${esc(tr("Back"))}</a>`;
  const invite = state.inviteUrl && state.statusCode === "waiting" ? `<div class="calls-invite"><input readonly value="${esc(state.inviteUrl)}" aria-label="${esc(tr("Guest link"))}" data-invite><button type="button" data-act="call-copy">${esc(tr("Copy link"))}</button>${navigator.share ? `<button type="button" data-act="call-share">${esc(tr("Share"))}</button>` : ""}</div>` : "";
  return `<div class="calls-page live" data-call-active="1" data-video="0" data-phase="${esc(state.phase)}">
    <header class="calls-bar">${back}<h1>${esc(state.test ? tr("Test call") : tr("Calls"))}</h1></header>
    <div class="calls-stage">
      <div class="calls-ava" data-speaking="${state.speaking ? "1" : "0"}" data-me="${state.meSpeaking ? "1" : "0"}">${esc(initial)}</div>
      <h2 class="calls-name">${esc(name)}</h2>
      <p class="calls-status" data-translating="${state.translating ? "1" : "0"}">${esc(statusText())}</p>
      ${invite}
      ${keyPanel()}
      ${subtitleBlock()}
      ${threadBlock()}
    </div>
    ${state.mode.send === "text" ? `<form class="calls-type" data-act="call-type-form"><input name="text" maxlength="500" aria-label="${esc(tr("Type to them"))}" autocomplete="off"></form>` : ""}
    ${state.mode.send === "note" ? (state.review ? `<div class="calls-review"><button type="button" data-act="call-note-send">${esc(tr("Send"))}</button><button type="button" data-act="call-note-cancel">${esc(tr("Cancel voice note"))}</button></div>` : `<button type="button" class="calls-talk" data-act="call-talk">${esc(state.recording ? tr("Slide to cancel") : tr("Hold to talk"))}</button>`) : ""}
    <div class="calls-controls" data-essentials="mute speaker hangup talk">
      <button type="button" data-act="call-mute" aria-label="${esc(state.muted ? tr("Unmute microphone") : tr("Mute microphone"))}">${esc(state.muted ? tr("Unmute") : tr("Mute"))}</button>
      <button type="button" data-act="call-speaker" aria-pressed="${state.speakerOn ? "true" : "false"}">${esc(tr("Speaker"))}</button>
      <button type="button" class="calls-end" data-act="call-end">${esc(tr("End call"))}</button>
      <button type="button" data-act="call-switch" aria-pressed="${talking ? "true" : "false"}">${esc(talking ? tr("Talk") : tr("Type to them"))}</button>
    </div>
    ${hint}
    ${testPanel()}
    <button type="button" class="calls-more" data-act="call-more">${esc(tr("More"))}</button>
    ${moreSheet()}
  </div>`;
}

function linkUrl(slug) {
  const base = standalone() ? new URL("./", location.href) : new URL("calls/", document.baseURI);
  return base.href + "#u/" + slug;
}
function linkPanel() {
  const l = state.link;
  const err = state.linkError ? `<p class="calls-error" role="alert">${esc(state.linkError)}</p>` : "";
  if (!l) return `<section class="calls-link" data-link><h3>${esc(tr("My call-me link"))}</h3><p class="calls-privacy">${esc(tr("A link that stays the same. Anyone who opens it can ring you, if your call settings allow it."))}</p>${err}<button type="button" class="calls-pill" data-act="call-link-create">${esc(tr("Create my call-me link"))}</button></section>`;
  return `<section class="calls-link" data-link><h3>${esc(tr("My call-me link"))}</h3>
    <div class="calls-invite"><input readonly value="${esc(linkUrl(l.slug))}" aria-label="${esc(tr("Call-me link"))}" data-invite><button type="button" data-act="call-link-copy">${esc(tr("Copy link"))}</button>${navigator.share ? `<button type="button" data-act="call-link-share">${esc(tr("Share"))}</button>` : ""}</div>
    ${l.enabled ? "" : `<p class="calls-privacy">${esc(tr("This link is turned off."))}</p>`}
    ${err}
    <div class="calls-modes">
      <button type="button" class="calls-pill" data-act="call-link-toggle">${esc(l.enabled ? tr("Turn off") : tr("Turn on"))}</button>
      <button type="button" class="calls-pill" data-act="call-link-regen">${esc(tr("Make a new link"))}</button>
      <button type="button" class="calls-pill" data-act="call-link-del">${esc(tr("Delete link"))}</button>
    </div>
    <form class="calls-lex" data-act="call-link-form"><input name="slug" maxlength="30" placeholder="${esc(tr("Custom name, like my-name"))}" aria-label="${esc(tr("Custom link name"))}" autocomplete="off" autocapitalize="off"><button type="submit">${esc(tr("Save"))}</button></form>
    <p class="calls-privacy">${esc(tr("Your quiet hours, blocks and who-can-call settings still apply. Turning the link off or making a new one stops the old link at once."))}</p>
  </section>`;
}

function installBlock() {
  if (!standalone()) {
    const href = new URL("calls/", document.baseURI).href;
    return `<p class="calls-empty"><a href="${esc(href)}" target="_blank" rel="noopener">${esc(tr("Open the ViktorychCalls app"))}</a></p>`;
  }
  const name = installName();
  return `<section class="calls-install" data-install>
    <label class="calls-vol"><span>${esc(tr("App name"))}</span><input data-act="call-pwa-name" maxlength="30" value="${esc(name)}" aria-label="${esc(tr("App name"))}"></label>
    <button type="button" class="calls-go" data-act="call-install"${installCan() ? "" : " hidden"}>${esc(tr("Install app"))}</button>
    <p class="calls-privacy" data-ios${iosDevice() ? "" : " hidden"}>${esc(tr("On iPhone: Share, then Add to Home Screen. The name above is filled in for you."))}</p>
  </section>`;
}
function installCan() {
  return !!(window.ViktorychCallsInstall && window.ViktorychCallsInstall.can && window.ViktorychCallsInstall.can());
}
function iosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function installName() {
  try { return localStorage.getItem("viktorych-calls-pwa-name") || "ViktorychCalls"; }
  catch (err) { return "ViktorychCalls"; }
}

function homeScreen() {
  const rows = state.history.slice(0, 8).map((row) => {
    const label = row.name || (row.handle ? "@" + row.handle : tr("Guest"));
    const kind = row.missed ? tr("Missed call") : (row.incoming ? tr("Incoming call") : tr("Outgoing call"));
    return `<li><span>${esc(label)} · ${esc(kind)}</span>${row.handle ? `<button type="button" data-act="call-back" data-handle="${esc(row.handle)}">${esc(tr("Call back"))}</button>` : ""}</li>`;
  }).join("");
  const back = standalone() ? "" : `<a class="calls-back" href="#/">${esc(tr("Back"))}</a>`;
  const err = state.error ? `<p class="calls-error" role="alert">${esc(state.error)}</p>` : "";
  const notSet = state.configured ? "" : `<p class="calls-empty">${esc(tr("Calls are not set up yet"))}</p>`;
  const signed = signedIn();
  const start = signed ? `<form class="calls-start" data-act="call-start-form"><input name="handle" maxlength="31" placeholder="${esc(tr("Username to call"))}" aria-label="${esc(tr("Username to call"))}" autocomplete="off" autocapitalize="off"><button type="submit" class="calls-go">${esc(tr("Call"))}</button></form>
    <h3>${esc(tr("Invite a guest by link"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("Link lasts"))}">${pill("ttl", "60", String(state.inviteTtl), tr("1 hour"))}${pill("ttl", "1440", String(state.inviteTtl), tr("24 hours"))}<button type="button" class="calls-pill" data-act="call-invite">${esc(tr("Create link and wait"))}</button></div>
    ${linkPanel()}
    <div class="calls-modes"><button type="button" class="calls-pill" data-act="call-test">${esc(tr("Test call"))}</button></div>`
    : `<p class="calls-empty">${esc(tr("Sign in to start a call, or open a guest link to join one."))}</p>`;
  return `<div class="calls-page" data-video="0" data-phase="idle">
    <header class="calls-bar">${back}<h1>${esc(tr("Calls"))}</h1></header>
    ${notSet}${err}${start}
    ${rows ? `<ul class="calls-missed">${rows}</ul>` : `<p class="calls-empty">${esc(tr("No calls yet"))}</p>`}
    ${installBlock()}
    <label class="calls-vol calls-homelang"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
  </div>`;
}

function incomingScreen() {
  const who = state.incoming || {};
  const initial = String(who.name || who.handle || "?").slice(0, 1).toUpperCase();
  return `<div class="calls-page live" data-phase="incoming">
    <div class="calls-stage">
      <div class="calls-ava">${esc(initial)}</div>
      <h2 class="calls-name">${esc(who.name || (who.handle ? "@" + who.handle : tr("Guest")))}</h2>
      <p class="calls-status">${esc(tr("Incoming call"))}</p>
    </div>
    <div class="calls-controls">
      <button type="button" class="calls-go" data-act="call-answer">${esc(tr("Answer"))}</button>
      <button type="button" class="calls-end" data-act="call-decline">${esc(tr("Decline"))}</button>
    </div>
  </div>`;
}

function joinScreen(route) {
  const err = state.error ? `<p class="calls-error" role="alert">${esc(state.error)}</p>` : "";
  const info = route && route.name === "calllink" && state.linkInfo ? state.linkInfo : null;
  const title = info && info.name ? tr("Call {name}", { name: info.name }) : tr("Join call");
  const closed = info && info.open === false ? `<p class="calls-error" role="alert">${esc(info.reason === "quiet" ? tr("They are not taking calls right now.") : tr("This person is not taking calls right now."))}</p>` : "";
  const ended = state.statusCode === "ended" ? `<p class="calls-empty">${esc(tr("The call has ended."))}</p>` : "";
  return `<div class="calls-page calls-join" data-phase="join" data-video="0">
    <header class="calls-bar"><h1>${esc(title)}</h1></header>
    ${ended}${closed}${err}
    <label class="calls-vol"><span>${esc(tr("Your name"))}</span><input id="calls-name" maxlength="40" value="${esc(state.name)}" autocomplete="name"></label>
    <label class="calls-vol"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
    <button type="button" class="calls-go" data-act="call-join"${info && info.open === false ? " disabled" : ""}>${esc(info ? tr("Call") : tr("Join call"))}</button>
    <p class="calls-privacy">${esc(tr("No account needed. Your microphone is used only during the call."))}</p>
    ${standalone() ? installBlock() : ""}
  </div>`;
}

function page(route) {
  loadDevice();
  state.route = route || state.route;
  const r = state.route || { name: "calls" };
  if (state.phase === "incoming") return incomingScreen();
  if (state.phase === "active" || state.phase === "calling") return callScreen();
  if (r.name === "callguest" || r.name === "calllink") return joinScreen(r);
  return homeScreen();
}

/* ---------- painting ---------- */
function host() { return document.querySelector(".calls-page"); }
function paint() {
  const el = host();
  if (!el || !el.parentElement) return;
  const focus = document.activeElement;
  const keep = focus && focus.name && el.contains(focus) ? { name: focus.name, value: focus.value } : null;
  const sheet = el.querySelector(".calls-sheet");
  const scroll = sheet ? sheet.scrollTop : 0;
  el.outerHTML = page(state.route);
  const fresh = host();
  if (keep && fresh) {
    const input = fresh.querySelector(`input[name="${keep.name}"]`);
    if (input) { input.value = keep.value; input.focus(); }
  }
  const sheetNow = fresh && fresh.querySelector(".calls-sheet");
  if (sheetNow) sheetNow.scrollTop = scroll;
  bindSession(state.phase === "active");
  holdWake(state.phase === "active");
}
/* Cheap updates while a call runs: no full repaint, so typing keeps focus. */
function live() {
  const el = host();
  if (!el || state.phase === "idle") return;
  const subs = el.querySelector(".calls-subs");
  if (subs) subs.outerHTML = subtitleBlock();
  const thread = el.querySelector(".calls-thread");
  if (thread && !thread.closest(".calls-test")) thread.outerHTML = threadBlock();
  const status = el.querySelector(".calls-status");
  if (status) { status.textContent = statusText(); status.dataset.translating = state.translating ? "1" : "0"; }
  const ava = el.querySelector(".calls-ava");
  if (ava) { ava.dataset.speaking = state.speaking || state.translating ? "1" : "0"; ava.dataset.me = state.meSpeaking ? "1" : "0"; }
  const quota = el.querySelector("[data-quota]");
  if (quota) quota.textContent = quotaLine();
  const test = el.querySelector("[data-test]");
  if (test && state.test) {
    const box = test.querySelector(".calls-thread");
    if (box) box.innerHTML = state.test.lines.slice(-6).map((line) => `<article class="calls-bubble${line.mine ? " mine" : ""}"><b>${esc(line.who)}</b>${line.original ? `<p>${esc(line.original)}</p>` : ""}${line.translation ? `<p class="calls-trn">${esc(line.translation)}</p>` : ""}</article>`).join("");
  }
}
function paintStats() {
  const el = host();
  const box = el && el.querySelector("[data-stats]");
  if (box) box.outerHTML = statsBlock();
}

async function bindSession(active) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (!active) { ms.playbackState = "none"; return; }
    ms.metadata = new window.MediaMetadata({ title: tr("Calls"), artist: state.peerName || tr("Guest") });
    ms.playbackState = state.muted ? "paused" : "playing";
    ms.setActionHandler("pause", () => { setMuted(true); });
    ms.setActionHandler("play", () => { setMuted(false); });
    ms.setActionHandler("stop", () => { hangUp(); });
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
    if (state.engine && id) await state.engine.setSink(id);
  } catch (err) { /* keep the current speaker */ }
}

/* ---------- ringing ---------- */
let ringCtx = null;
let ringTimer = null;
function ringStart() {
  ringStop();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ringCtx = new AC();
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      gain.gain.value = 0.2 * state.volumes.ring;
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.4);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) { /* a silent ring still shows the screen */ }
}
function ringStop() {
  clearInterval(ringTimer);
  ringTimer = null;
  if (ringCtx) { try { ringCtx.close(); } catch (err) { /* closed */ } }
  ringCtx = null;
}

/* ---------- engine wiring ---------- */
function pushLine(line) {
  const row = Object.assign({ id: String(Date.now()) + Math.floor(Math.random() * 1000) }, line);
  state.lines.push(row);
  if (row.translation && !row.mine) state.lastLine = rememberLine(state.lastLine, { text: row.translation });
  if (state.lines.length > 40) state.lines.shift();
}
function speakText(text, lang) {
  const line = String(text || "").trim();
  if (!line) return;
  try {
    if (window.speechSynthesis && noteShouldAutoplay(state.mode)) {
      const utter = new SpeechSynthesisUtterance(line);
      utter.volume = Math.max(0, Math.min(1, state.volumes.tts * state.volumes.overall));
      if (lang) utter.lang = lang;
      window.speechSynthesis.speak(utter);
    }
  } catch (err) { /* text still shows */ }
}
function engineConfig(extra) {
  return Object.assign({
    api: (path, init) => api(path, init),
    apiBase: apiBase,
    getMode: () => state.mode,
    getVolumes: () => state.volumes,
    getLang: myLang,
    getName: () => state.name || tr("Guest"),
    getLexicon: () => state.lexicon,
    voiceOverride: () => state.voice,
    getKey: localKey,
    speakerOn: () => state.speakerOn,
    connection: () => navigator.connection || {},
    relayFirst: relayFirst,
    relayUrl: (tokenValue) => apiBase() + "/v1/calls/live?t=" + encodeURIComponent(tokenValue),
    onRoute: rememberRoute,
    onEvent: onEngineEvent
  }, extra || {});
}
function onEngineEvent(type, d) {
  if (type === "status") {
    state.statusCode = d.code === "translating-ready" ? (state.statusCode || "connected") : d.code;
    if (d.code === "joined" || d.code === "connected") { state.phase = "active"; if (!state.startedAt) state.startedAt = Date.now(); ringStop(); }
    if (d.code === "left") { state.peerName = state.peerName; }
    live();
    if (d.code === "joined" || d.code === "connected") paint();
  } else if (type === "peer") {
    state.peerName = d.name || state.peerName;
    state.peerQuota = !!d.degraded;
    paint();
  } else if (type === "peerQuota") {
    state.mode = normalizeMode(Object.assign({}, state.mode, { send: "text" }));
    saveDevice();
    if (state.engine) state.engine.refresh();
    paint();
  } else if (type === "partial") {
    if (d.mine) return;
    state.partial = { original: d.original || "", translation: d.translation || "" };
    state.whoLabel = d.speaker || "";
    live();
  } else if (type === "line") {
    state.partial = { original: "", translation: "" };
    if (d.mine) {
      if (d.typed) pushLine({ who: tr("You"), mine: true, original: d.original });
      else if (d.original) pushLine({ who: tr("You"), mine: true, original: d.original, translation: d.translation });
    } else {
      pushLine({ who: d.speaker || state.peerName || tr("Guest"), original: d.original, translation: d.translation || d.original });
      if (d.typed && d.speakText) speakText(d.translation || d.original, d.lang);
    }
    live();
  } else if (type === "speaking") {
    if (d.who === "peer") state.speaking = d.on; else state.meSpeaking = d.on;
    live();
  } else if (type === "translating") {
    state.translating = d.on;
    live();
  } else if (type === "needKey") {
    state.needKey = d.reason === "badkey" ? "badkey" : "nokey";
    paint();
  } else if (type === "quota") {
    if (d.reason !== "key") state.quota = true;
    state.mode = normalizeMode(Object.assign({}, state.mode, { send: "text" }));
    saveDevice();
    paint();
  } else if (type === "route") {
    state.route = state.route;
    state.viaRoute = d.via;
  } else if (type === "note") {
    pushLine({ who: d.mine ? tr("You") : (state.peerName || tr("Guest")), mine: !!d.mine, original: tr("Voice note"), note: true, id: d.id });
    live();
  } else if (type === "ended") {
    /* handled by hangUp */
  }
}

/* ---------- starting calls ---------- */
function errorFor(res) {
  const code = res && res.data && res.data.error;
  if (code === "not_configured") return tr("Calls are not set up yet");
  if (code === "calls_closed") return tr("This person is not taking calls right now.");
  if (code === "not_found") return tr("That call link does not work any more.");
  if (code === "guests") return tr("This person turned guest links off.");
  if (res && res.status === 429) return tr("Too many calls. Try again later.");
  if (res && res.status === 401) return tr("Sign in to start a call, or open a guest link to join one.");
  return tr("The call could not start. Check your connection and try again.");
}
async function begin(info, role, extra) {
  state.error = "";
  state.callId = info.id;
  state.phase = "calling";
  state.lines = [];
  state.partial = { original: "", translation: "" };
  state.quota = false;
  state.peerQuota = false;
  state.muted = false;
  state.startedAt = 0;
  state.net = lighterFor(navigator.connection || {});
  state.engine = createEngine(engineConfig(extra));
  paint();
  try {
    await state.engine.start({ id: info.id, ticket: info.ticket, iceServers: info.iceServers, role: role });
  } catch (err) {
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    const none = err && err.name === "NotFoundError";
    await teardown(true);
    state.error = denied ? tr("Allow the microphone to talk. You can still type.") : (none ? tr("No microphone was found.") : tr("The call could not start. Check your connection and try again."));
    paint();
    return false;
  }
  routeOutput();
  return true;
}
async function startDirect(handle) {
  const clean = String(handle || "").replace(/^@/, "").trim();
  if (!clean) return;
  state.error = "";
  state.peerName = "@" + clean;
  state.statusCode = "calling";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ handle: clean }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); state.phase = "idle"; state.peerName = ""; paint(); return; }
  state.inviteUrl = "";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "host");
  if (ok) {
    state.engine.prewarm();
    state.ringTimeout = setTimeout(() => { if (state.phase === "calling") { state.error = tr("No answer."); hangUp(); } }, 120000);
  }
}
async function startInvite() {
  state.error = "";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ invite: true, ttlMin: state.inviteTtl }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.invite = res.data.invite;
  state.inviteUrl = guestUrl(res.data.invite);
  state.peerName = "";
  state.statusCode = "waiting";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "host");
  if (ok) state.engine.prewarm();
}
function guestUrl(invite) {
  const base = standalone() ? new URL("./", location.href) : new URL("calls/", document.baseURI);
  return base.href + "#" + invite;
}
async function joinAsGuest(tokenValue) {
  state.error = "";
  const typed = (document.getElementById("calls-name") || {}).value;
  state.name = String(typed || state.name || tr("Guest")).slice(0, 40);
  saveDevice();
  const res = await api("/v1/calls/join/" + encodeURIComponent(tokenValue), { method: "POST", body: JSON.stringify({ name: state.name }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.guestToken = res.data.guestToken;
  state.statusCode = "joined";
  state.peerName = "";
  await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "guest");
}
async function joinLink(slug) {
  state.error = "";
  const typed = (document.getElementById("calls-name") || {}).value;
  state.name = String(typed || state.name || tr("Guest")).slice(0, 40);
  saveDevice();
  const res = await api("/v1/calls/link/" + encodeURIComponent(slug) + "/join", { method: "POST", body: JSON.stringify({ name: state.name }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.guestToken = res.data.guestToken || "";
  state.statusCode = "calling";
  state.peerName = (state.linkInfo && state.linkInfo.name) || "";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "guest");
  if (!ok) return;
  state.engine.prewarm();
  const id = res.data.call.id;
  state.ringPoll = setInterval(async () => {
    if (state.phase !== "calling" || state.callId !== id) { clearInterval(state.ringPoll); return; }
    const st = await api("/v1/calls/" + id + "/state").catch(() => null);
    if (st && st.ok && st.data && st.data.ended) { clearInterval(state.ringPoll); state.error = tr("No answer."); await hangUp(); }
  }, 2500);
}
async function loadLink() {
  if (!signedIn()) return;
  const res = await api("/v1/calls/link").catch(() => null);
  if (res && res.ok && res.data) { state.link = res.data.link || null; if (host() && state.phase === "idle") paint(); }
}
async function saveLink(init, route) {
  state.linkError = "";
  const res = await api("/v1/calls/link" + (route || ""), Object.assign({ method: route ? "POST" : "PUT", body: JSON.stringify({}) }, init || {})).catch(() => null);
  if (res && res.ok && res.data) state.link = res.data.link || null;
  else state.linkError = res && res.data && res.data.error === "slug_taken" ? tr("That name is taken.") : (res && res.data && res.data.error === "bad_slug" ? tr("Use 3 to 30 letters, numbers or single dashes.") : tr("The link could not be saved."));
  paint();
}
async function answerIncoming() {
  const who = state.incoming;
  if (!who) return;
  ringStop();
  const res = await api("/v1/calls/" + who.id + "/answer", { method: "POST", body: "{}" }).catch(() => null);
  state.incoming = null;
  if (!res || !res.ok) { state.error = errorFor(res); state.phase = "idle"; paint(); return; }
  state.peerName = who.name || (who.handle ? "@" + who.handle : "");
  state.statusCode = "joined";
  await begin({ id: who.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, who.link ? "host" : "guest");
}
async function declineIncoming() {
  const who = state.incoming;
  ringStop();
  state.incoming = null;
  state.phase = "idle";
  if (who) api("/v1/calls/" + who.id + "/decline", { method: "POST", body: "{}" }).catch(() => {});
  paint();
}
function onRing(data) {
  if (!data || !data.id || state.phase !== "idle") return;
  if (!signedIn()) return;
  state.incoming = { id: data.id, name: data.name || "", handle: data.handle || "", link: data.guest === true || data.link === true };
  state.phase = "incoming";
  ringStart();
  if (!host()) { location.hash = "#/calls/" + data.id; return; }
  paint();
}
async function checkIncoming(id) {
  if (!signedIn() || state.phase !== "idle") return;
  const res = await api("/v1/calls/incoming").catch(() => null);
  const list = (res && res.ok && res.data && res.data.calls) || [];
  const hit = list.find((row) => !id || row.id === id) || null;
  if (hit) {
    let name = "";
    let handle = "";
    const hist = await api("/v1/calls/history").catch(() => null);
    const row = hist && hist.ok && hist.data && hist.data.calls && hist.data.calls.find((c) => c.id === hit.id);
    if (row) { name = row.name; handle = row.handle; }
    onRing({ id: hit.id, name: name, handle: handle, link: hit.kind === "link" });
  }
}
async function loadHistory() {
  if (!signedIn()) return;
  const res = await api("/v1/calls/history").catch(() => null);
  if (res && res.ok && res.data && Array.isArray(res.data.calls)) {
    state.history = res.data.calls;
    if (host() && state.phase === "idle") paint();
  }
}
async function loadStatus() {
  const res = await api("/v1/calls/status").catch(() => null);
  if (res && res.status === 200 && res.data) state.configured = res.data.configured !== false;
}

/* ---------- ending ---------- */
async function teardown(silent) {
  clearTimeout(state.ringTimeout);
  clearInterval(state.ringPoll);
  ringStop();
  const engine = state.engine;
  const partner = state.partner;
  state.engine = null;
  state.partner = null;
  state.test = null;
  state.phase = "idle";
  state.recording = false;
  state.speaking = false;
  state.meSpeaking = false;
  state.translating = false;
  clearInterval(state.statsTimer);
  if (partner) await partner.end(true).catch(() => {});
  if (engine) await engine.end(silent).catch(() => {});
  holdWake(false);
  state.guestToken = state.guestToken;
}
async function hangUp() {
  await teardown(false);
  state.statusCode = standalone() && state.route && state.route.name === "callguest" ? "ended" : "";
  paint();
  loadHistory();
}
function setMuted(on) {
  state.muted = !!on;
  if (state.engine) state.engine.setMuted(state.muted);
  paint();
}

/* ---------- self test ---------- */
async function startTest() {
  if (!signedIn()) return;
  state.error = "";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ invite: true, ttlMin: 10 }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  const lang = myLang() === "en" ? "es" : "en";
  state.test = { lang: lang, hear: false, lines: [] };
  state.statusCode = "waiting";
  state.peerName = tr("Test partner");
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "host");
  if (!ok) return;
  await startPartner(res.data.invite);
  state.statsTimer = setInterval(updateStats, 1000);
}
async function startPartner(invite) {
  const t = state.test;
  const joined = await api("/v1/calls/join/" + encodeURIComponent(invite), { method: "POST", body: JSON.stringify({ name: tr("Test partner") }) }).catch(() => null);
  if (!joined || !joined.ok) { state.error = errorFor(joined); paint(); return; }
  const guestToken = joined.data.guestToken;
  const partnerMode = { send: "text", receive: "both", original: false, translationOnly: false, subtitles: "both" };
  const eng = createEngine(engineConfig({
    api: (path, init) => api(path, Object.assign({}, init || {}, { headers: { "content-type": "application/json", "x-call-guest": guestToken } })),
    getMode: () => partnerMode,
    getVolumes: () => normalizeVolumes({ overall: state.test && state.test.hear ? 1 : 0, translation: state.test && state.test.hear ? 0.9 : 0, tts: 0 }),
    getLang: () => (state.test ? state.test.lang : "en"),
    getName: () => tr("Test partner"),
    voiceOverride: () => "",
    getMic: async () => {
      const mic = state.engine && state.engine.micClone && state.engine.micClone();
      return mic || null;
    },
    onEvent: (type, d) => {
      if (!state.test) return;
      if (type === "line") {
        if (d.mine) state.test.lines.push({ who: tr("Test partner"), mine: true, original: d.original });
        else state.test.lines.push({ who: tr("You"), original: d.original, translation: d.translation });
        live();
      } else if (type === "partial" && !d.mine) {
        state.test.partial = d;
      }
    }
  }));
  state.partner = eng;
  try { await eng.start({ id: state.callId, ticket: joined.data.ticket, iceServers: joined.data.iceServers, role: "guest" }); }
  catch (err) { state.error = tr("The call could not start. Check your connection and try again."); paint(); }
}
function testReply(text) {
  const clean = String(text || "").trim();
  if (!clean || !state.partner) return;
  state.partner.sendText(clean);
}
async function updateStats() {
  const eng = state.engine;
  if (!eng) return;
  const mine = await (eng.netStats ? eng.netStats() : Promise.resolve({}));
  const part = state.partner && state.partner.netStats ? await state.partner.netStats() : null;
  const e = eng.stats();
  const p = state.partner ? state.partner.stats() : null;
  const pm = state.partner ? state.partner.metrics() : null;
  const em = eng.metrics();
  const src = pm || em;
  const usage = (p ? p.usage : e.usage) || {};
  const net = part || mine || {};
  state.stats = {
    route: (p ? p.via : e.via) || "direct",
    media: net.media,
    firstAudio: src.firstAudio,
    endLag: src.endLag,
    jitter: net.jitter,
    lost: net.lost,
    rtt: net.rtt,
    speechSec: usage.speechMs != null ? Math.round(usage.speechMs / 100) / 10 : null,
    perMinute: usage.perMinute != null ? Math.round(usage.perMinute / 100) / 10 : null
  };
  paintStats();
}

/* ---------- handlers ---------- */
function applyMode(patch) {
  state.mode = normalizeMode(Object.assign({}, state.mode, patch));
  saveDevice();
  if (state.engine) state.engine.refresh();
  if (state.engine) state.engine.announce();
  paint();
}
function onSet(group, value) {
  if (group === "translationOnly" || group === "original" || group === "reviewNotes") applyMode({ [group]: value === "1" });
  else if (group === "send" || group === "receive" || group === "subtitles") applyMode({ [group]: value });
  else if (group === "ttl") { state.inviteTtl = Number(value) || 60; paint(); }
  else if (group === "who" || group === "guests" || group === "dnd") setPref(group, group === "who" ? value : value === "1");
}
async function setPref(key, value) {
  if (!signedIn()) return;
  state.prefs = Object.assign({}, state.prefs || {}, { [key]: value });
  const res = await api("/v1/calls/prefs", { method: "PUT", body: JSON.stringify({ [key]: value, tz: -new Date().getTimezoneOffset() }) }).catch(() => null);
  if (res && res.ok && res.data && res.data.prefs) state.prefs = res.data.prefs;
  writeJson("viktorych-calls-prefs-v1", state.prefs);
  const box = document.querySelector(".calls-settings");
  if (box) box.outerHTML = settingsHtml();
}
function repeatLast() {
  if (state.lastLine) speakText(state.lastLine.text, myLang());
}
function onPhrase(text) {
  const spoken = phraseLabel(text) || text;
  if (state.engine) state.engine.sendText(spoken);
}

function onAct(act, el) {
  if (act === "call-set") onSet(el.dataset.group, el.dataset.value);
  else if (act === "call-more") {
    state.more = !state.more;
    state.hintSeen = true;
    saveDevice();
    paint();
  } else if (act === "call-switch") {
    applyMode({ send: state.mode.send === "text" ? "voice" : "text" });
    state.hintSeen = true;
    saveDevice();
  } else if (act === "call-speaker") {
    state.speakerOn = !state.speakerOn;
    saveDevice();
    if (state.engine) state.engine.refresh();
    paint();
  } else if (act === "call-mute") setMuted(!state.muted);
  else if (act === "call-end") hangUp();
  else if (act === "call-repeat") repeatLast();
  else if (act === "call-phrase") onPhrase(el.dataset.text || "");
  else if (act === "call-back") startDirect(el.dataset.handle || "");
  else if (act === "call-open") { state.pendingTo = el.dataset.handle || ""; }
  else if (act === "call-invite") startInvite();
  else if (act === "call-test") startTest();
  else if (act === "call-answer") answerIncoming();
  else if (act === "call-decline") declineIncoming();
  else if (act === "call-join") {
    if (state.route && state.route.name === "calllink") joinLink(state.route.slug || "");
    else joinAsGuest((state.route && state.route.token) || "");
  }
  else if (act === "call-link-create") saveLink({ method: "PUT", body: JSON.stringify({}) });
  else if (act === "call-link-toggle") saveLink({ method: "PUT", body: JSON.stringify({ enabled: !(state.link && state.link.enabled) }) });
  else if (act === "call-link-regen") saveLink({ method: "POST", body: "{}" }, "/regenerate");
  else if (act === "call-link-del") { api("/v1/calls/link", { method: "DELETE" }).then(() => { state.link = null; paint(); }); }
  else if (act === "call-link-copy" || act === "call-link-share") {
    const url = state.link ? linkUrl(state.link.slug) : "";
    if (act === "call-link-share" && navigator.share) { try { navigator.share({ title: tr("Calls"), url: url }); } catch (err) { /* cancelled */ } }
    else { try { navigator.clipboard.writeText(url); } catch (err) { /* the field can be copied by hand */ } el.textContent = tr("Copied"); }
  }
  else if (act === "call-copy") {
    const input = document.querySelector("[data-invite]");
    try { navigator.clipboard.writeText(state.inviteUrl); } catch (err) { if (input) { input.select(); document.execCommand("copy"); } }
    el.textContent = tr("Copied");
  } else if (act === "call-share") {
    try { navigator.share({ title: tr("Calls"), url: state.inviteUrl }); } catch (err) { /* cancelled */ }
  } else if (act === "call-replay") {
    if (state.engine) state.engine.playNote(el.dataset.id);
  } else if (act === "call-note-cancel") {
    state.review = null;
    paint();
  } else if (act === "call-note-send") {
    const blob = state.review;
    state.review = null;
    if (blob && state.engine) state.engine.noteSend(blob);
    paint();
  } else if (act === "call-lex-del") {
    state.lexicon.splice(Number(el.dataset.i) || 0, 1);
    saveDevice();
    paint();
  } else if (act === "call-test-hear") {
    if (state.test) { state.test.hear = !state.test.hear; if (state.partner) state.partner.refresh(); paint(); }
  } else if (act === "call-test-reply") testReply(el.dataset.text || "");
  else if (act === "call-install") installApp();
  else if (act === "call-key-add") { state.needKey = "nokey"; state.more = false; paint(); }
  else if (act === "call-key-remove") removeKey();
  return true;
}

function onPointer(event) {
  const talk = event.target.closest && event.target.closest(".calls-talk");
  if (!talk || state.mode.send !== "note" || !state.engine) return;
  state.talkX = event.clientX;
  if (!state.engine.noteStart()) return;
  state.recording = true;
  state.meSpeaking = true;
  talk.textContent = tr("Slide to cancel");
  const move = (ev) => {
    const choice = noteRelease(state.talkX, ev.clientX, state.mode.reviewNotes);
    talk.classList.toggle("cancel", choice === "cancel");
  };
  const up = async (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    const choice = noteRelease(state.talkX, ev.clientX, state.mode.reviewNotes);
    const blob = await state.engine.noteStop();
    state.recording = false;
    state.meSpeaking = false;
    if (choice === "cancel" || !blob) state.review = null;
    else if (choice === "review") state.review = blob;
    else await state.engine.noteSend(blob);
    paint();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
}

function onInput(event) {
  const target = event.target;
  const raw = target && target.dataset && target.dataset.vol;
  const key = volKey(raw);
  if (key && VOLUME_KEYS.indexOf(key) >= 0) {
    state.volumes[key] = Number(target.value) / 100;
    saveDevice();
    if (state.engine) state.engine.refresh();
    if (state.partner) state.partner.refresh();
    return;
  }
  if (target && target.dataset && target.dataset.act === "call-pwa-name") setInstallName(target.value);
}
function onChange(event) {
  const target = event.target;
  const act = target && target.dataset && target.dataset.act;
  if (act === "call-voice") {
    state.voice = target.value;
    saveDevice();
    if (state.engine) state.engine.refresh();
  } else if (act === "call-lang") {
    state.lang = target.value;
    saveDevice();
    if (state.engine) { state.engine.refresh(); state.engine.announce(); }
    document.querySelectorAll('[data-act="call-lang"]').forEach((el) => { el.value = target.value; });
  } else if (act === "call-test-lang") {
    if (state.test) { state.test.lang = target.value; if (state.partner) { state.partner.refresh(); state.partner.announce(); } }
  }
}
function onSubmit(event) {
  const form = event.target.closest && event.target.closest("form[data-act], .calls-type");
  if (!form) return;
  const act = form.dataset.act || "call-type-form";
  event.preventDefault();
  const input = form.querySelector("input");
  const text = input && input.value;
  if (act === "call-type-form") {
    if (input) input.value = "";
    const parts = takeClauses(String(text || ""));
    const all = parts.ready.concat(parts.rest ? [parts.rest] : []);
    if (state.engine) (all.length ? all : [String(text || "")]).forEach((piece) => state.engine.sendText(piece));
    state.hintSeen = true;
  } else if (act === "call-link-form") {
    const slug = form.elements.slug.value;
    saveLink({ method: "PUT", body: JSON.stringify({ slug: slug }) });
  } else if (act === "call-key-form") {
    const value = form.elements.key.value;
    form.elements.key.value = "";
    saveKey(value);
  } else if (act === "call-test-form") {
    if (input) input.value = "";
    testReply(text);
  } else if (act === "call-start-form") {
    startDirect(text);
  } else if (act === "call-lex-form") {
    const word = form.elements.word.value;
    const say = form.elements.say.value;
    state.lexicon = cleanLexicon(state.lexicon.concat([{ word: word, say: say }]));
    saveDevice();
    paint();
  }
}

/* ---------- the user's own Gemini key ---------- */
async function loadKeyState() {
  if (!signedIn()) return;
  const res = await api("/v1/calls/key").catch(() => null);
  if (res && res.ok && res.data) { state.keySaved = !!res.data.saved; state.keyMask = res.data.mask || ""; }
}
async function saveKey(value) {
  const clean = String(value || "").trim();
  if (!validKeyShape(clean)) { state.needKey = "badkey"; paint(); return; }
  let stored = false;
  if (signedIn()) {
    const res = await api("/v1/calls/key", { method: "PUT", body: JSON.stringify({ key: clean }) }).catch(() => null);
    if (res && res.ok) { stored = true; state.keySaved = true; state.keyMask = (res.data && res.data.mask) || ""; try { localStorage.removeItem(GKEY); } catch (err) { /* ignore */ } }
    else if (res && res.status === 400) { state.needKey = "badkey"; paint(); return; }
  }
  if (!stored) { try { localStorage.setItem(GKEY, clean); } catch (err) { /* private mode */ } }
  state.needKey = "";
  state.quota = false;
  paint();
  if (state.engine) state.engine.retryTranslation();
  if (state.partner) state.partner.retryTranslation();
}
async function removeKey() {
  try { localStorage.removeItem(GKEY); } catch (err) { /* ignore */ }
  if (signedIn()) await api("/v1/calls/key", { method: "DELETE" }).catch(() => null);
  state.keySaved = false;
  state.keyMask = "";
  paint();
}

/* ---------- install (stand-alone page) ---------- */
function setInstallName(value) {
  const clean = String(value || "").replace(/[\u0000-\u001F<>]/g, "").trim().slice(0, 30) || "ViktorychCalls";
  try { localStorage.setItem("viktorych-calls-pwa-name", clean); } catch (err) { /* private mode */ }
  if (window.ViktorychCallsInstall && window.ViktorychCallsInstall.rename) window.ViktorychCallsInstall.rename(clean);
}
function installApp() {
  if (window.ViktorychCallsInstall && window.ViktorychCallsInstall.prompt) window.ViktorychCallsInstall.prompt();
}

/* ---------- mounting ---------- */
let bound = false;
function mount(route) {
  state.route = route || state.route;
  loadDevice();
  const target = document;
  if (!bound) {
    bound = true;
    target.addEventListener("pointerdown", onPointer);
    target.addEventListener("input", onInput);
    target.addEventListener("change", onChange);
    target.addEventListener("submit", onSubmit, true);
    window.addEventListener("viktorych-call-ring", (event) => onRing(event.detail));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => { routeOutput(); });
  }
  const r = state.route || {};
  loadStatus();
  loadKeyState();
  if (r.name === "calls") loadLink();
  if (r.name === "calllink" && r.slug && !state.linkInfo) {
    api("/v1/calls/link/" + encodeURIComponent(r.slug)).then((res) => {
      state.linkInfo = res && res.ok ? res.data : { name: "", open: false, reason: "closed" };
      if (host()) paint();
    }).catch(() => {});
  }
  if (r.name === "calls" && state.phase === "idle") {
    loadHistory();
    const to = r.query && r.query.get && r.query.get("to");
    if (to) {
      try { history.replaceState(null, "", location.href.split("?")[0].replace(/\?to=[^#]*/, "")); } catch (err) { /* keep the url */ }
      if (signedIn()) startDirect(to);
    } else if (r.id) checkIncoming(r.id);
    else checkIncoming("");
  }
  if (state.phase === "active") { bindSession(true); holdWake(true); routeOutput(); }
}
function unmount() {
  holdWake(false);
  bindSession(false);
}

function settingsHtml() {
  const prefs = state.prefs || readJson("viktorych-calls-prefs-v1") || { who: "everyone", guests: true, dnd: false };
  loadDevice();
  if (signedIn() && !state.prefsLoading && !state.prefsLoaded) {
    state.prefsLoading = true;
    api("/v1/calls/prefs").then((res) => {
      state.prefsLoading = false;
      state.prefsLoaded = true;
      if (res && res.ok && res.data && res.data.prefs) {
        state.prefs = res.data.prefs;
        writeJson("viktorych-calls-prefs-v1", state.prefs);
        const box = document.querySelector(".calls-settings");
        if (box) box.outerHTML = settingsHtml();
      }
    }).catch(() => { state.prefsLoading = false; });
  }
  const voices = [`<option value="">${esc(tr("Match the voice automatically"))}</option>`].concat(PREBUILT_VOICES.map((row) => `<option value="${esc(row.name)}"${state.voice === row.name ? " selected" : ""}>${esc(row.name)}</option>`)).join("");
  const words = state.lexicon.map((row, index) => `<li>${esc(row.word)} = ${esc(row.say)} <button type="button" data-act="call-lex-del" data-i="${index}">${esc(tr("Remove"))}</button></li>`).join("");
  return `<div class="calls-settings" data-video="0">
    <h2>${esc(tr("Calls settings"))}</h2>
    <p>${esc(tr("Voice calls with live translation. Audio and text only."))}</p>
    <label>${esc(tr("Translation voice"))}<select data-act="call-voice">${voices}</select></label>
    <h2>${esc(tr("Who can call me"))}</h2>
    <div class="calls-modes">${pill("who", "everyone", prefs.who || "everyone", tr("Everyone"))}${pill("who", "circle", prefs.who || "everyone", tr("People I follow or mutuals"))}${pill("who", "nobody", prefs.who || "everyone", tr("Nobody"))}</div>
    <div class="calls-modes"><button type="button" class="calls-pill${prefs.guests !== false ? " on" : ""}" data-act="call-set" data-group="guests" data-value="${prefs.guests !== false ? "0" : "1"}" aria-pressed="${prefs.guests !== false ? "true" : "false"}">${esc(tr("Allow guest invite links"))}</button>
    <button type="button" class="calls-pill${prefs.dnd ? " on" : ""}" data-act="call-set" data-group="dnd" data-value="${prefs.dnd ? "0" : "1"}" aria-pressed="${prefs.dnd ? "true" : "false"}">${esc(tr("Quiet hours"))}</button></div>
    <p>${esc(tr("Blocked accounts can’t call you."))}</p>
    <h2>${esc(tr("Name pronunciations"))}</h2>
    <ul>${words}</ul>
    <p>${esc(tr("On the free Gemini plan, Google may use call audio to improve its products."))}</p>
  </div>`;
}

function debug() {
  const e = state.engine;
  return {
    video: false,
    constraints: MIC_CONSTRAINTS,
    opus: OPUS_MAX_BITRATE,
    transmit: transmitOriginal(state.mode),
    mic: micOpen(state.mode, state.recording),
    guest: guestFeature("route") && guestFeature("background") && guestFeature("repeat") && guestFeature("callback"),
    sink: state.sink,
    voice: state.voice || DEFAULT_VOICE,
    mode: state.mode,
    volumes: state.volumes,
    direct: !proxiesAudio(),
    chunkSamples: CHUNK_SAMPLES,
    outputRate: OUTPUT_RATE,
    worklet: MIC_WORKLET,
    stats: e ? e.stats() : null,
    state: state
  };
}

window.ViktorychCalls = { repaint: paint, page, mount, unmount, onAct, settingsHtml, debug, guestFeature, PINNED_LANGS, CALL_LANGS, normalizeLang, detectLang, createVoiceMatch, DEFAULT_VOICE, onRing, checkIncoming };
