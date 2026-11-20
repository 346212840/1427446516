/* Typed-message preview for Calls. While someone types, a debounced request
   shows what the other person will read and, translated back, what it means.
   Pure logic: the page supplies `run(text)` and a paint callback. Nothing is
   sent anywhere until the person presses Send. */

export const PREVIEW_MIN = 3;
export const PREVIEW_DELAY = 650;
export const PREVIEW_WAIT = 1500;

export function createPreview(opts) {
  const run = opts.run;
  const onChange = opts.onChange || (() => {});
  const delay = opts.delay != null ? opts.delay : PREVIEW_DELAY;
  const min = opts.min != null ? opts.min : PREVIEW_MIN;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const cache = new Map();
  let seq = 0;
  let timer = null;
  let cur = { text: "", status: "idle" };
  let waiters = [];

  function set(next) {
    cur = next;
    onChange(cur);
    if (cur.status === "ready" || cur.status === "error" || cur.status === "idle") {
      const list = waiters;
      waiters = [];
      list.forEach((fn) => fn(cur));
    }
  }
  async function fire(text) {
    timer = null;
    const mine = ++seq;
    set({ text: text, status: "loading" });
    try {
      const out = await run(text);
      if (mine !== seq) return;
      if (!out || out.error) { set({ text: text, status: "error", error: out && out.error }); return; }
      const hit = { text: text, status: "ready", translation: String(out.translation || ""), back: String(out.back || ""), same: !!out.untranslated };
      cache.set(text, hit);
      if (cache.size > 30) cache.delete(cache.keys().next().value);
      set(hit);
    } catch (err) {
      if (mine !== seq) return;
      set({ text: text, status: "error" });
    }
  }
  function input(raw) {
    const text = String(raw || "").trim();
    if (timer) { clearT(timer); timer = null; }
    seq++;
    if (text.length < min) { set({ text: text, status: "idle" }); return; }
    if (cache.has(text)) { set(cache.get(text)); return; }
    set({ text: text, status: "wait" });
    timer = setT(() => fire(text), delay);
  }
  /* Resolves once the current text has a preview (or failed), never later than `wait` ms, so Send is never stuck. */
  function settle(raw, wait) {
    const text = String(raw || "").trim();
    if (text.length < min) return Promise.resolve({ text: text, status: "idle" });
    if (cur.text === text && (cur.status === "ready" || cur.status === "error")) return Promise.resolve(cur);
    if (cache.has(text)) return Promise.resolve(cache.get(text));
    if (cur.text !== text || cur.status === "idle") input(text);
    if (timer) { clearT(timer); fire(text); }
    return new Promise((resolve) => {
      const done = (value) => { clearT(guard); resolve(value); };
      const guard = setT(() => { waiters = waiters.filter((fn) => fn !== done); resolve({ text: text, status: "late" }); }, wait != null ? wait : PREVIEW_WAIT);
      waiters.push(done);
    });
  }
  function reset() {
    if (timer) { clearT(timer); timer = null; }
    seq++;
    set({ text: "", status: "idle" });
  }
  return { input, settle, reset, state: () => cur };
}
