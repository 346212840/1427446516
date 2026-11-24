/* Desktop window layout for the call screens (switch calls_desktop).
   Loads snapshots of the rendered calls screens (made-up names, example.test
   links) with the real calls.css and checks the layout at desktop sizes:
   the stage fills the window, chat is a side panel on wide windows, the call
   bar is centred and never stretched, the sheet tabs all fit, captions and the
   composer stay clear of the bar, and the home and test set-up are centred.
   It also checks that phones look exactly the same with the switch on. */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/* Static wiring: the switch exists on both sides and the page marks itself. */
check(read("worker/src/feature-flags.js").includes("calls_desktop: { paths: [] }"), "calls_desktop missing from feature-flags.js");
check(/SERVER_FEATURES = \[[^\]]*"calls_desktop"/.test(read("app.js")), "calls_desktop missing from SERVER_FEATURES");
const callsJs = read("calls.js");
check(callsJs.includes('indexOf("calls_desktop")') && /function page\(route\) \{\s*markDesk\(\);/.test(callsJs), "calls.js does not mark the desktop layout");
const css = read("calls.css");
check(/@media \(min-width: 700px\)[^]*html\[data-calls-desk\]/.test(css), "desktop rules missing from calls.css");

function startServer() {
  const shared = sharedStaticServer();
  if (shared) return Promise.resolve(shared);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* The stand-alone calls page with its scripts removed and a snapshot mounted. */
function fixturePage(name, desk) {
  const shell = read("calls/index.html")
    .replace(/<script[^]*?<\/script>/g, "")
    .replace(/<main id="calls-root">[^]*?<\/main>/, `<main id="calls-root">${read("scripts/fixtures/calls-desktop/" + name + ".html")}</main>`);
  const boot = `<script>${desk ? "document.documentElement.setAttribute('data-calls-desk','');" : ""}
    addEventListener('DOMContentLoaded',function(){var b=document.querySelector('.calls-bar');if(b)document.documentElement.style.setProperty('--calls-bar-h',b.offsetHeight+'px');});</script>`;
  return shell.replace("</head>", boot + "</head>");
}

async function measure(page) {
  return page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
    const all = (sel) => [...document.querySelectorAll(sel)].map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; });
    return {
      vw: innerWidth, vh: innerHeight, hscroll: document.documentElement.scrollWidth > innerWidth + 1,
      stage: box(".calls-stage"), grid: box(".calls-grid"), tiles: all(".calls-grid .calls-tile"), chips: box(".calls-stagechips"),
      conv: box(".calls-conv"), compose: box(".calls-conv .calls-compose"), bar: box(".calls-bar"), handle: box(".calls-handle i"),
      tabs: all(".calls-sheet-tab"), subs: box(".calls-subs"), side: box(".calls-side"), main: box(".calls-main"), prejoin: box(".calls-prejoin"),
      kinds: box(".calls-testkind")
    };
  });
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

async function main() {
  if (!process.env.PLAYWRIGHT_CORE) { console.log(failures.length ? "" : "calls desktop layout: static checks ok, browser check skipped"); return; }
  const mod = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  let browser;
  try { browser = await chromium.launch({ headless: true, channel: "chrome" }); } catch (err) { browser = await chromium.launch({ headless: true }); }
  const open = async (name, w, h, desk) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: "dark", deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.route(origin + "/calls/__fixture", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixturePage(name, desk) }));
    await page.goto(origin + "/calls/__fixture", { waitUntil: "load" });
    await page.waitForTimeout(250);
    const m = await measure(page);
    await ctx.close();
    return m;
  };
  try {
    for (const [w, h] of [[1920, 1080], [1280, 720]]) {
      const tag = w + "x" + h;
      const call = await open("incall", w, h, true);
      check(!call.hscroll, tag + " in-call scrolls sideways");
      check(call.stage.w >= w - 2, tag + " stage does not fill the window (" + Math.round(call.stage.w) + ")");
      check(call.conv && call.conv.l > call.grid.r + 8 && call.conv.r <= w, tag + " chat is not a side panel beside the tiles");
      check(call.conv.h > h * 0.6, tag + " chat panel is too short");
      check(call.tiles.length === 2 && call.tiles.every((t) => t.h >= 160 && t.w >= 280), tag + " tiles are cramped");
      check(call.chips.t >= call.grid.b - 1 && call.kinds.b <= call.grid.t + 1, tag + " chips or the test switch overlap the tiles");
      check(call.bar.r < call.conv.l - 8, tag + " call bar runs under the chat panel");
      check(near((call.bar.l + call.bar.r) / 2, (call.grid.l + call.grid.r) / 2, 24), tag + " call bar is not centred under the stage");
      check(call.bar.w <= 722, tag + " call bar is stretched (" + Math.round(call.bar.w) + ")");
      check(call.chips.b <= call.bar.t, tag + " stage controls run under the call bar");
      check(call.handle && call.handle.w >= 30 && call.handle.h >= 4, tag + " slide-up handle is not visible");

      const quiet = await open("incall-nochat", w, h, true);
      check(quiet.stage.w >= w - 2 && quiet.tiles.every((t) => t.w >= 300), tag + " tiles do not use the window without chat");
      check(!quiet.subs || quiet.subs.b <= quiet.bar.t, tag + " captions sit under the call bar");

      const sheet = await open("sheet", w, h, true);
      check(sheet.tabs.length >= 5 && sheet.tabs.every((t) => t.l >= sheet.bar.l && t.r <= sheet.bar.r && t.h > 0), tag + " sheet tabs are cut off");
      check(sheet.bar.b <= h + 1 && sheet.bar.t >= 0, tag + " open sheet leaves the window");
      check(sheet.chips.t >= sheet.grid.b - 1 && sheet.kinds.b <= sheet.grid.t + 1, tag + " open sheet squeezes the tiles over the chips");

      const home = await open("home", w, h, true);
      check(!home.hscroll && home.side.r <= home.main.l + 1, tag + " home list and main area are not side by side");
      check(near(home.main.l - home.side.r, w - home.main.r, 4), tag + " home main area is not centred");

      const prep = await open("testprep", w, h, true);
      check(near(prep.prejoin.l, w - prep.prejoin.r, 4), tag + " test call set-up is not centred");
    }
    const mid = await open("incall", 1024, 768, true);
    check(mid.stage.w >= 1022 && mid.compose && mid.compose.b <= mid.bar.t - 4, "1024x768 composer is not clear of the call bar");
    check(mid.grid.w <= 900, "1024x768 call column is stretched edge to edge");
    /* Phones: identical with the switch on and off. */
    for (const name of ["incall", "sheet", "home", "testprep"]) {
      const on = await open(name, 393, 851, true);
      const off = await open(name, 393, 851, false);
      check(JSON.stringify(on) === JSON.stringify(off), "phone layout changed with the switch on: " + name);
    }
  } finally {
    await browser.close();
    if (!process.env.SMOKE_ORIGIN) await new Promise((resolve) => server.close(resolve));
  }
}

await main();
if (failures.length) {
  for (const f of failures) console.error("FAIL " + f);
  process.exit(1);
}
console.log("ok calls desktop layout");
