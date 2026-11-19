import assert from "node:assert/strict";
import { createLiveSession, directSocketUrl, proxiesAudio, MIC_WORKLET, CHUNK_SAMPLES, OUTPUT_RATE, needsResume, SESSION_REFRESH_MS, createVad } from "../shared/call-gemini.js";
import { isCallLang, CALL_LANGS, detectLang, guessLang } from "../shared/call-langs.js";
import { outputGains, createJitter, soakJitter, createMeter, normalizeVolumes, MIC_CONSTRAINTS, OPUS_MAX_BITRATE } from "../shared/call-audio.js";
import { callDecision, dndActive } from "../shared/call-privacy.js";
import {
  normalizeMode, transmitOriginal, micOpen, noteRelease, noteShouldAutoplay,
  chatVisible, showOriginalSub, showTranslationSub, threadVisible, takeClauses,
  guestFeature, GUEST_FEATURES, modeSwitchKeepsCall, QUICK_PHRASES
} from "../shared/call-mode.js";
import { estimatePitch, matchVoice, resolveVoice, createVoiceMatch, voiceChanged, DEFAULT_VOICE } from "../shared/call-voice.js";
import { langName } from "../shared/call-langs.js";
import { createDiarizer, overlappingPitches } from "../shared/call-speakers.js";
import { liveSetup, rejectsClone } from "../shared/call-setup.js";
import { createHistory, loadLocal, recordLocal, removeRows, restoreRows, swipeAction, toggleSet } from "../shared/call-history.js";
import { createRaiseDetector, earSinkId, cheekLike, createUnlocker, EAR_VOLUME_CAP } from "../shared/call-ear.js";
import { createPipe } from "../shared/call-engine.js";
import { relayHint } from "../worker/src/calls.js";
import pagesRelay from "./pages_relay_worker.js";
import { readFileSync } from "node:fs";
const pagesRelaySource = readFileSync(new URL("./pages_relay_worker.js", import.meta.url), "utf8");
import { lighterFor, pickSink, sinkChangeKeepsCall, cleanLexicon, rememberLine } from "../shared/call-quality.js";

assert.equal(isCallLang("ca"), true, "Catalan is a Live Translate target");
assert.equal(isCallLang("sv"), true, "Swedish is a Live Translate target");
assert.ok(CALL_LANGS.some((row) => row[0] === "ca" && row[1] === "Catalan"));
assert.ok(CALL_LANGS.some((row) => row[0] === "sv" && row[1] === "Swedish"));
assert.equal(guessLang("ca-ES"), "ca");
assert.equal(detectLang("Gràcies, és un bon dia amb amics", "en").code, "ca");
assert.equal(detectLang("Hej, det här är också bra", "en").code, "sv");

const high = outputGains({ original: 0.28, translation: 0.8, overall: 1, tts: 0.5 }, { translating: true, hearOriginal: true, playTranslation: true, playTts: true });
assert.ok(high.original < 0.3 && high.translation === 0.8 && high.tts === 0.5);
const restored = outputGains({ original: 0.28 }, { translating: false, hearOriginal: true, playTranslation: true });
assert.ok(restored.original > high.original);
assert.equal(outputGains({}, { hearOriginal: false, playTranslation: false }).original, 0);
assert.equal(MIC_CONSTRAINTS.echoCancellation, true);
assert.equal(MIC_CONSTRAINTS.noiseSuppression, true);
assert.equal(MIC_CONSTRAINTS.autoGainControl, true);
assert.equal("video" in MIC_CONSTRAINTS, false);
assert.ok(OPUS_MAX_BITRATE >= 128000);
assert.equal(normalizeVolumes({ mic: 2 }).mic, 1);

const jitter = createJitter(() => 0);
jitter.push({ byteLength: 100 }, 10);
const first = jitter.pull(10);
assert.ok(first, "playback starts on the first chunk");
assert.equal(jitter.stats().startDelay, 0);
const soak = soakJitter(18000);
assert.equal(soak.capped, true);

const meter = createMeter();
meter.mic(0);
meter.partial(80);
meter.translationAudio(120);
meter.text(0);
meter.tts(40);
meter.note(0);
meter.notePlay(30);
const report = meter.report();
assert.equal(report.voiceToVoice, 120);
assert.equal(report.voiceToText, 80);
assert.equal(report.textToVoice, 40);
assert.equal(report.noteToVoice, 30);

