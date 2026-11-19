/* Languages Gemini 3.5 Live Translate accepts as targetLanguageCode.
   Catalan (ca) and Swedish (sv) are in the model's table.
   Regional tags such as en-GB collapse to the primary code when that
   primary is listed. zh-CN does not: Chinese is zh-Hans or zh-Hant. */

export const CALL_MODEL = "gemini-3.5-live-translate-preview";

export const CALL_LANGS = [
  ["af", "Afrikaans"], ["ak", "Akan"], ["sq", "Albanian"], ["am", "Amharic"],
  ["ar", "Arabic"], ["hy", "Armenian"], ["az", "Azerbaijani"], ["eu", "Basque"],
  ["be", "Belarusian"], ["bn", "Bengali"], ["bg", "Bulgarian"], ["my", "Burmese"],
  ["ca", "Catalan"], ["zh-Hans", "Chinese (Simplified)"], ["zh-Hant", "Chinese (Traditional)"],
  ["hr", "Croatian"], ["cs", "Czech"], ["da", "Danish"], ["nl", "Dutch"],
  ["en", "English"], ["et", "Estonian"], ["fil", "Filipino"], ["fi", "Finnish"],
  ["fr", "French"], ["gl", "Galician"], ["ka", "Georgian"], ["de", "German"],
  ["el", "Greek"], ["gu", "Gujarati"], ["ha", "Hausa"], ["he", "Hebrew"],
  ["hi", "Hindi"], ["hu", "Hungarian"], ["is", "Icelandic"], ["id", "Indonesian"],
  ["it", "Italian"], ["ja", "Japanese"], ["jv", "Javanese"], ["kn", "Kannada"],
  ["kk", "Kazakh"], ["km", "Khmer"], ["rw", "Kinyarwanda"], ["ko", "Korean"],
  ["lo", "Lao"], ["lv", "Latvian"], ["lt", "Lithuanian"], ["mk", "Macedonian"],
  ["ms", "Malay"], ["ml", "Malayalam"], ["mr", "Marathi"], ["mn", "Mongolian"],
  ["ne", "Nepali"], ["no", "Norwegian"], ["nb", "Norwegian Bokmål"], ["fa", "Persian"],
  ["pl", "Polish"], ["pt-BR", "Portuguese (Brazil)"], ["pt-PT", "Portuguese (Portugal)"],
  ["pa", "Punjabi"], ["ro", "Romanian"], ["ru", "Russian"], ["sr", "Serbian"],
  ["sd", "Sindhi"], ["si", "Sinhala"], ["sk", "Slovak"], ["sl", "Slovenian"],
  ["es", "Spanish"], ["su", "Sundanese"], ["sw", "Swahili"], ["sv", "Swedish"],
  ["ta", "Tamil"], ["te", "Telugu"], ["th", "Thai"], ["tr", "Turkish"],
  ["uk", "Ukrainian"], ["ur", "Urdu"], ["uz", "Uzbek"], ["vi", "Vietnamese"],
  ["zu", "Zulu"]
];

export const PINNED_LANGS = ["es", "en", "sv", "ca", "ru"];

const CODES = new Set(CALL_LANGS.map((row) => row[0]));

export function isCallLang(code) {
  return CODES.has(String(code || ""));
}

/* en-GB → en. zh-CN stays rejected (use zh-Hans / zh-Hant). */
export function normalizeLang(code) {
  const text = String(code || "").trim().replace(/_/g, "-");
  if (!text) return "";
  if (CODES.has(text)) return text;
  const primary = text.split("-")[0].toLowerCase();
  if (primary === "zh") return "";
  const hit = CALL_LANGS.find((row) => row[0].toLowerCase() === primary || row[0].toLowerCase().startsWith(primary + "-"));
  return hit ? hit[0] : "";
}

export function langName(code) {
  const row = CALL_LANGS.find((item) => item[0] === code);
  return row ? row[1] : String(code || "");
}

/* First guess from an account or browser tag. Unknown tags fall back to en. */
export function guessLang(tag) {
  return normalizeLang(tag) || "en";
}

/* Lightweight detector for the first words of a live transcript.
   High confidence may switch the language with no extra tap.
   Short or ambiguous text stays low so the current guess remains. */
export function detectLang(text, guess) {
  const raw = String(text || "").trim();
  const fallback = guessLang(guess);
  if (raw.length < 8) return { code: fallback, confidence: 0.2 };
  const cyr = (raw.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyr / raw.length > 0.3) return { code: "ru", confidence: 0.92 };
  if (/[åäöÅÄÖ]/.test(raw)) return { code: "sv", confidence: 0.86 };
  if (/[ñ¿¡]/.test(raw) || /\b(hola|gracias|también|estoy)\b/i.test(raw)) return { code: "es", confidence: 0.8 };
  if (/[·]/.test(raw) || /\b(és|amb|perquè|això|bon dia)\b/i.test(raw)) return { code: "ca", confidence: 0.8 };
  if (/\b(the|and|you|this|hello|thanks)\b/i.test(raw)) return { code: "en", confidence: 0.74 };
  return { code: fallback, confidence: 0.4 };
}

export function sameLang(a, b) {
  const left = normalizeLang(a);
  const right = normalizeLang(b);
  return !!(left && right && left === right);
}
