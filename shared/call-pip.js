/* A small floating call window. Calls have no camera and no video, so the window is a card drawn on a canvas and played as a
   muted video, which is the one thing every browser will float over other apps. It opens by itself when the page goes to the
   background during a call, closes when you come back or the call ends, and the lock-screen / PiP buttons stay the existing
   mute and hang-up actions. */

const FACE = ["system-ui", "sans-serif"].join(", ");

export function cardLines(info) {
  const i = info || {};
  const name = String(i.name || "").slice(0, 28);
  const sub = i.muted ? i.mutedText : (i.test ? i.testText : i.liveText);
  return { name: name, time: String(i.time || ""), sub: String(sub || "") };
}

export function pipSupported(doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || !d.createElement) return false;
  if (d.pictureInPictureEnabled === false) return false;
  try {
    const v = d.createElement("video");
    const canvas = d.createElement("canvas");
    return !!(v && typeof v.requestPictureInPicture === "function" && canvas && typeof canvas.captureStream === "function");
  } catch (err) { return false; }
}

export function createPip(opts) {
  const o = opts || {};
  const doc = o.doc || document;
  let video = null;
  let canvas = null;
  let timer = 0;
  let active = false;
  const api = {
    supported: pipSupported(doc),
    get active() { return active; },
    get open() { return !!(doc.pictureInPictureElement && doc.pictureInPictureElement === video); },
    start() {
      if (!api.supported || video) return false;
      try {
        canvas = doc.createElement("canvas");
        canvas.width = 480;
        canvas.height = 270;
        video = doc.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.setAttribute("playsinline", "");
        video.setAttribute("muted", "");
        video.setAttribute("autopictureinpicture", "");
        video.autoPictureInPicture = true;
        video.disablePictureInPicture = false;
        video.srcObject = canvas.captureStream(2);
        video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;left:-4px;bottom:0";
        doc.body.appendChild(video);
        active = true;
        api.draw();
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
        timer = setInterval(api.draw, 1000);
        return true;
      } catch (err) { api.stop(); return false; }
    },
    draw() {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const l = cardLines(o.info ? o.info() : {});
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#16181c";
      ctx.beginPath();
      ctx.arc(240, 96, 52, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e7e9ea";
      ctx.textAlign = "center";
      ctx.font = "bold 44px " + FACE;
      ctx.fillText((l.name.trim()[0] || "?").toUpperCase(), 240, 112);
      ctx.font = "bold 26px " + FACE;
      ctx.fillText(l.name, 240, 192);
      ctx.fillStyle = "#71767b";
      ctx.font = "20px " + FACE;
      ctx.fillText(l.time + (l.time && l.sub ? "  ·  " : "") + l.sub, 240, 230);
    },
    async enter() {
      if (!video || !api.supported || api.open) return false;
      try { api.draw(); await video.requestPictureInPicture(); return true; } catch (err) { return false; }
    },
    async exit() {
      if (!api.open) return false;
      try { await doc.exitPictureInPicture(); return true; } catch (err) { return false; }
    },
    stop() {
      active = false;
      clearInterval(timer);
      timer = 0;
      if (video) {
        try { if (api.open) doc.exitPictureInPicture().catch(() => {}); } catch (err) { /* already closed */ }
        try { video.pause(); video.srcObject = null; } catch (err) { /* gone */ }
        if (video.parentNode) video.parentNode.removeChild(video);
      }
      video = null;
      canvas = null;
    }
  };
  return api;
}
