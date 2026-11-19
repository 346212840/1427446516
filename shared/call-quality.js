/* Connection and output choices that must not restart the call.
   A headset change only picks an output device. A slow network
   picks a lighter bitrate before the answer, not during it. */

export function lighterFor(conn) {
  const net = conn || {};
  const type = String(net.effectiveType || "");
  const downlink = Number(net.downlink);
  const rtt = Number(net.rtt);
  const slow = net.saveData === true || type === "slow-2g" || type === "2g" || rtt > 400 || (downlink > 0 && downlink < 0.4);
  if (!slow) return { lighter: false, bitrate: 510000, jitter: 0 };
  return { lighter: true, bitrate: 24000, jitter: 2 };
}

/* Prefer a headphone or Bluetooth output. Empty means the current default.
   The peer connection is not part of this choice. */
export function pickSink(devices) {
  const outs = (Array.isArray(devices) ? devices : []).filter((item) => item && item.kind === "audiooutput");
  const hit = outs.find((item) => /head|bluetooth|airpod|headset|buds|earpod/i.test(String(item.label || "")));
  return hit && hit.deviceId ? String(hit.deviceId) : "";
}

export function sinkChangeKeepsCall() {
  return true;
}

export function cleanLexicon(list) {
  const out = [];
  const rows = Array.isArray(list) ? list : [];
  for (let i = 0; i < rows.length && out.length < 20; i++) {
    const word = String((rows[i] && rows[i].word) || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 40);
    const say = String((rows[i] && rows[i].say) || "").replace(/[\u0000-\u001F]/g, "").trim().slice(0, 60);
    if (!word || !say) continue;
    out.push({ word: word, say: say });
  }
  return out;
}

export function lexiconHint(list) {
  const rows = cleanLexicon(list);
  if (!rows.length) return "";
  return "Pronounce these as specified: " + rows.map((row) => row.word + " = " + row.say).join("; ") + ".";
}

/* The last translated sentence the listener can replay locally. */
export function rememberLine(previous, line) {
  const text = String((line && line.text) || "").trim().slice(0, 500);
  if (!text) return previous || null;
  return { text: text, pcm: line && line.pcm ? line.pcm : null };
}
