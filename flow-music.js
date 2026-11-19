/* Desktop Music tab. Talks only to a FlowMusic2API on this computer.
   Every finished song is also stored in this browser. */
(function (root) {
  "use strict";
  var DB = "viktorych-studio-songs-v1";
  var GATE = "viktorych-flowmusic-gate";
  var memory = [];

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
    var voice = root.ViktorychLocalVoice;
    if (voice && voice.desktop) return voice.desktop();
    if (!root.matchMedia) return false;
    return root.matchMedia("(min-width: 700px)").matches && root.matchMedia("(hover: hover) and (pointer: fine)").matches;
  }
  function gate() {
    try { return JSON.parse(localStorage.getItem(GATE) || "{}") || {}; }
    catch (err) { return {}; }
  }
  function saveGate(next) {
    var cur = gate();
    cur.port = String((next && next.port) || cur.port || "8000").replace(/[^\d]/g, "").slice(0, 5) || "8000";
    if (next && typeof next.token === "string" && next.token) cur.token = next.token.slice(0, 200);
    localStorage.setItem(GATE, JSON.stringify(cur));
  }
  function origin() {
    return "http://127.0.0.1:" + (gate().port || "8000");
  }
  function openDb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(DB, 1); }
      catch (err) { resolve(null); return; }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains("songs")) req.result.createObjectStore("songs", { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }
  function listSongs() {
    return openDb().then(function (db) {
      if (!db) return memory.slice();
      return new Promise(function (resolve) {
        var req = db.transaction("songs", "readonly").objectStore("songs").getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve(memory.slice()); };
      });
    });
  }
  function keepSong(song) {
    memory = memory.filter(function (row) { return row.id !== song.id; }).concat([song]);
    return openDb().then(function (db) {
      if (!db) return song;
      return new Promise(function (resolve) {
        var tx = db.transaction("songs", "readwrite");
        tx.objectStore("songs").put(song);
        tx.oncomplete = function () { resolve(song); };
        tx.onerror = function () { resolve(song); };
      });
    });
  }

  var view = { up: false, prompt: "", lyrics: "", instrumental: false, model: "lyria", songs: [], note: "", songsLoaded: false };

  function libraryNote() {
    return tr("Songs made here are also created in your Flow Music account, so they show in the Flow Music website library. This page keeps a copy too.");
  }

  function html() {
    if (!desktop()) {
      return "<section class=\"ac-block\" data-flow-root><h3>" + esc(tr("Music")) + "</h3><p class=\"ac-note\">" + esc(tr("Music on this computer is desktop only.")) + "</p></section>";
    }
    var guide = "https://github.com/ViktorychGroup/ViktorychApp1427446516/blob/main/docs/flow-music.md";
    var saved = gate();
    var rows = view.songs.map(function (song) {
      var src = song.url || "";
      return "<article class=\"ac-item\"><b>" + esc(song.title || tr("Song")) + "</b><span class=\"ac-meta\">" + esc(song.model || "") + "</span>" +
        (src ? "<audio controls src=\"" + esc(src) + "\"></audio>" : "") +
        (src ? "<a class=\"ac-link\" href=\"" + esc(src) + "\" download=\"" + esc(song.title || "audio") + ".mp3\">" + esc(tr("Download")) + "</a>" : "") +
        "</article>";
    }).join("");
    var down = view.up ? "" : "<p class=\"ac-note\" data-flow-down>" + esc(tr("The local music server is not running.")) + " <a href=\"" + guide + "\">" + esc(tr("Setup guide")) + "</a></p>";
    return "<section class=\"ac-block\" data-flow-root><h3>" + esc(tr("Music")) + "</h3>" +
      "<p class=\"ac-note\">" + esc(libraryNote()) + "</p>" + down +
      "<div class=\"ac-row\"><input class=\"ac-search\" data-flow=\"port\" inputmode=\"numeric\" aria-label=\"" + esc(tr("Port")) + "\" value=\"" + esc(saved.port || "8000") + "\">" +
      "<input class=\"ac-search\" data-flow=\"token\" type=\"password\" autocomplete=\"off\" aria-label=\"" + esc(tr("Local API key")) + "\" placeholder=\"" + esc(tr("Local API key")) + "\"></div>" +
      "<button class=\"ac-btn\" type=\"button\" data-flow=\"connect\">" + esc(tr("Connect")) + "</button>" +
      (view.up ? "<label class=\"ac-field\"><span>" + esc(tr("Prompt")) + "</span><textarea class=\"ac-box\" data-flow=\"prompt\">" + esc(view.prompt) + "</textarea></label>" +
        "<label class=\"ac-field\"><span>" + esc(tr("Lyrics")) + "</span><textarea class=\"ac-box\" data-flow=\"lyrics\" placeholder=\"[Verse]\n\n[Chorus]\">" + esc(view.lyrics) + "</textarea></label>" +
        "<label class=\"ac-row\"><input data-flow=\"inst\" type=\"checkbox\"" + (view.instrumental ? " checked" : "") + "> " + esc(tr("Instrumental")) + "</label>" +
        "<div class=\"ac-pills\"><button type=\"button\" class=\"ac-pill" + (view.model === "lyria" ? " on" : "") + "\" data-flow=\"model\" data-model=\"lyria\">Lyria 3.5</button>" +
        "<button type=\"button\" class=\"ac-pill" + (view.model === "lyria-pro" ? " on" : "") + "\" data-flow=\"model\" data-model=\"lyria-pro\">Lyria 3 Pro</button></div>" +
        "<button class=\"ac-btn primary\" type=\"button\" data-flow=\"go\">" + esc(tr("Generate")) + "</button>" : "") +
      (view.note ? "<p class=\"ac-note\">" + esc(view.note) + "</p>" : "") +
      "<h3>" + esc(tr("Songs on this device")) + "</h3>" + (rows || "<p class=\"ac-note\">" + esc(tr("No songs yet.")) + "</p>") +
      "</section>";
  }

  function promptBody() {
    var prompt = view.prompt.trim();
    if (view.instrumental) prompt = "[Instrumental]\n" + prompt;
    if (view.lyrics.trim()) prompt = prompt + "\n\n" + view.lyrics.trim();
    return { model: view.model, prompt: prompt };
  }

  function repaint(host) {
    var box = host.querySelector("[data-flow-root]");
    if (!box) return;
    box.outerHTML = html();
    mount(host);
  }

  function mount(host) {
    var slot = host.querySelector("[data-flow-root]") || host.querySelector("[data-local-voice]");
    var box = host.querySelector("[data-flow-root]");
    if (!box) {
      var holder = document.createElement("div");
      holder.innerHTML = html();
      var built = holder.firstElementChild;
      if (!built) return;
      host.querySelector(".ac").appendChild(built);
      box = built;
    }
    if (box.dataset.bound === "1") return;
    box.dataset.bound = "1";
    if (!view.songsLoaded) {
      view.songsLoaded = true;
      listSongs().then(function (rows) {
        view.songs = rows || [];
        repaint(host);
      });
    }
    box.addEventListener("click", function (event) {
      var node = event.target.closest("[data-flow]");
      if (!node) return;
      var act = node.getAttribute("data-flow");
      if (act === "model") { view.model = node.getAttribute("data-model") || "lyria"; box.outerHTML = html(); mount(host); return; }
      if (act === "connect") {
        var port = box.querySelector("[data-flow=port]");
        var token = box.querySelector("[data-flow=token]");
        saveGate({ port: port && port.value, token: token && token.value });
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, 2500);
        fetch(origin() + "/health", { headers: { Authorization: "Bearer " + (gate().token || "") }, signal: ctrl.signal }).then(function (res) {
          clearTimeout(timer);
          view.up = res.ok;
          view.note = view.up ? "" : tr("The local music server is not running.");
          box.outerHTML = html();
          mount(host);
        }).catch(function () {
          clearTimeout(timer);
          view.up = false;
          view.note = tr("The local music server is not running.");
          box.outerHTML = html();
          mount(host);
        });
      }
      if (act === "go") {
        view.prompt = (box.querySelector("[data-flow=prompt]") || {}).value || "";
        view.lyrics = (box.querySelector("[data-flow=lyrics]") || {}).value || "";
        view.instrumental = !!((box.querySelector("[data-flow=inst]") || {}).checked);
        var body = promptBody();
        if (!body.prompt.trim()) return;
        fetch(origin() + "/v1/music/generations", {
          method: "POST",
          headers: { Authorization: "Bearer " + (gate().token || ""), "content-type": "application/json" },
          body: JSON.stringify(body)
        }).then(function (res) { if (!res.ok) throw new Error("music"); return res.json(); }).then(function (payload) {
          var clips = payload.clips || payload.data || [];
          var jobs = clips.map(function (clip) {
            var song = {
              id: String(clip.id || clip.clip_id || ("s" + Date.now())),
              title: clip.title || tr("Song"),
              model: view.model,
              url: clip.audio_url || clip.url || "",
              at: Date.now()
            };
            return keepSong(song);
          });
          return Promise.all(jobs);
        }).then(function () { return listSongs(); }).then(function (rows) {
          view.songs = rows || [];
          view.note = libraryNote();
          box.outerHTML = html();
          mount(host);
        }).catch(function () {
          view.up = false;
          view.note = tr("The local music server is not running.");
          box.outerHTML = html();
          mount(host);
        });
      }
    });
  }

  root.ViktorychFlowMusic = { desktop: desktop, html: html, mount: mount, keepSong: keepSong, listSongs: listSongs, libraryNote: libraryNote };
})(typeof globalThis !== "undefined" ? globalThis : this);
