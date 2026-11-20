/* Gemini Live setup for translation. The voice is a prebuilt name.
   Reference audio and clone fields are refused. */

import { CALL_MODEL, normalizeLang, langName } from "./call-langs.js";
import { isPrebuiltVoice, DEFAULT_VOICE } from "./call-voice.js";

export function cleanVoice(name) {
  return isPrebuiltVoice(name) ? name : "";
}

/* "translate" is Gemini Live Translate (translationConfig). "live" is the
   earlier interpreter path: the same Live socket and model, with a system
   instruction and no translationConfig. */
export function livePath(flagOn, wantFallback) {
  return flagOn && !wantFallback ? "translate" : "live";
}

export function liveSetup(target, voice, resume, hint, source, path) {
  const lang = normalizeLang(target) || "en";
  const from = normalizeLang(source);
  const translate = path !== "live";
  const setup = {
    model: "models/" + CALL_MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"]
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    /* A long call reconnects with the handle. Compression keeps the
       socket inside the model's context instead of failing at the limit. */
    sessionResumption: resume && typeof resume === "string" && resume.length < 400 ? { handle: resume } : {},
    contextWindowCompression: { slidingWindow: {} }
  };
  if (translate) {
    setup.generationConfig.translationConfig = {
      targetLanguageCode: lang,
      echoTargetLanguage: false
    };
  }
  const picked = cleanVoice(voice) || DEFAULT_VOICE;
  setup.generationConfig.speechConfig = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: picked } }
  };
  const lines = [];
  if (!translate) {
    const named = langName(lang, "en") || lang;
    lines.push("You are a simultaneous interpreter. Translate everything you hear into " + named + " (" + lang + "). Speak only the translation, never answer or comment. Stay silent when there is no speech.");
  }
  if (from) lines.push("Speaker language: " + from + ".");
  lines.push("Listener language: " + lang + ".");
  const note = String(hint || "").trim().slice(0, 800);
  if (note) lines.push(note);
  setup.systemInstruction = { parts: [{ text: lines.join(" ") }] };
  return setup;
}

/* A client must not upload a sample of someone's voice. */
export function rejectsClone(body) {
  if (!body || typeof body !== "object") return false;
  const keys = Object.keys(body);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i].toLowerCase();
    if (key.indexOf("clone") >= 0 || key === "referenceaudio" || key === "voiceaudio" || key === "embeddings") return true;
  }
  return false;
}