assert.equal(callDecision({ who: "everyone" }).ok, true);
assert.equal(callDecision({ who: "nobody" }).ok, false);
assert.equal(callDecision({ who: "circle", follows: false, mutual: false }).ok, false);
assert.equal(callDecision({ who: "circle", follows: true }).ok, true);
assert.equal(callDecision({ blocked: true, who: "everyone" }).ok, false);
assert.equal(callDecision({ invite: true, guests: false }).ok, false);
assert.equal(callDecision({ invite: true, guests: true, who: "nobody" }).ok, true);
assert.equal(callDecision({ dnd: true }).ok, false);
const night = Date.UTC(2026, 10, 19, 22, 30);
assert.equal(dndActive({ dnd: true, dndStart: "22:00", dndEnd: "07:00", tz: 0 }, night), true);
assert.equal(dndActive({ dnd: false, dndStart: "22:00", dndEnd: "07:00", tz: 0 }, night), false);

for (const send of ["voice", "text", "note"]) {
  for (const receive of ["voice", "text", "both"]) {
    const mode = normalizeMode({ send, receive, original: true });
    assert.equal(mode.send, send);
    assert.equal(mode.receive, receive);
    assert.equal(transmitOriginal(mode), send === "voice");
    assert.equal(noteShouldAutoplay(mode), receive !== "text");
  }
}
assert.equal(transmitOriginal({ send: "voice", translationOnly: true }), false);
assert.equal(micOpen({ send: "note" }, false), false);
assert.equal(micOpen({ send: "note" }, true), true);
assert.equal(micOpen({ send: "text" }, true), false);
assert.equal(micOpen({ send: "voice" }, false), true);
assert.equal(noteRelease(0, -80, false), "cancel");
assert.equal(noteRelease(0, -10, true), "review");
assert.equal(noteRelease(0, -10, false), "send");
assert.equal(modeSwitchKeepsCall(), true);

assert.equal(showOriginalSub({ subtitles: "off" }), false);
assert.equal(showTranslationSub({ subtitles: "off" }), false);
assert.equal(showOriginalSub({ subtitles: "translated" }), false);
assert.equal(showTranslationSub({ subtitles: "translated" }), true);
assert.equal(showOriginalSub({ subtitles: "original" }), true);
assert.equal(showTranslationSub({ subtitles: "original" }), false);
assert.equal(showOriginalSub({ subtitles: "both" }), true);
assert.equal(showTranslationSub({ subtitles: "both" }), true);
assert.equal(chatVisible({ receive: "text", subtitles: "off" }), true);
assert.equal(chatVisible({ receive: "voice", subtitles: "both" }), false);
assert.equal(threadVisible({ receive: "voice", subtitles: "off" }, true), true);
const clauses = takeClauses("Hello there. More words are still coming into this");
assert.equal(clauses.ready[0], "Hello there.");
assert.ok(clauses.rest.length > 0, "the rest of the sentence is not required before speech");

GUEST_FEATURES.forEach((name) => assert.equal(guestFeature(name), true));
assert.equal(guestFeature("video"), false);

