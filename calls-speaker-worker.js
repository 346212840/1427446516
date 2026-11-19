/* Speaker labels for a call. The page does not wait on this worker.
   Audio keeps flowing while a label is worked out. */
import { createDiarizer } from "./shared/call-speakers.js";

const diarizer = createDiarizer();

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.op === "rename") {
    diarizer.rename(data.id, data.name);
    self.postMessage({ op: "speakers", speakers: diarizer.speakers() });
    return;
  }
  if (data.op !== "frame") return;
  const decision = diarizer.push(data.samples, data.rate, data.text);
  self.postMessage({
    op: "frame",
    send: decision.send,
    overlap: decision.overlap,
    speaker: decision.speaker,
    speakers: diarizer.speakers()
  });
};
