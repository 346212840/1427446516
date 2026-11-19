/* An X video stays inside the post card on a phone and on a desktop. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 }
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      const type = file.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function check(browser, origin, size) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto(origin + "/styles.css", { waitUntil: "domcontentloaded" });
  await page.setContent(`<!doctype html><html><head>
    <link rel="stylesheet" href="${origin}/styles.css">
    <script src="${origin}/video-embed.js"></script>
    </head><body style="margin:0;width:${size.width}px;background:#000">
    <article class="post" style="width:${Math.min(size.width, 600)}px;max-width:100%">
      <div class="media m1" id="card">
        <div class="tile vplay has-ratio" data-xvideo="1" style="aspect-ratio:16 / 9">
          <video id="clip" controls playsinline style="width:100%;height:100%;max-width:100%;object-fit:contain" width="1280" height="720"></video>
        </div>
      </div>
      <div class="media m1" id="fallback" style="margin-top:12px">
        <div class="tile vplay has-ratio is-x-embed" id="embed-tile" style="aspect-ratio:16 / 9"></div>
      </div>
    </article>
  </body>`, { waitUntil: "load" });
  const box = await page.evaluate(() => {
    const tile = document.getElementById("embed-tile");
    const frame = document.createElement("iframe");
    frame.className = "x-embed-frame";
    frame.setAttribute("loading", "lazy");
    frame.title = "Post";
    const wrap = document.createElement("div");
    wrap.className = "vembed-fit";
    wrap.setAttribute("data-site", "x");
    wrap.appendChild(frame);
    tile.appendChild(wrap);
    window.ViktorychEmbed.fitEmbed(wrap, frame, { width: 550, height: 560, fit: "contain" });
    const card = document.getElementById("card").getBoundingClientRect();
    const video = document.getElementById("clip").getBoundingClientRect();
    const embed = frame.getBoundingClientRect();
    const host = tile.getBoundingClientRect();
    return {
      videoInside: video.left >= card.left - 1 && video.right <= card.right + 1 && video.width <= card.width + 1,
      embedInside: embed.left >= host.left - 1 && embed.right <= host.right + 1 && embed.top >= host.top - 1 && embed.bottom <= host.bottom + 1,
      videoWidth: video.width,
      cardWidth: card.width,
      embedWidth: embed.width,
      hostWidth: host.width,
      minWidth: getComputedStyle(frame).minWidth
    };
  });
  if (!box.videoInside) fail(size.name + ": the video is outside the card " + JSON.stringify(box));
  if (!box.embedInside) fail(size.name + ": the X embed is outside the card " + JSON.stringify(box));
  if (box.embedWidth > box.hostWidth + 1) fail(size.name + ": the embed is wider than the card " + JSON.stringify(box));
  if (box.minWidth && box.minWidth !== "0px" && box.minWidth !== "auto") fail(size.name + ": the embed has a fixed min width " + box.minWidth);
  await page.close();
  console.log("x card fit ok " + size.name);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const size of SIZES) await check(browser, origin, size);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
