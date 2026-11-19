/* Runs the bundled ffmpeg.wasm build. Audio bytes stay in this worker. */
"use strict";
importScripts("audio-convert-plan.js");

var plan = self.AudioConvertPlan;
var core = null;
var soxr = false;
var busy = false;

function post(msg) { self.postMessage(msg); }

function fail(id, code) { post({ op: "error", id: id || "", code: code || "failed" }); }

function coreUrl(kind, file) {
  return new URL("vendor/ffmpeg/" + kind + "/" + file, self.location.href).href;
}

function loadKind(kind) {
  var js = coreUrl(kind, "ffmpeg-core.js");
  var wasm = coreUrl(kind, "ffmpeg-core.wasm");
  var worker = kind === "mt" ? coreUrl(kind, "ffmpeg-core.worker.js") : "";
  importScripts(js);
  if (typeof createFFmpegCore !== "function") return Promise.reject(new Error("api"));
  var stamp = btoa(JSON.stringify({ wasmURL: wasm, workerURL: worker }));
  return createFFmpegCore({ mainScriptUrlOrBlob: js + "#" + stamp });
}

function isolated() {
  return typeof SharedArrayBuffer === "function" && !!self.crossOriginIsolated;
}

function boot() {
  var first = isolated() ? loadKind("mt") : Promise.reject(new Error("st"));
  return first.catch(function () { return loadKind("st"); }).then(function (mod) {
    core = mod;
    var logs = [];
    core.setLogger(function (row) { logs.push(String(row && row.message || "")); });
    try { core.exec("-hide_banner", "-filters"); } catch (err) { logs.push(String(err && err.message || err)); }
    soxr = /soxr/.test(logs.join("\n"));
    core.setLogger(function () {});
    post({ op: "ready", soxr: soxr, mt: isolated() });
  }).catch(function () { fail("", "load"); });
}

function mount(file) {
  var fs = core.FS;
  try { fs.unmount("/in"); } catch (err) { /* first use */ }
  try { fs.rmdir("/in"); } catch (err) { /* already gone */ }
  try { fs.unlink("/out.bin"); } catch (err) { /* no previous output */ }
  fs.mkdir("/in");
  var named = new File([file], "source.bin", { type: file.type || "application/octet-stream" });
  fs.mount(core.WORKERFS, { files: [named] }, "/in");
  return "/in/source.bin";
}

function readOut() {
  var fs = core.FS;
  var stat = fs.stat("/out.bin");
  var size = stat.size;
  var fd = fs.open("/out.bin", "r");
  var out = new Uint8Array(size);
  var chunk = 1024 * 1024;
  var tmp = new Uint8Array(Math.min(chunk, size || 1));
  var off = 0;
  while (off < size) {
    var n = Math.min(chunk, size - off);
    fs.read(fd, tmp, 0, n, off);
    out.set(n === tmp.length ? tmp : tmp.subarray(0, n), off);
    off += n;
  }
  fs.close(fd);
  try { fs.unlink("/out.bin"); } catch (err) { /* already removed */ }
  return out;
}

function unmount() {
  try { core.FS.unmount("/in"); } catch (err) { /* not mounted */ }
  try { core.FS.rmdir("/in"); } catch (err) { /* already gone */ }
}

function run(args) {
  return core.exec.apply(core, args);
}

function probeText(input) {
  var logs = [];
  core.setLogger(function (row) { logs.push(String(row && row.message || "")); });
  try { run(["-hide_banner", "-i", input]); } catch (err) { logs.push(String(err && err.message || err)); }
  return logs.join("\n");
}

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.op === "load") {
    if (core) { post({ op: "ready", soxr: soxr, mt: isolated() }); return; }
    boot();
    return;
  }
  if (msg.op !== "convert" && msg.op !== "pcm") return;
  if (!core || busy) { fail(msg.id, "busy"); return; }
  var file = msg.file;
  if (!file || typeof file.arrayBuffer !== "function" && !file.name) { fail(msg.id, "file"); return; }
  busy = true;
  var input = "";
  try {
    input = mount(file);
    if (msg.op === "pcm") {
      var pcmCode = 0;
      try { pcmCode = run(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", "-f", "f32le", "/out.bin"]); }
      catch (err) { pcmCode = 1; }
      if (pcmCode !== 0) {
        unmount();
        busy = false;
        fail(msg.id, "failed");
        return;
      }
      var pcm = readOut();
      unmount();
      busy = false;
      if (pcm.length > 16000 * 60 * 20 * 4) {
        fail(msg.id, "memory");
        return;
      }
      post({ op: "pcm", id: msg.id, bytes: pcm.buffer }, [pcm.buffer]);
      return;
    }
    var text = probeText(input);
    var info = plan.parseProbe(text);
    if (!info.audio) {
      unmount();
      busy = false;
      fail(msg.id, "no-audio");
      return;
    }
    var opt = Object.assign({}, msg.options || {}, { soxr: soxr });
    var built = plan.argsFor(info, opt, input, "/out.bin");
    var last = 0;
    core.setProgress(function (row) {
      var now = Date.now();
      if (now - last < 80) return;
      last = now;
      var ratio = Number(row && row.progress);
      if (!isFinite(ratio)) ratio = 0;
      post({ op: "progress", id: msg.id, ratio: Math.max(0, Math.min(0.99, ratio)) });
    });
    var code = 0;
    try { code = run(built.args); }
    catch (err) { code = 1; }
    if (code !== 0 && built.args.indexOf("0:v?") >= 0) {
      try { core.FS.unlink("/out.bin"); } catch (err) { /* partial output */ }
      var again = plan.argsFor(info, Object.assign({}, opt, { cover: false }), input, "/out.bin");
      try { code = run(again.args); }
      catch (err) { code = 1; }
      built = again;
    }
    if (code !== 0) {
      unmount();
      busy = false;
      fail(msg.id, "failed");
      return;
    }
    var bytes = readOut();
    unmount();
    busy = false;
    var copy = bytes.buffer;
    post({
      op: "done",
      id: msg.id,
      bytes: copy,
      size: bytes.length,
      duration: info.duration,
      ext: built.ext,
      mime: built.mime,
      lossy: built.lossy
    }, [copy]);
  } catch (err) {
    try { unmount(); } catch (ignore) { /* worker is already failing */ }
    busy = false;
    var message = String(err && err.message || err);
    fail(msg.id, /memory|allocate|OOM/i.test(message) ? "memory" : "failed");
  }
};
