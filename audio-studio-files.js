/* Convert queue and voice notes. Bytes stay in this browser until Send. */
(function (root) {
  "use strict";
  var jobs = [];
  var worker = null;
  var whisper = null;
  var seq = 1;
  var pending = {};
  var queue = [];
  var running = false;
  var ready = false;
  var current = null;
  var format = "flac";
  var flac = 8;
  var mp3 = "320";
  var recorder = null;
  var chunks = [];

  function tr(key, vars) {
    var fn = root.t;
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch];
    });
  }
  function plan() { return root.AudioConvertPlan; }

  function engine() {
    if (worker) return worker;
    worker = new Worker(new URL("audio-convert-worker.js", root.location.href));
    worker.onmessage = function (event) {
      var msg = event.data || {};
      if (msg.op === "ready") {
        ready = true;
        running = false;
        kick();
        return;
      }
      if (msg.op === "error" && msg.code === "busy" && current) {
        queue.unshift(current);
        current = null;
        running = false;
        kick();
        return;
      }
      var job = pending[msg.id];
      if (msg.op !== "progress") {
        current = null;
        running = false;
      }
      if (job) {
        if (msg.op === "progress") job.ratio = msg.ratio || 0;
        if (msg.op === "error") job.state = msg.code || "failed";
        if (msg.op === "done") {
          if (job.url) URL.revokeObjectURL(job.url);
          job.ogg = new Uint8Array(msg.bytes);
          job.mime = msg.mime || "audio/ogg";
          job.ext = msg.ext || "bin";
          job.lossy = !!msg.lossy;
          job.url = URL.createObjectURL(new Blob([job.ogg], { type: job.mime }));
          job.state = job.transcript ? "text" : "done";
        }
        if (msg.op === "pcm") {
          job.state = "transcribing";
          transcribe(job, new Uint8Array(msg.bytes));
        }
        paintJobs();
      }
      if (msg.op !== "progress") kick();
    };
    worker.postMessage({ op: "load" });
    return worker;
  }

  function kick() {
    if (!ready || running || !queue.length) return;
    current = queue.shift();
    running = true;
    pending[current.id] = current.job;
    engine().postMessage(current.msg);
  }
  function transcribe(job, bytes) {
    if (!whisper) {
      whisper = new Worker(new URL("audio-convert-whisper.js", root.location.href));
      whisper.onmessage = function (event) {
        var msg = event.data || {};
        var row = pending[msg.id];
        if (!row) return;
        if (msg.op === "text") { row.transcript = msg.text || ""; row.state = "text"; paintJobs(); }
        if (msg.op === "error") { row.state = "text"; paintJobs(); }
      };
    }
    var audio = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    whisper.postMessage({ op: "run", id: job.id, audio: audio });
  }

  function enqueue(file, options) {
    var id = "j" + (seq++);
    var job = {
      id: id,
      name: plan().safeBase(file.name || "audio"),
      file: file,
      state: "queued",
      ratio: 0,
      options: options,
      transcript: "",
      voice: !!options.voice
    };
    jobs.push(job);
    pending[id] = job;
    if (options.voice) {
      queue.push({ id: id, job: job, msg: { op: "convert", id: id, file: file, options: { voice: true, voiceRate: "64k" } } });
      queue.push({ id: id + "pcm", job: job, msg: { op: "pcm", id: id + "pcm", file: file } });
    } else {
      queue.push({ id: id, job: job, msg: { op: "convert", id: id, file: file, options: options } });
    }
    kick();
    paintJobs();
  }

  function paintJobs() {
    var box = document.querySelector("[data-ac-jobs]");
    if (!box) return;
    box.innerHTML = jobs.map(function (job) {
      var failed = job.state === "failed" || job.state === "busy" || job.state === "no-audio" || job.state === "memory" || job.state === "load" || job.state === "file";
      var label = failed ? tr("Could not convert this file.") : job.state === "done" || job.state === "text" ? tr("Delivered") : job.state === "transcribing" ? tr("Transcribing") : job.state === "queued" ? tr("Converting") : tr("Converting");
      var loss = job.lossy ? tr("Lossy") : tr("Lossless");
      var audio = job.url ? "<audio controls src=\"" + job.url + "\"></audio>" : "";
      var text = job.voice ? "<textarea class=\"ac-box\" data-ac-transcript=\"" + esc(job.id) + "\">" + esc(job.transcript || "") + "</textarea><a class=\"ac-link\" href=\"https://vk.com/im\" target=\"_blank\" rel=\"noopener\">" + esc(tr("Open VK")) + "</a>" : "";
      var send = job.voice && job.ogg ? "<button type=\"button\" class=\"ac-btn primary\" data-ac-send=\"" + esc(job.id) + "\">" + esc(tr("Send")) + "</button>" : "";
      var save = job.url && !job.voice ? "<a class=\"ac-link\" download=\"" + esc(job.name + "." + (job.ext || "bin")) + "\" href=\"" + job.url + "\">" + esc(tr("Download")) + "</a>" : "";
      return "<article class=\"ac-item\"><b>" + esc(job.name) + "</b><span class=\"ac-meta\">" + esc(label) + " " + esc(loss) + "</span>" + audio + text + send + save + "</article>";
    }).join("");
  }

  function formats() {
    return ["wav", "flac", "alac", "aiff", "mp3", "aac", "opus", "vorbis"].map(function (id) {
      var spec = plan().FORMATS[id];
      var kind = spec.lossy ? tr("Lossy") : tr("Lossless");
      return "<button type=\"button\" class=\"ac-pill" + (format === id ? " on" : "") + "\" data-ac-format=\"" + id + "\">" + id + " " + esc(kind) + "</button>";
    }).join("");
  }

  function convertHtml() {
    return "<section class=\"ac-block\" data-ac-convert><h3>" + esc(tr("Convert")) + "</h3>" +
      "<p class=\"ac-lead\">" + esc(tr("Files stay on this device until you choose to send one.")) + "</p>" +
      "<label class=\"ac-drop\"><input data-ac-files type=\"file\" accept=\"audio/*,video/*\" multiple>" + esc(tr("Drop audio here or pick files")) + "</label>" +
      "<div class=\"ac-pills\">" + formats() + "</div>" +
      "<p class=\"ac-note\">" + esc(tr("Lossless")) + " WAV FLAC ALAC AIFF. " + esc(tr("Lossy")) + " MP3 AAC Opus Vorbis.</p>" +
      "<div data-ac-jobs></div>" +
      "<button type=\"button\" class=\"ac-btn\" data-ac-zip>" + esc(tr("Download all")) + "</button>" +
      "</section>";
  }

  function voiceHtml() {
    var account = root.ViktorychTgAccount;
    var gate = account && account.on() ? "<div data-tg-box></div>" : "";
    return "<section class=\"ac-block\" data-ac-voice><h3>" + esc(tr("Voice Notes")) + "</h3>" +
      "<p class=\"ac-note\">" + esc(tr("Record or drop audio, then send it as a Telegram voice note.")) + "</p>" +
      "<div class=\"ac-row\"><button type=\"button\" class=\"ac-btn primary\" data-ac-rec>" + esc(tr("Record")) + "</button>" +
      "<label class=\"ac-btn\"><input data-ac-voice-file type=\"file\" accept=\"audio/*,video/*\">" + esc(tr("Drop audio here or pick files")) + "</label></div>" +
      gate +
      "<div data-ac-jobs></div>" +
      "<p class=\"ac-note\">" + esc(tr("VK gets an audio file, not a voice message.")) + "</p>" +
      "</section>";
  }

  function html(tab) {
    if (tab === "convert") return convertHtml();
    if (tab === "voice") return voiceHtml();
    return "";
  }

  function takeFiles(list, voice) {
    Array.prototype.forEach.call(list || [], function (file) {
      if (voice) enqueue(file, { voice: true });
      else enqueue(file, { format: format, flac: flac, mp3: mp3 === "v0" ? "v0" : "320", cover: true, depth: "orig" });
    });
  }

  function mount(host) {
    var box = host.querySelector("[data-ac-convert], [data-ac-voice]");
    if (!box || box.dataset.bound === "1") return;
    box.dataset.bound = "1";
    box.addEventListener("change", function (event) {
      var input = event.target;
      if (input.hasAttribute("data-ac-files")) takeFiles(input.files, false);
      if (input.hasAttribute("data-ac-voice-file")) takeFiles(input.files, true);
    });
    box.addEventListener("dragover", function (event) { event.preventDefault(); });
    box.addEventListener("drop", function (event) {
      event.preventDefault();
      takeFiles(event.dataTransfer && event.dataTransfer.files, !!box.hasAttribute("data-ac-voice"));
    });
    box.addEventListener("click", function (event) {
      var formatBtn = event.target.closest("[data-ac-format]");
      if (formatBtn) { format = formatBtn.getAttribute("data-ac-format"); box.querySelector(".ac-pills").innerHTML = formats(); }
      var send = event.target.closest("[data-ac-send]");
      if (send) {
        var job = pending[send.getAttribute("data-ac-send")];
        var area = box.querySelector("[data-ac-transcript=\"" + job.id + "\"]");
        if (area) job.transcript = area.value;
        if (root.ViktorychVoiceSheet && job.ogg) {
          root.ViktorychVoiceSheet.open(new Blob([job.ogg], { type: "audio/ogg" }), job.transcript);
        }
      }
      if (event.target.closest("[data-ac-zip]")) {
        var files = jobs.filter(function (job) { return job.ogg && !job.voice; }).map(function (job) {
          return { name: job.name + "." + (job.ext || "bin"), bytes: job.ogg };
        });
        if (!files.length) return;
        var zip = plan().zipStore(files);
        var link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
        link.download = "audio.zip";
        link.click();
      }
      var rec = event.target.closest("[data-ac-rec]");
      if (rec && navigator.mediaDevices) {
        if (recorder && recorder.state === "recording") {
          recorder.stop();
          rec.textContent = tr("Record");
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
          chunks = [];
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
          recorder.onstop = function () {
            stream.getTracks().forEach(function (track) { track.stop(); });
            var blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
            enqueue(new File([blob], "recording.webm", { type: blob.type }), { pcm: true, voice: true });
          };
          recorder.start();
          rec.textContent = tr("Stop");
        }).catch(function () { rec.textContent = tr("Retry"); });
      }
    });
    paintJobs();
    var tg = box.querySelector("[data-tg-box]");
    if (tg && root.ViktorychTgAccount) root.ViktorychTgAccount.attach(tg);
  }

  root.ViktorychStudioFiles = { html: html, mount: mount, jobs: function () { return jobs; } };
})(typeof globalThis !== "undefined" ? globalThis : this);
