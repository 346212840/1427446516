/* Optional "send as my Telegram account". Off until the owner turns
   telegram_account_send on. The app id, app hash and session stay in this
   browser, sealed with AES-GCM. Tests pass window.ViktorychTgMock and never
   load the real library. */
(function (root) {
  "use strict";
  var DB = "viktorych-tg-account-v1";
  var OLD_KEY = "viktorych-tg-account-v1";
  var waitUntil = 0;
  var state = {
    step: "app",
    vault: null,
    client: null,
    lib: null,
    phone: "",
    phoneCodeHash: "",
    sending: false
  };

  function tr(key) {
    var fn = root.t;
    return fn ? fn(key) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch];
    });
  }
  function fail(code) {
    return Object.assign(new Error(code), { code: code });
  }
  function on() {
    return !!(root.ViktorychServerFeature && root.ViktorychServerFeature("telegram_account_send"));
  }
  function floodWait() {
    return Math.max(0, waitUntil - Date.now());
  }
  function noteFlood(seconds) {
    var n = Math.max(1, Number(seconds) || 1);
    waitUntil = Date.now() + n * 1000;
    return n;
  }
  function floodSeconds(err) {
    if (!err) return 0;
    if (typeof err.seconds === "number" && err.seconds > 0) return err.seconds;
    var msg = String(err.errorMessage || err.message || "");
    var match = /FLOOD_WAIT_(\d+)/.exec(msg);
    return match ? Number(match[1]) : 0;
  }
  function asFlood(err) {
    var secs = floodSeconds(err);
    if (!secs) return null;
    noteFlood(secs);
    return Object.assign(fail("flood"), { wait: secs * 1000 });
  }
  function isPassword(err) {
    return String((err && (err.errorMessage || err.message)) || "").indexOf("SESSION_PASSWORD_NEEDED") >= 0;
  }
  function isSignup(result) {
    return String((result && (result.className || result._)) || "").indexOf("SignUpRequired") >= 0;
  }
  function scrub() {
    try { root.sessionStorage.removeItem(OLD_KEY); } catch (err) { /* private mode */ }
  }
  function loadLib() {
    if (root.ViktorychTgMock) return Promise.resolve(root.ViktorychTgMock);
    if (state.lib) return Promise.resolve(state.lib);
    return import("./vendor/gramjs/telegram.js").then(function (mod) {
      state.lib = mod;
      return mod;
    });
  }
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || fail("auth")); };
    });
  }
  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction("kv", "readonly").objectStore("kv").get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || fail("auth")); };
      });
    });
  }
  function idbSet(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req = db.transaction("kv", "readwrite").objectStore("kv").put(value, key);
        req.onsuccess = function () { resolve(true); };
        req.onerror = function () { reject(req.error || fail("auth")); };
      });
    });
  }
  function bytesToB64(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(text) {
    var bin = atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function aesKey() {
    return idbGet("key").then(function (key) {
      if (key) return key;
      return root.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]).then(function (made) {
        return idbSet("key", made).then(function () { return made; });
      });
    });
  }
  function writeVault(data) {
    var payload = {
      apiId: String(data.apiId || ""),
      apiHash: String(data.apiHash || ""),
      session: String(data.session || "")
    };
    return aesKey().then(function (key) {
      var iv = root.crypto.getRandomValues(new Uint8Array(12));
      return root.crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(JSON.stringify(payload))).then(function (ct) {
        return idbSet("vault", { iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ct)) });
      });
    });
  }
  function readVault() {
    return idbGet("vault").then(function (row) {
      if (!row || !row.iv || !row.ct) return { apiId: "", apiHash: "", session: "" };
      return aesKey().then(function (key) {
        return root.crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(row.iv) }, key, b64ToBytes(row.ct)).then(function (buf) {
          var data = JSON.parse(new TextDecoder().decode(buf));
          return { apiId: String(data.apiId || ""), apiHash: String(data.apiHash || ""), session: String(data.session || "") };
        }).catch(function () { return { apiId: "", apiHash: "", session: "" }; });
      });
    }).catch(function () { return { apiId: "", apiHash: "", session: "" }; });
  }
  function loadVault() {
    if (state.vault) return Promise.resolve(state.vault);
    return readVault().then(function (vault) {
      state.vault = vault;
      return vault;
    });
  }
  function connect(vault) {
    return loadLib().then(function (lib) {
      state.lib = lib;
      if (typeof lib.createClient === "function") {
        return Promise.resolve(lib.createClient({
          apiId: vault.apiId,
          apiHash: vault.apiHash,
          session: vault.session || ""
        })).then(function (client) {
          state.client = client;
          return client;
        });
      }
      var client = new lib.TelegramClient(new lib.StringSession(vault.session || ""), Number(vault.apiId), vault.apiHash, {
        connectionRetries: 2,
        requestRetries: 1,
        useWSS: true,
        floodSleepThreshold: 0,
        autoReconnect: false,
        deviceModel: "ViktorychApp",
        appVersion: "1.0"
      });
      return client.connect().then(function () {
        state.client = client;
        return client;
      });
    });
  }
  function requestSignIn(client, lib, phone, hash, code) {
    if (typeof client.signInCode === "function") return client.signInCode({ phone: phone, hash: hash, code: code });
    return client.invoke(new lib.Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
  }
  function requestPassword(client, creds, password) {
    if (typeof client.checkPassword === "function") return client.checkPassword(password);
    return client.signInWithPassword(creds, {
      password: function () { return Promise.resolve(password); },
      onError: function () { return Promise.resolve(true); }
    });
  }
  function requestLogout(client, lib) {
    if (typeof client.logOut === "function") return Promise.resolve(client.logOut());
    return client.invoke(new lib.Api.auth.LogOut({}));
  }
  function persist(client) {
    var saved = "";
    if (client.session && typeof client.session.save === "function") saved = client.session.save();
    else if (typeof client.sessionString === "string") saved = client.sessionString;
    if (!saved) return Promise.reject(fail("auth"));
    var vault = state.vault || {};
    state.vault = { apiId: vault.apiId, apiHash: vault.apiHash, session: saved };
    state.phone = "";
    state.phoneCodeHash = "";
    state.step = "ready";
    return writeVault(state.vault);
  }
  function saveApp(apiId, apiHash) {
    apiId = String(apiId || "").trim();
    apiHash = String(apiHash || "").trim();
    if (!/^\d{3,12}$/.test(apiId) || !/^[A-Za-z0-9]{8,64}$/.test(apiHash)) return Promise.reject(fail("auth"));
    state.client = null;
    state.phone = "";
    state.phoneCodeHash = "";
    state.vault = { apiId: apiId, apiHash: apiHash, session: "" };
    state.step = "phone";
    return writeVault(state.vault).then(function () { return { step: "phone" }; });
  }
  function beginPhone(phone) {
    var digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 5 || digits.length > 15) return Promise.reject(fail("auth"));
    return loadVault().then(function (vault) {
      if (!vault.apiId || !vault.apiHash) return Promise.reject(fail("auth"));
      return connect(vault).then(function (client) {
        return client.sendCode({ apiId: Number(vault.apiId), apiHash: vault.apiHash }, "+" + digits, false);
      }).then(function (sent) {
        if (!sent || typeof sent.phoneCodeHash !== "string" || !sent.phoneCodeHash) return Promise.reject(fail("auth"));
        state.phone = "+" + digits;
        state.phoneCodeHash = sent.phoneCodeHash;
        state.step = "code";
        return { step: "code" };
      }).catch(function (err) {
        if (err && err.code) throw err;
        var flood = asFlood(err);
        if (flood) throw flood;
        throw fail("auth");
      });
    });
  }
  function submitCode(code) {
    code = String(code || "").trim();
    if (!/^\d{4,8}$/.test(code)) return Promise.reject(fail("auth"));
    if (!state.client || !state.phone || !state.phoneCodeHash) return Promise.reject(fail("auth"));
    return loadLib().then(function (lib) {
      return requestSignIn(state.client, lib, state.phone, state.phoneCodeHash, code);
    }).then(function (result) {
      if (isSignup(result)) return Promise.reject(fail("auth"));
      return persist(state.client).then(function () { return { step: "ready" }; });
    }).catch(function (err) {
      if (isPassword(err)) {
        state.step = "password";
        return { step: "password" };
      }
      if (err && err.code) throw err;
      var flood = asFlood(err);
      if (flood) throw flood;
      throw fail("auth");
    });
  }
  function submitPassword(password) {
    password = String(password || "");
    if (!password.trim() || !state.client) return Promise.reject(fail("auth"));
    return loadVault().then(function (vault) {
      return requestPassword(state.client, { apiId: Number(vault.apiId), apiHash: vault.apiHash }, password);
    }).then(function () {
      return persist(state.client).then(function () { return { step: "ready" }; });
    }).catch(function (err) {
      if (err && err.code) throw err;
      var flood = asFlood(err);
      if (flood) throw flood;
      throw fail("auth");
    });
  }
  function prepare() {
    scrub();
    if (!on()) {
      state.step = "off";
      return Promise.resolve("off");
    }
    return loadVault().then(function (vault) {
      if (!vault.apiId || !vault.apiHash) state.step = "app";
      else if (!vault.session && state.step !== "code" && state.step !== "password") state.step = "phone";
      else if (vault.session) state.step = "ready";
      return state.step;
    });
  }
  function packWaveform(samples) {
    var out = [];
    var bitbuffer = 0;
    var bits = 0;
    var i;
    for (i = 0; i < samples.length; i++) {
      bitbuffer |= (samples[i] & 31) << bits;
      bits += 5;
      while (bits >= 8) {
        out.push(bitbuffer & 255);
        bitbuffer >>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) out.push(bitbuffer & 255);
    return new Uint8Array(out);
  }
  function barsFrom(bytes) {
    var bars = new Uint8Array(100);
    var n = bytes.length || 1;
    var i;
    for (i = 0; i < 100; i++) {
      var start = Math.floor(i * n / 100);
      var end = Math.max(start + 1, Math.floor((i + 1) * n / 100));
      var peak = 0;
      var j;
      for (j = start; j < end && j < n; j++) {
        var v = Math.abs(bytes[j] - 128);
        if (v > peak) peak = v;
      }
      bars[i] = Math.min(31, Math.round(peak / 8));
    }
    return bars;
  }
  function voicePayload(lib, blob) {
    return blob.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      var duration = Math.max(1, Math.round(bytes.length * 8 / 64000));
      var waveform = packWaveform(barsFrom(bytes));
      var packed = typeof root.Buffer !== "undefined" ? root.Buffer.from(waveform) : waveform;
      var attr = lib && lib.Api && lib.Api.DocumentAttributeAudio
        ? new lib.Api.DocumentAttributeAudio({ voice: true, duration: duration, waveform: packed })
        : { voice: true, duration: duration, waveform: packed };
      var FileCtor = root.File || root.Blob;
      return {
        file: new FileCtor([bytes], "voice.ogg", { type: "audio/ogg" }),
        voiceNote: true,
        workers: 1,
        attributes: [attr]
      };
    });
  }
  function ensureClient() {
    return loadVault().then(function (vault) {
      if (!vault.session) return Promise.reject(fail("auth"));
      if (state.client) return Promise.resolve(state.client);
      return connect(vault).then(function (client) {
        if (typeof client.checkAuthorization !== "function") return client;
        return client.checkAuthorization().then(function (ok) {
          if (ok) return client;
          state.vault = { apiId: vault.apiId, apiHash: vault.apiHash, session: "" };
          state.step = "phone";
          state.client = null;
          return writeVault(state.vault).then(function () { return Promise.reject(fail("auth")); });
        });
      });
    });
  }
  function send(blob, caption, peer) {
    if (state.sending) return Promise.reject(fail("busy"));
    if (floodWait() > 0) return Promise.reject(Object.assign(fail("flood"), { wait: floodWait() }));
    peer = String(peer || "").trim();
    if (!peer || !blob) return Promise.reject(fail("peer"));
    state.sending = true;
    return loadLib().then(function (lib) {
      return ensureClient().then(function (client) {
        return voicePayload(lib, blob).then(function (payload) {
          payload.caption = caption || "";
          return client.sendFile(peer, payload);
        });
      });
    }).then(function (out) {
      return out || { ok: true };
    }).catch(function (err) {
      var flood = asFlood(err);
      if (flood) throw flood;
      if (err && err.code) throw err;
      throw fail("auth");
    }).finally(function () { state.sending = false; });
  }
  function signOut() {
    return loadVault().then(function (vault) {
      function wipe() {
        state.phone = "";
        state.phoneCodeHash = "";
        state.client = null;
        state.step = vault.apiId ? "phone" : "app";
        state.vault = { apiId: vault.apiId || "", apiHash: vault.apiHash || "", session: "" };
        return writeVault(state.vault).then(function () { return true; });
      }
      var getting = state.client
        ? Promise.resolve(state.client)
        : (vault.session ? connect(vault).catch(function () { return null; }) : Promise.resolve(null));
      return getting.then(function (client) {
        if (!client) return wipe();
        return loadLib().then(function (lib) {
          return Promise.resolve(requestLogout(client, lib)).catch(function () { return null; });
        }).then(function () {
          if (client.disconnect) return Promise.resolve(client.disconnect()).catch(function () { return null; });
          return null;
        }).then(wipe);
      });
    });
  }
  function field(label, name, type) {
    return "<label class=\"ac-field\"><span>" + esc(label) + "</span><input class=\"ac-search\" data-tg-field=\"" + name + "\" type=\"" + type + "\" autocomplete=\"off\"></label>";
  }
  function markup() {
    if (!on() || state.step === "off") return "";
    var status = "<p class=\"ac-note\" data-tg-status></p>";
    if (state.step === "ready") {
      return "<p class=\"ac-note\">" + esc(tr("Signed in on this device.")) + "</p>" +
        "<button type=\"button\" class=\"ac-btn\" data-tg=\"out\">" + esc(tr("Sign out")) + "</button>";
    }
    if (state.step === "password") {
      return field(tr("Two-factor password"), "password", "password") + status +
        "<button type=\"button\" class=\"ac-btn\" data-tg=\"password\">" + esc(tr("Sign in")) + "</button>";
    }
    if (state.step === "code") {
      return field(tr("Login code"), "code", "text") + status +
        "<button type=\"button\" class=\"ac-btn\" data-tg=\"code\">" + esc(tr("Sign in")) + "</button>";
    }
    if (state.step === "phone") {
      return "<p class=\"ac-note\">" + esc(tr("Create the app id on my.telegram.org. It stays on this device.")) + "</p>" +
        field(tr("Phone number"), "phone", "tel") + status +
        "<button type=\"button\" class=\"ac-btn\" data-tg=\"phone\">" + esc(tr("Sign in")) + "</button>";
    }
    return "<p class=\"ac-note\">" + esc(tr("Create the app id on my.telegram.org. It stays on this device.")) + "</p>" +
      field(tr("App id"), "apiId", "text") + field(tr("App hash"), "apiHash", "password") + status +
      "<button type=\"button\" class=\"ac-btn\" data-tg=\"app\">" + esc(tr("Save on this device")) + "</button>";
  }
  function paintBoxes() {
    if (!root.document) return;
    var list = root.document.querySelectorAll("[data-tg-box]");
    var i;
    for (i = 0; i < list.length; i++) list[i].innerHTML = markup();
  }
  function bind(box) {
    if (box.dataset.tgBound === "1") return;
    box.dataset.tgBound = "1";
    box.addEventListener("click", function (event) {
      var button = event.target.closest("[data-tg]");
      if (!button || button.disabled) return;
      var act = button.getAttribute("data-tg");
      function value(name) {
        var input = box.querySelector("[data-tg-field=\"" + name + "\"]");
        return input ? String(input.value || "").trim() : "";
      }
      var job = null;
      if (act === "app") job = saveApp(value("apiId"), value("apiHash"));
      if (act === "phone") job = beginPhone(value("phone"));
      if (act === "code") job = submitCode(value("code"));
      if (act === "password") job = submitPassword(value("password"));
      if (act === "out") job = signOut();
      if (!job) return;
      button.disabled = true;
      job.then(function () { paintBoxes(); }).catch(function (err) {
        button.disabled = false;
        var note = box.querySelector("[data-tg-status]");
        if (note) note.textContent = err && err.code === "flood" ? tr("Retry") : tr("Could not sign in.");
      });
    });
  }
  function attach(box) {
    if (!box || !on()) return;
    bind(box);
    prepare().then(function () { box.innerHTML = markup(); }).catch(function () {
      var note = box.querySelector("[data-tg-status]");
      if (note) note.textContent = tr("Could not sign in.");
    });
  }
  function signedIn() {
    return state.step === "ready" && !!(state.vault && state.vault.session);
  }

  root.ViktorychTgAccount = {
    on: on,
    floodWait: floodWait,
    noteFlood: noteFlood,
    send: send,
    signOut: signOut,
    signedIn: signedIn,
    step: function () { return state.step; },
    saveApp: saveApp,
    beginPhone: beginPhone,
    submitCode: submitCode,
    submitPassword: submitPassword,
    prepare: prepare,
    markup: markup,
    attach: attach,
    packWaveform: packWaveform
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
