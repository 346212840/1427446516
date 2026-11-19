/* Language routing for Local voice. Keep the same decisions in
   scripts/local_voice_route.py. Official lists are in docs/local-voice.md. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ViktorychLocalVoiceRoute = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var OWNER = ["en", "es", "sv", "ca", "ru"];
  var QWEN = { en: 1, es: 1, ru: 1 };
  var FISH = { en: 1, es: 1, ru: 1 };
  var OMNI = { en: 1, es: 1, sv: 1, ca: 1, ru: 1 };
  var NAMES = { qwen: "Qwen3-TTS", omnivoice: "OmniVoice", fish: "Fish-Speech 1.5" };

  function supports(engine, language) {
    var table = engine === "qwen" ? QWEN : engine === "fish" ? FISH : engine === "omnivoice" ? OMNI : null;
    return !!(table && table[language]);
  }

  function words(text) {
    var padded = (" " + String(text || "").toLowerCase().replace(/[.,!?¿¡;:()"“”]+/g, " ") + " ").replace(/\s+/g, " ");
    return function (list) {
      var n = 0;
      list.forEach(function (word) {
        var needle = " " + word + " ";
        var from = 0;
        while (padded.indexOf(needle, from) >= 0) {
          n += 1;
          from = padded.indexOf(needle, from) + needle.length;
        }
      });
      return n;
    };
  }

  function detect(text) {
    var raw = String(text || "");
    if (!raw.trim()) return "en";
    var letters = 0;
    var cyr = 0;
    var i;
    for (i = 0; i < raw.length; i++) {
      var code = raw.charCodeAt(i);
      if (code >= 0x0400 && code <= 0x04ff) cyr += 1;
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 0x0400 && code <= 0x04ff) || "àáâäåèéêëìíîïòóôöùúûüñç·".indexOf(raw[i].toLowerCase()) >= 0) letters += 1;
    }
    if (cyr >= 2 && cyr / (letters || 1) > 0.2) return "ru";
    var low = raw.toLowerCase();
    if (/[åäö]/.test(low)) return "sv";
    var hit = words(low);
    var scores = { sv: 0, ca: 0, es: 0, en: 0 };
    scores.sv += hit(["och", "att", "inte", "jag", "också", "hej", "svenska", "för"]) * 2;
    if (low.indexOf("ç") >= 0 || low.indexOf("·") >= 0) scores.ca += 3;
    scores.ca += hit(["és", "amb", "però", "això", "també", "català", "doncs", "després", "vosaltres", "aquesta", "aquest", "molt"]) * 2;
    if (low.indexOf("ñ") >= 0 || raw.indexOf("¿") >= 0 || raw.indexOf("¡") >= 0) scores.es += 3;
    scores.es += hit(["también", "pero", "porque", "está", "hola", "gracias", "usted", "qué", "español", "los", "las", "del", "por", "con", "para"]);
    scores.en += hit(["the", "and", "you", "this", "that", "with", "from", "have", "hello", "english"]);
    var best = "en";
    var bestScore = -1;
    var rank = { en: 3, es: 2, ca: 1, sv: 0 };
    OWNER.forEach(function (code) {
      if (code === "ru") return;
      var score = scores[code] || 0;
      if (score > bestScore || (score === bestScore && rank[code] > rank[best])) {
        best = code;
        bestScore = score;
      }
    });
    return bestScore > 0 ? best : "en";
  }

  function choose(text, language, engine) {
    var lang = OWNER.indexOf(language) >= 0 ? language : detect(text);
    var autoEngine = QWEN[lang] ? "qwen" : "omnivoice";
    var forced = engine === "qwen" || engine === "omnivoice" || engine === "fish" ? engine : "auto";
    var rerouted = false;
    var picked = autoEngine;
    if (forced !== "auto") {
      if (supports(forced, lang)) picked = forced;
      else rerouted = true;
    }
    return {
      language: lang,
      engine: picked,
      engineName: NAMES[picked],
      rerouted: rerouted
    };
  }

  return { detect: detect, choose: choose, supports: supports, names: NAMES };
});
