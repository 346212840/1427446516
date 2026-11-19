/* Optional "send as my Telegram account". The session stays in this browser.
   Tests pass window.ViktorychTgMock and never load the real library. */
(function (root) {
  "use strict";
  var KEY = "viktorych-tg-account-v1";
  var waitUntil = 0;

  function tr(key, vars) {
    var fn = root.t;
    return fn ? fn(key, vars) : key;
  }
  function on() {
    if (root.ViktorychServerFeature && !root.ViktorychServerFeature("telegram_account_send")) {
      var at = 0;
      try { at = Number(localStorage.getItem("viktorychapp-server-off-at")) || 0; } catch (err) { at = 0; }
      if (at > 0) return false;
    }
    return true;
  }
  function floodWait() {
    return Math.max(0, waitUntil - Date.now());
  }
  function noteFlood(seconds) {
    var n = Math.max(1, Number(seconds) || 1);
    waitUntil = Date.now() + n * 1000;
    return n;
  }
  function loadLib() {
    if (root.ViktorychTgMock) return Promise.resolve(root.ViktorychTgMock);
    return import("./vendor/gramjs/telegram.js");
  }
  function session() {
    try { return sessionStorage.getItem(KEY) || ""; }
    catch (err) { return ""; }
  }
  function saveSession(value) {
    try {
      if (value) sessionStorage.setItem(KEY, value);
      else sessionStorage.removeItem(KEY);
    } catch (err) { /* private mode */ }
  }
  function send(blob, caption) {
    if (floodWait() > 0) return Promise.reject(Object.assign(new Error("flood"), { code: "flood", wait: floodWait() }));
    return loadLib().then(function (lib) {
      if (lib && lib.sendVoice) return lib.sendVoice(blob, caption || "");
      return Promise.reject(new Error("library"));
    }).then(function (out) {
      if (out && out.flood) {
        noteFlood(out.flood);
        throw Object.assign(new Error("flood"), { code: "flood", wait: out.flood * 1000 });
      }
      return out || { ok: true };
    });
  }
  function signOut() {
    saveSession("");
    var lib = root.ViktorychTgMock;
    if (lib && lib.logOut) return Promise.resolve(lib.logOut()).then(function () { return true; });
    return Promise.resolve(true);
  }
  root.ViktorychTgAccount = {
    on: on,
    floodWait: floodWait,
    noteFlood: noteFlood,
    send: send,
    signOut: signOut,
    session: session,
    saveSession: saveSession,
    tr: tr
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
