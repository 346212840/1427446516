/* Audio Studio. Convert, voice notes, and Type to voice. Fish previews play the model's
   sample. Generate is the only Fish credit spend, and a repeat is local. */
(function (root) {
  "use strict";
  var plan = function () { return root.AudioConvertPlan; };
  var cache = function () { return root.ViktorychFishCache; };
  var TABS = [
    { id: "convert", label: "Convert" },
    { id: "voice", label: "Voice Notes" },
    { id: "type", label: "Type to Voice" },
    { id: "music", label: "Music" }
  ];
  var state = {
    mode: "convert",
    text: "",
    voices: [],
    voiceId: "",
    format: "opus",
    speed: 1,
    latency: "normal",
    configured: false,
    loaded: false,
    confirm: false,
    note: "",
    clip: null,
    fromCache: false,
    busy: false
  };

  function tr(key, vars) {
    var fn = root.t;
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value || "").replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch];
    });
  }
  function owner() {
    var api = root.ViktorychAccounts;
    var account = api && api.account ? api.account() : null;
    return !!(account && account.owner && api.token && api.token());
  }
  function fishOn() {
    return !!(root.ViktorychServerFeature && root.ViktorychServerFeature("fish_audio"));
  }
  function apiBase() {
    var accounts = root.ViktorychAccounts;
    var cur = accounts && accounts.currentApi ? accounts.currentApi() : "";
    if (!cur && root.VIKTORYCH_ACCOUNTS) cur = root.VIKTORYCH_ACCOUNTS.api || "";
    return String(cur || "").replace(/\/$/, "");
  }
  function token() {
    var accounts = root.ViktorychAccounts;
    return accounts && accounts.token ? accounts.token() : "";
  }
  function spec() {
    return { voice: state.voiceId, text: state.text.trim(), format: state.format, speed: Number(state.speed) || 1, latency: state.latency, name: "typed-voice." + (state.format === "wav" ? "wav" : state.format === "mp3" ? "mp3" : "ogg") };
  }
  function paint() {
    var rootEl = document.getElementById("ac-root");
    if (!rootEl) return;
    rootEl.innerHTML = html({ tab: state.mode });
    bind(rootEl);
    if (root.ViktorychLocalVoice) root.ViktorychLocalVoice.mount(rootEl);
  }
  function studioName() {
    var bag = root.ViktorychAudioStudio;
    return tr(bag && bag.name ? bag.name : "Audio Studio");
  }
  function tabId(route) {
    var id = route && route.tab;
    return TABS.some(function (tab) { return tab.id === id; }) ? id : "convert";
  }
  function tabsHtml(current) {
    return "<div class=\"ac-pills\" role=\"tablist\">" + TABS.map(function (tab) {
      var on = tab.id === current ? " on\" aria-selected=\"true" : "\" aria-selected=\"false";
      return "<a class=\"ac-pill" + on + "\" role=\"tab\" href=\"#/studio/" + tab.id + "\">" + esc(tr(tab.label)) + "</a>";
    }).join("") + "</div>";
  }
  function html(route) {
    var count = state.text.length;
    var long = cache() && cache().needsConfirm(state.text.trim());
    var voices = state.voices.map(function (voice) {
      var on = voice.id === state.voiceId ? " on" : "";
      var preview = voice.previewUrl ? "<audio controls preload=\"none\" src=\"" + esc(voice.previewUrl) + "\"></audio>" : "";
      return "<button class=\"ac-pill" + on + "\" type=\"button\" data-ac=\"voice\" data-id=\"" + esc(voice.id) + "\">" + esc(voice.title || tr("Voice")) + "</button>" + preview;
    }).join("");
    var fish = "";
    if (owner() && fishOn()) {
      fish = "<section class=\"ac-block\"><h3>" + esc(tr("Type to voice")) + "</h3>" +
        (state.configured ? "" : "<p class=\"ac-note\">" + esc(tr("Fish Audio is not configured yet.")) + "</p>") +
        "<textarea class=\"ac-box\" data-ac=\"text\" maxlength=\"2000\">" + esc(state.text) + "</textarea>" +
        "<p class=\"ac-note\" data-ac=\"count\">" + esc(tr("About {n} characters. A new generation spends Fish Audio credits. A saved copy does not.", { n: String(count) })) + "</p>" +
        "<div class=\"ac-pills\">" + voices + "</div>" +
        "<div class=\"ac-row\">" +
        ["opus", "mp3", "wav"].map(function (fmt) { return "<button class=\"ac-pill" + (state.format === fmt ? " on" : "") + "\" type=\"button\" data-ac=\"fmt\" data-fmt=\"" + fmt + "\">" + fmt + "</button>"; }).join("") +
        "</div>" +
        (state.confirm ? "<p class=\"ac-note\">" + esc(tr("Generate this text? It spends Fish Audio credits.")) + "</p><button class=\"ac-btn primary\" type=\"button\" data-ac=\"gen\" data-ok=\"1\">" + esc(tr("Generate")) + "</button>" : "<button class=\"ac-btn primary\" type=\"button\" data-ac=\"gen\"" + (state.busy ? " disabled" : "") + ">" + esc(tr("Generate")) + "</button>") +
        (state.note ? "<p class=\"ac-note\">" + esc(state.note) + "</p>" : "") +
        (state.clip ? "<audio controls src=\"" + state.clip.url + "\"></audio><div class=\"ac-row\"><a class=\"ac-link\" download=\"" + esc(state.clip.name) + "\" href=\"" + state.clip.url + "\">" + esc(tr("Download")) + "</a><a class=\"ac-link\" href=\"https://vk.com/im\" target=\"_blank\" rel=\"noopener\">" + esc(tr("Open VK")) + "</a></div><p class=\"ac-note\">" + esc(tr("VK gets an audio file, not a voice message.")) + "</p>" : "") +
        "</section>";
    }
    var current = tabId(route || { tab: state.mode });
    state.mode = current;
    var local = current === "type" && root.ViktorychLocalVoice ? root.ViktorychLocalVoice.html() : "";
    var music = current === "music" && root.ViktorychFlowMusic ? root.ViktorychFlowMusic.html() : "";
    var files = root.ViktorychStudioFiles;
    var convert = current === "convert" && files ? files.html("convert") : "";
    var voice = current === "voice" && files ? files.html("voice") : "";
    var type = current === "type" ? fish + local : "";
    return "<div class=\"ac\"><h2 class=\"ac-title\">" + esc(studioName()) + "</h2>" + tabsHtml(current) + convert + voice + type + music + "</div>";
  }

  function useClip(blob, name, fromCache) {
    if (state.clip && state.clip.url) URL.revokeObjectURL(state.clip.url);
    var file = blob instanceof Blob ? blob : blob.blob;
    state.clip = { url: URL.createObjectURL(file), name: name, blob: file };
    state.fromCache = !!fromCache;
    state.note = fromCache ? tr("Saved copy on this device. No new credits.") : "";
    state.confirm = false;
    state.busy = false;
    paint();
  }

  function generate(confirmed) {
    var now = spec();
    if (!now.text || !now.voice) return;
    state.busy = true;
    state.note = "";
    cache().read(now).then(function (hit) {
      if (hit) { useClip(hit.blob, hit.name || now.name, true); return; }
      if (cache().needsConfirm(now.text) && !confirmed) {
        state.busy = false;
        state.confirm = true;
        paint();
        return;
      }
      var base = apiBase();
      return fetch(base + "/v1/owner/fish/tts", {
        method: "POST",
        headers: { Authorization: "Bearer " + token(), "content-type": "application/json" },
        body: JSON.stringify({ text: now.text, referenceId: now.voice, format: now.format, speed: now.speed, latency: now.latency })
      }).then(function (res) {
        if (res.status === 402) throw new Error("quota");
        if (!res.ok) throw new Error("fail");
        return res.blob();
      }).then(function (blob) {
        return cache().remember(now, blob).then(function () { useClip(blob, now.name, false); });
      });
    }).catch(function (err) {
      state.busy = false;
      state.note = err && err.message === "quota" ? tr("Quota is used up.") : tr("Could not generate speech.");
      paint();
    });
  }

  function loadVoices() {
    if (!owner() || !fishOn()) return;
    var base = apiBase();
    fetch(base + "/v1/owner/fish", { headers: { Authorization: "Bearer " + token() } }).then(function (res) { return res.ok ? res.json() : { configured: false }; }).then(function (body) {
      state.configured = !!(body && body.configured);
      if (!state.configured) { state.loaded = true; paint(); return null; }
      return fetch(base + "/v1/owner/fish/voices", { headers: { Authorization: "Bearer " + token() } }).then(function (res) { return res.ok ? res.json() : { voices: [] }; });
    }).then(function (body) {
      if (!body) return;
      state.voices = body.voices || [];
      if (!state.voiceId && state.voices[0]) state.voiceId = state.voices[0].id;
      state.loaded = true;
      paint();
    }).catch(function () { state.loaded = true; paint(); });
  }

  function bind(el) {
    var box = el.querySelector("[data-ac=text]");
    if (box && box.dataset.bound !== "1") {
      box.dataset.bound = "1";
      box.addEventListener("input", function () {
        state.text = box.value;
        state.confirm = false;
        var note = el.querySelector("[data-ac=count]");
        if (note) note.textContent = tr("About {n} characters. A new generation spends Fish Audio credits. A saved copy does not.", { n: String(box.value.length) });
      });
    }
    if (el.dataset.click === "1") return;
    el.dataset.click = "1";
    el.addEventListener("click", function (event) {
      var node = event.target.closest("[data-ac]");
      if (!node) return;
      var act = node.getAttribute("data-ac");
      if (act === "voice") { state.voiceId = node.getAttribute("data-id") || ""; state.confirm = false; paint(); }
      if (act === "fmt") { state.format = node.getAttribute("data-fmt") || "opus"; state.confirm = false; paint(); }
      if (act === "gen") generate(node.getAttribute("data-ok") === "1");
    });
  }

  function page(route) {
    state.mode = tabId(route);
    return "<div id=\"ac-root\" data-tab=\"" + esc(state.mode) + "\"></div>";
  }
  function mount(route) {
    state.mode = tabId(route);
    var el = document.getElementById("ac-root");
    if (!el) return;
    el.innerHTML = html(route);
    bind(el);
    if (state.mode === "type") {
      if (root.ViktorychLocalVoice) root.ViktorychLocalVoice.mount(el);
      loadVoices();
    }
    if (state.mode === "music" && root.ViktorychFlowMusic) root.ViktorychFlowMusic.mount(el);
    if ((state.mode === "convert" || state.mode === "voice") && root.ViktorychStudioFiles) root.ViktorychStudioFiles.mount(el);
  }
  function unmount() {}
  function useLocalClip(blob) {
    state.clip = { url: URL.createObjectURL(blob), name: "local-voice.wav", blob: blob };
    state.note = "";
    if (state.mode === "type") paint();
  }

  root.ViktorychConvert = { page: page, mount: mount, unmount: unmount, spec: spec, generate: generate, useLocalClip: useLocalClip };
})(typeof globalThis !== "undefined" ? globalThis : this);