function sine(hz, rate, seconds) {
  const n = Math.floor(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}
const low = estimatePitch(sine(120, 16000, 0.25), 16000);
assert.equal(low.confident, true);
assert.ok(Math.abs(low.hz - 120) <= 8, "pitch " + low.hz);
assert.equal(matchVoice(120), matchVoice(low.hz));
const highPitch = estimatePitch(sine(220, 16000, 0.25), 16000);
assert.ok(Math.abs(highPitch.hz - 220) <= 12, "pitch " + highPitch.hz);
assert.notEqual(matchVoice(120), matchVoice(220));
const instant = resolveVoice("", 0, false);
assert.equal(instant.voice, DEFAULT_VOICE);
assert.equal(instant.source, "default");
assert.equal(resolveVoice("Kore", 120, true).voice, "Kore");
assert.equal(resolveVoice("Kore", 120, true).source, "override");
const matcher = createVoiceMatch();
const before = matcher.current();
assert.equal(before.source, "default");
assert.equal(matcher.current() instanceof Promise, false);
for (let i = 0; i < 10; i++) matcher.push(sine(120, 16000, 0.1), 16000);
const after = matcher.current();
assert.equal(after.source, "pitch");
assert.equal(voiceChanged(before, after), true);
const locked = createVoiceMatch("Aoede");
locked.push(sine(120, 16000, 0.2), 16000);
assert.equal(locked.current().voice, "Aoede");
assert.equal(locked.current().source, "override");

const setup = liveSetup("sv", "Leda");
assert.equal(setup.generationConfig.translationConfig.targetLanguageCode, "sv");
assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Leda");
assert.equal(setup.inputAudioTranscription != null, true);
assert.equal(JSON.stringify(setup).toLowerCase().includes("clone"), false);
assert.equal(rejectsClone({ referenceAudio: "abc" }), true);
assert.equal(rejectsClone({ voice: "Puck" }), false);
assert.equal(liveSetup("ca").generationConfig.translationConfig.targetLanguageCode, "ca");
const hinted = liveSetup("en", "Puck", "", "Pronounce these as specified: Nova = NO-vah.");
assert.equal(hinted.systemInstruction.parts[0].text.indexOf("NO-vah") >= 0, true);
const both = liveSetup("sv", "Leda", "resume-1", "", "en");
assert.equal(both.sessionResumption.handle, "resume-1");
assert.ok(both.contextWindowCompression.slidingWindow);
assert.ok(both.systemInstruction.parts[0].text.indexOf("Speaker language: en.") >= 0);
assert.ok(both.systemInstruction.parts[0].text.indexOf("Listener language: sv.") >= 0);
assert.equal(lighterFor({ effectiveType: "4g", downlink: 10, rtt: 50 }).lighter, false);
assert.equal(lighterFor({ saveData: true }).bitrate, 24000);
assert.equal(pickSink([{ kind: "audiooutput", deviceId: "spk", label: "Speaker" }, { kind: "audiooutput", deviceId: "bt", label: "Bluetooth headphones" }]), "bt");
assert.equal(sinkChangeKeepsCall(), true);
assert.equal(cleanLexicon([{ word: "Nova", say: "NO-vah" }, { word: "", say: "x" }]).length, 1);
assert.equal(rememberLine(null, { text: "Hola" }).text, "Hola");
assert.deepEqual(QUICK_PHRASES, ["hold", "repeat", "back"]);

const session = createLiveSession();
session.ring(0);
assert.equal(session.phase(), "warming");
session.ready(10);
assert.equal(session.warm(), true);
assert.equal(proxiesAudio(), false);
assert.equal(CHUNK_SAMPLES, 1600);
assert.equal(OUTPUT_RATE, 24000);
assert.ok(MIC_WORKLET.indexOf("new Int16Array(1600)") >= 0);
assert.ok(MIC_WORKLET.indexOf("16000") >= 0);
const socket = directSocketUrl("test-ephemeral");
assert.ok(socket.indexOf("access_token=") >= 0);
assert.equal(socket.indexOf("key="), -1);
assert.equal(directSocketUrl(""), "");
const silent = new Float32Array(1600);
const loud = new Float32Array(1600);
loud.fill(0.2);
assert.equal(session.onSpeech(silent, 20).reason, "vad");
assert.equal(session.onSpeech(loud, 30).send, true);
assert.equal(session.onSpeech(loud, 30).bytes, 3200);
for (let i = 0; i < 400; i++) session.onSpeech(loud, 1000 + i * 100);
assert.equal(session.quota(1000 + 400 * 100).degraded, true);
assert.equal(session.quota(1000 + 400 * 100).mode, "text");
assert.equal(session.onSpeech(loud, 50000).reason, "text");
assert.ok(session.quota(50000).perMinute > 0);
assert.equal(needsResume(SESSION_REFRESH_MS, false), true);
assert.equal(needsResume(1000, true), true);

function tone(hz) {
  const out = new Float32Array(4000);
  for (let i = 0; i < out.length; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / 16000);
  return out;
}
const mixed = tone(120);
const other = tone(220);
for (let i = 0; i < mixed.length; i++) mixed[i] = (mixed[i] + other[i]) * 0.5;
assert.equal(overlappingPitches(tone(120), 16000).length, 0);
assert.equal(overlappingPitches(mixed, 16000).length, 2);
const people = createDiarizer();
const speakerA = people.push(tone(120), 16000, "Hello thanks and this is good");
let speakerB = null;
for (let i = 0; i < 12; i++) speakerB = people.push(tone(220), 16000, i === 11 ? "Hola gracias también estoy aquí" : "");
assert.equal(speakerA.send, true);
assert.equal(speakerB.send, true);
assert.notEqual(speakerA.speaker.id, speakerB.speaker.id);
assert.equal(speakerA.speaker.lang, "en");
assert.equal(speakerB.speaker.lang, "es");
assert.notEqual(speakerA.speaker.voice, speakerB.speaker.voice);
assert.equal(people.push(mixed, 16000, "").send, false);
const one = createDiarizer();
for (let i = 0; i < 60; i++) one.push(tone(i % 9 === 0 ? 0 : 120 + (i % 5) * 4), 16000, "");
assert.equal(one.speakers().length, 1, "one steady voice with small pitch wobble stays one speaker");
const breaths = createDiarizer();
breaths.push(tone(125), 16000, "");
for (let i = 0; i < 20; i++) breaths.push(tone(220), 16000, "");
assert.equal(breaths.speakers().length, 2, "a clearly different voice is a second speaker once it holds");
const blip = createDiarizer();
blip.push(tone(125), 16000, "");
blip.push(tone(230), 16000, "");
blip.push(tone(125), 16000, "");
assert.equal(blip.speakers().length, 1, "a single odd frame does not split the voice");
people.rename(speakerB.speaker.id, "Nova");
assert.equal(people.speakers().find((item) => item.id === speakerB.speaker.id).name, "Nova");

assert.equal(langName("es", "en"), "Spanish");
assert.equal(langName("es", "es"), "Español");
assert.equal(langName("sv", "ru"), "Шведский");
assert.equal(langName("ca", "hi").length > 0, true);
assert.equal(langName("zz", "en"), "zz");


/* Ear mode: raise-to-ear detection, earpiece route, cheek-proof unlock */
{
  const feed = (det, rows) => rows.map(([t, b, g]) => det.feed({ t, beta: b, gamma: g })).filter(Boolean);
  const raised = [];
  for (let t = 0; t <= 1000; t += 50) raised.push([t, 50, 0]);
  for (let t = 1050; t <= 1400; t += 50) raised.push([t, 50 + (t - 1000) / 400 * 40, 3]);
  for (let t = 1450; t <= 2600; t += 50) raised.push([t, 92, 4]);
  assert.deepEqual(feed(createRaiseDetector(), raised), ["ear"], "raising the phone upright to the ear locks once");
  const mount = [];
  for (let t = 0; t <= 6000; t += 50) mount.push([t, 90, 0]);
  assert.deepEqual(feed(createRaiseDetector(), mount), [], "a phone sitting upright in a car mount never locks");
  const swing = [];
  for (let t = 0; t <= 1000; t += 50) swing.push([t, 50, 0]);
  for (let t = 1050; t <= 2600; t += 50) swing.push([t, 90 + ((t / 50) % 2 ? 9 : -9), 0]);
  assert.deepEqual(feed(createRaiseDetector(), swing), [], "a shaking phone does not count as raised and held");
  const det = createRaiseDetector();
  feed(det, raised);
  const lower = [];
  for (let t = 3000; t <= 4200; t += 50) lower.push([t, 20, 0]);
  assert.deepEqual(feed(det, lower), ["away"], "lowering the phone ends an automatic ear mode");
  assert.equal(EAR_VOLUME_CAP < 1 && EAR_VOLUME_CAP > 0.3, true);

  const sinks = [{ kind: "audiooutput", label: "Speaker", deviceId: "s" }, { kind: "audiooutput", label: "Phone earpiece", deviceId: "e" }, { kind: "audiooutput", label: "Bluetooth headset", deviceId: "b" }];
  assert.equal(earSinkId(sinks), "e");
  assert.equal(earSinkId([sinks[0], sinks[2]]), "", "no earpiece listed means no route change");
  assert.equal(cheekLike({ width: 70, height: 90 }), true);
  assert.equal(cheekLike({ width: 20, height: 20 }), false);

  const u = createUnlocker();
  u.down(1, 100, 100, 0, { width: 20, height: 20 });
  assert.equal(u.up(1, 100, 100, 80), "", "one tap does nothing");
  u.down(1, 102, 101, 200, { width: 20, height: 20 });
  assert.equal(u.up(1, 102, 101, 270), "unlock", "double tap unlocks");
  u.down(2, 100, 100, 1000, { width: 90, height: 90 });
  assert.equal(u.up(2, 100, 100, 1060), "");
  u.down(2, 100, 100, 1150, { width: 90, height: 90 });
  assert.equal(u.up(2, 100, 100, 1200), "", "a wide cheek contact never unlocks");
  u.down(3, 100, 300, 2000, { width: 20, height: 20 });
  u.down(4, 150, 300, 2010, { width: 20, height: 20 });
  assert.equal(u.up(3, 100, 100, 2200), "", "two fingers at once are ignored");
  u.up(4, 150, 300, 2210);
  u.down(5, 100, 400, 3000, { width: 20, height: 20 });
  u.move(5, 100, 250);
  assert.equal(u.up(5, 100, 240, 3300), "unlock", "a swipe up unlocks");
  u.down(6, 100, 400, 4000, { width: 20, height: 20 });
  assert.equal(u.up(6, 100, 330, 4300), "", "a short drag is not a swipe");
}

/* Editing call history: hide for me, undo, clear all, guests stay local. */
{
  const mem = {};
  const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  recordLocal(storage, { id: "a1", name: "Ann", createdAt: 1000, duration: 5000 });
  recordLocal(storage, { id: "b2", name: "Bo", createdAt: 3000 });
  recordLocal(storage, { id: "a1", name: "Ann", createdAt: 1000 });
  assert.deepEqual(loadLocal(storage).map((r) => r.id), ["a1", "b2"], "one row per call id, the latest record first");
  assert.equal(loadLocal(storage).length, 2);
  const calls = [];
  const h = createHistory({ api: async (path, init) => { calls.push(path); return { ok: true, data: path.endsWith("/clear") ? { ids: ["x1", "x2"] } : { calls: [{ id: "x1", createdAt: 5 }, { id: "x2", createdAt: 9 }] } }; }, storage, signedIn: () => false });
  await h.load();
  assert.deepEqual(h.rows.map((r) => r.id).sort(), ["a1", "b2"]);
  const t1 = await h.remove(["a1"]);
  assert.deepEqual(h.rows.map((r) => r.id), ["b2"]);
  assert.equal(calls.length, 0, "guests never call the Worker");
  assert.deepEqual(loadLocal(storage).map((r) => r.id), ["b2"], "guest removal is saved on the device");
  await h.restore(t1);
  assert.equal(h.rows.length, 2);
  assert.equal(h.rows[0].id, "b2", "newest first after undo");
  const cleared = await h.clear();
  assert.equal(h.rows.length, 0);
  await h.restore(cleared);
  assert.equal(h.rows.length, 2);

  const s2 = createHistory({ api: async (path) => { calls.push(path); return { ok: true, data: path.endsWith("/clear") ? { ids: ["x1", "x2"] } : { calls: [{ id: "x1", createdAt: 5 }, { id: "x2", createdAt: 9 }] } }; }, storage, signedIn: () => true });
  await s2.load();
  assert.deepEqual(s2.rows.map((r) => r.id), ["x1", "x2"]);
  const tk = await s2.remove(["x2"]);
  assert.deepEqual(calls.slice(-1), ["/v1/calls/history/hide"]);
  await s2.restore(tk);
  assert.deepEqual(calls.slice(-1), ["/v1/calls/history/unhide"]);
  const all = await s2.clear();
  assert.deepEqual(all.ids, ["x1", "x2"]);
  assert.equal(s2.rows.length, 0);
  const bad = createHistory({ api: async () => ({ ok: false }), storage, signedIn: () => true });
  bad.rows = [{ id: "q", createdAt: 1 }];
  await assert.rejects(() => bad.remove(["q"]));
  assert.equal(bad.rows.length, 1, "a failed hide puts the row back");
  assert.equal(swipeAction(-120, 10, 320), "delete");
  assert.equal(swipeAction(-60, 5, 320), "none");
  assert.equal(swipeAction(-120, 90, 320), "none", "a mostly vertical drag is a scroll");
  assert.deepEqual([...toggleSet(new Set(["a"]), "a")], []);
  assert.deepEqual(removeRows([{ id: 1 }, { id: 2 }], [2]).kept, [{ id: 1 }]);
  assert.equal(restoreRows([{ id: 1, createdAt: 1 }], [{ id: 2, createdAt: 2 }])[0].id, 2);
}


/* Route race: relay first for a blocked network, a second route that starts
   beside a slow first one, and the loser is closed. */
{
  assert.deepEqual(relayHint({ cf: { country: "RU" } }), { country: "RU", prefer: "relay" });
  assert.deepEqual(relayHint({ cf: { country: "SE" } }), { country: "SE" });
  assert.deepEqual(relayHint({ headers: new Headers({ "CF-IPCountry": "by" }) }), { country: "BY", prefer: "relay" });
  assert.deepEqual(relayHint({ headers: new Headers() }), {});

  const sockets = [];
  const plan = {};
  class FakeSocket {
    constructor(url) {
      this.url = url; this.closed = false; sockets.push(this);
      const how = Object.keys(plan).find((key) => url.indexOf(key) >= 0);
      this.how = how ? plan[how] : "ok";
      setTimeout(() => { if (this.how === "dead") { this.onclose && this.onclose(); } else if (this.how !== "hang" && !this.closed) this.onopen && this.onopen(); }, this.how === "dead" ? 5 : 0);
    }
    send() { if (this.how === "ok" || this.how === "slow") setTimeout(() => { if (!this.closed && this.onmessage) this.onmessage({ data: '{"setupComplete":{}}' }); }, this.how === "slow" ? 1800 : 10); }
    close() { this.closed = true; }
  }
  globalThis.WebSocket = FakeSocket;
  let minted = 0;
  const run = async (hostPlan, order, flags) => {
    sockets.length = 0;
    Object.keys(plan).forEach((key) => delete plan[key]);
    Object.assign(plan, hostPlan);
    const seen = [];
    const env = {
      relayFirst: () => !!(flags && flags.relay), routeKnown: () => false, noteRoute: (via) => seen.push(via),
      relayUrl: (t) => "wss://main.test/live?t=" + t,
      relayUrls: (t) => ["wss://main.test/live?t=" + t, "wss://mirror.test/live?t=" + t]
    };
    const states = [];
    const pipe = createPipe(env, {
      id: "t", target: "en", out: null, source: "",
      token: async () => { minted += 1; return { mode: "token", token: "tok" + minted + "_abcdefgh", url: "wss://google.test/ws?t=" + minted, setup: {}, prefer: flags && flags.prefer }; },
      onState: (p, st) => states.push(st), onLine() {}, onPartial() {}, onOut() {}, onGoAway() {}
    });
    const t0 = Date.now();
    pipe.open();
    for (let i = 0; i < 80 && !pipe.via && !states.includes("failed"); i++) await new Promise((r) => setTimeout(r, 100));
    return { via: pipe.via, ms: Date.now() - t0, seen, minted, sockets: sockets.slice(), pipe };
  };
  let r = await run({ "google.test": "ok" }, 0, {});
  assert.equal(r.via, "direct");
  assert.equal(r.sockets.length, 1, "a fast direct route never starts the relay");
  r.pipe.close();
  r = await run({ "google.test": "dead" }, 0, {});
  assert.equal(r.via, "relay", "a dead direct route falls to the relay at once");
  assert.ok(r.ms < 800, "the fallback does not wait for the full timeout: " + r.ms);
  r.pipe.close();
  r = await run({ "google.test": "slow", "main.test": "ok" }, 0, {});
  assert.equal(r.via, "relay", "a slow direct route loses to the relay that starts beside it");
  assert.ok(r.sockets.filter((sock) => sock.url.indexOf("google") >= 0).every((sock) => sock.closed), "the slow loser is closed");
  r.pipe.close();
  r = await run({ "main.test": "dead", "mirror.test": "ok" }, 0, { prefer: "relay" });
  assert.equal(r.via, "relay");
  assert.ok(r.sockets[0].url.indexOf("main.test") >= 0 && r.sockets[1].url.indexOf("mirror.test") >= 0, "a blocked main host falls to the mirror host");
  assert.ok(!r.sockets.some((sock) => sock.url.indexOf("google") >= 0), "a hinted caller never opens a Google socket when the relay works");
  r.pipe.close();
  r = await run({ "main.test": "hang", "mirror.test": "ok" }, 0, { prefer: "relay" });
  assert.equal(r.via, "relay");
  assert.ok(r.ms > 1400 && r.ms < 2600, "a hung main host hands over to the mirror after about 1.6 s: " + r.ms);
  assert.ok(r.sockets.filter((sock) => sock.url.indexOf("main.test") >= 0).every((sock) => sock.closed), "the hung socket is closed");
  r.pipe.close();
  delete globalThis.WebSocket;

  const assets = { fetch: async () => new Response("asset") };
  const hit = (path, init) => pagesRelay.fetch(new Request("https://viktorychapp.pages.dev" + path, init), { ASSETS: assets });
  assert.equal(await (await hit("/index.html")).text(), "asset");
  assert.equal((await hit("/v1/calls/live?t=abcdefgh1234")).status, 426);
  assert.ok(pagesRelaySource.includes("arrayBuffer") && !/server\.send\(event\.data\)/.test(pagesRelaySource), "Blob frames are converted before they are sent on");
  assert.equal((await hit("/v1/calls/live?t=%20bad", { headers: { Upgrade: "websocket" } })).status, 400);
}

console.log("calls logic ok", JSON.stringify(report));
