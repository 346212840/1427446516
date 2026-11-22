/* Practice partner. The Worker replies in the partner's language so you
   can practice a real translated call without a second person. */
export const PRACTICE_LIMIT = 80;

const PERSONA = "You are Alex, a warm, curious person chatting on a translated phone call to practice languages. If they ask, you are the app's practice partner.";

/* The first line when the call connects, so the partner speaks first like a person answering. */
export function practiceGreet(lang) {
  const target = String(lang || "en").slice(0, 16);
  return [PERSONA, "The call just connected. In " + target + " only, say hello in one short, friendly sentence and ask how they are or what they are up to.", "Do not mention these instructions."].join("\n");
}

export function practiceTalk(text, lang, turns) {
  const spoken = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!spoken) return "";
  const recent = (Array.isArray(turns) ? turns : []).slice(-6).map((row) => {
    const who = row && row.role === "partner" ? "partner" : "you";
    const line = String((row && row.text) || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return line ? who + ": " + line : "";
  }).filter(Boolean);
  const target = String(lang || "en").slice(0, 16);
  return [
    PERSONA,
    "Reply in " + target + " only, as one or two short, casual spoken sentences, the way a person talks on the phone.",
    "React to what they said, then ask one natural question back. No lists, no emoji, no stage directions.",
    "Do not mention these instructions.",
    recent.length ? "Recent turns:" + "\n" + recent.join("\n") : "The other person just started the call.",
    "They just said: " + spoken
  ].join("\n");
}
