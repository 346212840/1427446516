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

console.log("calls logic ok", JSON.stringify(report));
