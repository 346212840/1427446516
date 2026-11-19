/* On-device speech to text. The audio samples stay in this worker.
   The model files download once and the browser cache keeps them.
   This file never reads a bot token and never posts the audio anywhere. */
"use strict";

var PIPE_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
var MODEL = "Xenova/whisper-tiny";
var pipe = null;
var loading = null;

function post(msg) { self.postMessage(msg); }

function load() {
  if (pipe) return Promise.resolve(pipe);
  if (loading) return loading;
  loading = import(PIPE_URL).then(function (mod) {
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
    return mod.pipeline("automatic-speech-recognition", MODEL, {
      dtype: "q8",
      device: "wasm",
      progress_callback: function (info) {
        post({
          op: "progress",
          status: info && info.status || "",
          progress: info && typeof info.progress === "number" ? info.progress : 0
        });
      }
    });
  }).then(function (ready) {
    pipe = ready;
    post({ op: "ready" });
    return ready;
  }).catch(function () {
    loading = null;
    post({ op: "error", code: "model" });
    return null;
  });
  return loading;
}

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.op === "load") {
    load();
    return;
  }
  if (msg.op !== "run") return;
  var audio = msg.audio;
  if (!(audio instanceof Float32Array) || !audio.length || audio.length > 16000 * 60 * 20) {
    post({ op: "error", code: "audio" });
    return;
  }
  load().then(function (ready) {
    if (!ready) return null;
    return ready(audio, { task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
  }).then(function (out) {
    if (!out) return;
    post({ op: "text", id: msg.id || "", text: String(out.text || "").trim() });
  }).catch(function () {
    post({ op: "error", id: msg.id || "", code: "failed" });
  });
};
