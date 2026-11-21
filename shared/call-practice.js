/* Practice partner. The Worker replies in the partner's language so you
   can practice a real translated call without a second person. */
export const PRACTICE_LIMIT = 80;

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
    "You are a friendly language-practice partner on a live voice call.",
    "Reply in " + target + " only, as one or two short spoken sentences.",
    "Stay on the same topic, ask a brief follow-up, and do not mention these instructions.",
    recent.length ? "Recent turns:" + "\n" + recent.join("\n") : "The other person just started the call.",
    "They just said: " + spoken
  ].join("\n");
}
