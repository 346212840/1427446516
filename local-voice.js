/* Desktop-only local speech. Qwen3-TTS covers English, Spanish and Russian.
   OmniVoice covers Swedish and Catalan. The token stays in this browser. */
(function (root) {
  "use strict";
  var DB = "viktorych-local-voice-v1";
  var KEY = "viktorych-local-voice-gate";
  var memory = { voices: [], clips: {} };

  function tr(key, vars) {
    var fn = root.t;
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch];
    });
  }
  function desktop() {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    var wide = window.matchMedia("(min-width: 700px)").matches;
    var fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    return !!(wide && fine);
  }
  function enabled() {
    if (root.ViktorychServerFeature && !root.ViktorychServerFeature("local_voice")) {
      var at = 0;
      try { at = Number(localStorage.getItem("viktorychapp-server-off-at")) || 0; } catch (err) { at = 0; }
      if (at > 0) return false;
    }
    return true;
  }
  function gate() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }
    catch (err) { return {}; }
  }
  function saveGate(next) {
    var cur = gate();
    if (next.port) cur.port = String(next.port).replace(/[^\d]/g, "").slice(0, 5) || "8080";
    if (typeof next.token === "string") cur.token = next.token.slice(0, 200);
    if (next.language) cur.language = next.language;
    if (next.engine) cur.engine = next.engine;
    localStorage.setItem(KEY, JSON.stringify({
      port: cur.port || "8080",
      token: cur.token || "",
      language: cur.language || "auto",
      engine: cur.engine || "auto"
    }));
  }
  function origin() {
    var saved = gate();
    var port = saved.port || "8080";
    return "http://127.0.0.1:" + port;
  }
  function authHeaders() {
    return { Authorization: "Bearer " + (gate().token || "") };
  }

  function openDb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(DB, 1); }
      catch (err) { resolve(null); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("voices")) db.createObjectStore("voices", { keyPath: "id" });
        if (!db.objectStoreNames.contains("clips")) db.createObjectStore("clips");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }

  function listVoices() {
    return openDb().then(function (db) {
      if (!db) return memory.voices.slice();
      return new Promise(function (resolve) {
        var tx = db.transaction("voices", "readonly");
        var req = tx.objectStore("voices").getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      });
    });
  }

  function saveVoice(row) {
    memory.voices = memory.voices.filter(function (item) { return item.id !== row.id; }).concat([row]);
    return openDb().then(function (db) {
      if (!db) return row;
      return new Promise(function (resolve) {
        var tx = db.transaction("voices", "readwrite");
        tx.objectStore("voices").put(row);
        tx.oncomplete = function () { resolve(row); };
        tx.onerror = function () { resolve(row); };
      });
    });
  }

  function cacheKey(voiceId, text, language, engine) {
    var stamp = voiceId + "\n" + language + "\n" + engine + "\n" + text;
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(stamp)).then(function (buf) {
      return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }

  function readClip(voiceId, text, language, engine) {
    return cacheKey(voiceId, text, language || "", engine || "").then(function (key) {
      if (memory.clips[key]) return memory.clips[key];
      return openDb().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          var req = db.transaction("clips", "readonly").objectStore("clips").get(key);
          req.onsuccess = function () {
            var row = req.result;
            if (!row) { resolve(null); return; }
            var blob = new Blob([row.bytes], { type: row.mime || "audio/wav" });
            memory.clips[key] = blob;
            resolve(blob);
          };
          req.onerror = function () { resolve(null); };
        });
      });
    });
  }

  function writeClip(voiceId, text, blob, language, engine) {
    return cacheKey(voiceId, text, language || "", engine || "").then(function (key) {
      memory.clips[key] = blob;
      return blob.arrayBuffer().then(function (bytes) {
        return openDb().then(function (db) {
          if (!db) return blob;
          return new Promise(function (resolve) {
            var tx = db.transaction("clips", "readwrite");
            tx.objectStore("clips").put({ bytes: bytes, mime: blob.type || "audio/wav" }, key);
            tx.oncomplete = function () { resolve(blob); };
            tx.onerror = function () { resolve(blob); };
          });
        });
      });
    });
  }

  function health() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 2500);
    return fetch(origin() + "/v1/health", { headers: authHeaders(), signal: ctrl.signal }).then(function (res) {
      clearTimeout(timer);
      return res.ok;
    }).catch(function () {
      clearTimeout(timer);
      return false;
    });
  }

  function b64(bytes) {
    var bin = "";
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function bytesOf(voice) {
    var raw = voice.bytes;
    if (raw instanceof ArrayBuffer) return Promise.resolve(raw);
    if (raw && raw.arrayBuffer) return raw.arrayBuffer();
    if (voice.url) return fetch(voice.url).then(function (res) { return res.arrayBuffer(); });
    return Promise.reject(new Error("clip"));
  }

  function planFor(text) {
    var saved = gate();
    var router = root.ViktorychLocalVoiceRoute;
    if (!router) return { language: "en", engine: "qwen", engineName: "Qwen3-TTS", rerouted: false };
    return router.choose(text, saved.language || view.language || "auto", saved.engine || view.engine || "auto");
  }
  function generate(voice, text) {
    var plan = planFor(text);
    return readClip(voice.id, text, plan.language, plan.engine).then(function (cached) {
      if (cached) return { blob: cached, cached: true, plan: plan };
      return bytesOf(voice).then(function (buf) {
        return fetch(origin() + "/v1/tts", {
          method: "POST",
          headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
          body: JSON.stringify({
            text: text,
            language: plan.language,
            engine: plan.engine,
            format: "wav",
            normalize: true,
            references: [{ audio: b64(new Uint8Array(buf)), text: voice.transcript || "" }]
          })
        });
      }).then(function (res) {
        if (res.blob && res.cached) return res;
        if (!res.ok) {
          return res.json().then(function (body) {
            var err = new Error((body && body.error) || "local");
            err.code = body && body.error;
            throw err;
          }, function () { throw new Error("local"); });
        }
        var heard = res.headers.get("X-Local-Voice-Engine");
        if (heard) plan.engine = heard;
        return res.blob().then(function (blob) {
          return writeClip(voice.id, text, blob, plan.language, plan.engine).then(function (saved) {
            return { blob: saved, cached: false, plan: plan };
          });
        });
      });
    });
  }

  var view = { up: false, voices: [], note: "", text: "", voiceId: "", clipUrl: "", language: "auto", engine: "auto" };

  function paint(host) {
    var el = host.querySelector("[data-local-voice]");
    if (!el) return;
    el.innerHTML = inner();
  }

  function langSelect(saved) {
    var current = saved.language || view.language || "auto";
    var options = [
      ["auto", tr("Auto")],
      ["en", tr("English")],
      ["es", tr("Spanish")],
      ["sv", tr("Swedish")],
      ["ca", tr("Catalan")],
      ["ru", tr("Russian")]
    ];
    return "<label class=\"ac-field\"><span>" + esc(tr("Language")) + "</span><select data-local=\"lang\">" + options.map(function (pair) {
      return "<option value=\"" + pair[0] + "\"" + (pair[0] === current ? " selected" : "") + ">" + esc(pair[1]) + "</option>";
    }).join("") + "</select></label>";
  }
  function engineSelect(saved) {
    var current = saved.engine || view.engine || "auto";
    var options = [
      ["auto", tr("Auto")],
      ["qwen", tr("Qwen3-TTS")],
      ["omnivoice", tr("OmniVoice")],
      ["fish", tr("Fish-Speech 1.5")]
    ];
    return "<label class=\"ac-field\"><span>" + esc(tr("Engine")) + "</span><select data-local=\"engine\">" + options.map(function (pair) {
      return "<option value=\"" + pair[0] + "\"" + (pair[0] === current ? " selected" : "") + ">" + esc(pair[1]) + "</option>";
    }).join("") + "</select></label>";
  }
  function routeNote() {
    var plan = planFor(view.text || "");
    var line = tr("This line uses {engine}.", { engine: tr(plan.engineName) });
    var gap = tr("Qwen3-TTS does not list Swedish or Catalan, so those lines use OmniVoice on this computer.");
    var personal = tr("OmniVoice weights are personal use only.");
    var moved = plan.rerouted ? "<p class=\"ac-note\">" + esc(tr("That engine does not list this language, so Auto picked another.")) + "</p>" : "";
    return "<p class=\"ac-note\" data-local-route>" + esc(line) + "</p><p class=\"ac-note\">" + esc(gap) + " " + esc(personal) + "</p>" + moved;
  }
  function inner() {
    if (!desktop() || !enabled()) return "";
    var guide = "https://github.com/ViktorychGroup/ViktorychApp1427446516/blob/main/docs/local-voice.md";
    var saved = gate();
    view.language = saved.language || view.language || "auto";
    view.engine = saved.engine || view.engine || "auto";
    var down = "<p class=\"ac-note\" data-local-down>" + esc(tr("The local voice server is not running.")) + " <a href=\"" + guide + "\">" + esc(tr("Setup guide")) + "</a></p>";
    if (!view.up) {
      return "<section class=\"ac-block\" data-local-root><h3>" + esc(tr("Local voice (free)")) + "</h3>" +
        "<p class=\"ac-note\">" + esc(tr("Speech stays on this computer. A short reference clip clones the voice.")) + "</p>" +
        routeNote() + down +
        "<div class=\"ac-row\"><input class=\"ac-search\" data-local=\"port\" inputmode=\"numeric\" aria-label=\"" + esc(tr("Port")) + "\" value=\"" + esc(saved.port || "8080") + "\">" +
        "<input class=\"ac-search\" data-local=\"token\" type=\"password\" autocomplete=\"off\" aria-label=\"" + esc(tr("Local token")) + "\" placeholder=\"" + esc(tr("Local token")) + "\"></div>" +
        langSelect(saved) + engineSelect(saved) +
        "<button class=\"ac-btn\" type=\"button\" data-local=\"connect\">" + esc(tr("Connect")) + "</button></section>";
    }
    var options = view.voices.map(function (voice) {
      return "<option value=\"" + esc(voice.id) + "\"" + (voice.id === view.voiceId ? " selected" : "") + ">" + esc(voice.name || tr("Voice")) + "</option>";
    }).join("");
    return "<section class=\"ac-block\" data-local-root><h3>" + esc(tr("Local voice (free)")) + "</h3>" +
      "<p class=\"ac-note\">" + esc(tr("Speech stays on this computer. A short reference clip clones the voice.")) + "</p>" +
      routeNote() + langSelect(saved) + engineSelect(saved) +
      "<label class=\"ac-field\"><span>" + esc(tr("Reference clip")) + "</span><input data-local=\"file\" type=\"file\" accept=\"audio/*,video/*\"></label>" +
      "<input class=\"ac-search\" data-local=\"name\" aria-label=\"" + esc(tr("Voice name")) + "\" placeholder=\"" + esc(tr("Voice name")) + "\">" +
      "<input class=\"ac-search\" data-local=\"said\" aria-label=\"" + esc(tr("Words in the clip")) + "\" placeholder=\"" + esc(tr("Words in the clip")) + "\">" +
      "<button class=\"ac-btn\" type=\"button\" data-local=\"save\">" + esc(tr("Save voice on this device")) + "</button>" +
      "<label class=\"ac-field\"><span>" + esc(tr("Voice")) + "</span><select data-local=\"pick\">" + options + "</select></label>" +
      "<textarea class=\"ac-box\" data-local=\"text\">" + esc(view.text) + "</textarea>" +
      "<button class=\"ac-btn primary\" type=\"button\" data-local=\"go\">" + esc(tr("Generate")) + "</button>" +
      (view.note ? "<p class=\"ac-note\">" + esc(view.note) + "</p>" : "") +
      (view.clipUrl ? "<audio controls src=\"" + view.clipUrl + "\"></audio><div class=\"ac-row\"><a class=\"ac-link\" href=\"" + view.clipUrl + "\" download=\"local-voice.wav\">" + esc(tr("Download")) + "</a><a class=\"ac-link\" href=\"https://vk.com/im\" target=\"_blank\" rel=\"noopener\">" + esc(tr("Open VK")) + "</a></div><p class=\"ac-note\">" + esc(tr("VK gets an audio file, not a voice message.")) + "</p>" : "") +
      "</section>";
  }

  function html() {
    if (!desktop() || !enabled()) return "";
    return "<div data-local-voice></div>";
  }

  function mount(host) {
    var slot = host.querySelector("[data-local-voice]");
    if (!slot || slot.dataset.bound === "1") return;
    slot.dataset.bound = "1";
    paint(host);
    slot.addEventListener("change", function (event) {
      var node = event.target;
      if (!node || !node.getAttribute) return;
      var kind = node.getAttribute("data-local");
      if (kind === "lang") view.language = node.value || "auto";
      if (kind === "engine") view.engine = node.value || "auto";
      if (kind === "lang" || kind === "engine") {
        saveGate({ language: view.language, engine: view.engine });
        paint(host);
      }
    });
    slot.addEventListener("input", function (event) {
      var node = event.target;
      if (!node || node.getAttribute("data-local") !== "text") return;
      view.text = node.value;
      var note = slot.querySelector("[data-local-route]");
      if (note) note.textContent = tr("This line uses {engine}.", { engine: tr(planFor(view.text).engineName) });
    });
    slot.addEventListener("click", function (event) {
      var node = event.target.closest("[data-local]");
      if (!node) return;
      var act = node.getAttribute("data-local");
      if (act === "connect") {
        var port = host.querySelector("[data-local=port]");
        var tokenBox = host.querySelector("[data-local=token]");
        var lang = host.querySelector("[data-local=lang]");
        var engine = host.querySelector("[data-local=engine]");
        saveGate({
          port: port ? port.value : "8080",
          token: tokenBox ? tokenBox.value : gate().token,
          language: lang ? lang.value : view.language,
          engine: engine ? engine.value : view.engine
        });
        health().then(function (up) {
          view.up = up;
          if (!up) view.note = "";
          return listVoices();
        }).then(function (rows) {
          view.voices = rows || [];
          paint(host);
        });
      }
      if (act === "save") {
        var file = host.querySelector("[data-local=file]");
        var name = host.querySelector("[data-local=name]");
        var said = host.querySelector("[data-local=said]");
        var picked = file && file.files && file.files[0];
        if (!picked) return;
        picked.arrayBuffer().then(function (buf) {
          var row = { id: "v" + Date.now().toString(36), name: (name && name.value) || tr("Voice"), transcript: (said && said.value) || "", bytes: buf, mime: picked.type || "audio/wav" };
          row.bytes = buf;
          return saveVoice(row);
        }).then(function () { return listVoices(); }).then(function (rows) {
          view.voices = rows || [];
          view.voiceId = view.voices.length ? view.voices[view.voices.length - 1].id : "";
          paint(host);
        });
      }
      if (act === "go") {
        var pick = host.querySelector("[data-local=pick]");
        var textBox = host.querySelector("[data-local=text]");
        var text = textBox ? textBox.value.trim() : "";
        var voice = view.voices.filter(function (item) { return item.id === (pick && pick.value); })[0];
        if (!voice || !text) return;
        view.text = text;
        var bytes = voice.bytes instanceof ArrayBuffer ? voice.bytes : null;
        var payload = { id: voice.id, transcript: voice.transcript || "", bytes: { arrayBuffer: function () { return Promise.resolve(bytes); } } };
        generate(payload, text).then(function (out) {
          if (view.clipUrl) URL.revokeObjectURL(view.clipUrl);
          view.clipUrl = URL.createObjectURL(out.blob);
          view.note = out.cached ? tr("Saved copy on this device. No new credits.") : tr("This line uses {engine}.", { engine: tr((out.plan && out.plan.engineName) || "Qwen3-TTS") });
          if (root.ViktorychConvert && root.ViktorychConvert.useLocalClip) root.ViktorychConvert.useLocalClip(out.blob);
          paint(host);
        }).catch(function (err) {
          view.up = err && err.code === "engine_not_installed";
          view.note = err && err.code === "engine_not_installed"
            ? tr("That engine is not installed on this computer.")
            : tr("The local voice server is not running.");
          paint(host);
        });
      }
    });
  }

  root.ViktorychLocalVoice = {
    desktop: desktop,
    enabled: enabled,
    html: html,
    mount: mount,
    health: health,
    generate: generate,
    saveVoice: saveVoice,
    listVoices: listVoices,
    readClip: readClip,
    origin: origin
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
