/* How each person sends and receives. The two sides never have to match.
   Subtitles are a separate choice. Text receive keeps the chat thread
   even when subtitles are off. */

export const SENDS = ["voice", "text", "note"];
export const RECEIVES = ["voice", "text", "both"];
export const SUBTITLES = ["off", "translated", "original", "both"];
/* Slide left this far (px) cancels a voice note before it is sent. */
export const NOTE_CANCEL_DX = 72;

export function normalizeMode(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const send = src.send === "text" || src.send === "note" ? src.send : "voice";
  return {
    send: send,
    receive: src.receive === "text" || src.receive === "both" ? src.receive : "voice",
    original: src.original !== false,
    translationOnly: src.translationOnly === true,
    subtitles: SUBTITLES.indexOf(src.subtitles) >= 0 ? src.subtitles : "both",
    reviewNotes: src.reviewNotes === true,
    /* Empty means auto-match a prebuilt voice. A name is a manual override. */
    voice: typeof src.voice === "string" ? src.voice.slice(0, 32) : ""
  };
}

export function textReceive(mode) {
  const row = normalizeMode(mode);
  return row.receive === "text" || row.receive === "both";
}

/* Chat stays up for a text receiver no matter the subtitle choice. */
export function chatVisible(mode) {
  return textReceive(mode);
}

export function showOriginalSub(mode) {
  const row = normalizeMode(mode);
  return row.subtitles === "original" || row.subtitles === "both";
}

export function showTranslationSub(mode) {
  const row = normalizeMode(mode);
  return row.subtitles === "translated" || row.subtitles === "both";
}

/* Live voice is the only send mode that puts the mic on the peer
   connection. Text and voice notes keep that track closed. A note
   records locally and sends one clip when the person lets go. */
export function transmitOriginal(mode) {
  const row = normalizeMode(mode);
  if (row.send !== "voice") return false;
  if (row.translationOnly) return false;
  return true;
}

/* The capture mic opens for live voice, and for a voice note only
   while the talk button is held or latched. */
export function micOpen(mode, recording) {
  const row = normalizeMode(mode);
  if (row.send === "voice") return true;
  if (row.send === "note") return !!recording;
  return false;
}

/* Releasing a note: a leftward slide cancels. Review holds the clip
   on this device until Send. Otherwise it goes out immediately.
   The peer connection is not part of this choice. */
export function noteRelease(startX, x, review) {
  const dx = (Number(x) || 0) - (Number(startX) || 0);
  if (dx <= -NOTE_CANCEL_DX) return "cancel";
  if (review) return "review";
  return "send";
}

export function noteShouldAutoplay(mode) {
  return playTranslatedVoice(mode);
}

/* A voice-note bubble is a message, not a subtitle. The thread stays
   up for text receive and whenever a note is already on screen. */
export function threadVisible(mode, hasThread) {
  return chatVisible(mode) || !!hasThread;
}

export function modeSwitchKeepsCall() {
  return true;
}

export function playTranslatedVoice(mode) {
  const row = normalizeMode(mode);
  return row.receive === "voice" || row.receive === "both";
}

export function playOriginal(mode) {
  const row = normalizeMode(mode);
  return row.original === true;
}

/* Speak a finished clause, or the first handful of words, before the
   person has finished the whole message. */
export function takeClauses(buffer) {
  const text = String(buffer || "");
  const ready = [];
  let rest = text;
  const mark = /[.!?…\n]/;
  while (rest) {
    const at = rest.search(mark);
    if (at < 0) break;
    const piece = rest.slice(0, at + 1).trim();
    rest = rest.slice(at + 1);
    if (piece) ready.push(piece);
  }
  const words = rest.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 8) {
    ready.push(words.slice(0, 8).join(" "));
    rest = words.slice(8).join(" ");
  }
  return { ready: ready, rest: rest.replace(/^\s+/, "") };
}

export const QUICK_PHRASES = ["hold", "repeat", "back"];
export const QUICK_REPLIES = QUICK_PHRASES;

/* Guests use the same call tools as an account. Video is not one of them. */
export const GUEST_FEATURES = [
  "voice", "text", "note", "receive", "translationOnly", "volumes",
  "subtitles", "voiceMatch", "transcript", "original",
  "repeat", "phrases", "lexicon", "route", "background", "callback"
];

export function guestFeature(name) {
  return GUEST_FEATURES.indexOf(name) >= 0 && name !== "video";
}
