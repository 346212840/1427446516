/* Saved Fish Audio clips on this device. A repeat of the same voice, text
   and settings is replayed from here and does not call the API again. */
(function (root) {
  "use strict";
  var DB = "viktorych-fish-tts-v1";
  var STORE = "clips";
  var memory = new Map();
  var LONG = 400;

  function keyFor(spec) {
    var raw = [
      String(spec && spec.voice || ""),
      String(spec && spec.text || ""),
      String(spec && spec.format || "opus"),
      String(spec && spec.speed != null ? spec.speed : 1),
      String(spec && spec.latency || "normal")
    ].join("\n");
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)).then(function (buf) {
      return Array.from(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }

  function openDb() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(DB, 1); }
      catch (err) { resolve(null); return; }
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }

  function remember(spec, blob) {
    return keyFor(spec).then(function (key) {
      return blob.arrayBuffer().then(function (bytes) {
        var row = { bytes: bytes, mime: blob.type || "application/octet-stream", name: spec.name || "voice", at: Date.now() };
        memory.set(key, row);
        return openDb().then(function (db) {
          if (!db) return key;
          return new Promise(function (resolve) {
            var tx = db.transaction(STORE, "readwrite");
            tx.objectStore(STORE).put(row, key);
            tx.oncomplete = function () { resolve(key); };
            tx.onerror = function () { resolve(key); };
          });
        });
      });
    });
  }

  function read(spec) {
    return keyFor(spec).then(function (key) {
      var local = memory.get(key);
      if (local) return blobOf(local);
      return openDb().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE, "readonly");
          var req = tx.objectStore(STORE).get(key);
          req.onsuccess = function () {
            if (!req.result) { resolve(null); return; }
            memory.set(key, req.result);
            resolve(blobOf(req.result));
          };
          req.onerror = function () { resolve(null); };
        });
      });
    });
  }

  function blobOf(row) {
    if (!row || !row.bytes) return null;
    return { blob: new Blob([row.bytes], { type: row.mime || "application/octet-stream" }), name: row.name || "voice" };
  }

  function needsConfirm(text) {
    return String(text || "").length >= LONG;
  }

  root.ViktorychFishCache = {
    keyFor: keyFor,
    remember: remember,
    read: read,
    needsConfirm: needsConfirm,
    LONG: LONG
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
