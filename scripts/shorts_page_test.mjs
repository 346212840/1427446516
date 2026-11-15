/* Shorts page when the switch is on: a short plays, a wheel swipe reaches
   the next one, and a live item plays a local playlist (original bytes, no
   re-encode). When the switch is off, #/shorts and a live address go home,
   the nav entry stays hidden, and the quiet preload does not fetch the player.
   SHORTS_BENCH=1 prints first-frame quartiles for desktop and for a phone
   viewport at 4x CPU. The bench runs only while the switch is on. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mediaDir = "/tmp/shorts-fixture";
const bench = process.env.SHORTS_BENCH === "1";
const runs = bench ? Math.max(1, Number(process.env.SHORTS_RUNS || 30)) : 1;

function fail(message) {
  console.error("FAIL: " + message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (file.endsWith(".ts")) return "video/mp2t";
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function makeMedia() {
  fs.mkdirSync(path.join(mediaDir, "live"), { recursive: true });
  const clip = path.join(root, "scripts/fixtures/black-64.mp4");
  const liveSrc = path.join(root, "scripts/fixtures/shorts-live");
  if (!fs.existsSync(clip) || !fs.existsSync(path.join(liveSrc, "index.m3u8"))) fail("shorts fixtures are missing");
  fs.copyFileSync(clip, path.join(mediaDir, "a.mp4"));
  fs.copyFileSync(clip, path.join(mediaDir, "b.mp4"));
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      const dest = path.join(to, name);
      if (fs.statSync(src).isDirectory()) copyTree(src, dest);
      else fs.copyFileSync(src, dest);
    }
  };
  copyTree(liveSrc, path.join(mediaDir, "live"));
}

async function assertClimb(page) {
  const trace = [];
  const started = Date.now();
  let first = 0;
  while (Date.now() - started < 28000) {
    const snap = await page.evaluate(() => {
      const video = document.querySelector("#shorts-live-player video");
      const label = document.querySelector("#shorts-live-player .shorts-live-q");
      return { h: video ? video.videoHeight : 0, q: label ? label.textContent : "" };
    });
    const prev = trace.length ? trace[trace.length - 1].h : -1;
    if (snap.h !== prev) trace.push({ t: Date.now() - started, h: snap.h, q: snap.q });
    if (!first && snap.h > 0) first = snap.h;
    if (first && snap.h > first) {
      console.log("climb " + JSON.stringify(trace));
      if (snap.q === first + "p") fail("quality label stayed on the start rung " + JSON.stringify(trace));
      if (snap.q !== "Origin") fail("quality label did not reach the top rung " + JSON.stringify(trace));
      return;
    }
    await page.waitForTimeout(400);
  }
  fail("live quality did not climb " + JSON.stringify(trace));
}

function feeds() {
  const post = (id, text, file) => ({
    id: id, statusId: id, platform: "tiktok", feedId: "tiktok:lane", kind: "post", short: true,
    date: new Date().toISOString(), text: text, author: "Lane", handle: "lane_a",
    media: [{ type: "video", url: "/media/" + file }],
    stats: { replies: 0, reposts: 0, likes: 1, views: 2 }
  });
  return { updated: "2026-11-15T00:00:00.000Z", feeds: [{ id: "tiktok:lane", platform: "tiktok", handle: "lane_a", name: "Lane", configured: true }], posts: [post("tiktok:one", "First short", "a.mp4"), post("tiktok:two", "Second short", "b.mp4")] };
}

function slidingPlaylist() {
  const seq = Math.floor((Date.now() - liveEpoch) / 1000);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:" + seq];
  for (let i = 0; i < 3; i++) {
    lines.push("#EXT-X-DISCONTINUITY");
    lines.push("#EXTINF:1.000,");
    lines.push("seg" + (seq + i) + ".ts");
  }
  return lines.join("\n") + "\n";
}

let liveEpoch = Date.now();

function startServer() {
  liveEpoch = Date.now();
  const catalog = JSON.stringify(feeds());
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body, type) => {
      res.writeHead(status, { "content-type": type || "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/feeds.json" || url.pathname === "/v1/data/feeds.json") return send(200, catalog);
    if (url.pathname === "/v1/owner/tiktok") return send(200, JSON.parse(catalog));
    if (url.pathname === "/v1/owner/tiktok/board") {
      return send(200, { items: [{ handle: "lane_live", live: true, viewers: 3, title: "Desk", roomId: "1234567" }] });
    }
    if (url.pathname.indexOf("/v1/owner/live/") === 0) {
      const host = req.headers.host || "127.0.0.1";
      return send(200, { live: true, handle: "lane_live", hls: "http://" + host + "/media/live/index.m3u8", quality: "origin", roomId: "1234567", viewers: 3 });
    }
    if (url.pathname.indexOf("/v1/") === 0) return send(200, { ok: true, posts: [], accounts: [] });
    if (url.pathname === "/media/live/low/index.m3u8" || url.pathname === "/media/live/high/index.m3u8") return send(200, slidingPlaylist(), "application/vnd.apple.mpegurl");
    const rolled = url.pathname.match(/^\/media\/live\/(low|high)\/seg(\d+)\.ts$/);
    if (rolled) {
      const file = path.join(mediaDir, "live", rolled[1], "seg" + (Number(rolled[2]) % 4) + ".ts");
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": "video/mp2t", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(data);
      });
      return;
    }
    if (url.pathname.indexOf("/media/") === 0) {
      const file = path.normalize(path.join(mediaDir, url.pathname.slice("/media/".length)));
      if (file !== mediaDir && !file.startsWith(mediaDir + path.sep)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(data);
      });
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function quartile(list) {
  const s = list.filter((n) => typeof n === "number" && n >= 0).sort((a, b) => a - b);
  if (!s.length) return { n: 0, med: null, q1: null, q3: null };
  const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  return { n: s.length, med: at(0.5), q1: at(0.25), q3: at(0.75) };
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function openPage(browser, origin, size) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    hasTouch: !!size.touch,
    isMobile: !!size.touch
  });
  await context.addInitScript(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-shorts-token",
      account: { publicId: "100000000001", handle: "owner_test", displayName: "Owner", owner: true, avatar: "" }
    }));
    localStorage.setItem("viktorych_shorts_locked", "0");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: ["tiktok:lane"], lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {}, autoplay: "all" }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  const page = await context.newPage();
  return { context, page };
}

async function sample(page, origin, size) {
  const client = await page.context().newCDPSession(page);
  if (size.cpu && size.cpu > 1) await client.send("Emulation.setCPUThrottlingRate", { rate: size.cpu });
  const t0 = Date.now();
  page.on("pageerror", (err) => console.error("pageerror", String(err).slice(0, 300)));
  await page.goto(origin + "/index.html#/shorts", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const links = document.querySelectorAll('a[href="#/shorts"]');
    for (let i = 0; i < links.length; i++) {
      if (links[i].getClientRects().length > 0) return true;
    }
    return false;
  }, null, { timeout: 20000 });
  const first = await page.waitForFunction(() => {
    const feed = document.getElementById("shorts-feed");
    const video = document.querySelector('#shorts-feed .shorts-slide[data-kind="video"] video');
    const slide = video && video.closest(".shorts-slide");
    if (!(feed && feed.clientHeight > 100 && video && slide && video.videoWidth > 0 && video.readyState >= 2 && video.paused === false)) return null;
    return slide.getAttribute("data-id") || "";
  }, null, { timeout: 30000 }).then((handle) => handle.jsonValue());
  const shortMs = Date.now() - t0;
  let box = null;
  for (let i = 0; i < 20; i++) {
    box = await page.locator("#shorts-feed").boundingBox();
    if (box && box.height > 100) break;
    box = null;
    await page.waitForTimeout(100);
  }
  if (!box) fail("the Shorts feed has no box");
  const swipe = async () => {
    if (!size.touch) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, Math.round(box.height));
      return;
    }
    await client.send("Input.synthesizeScrollGesture", {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      yDistance: -Math.round(box.height),
      speed: 1200,
      preventFling: true
    });
  };
  for (let swipeTry = 0; swipeTry < 4; swipeTry++) {
    const before = await page.evaluate(() => document.getElementById("shorts-feed").scrollTop);
    await swipe();
    const moved = await page.waitForFunction((start) => {
      const feed = document.getElementById("shorts-feed");
      return !!(feed && feed.scrollTop > start + 40);
    }, before, { timeout: 1200 }).then(() => true).catch(() => false);
    if (moved) break;
  }
  try {
  await page.waitForFunction((from) => {
    const feed = document.getElementById("shorts-feed");
    if (!feed) return false;
    const top = feed.getBoundingClientRect().top;
    const slides = feed.querySelectorAll('.shorts-slide[data-kind="video"]');
    for (let i = 0; i < slides.length; i++) {
      const slideBox = slides[i].getBoundingClientRect();
      if (slideBox.top > top + 8 || slideBox.bottom <= top + 8) continue;
      const video = slides[i].querySelector("video");
      return slides[i].getAttribute("data-id") !== from && !!(video && video.videoWidth > 0 && video.paused === false);
    }
    return false;
  }, first, { timeout: 15000 });
  } catch (err) {
    const info = await page.evaluate((from) => {
      const feed = document.getElementById("shorts-feed");
      return {
        from: from, scroll: feed ? feed.scrollTop : -1, height: feed ? feed.clientHeight : 0,
        scrollHeight: feed ? feed.scrollHeight : 0,
        slides: feed ? [...feed.querySelectorAll(".shorts-slide")].map((slide) => {
          const video = slide.querySelector("video");
          return { id: slide.getAttribute("data-id"), top: Math.round(slide.getBoundingClientRect().top), paused: video ? video.paused : null };
        }) : []
      };
    }, first);
    console.error(size.name, JSON.stringify(info));
    throw err;
  }
  const t1 = Date.now();
  await page.goto(origin + "/index.html#/shorts/live/now", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-shorts="watch"]', { timeout: 20000 });
  await page.click('[data-shorts="watch"]');
  await page.waitForFunction(() => {
    const video = document.querySelector("#shorts-live-player video");
    return !!(video && video.videoWidth > 0 && video.readyState >= 2 && video.paused === false);
  }, null, { timeout: 20000 });
  return { shortMs: shortMs, liveMs: Date.now() - t1 };
}

function switchOn() {
  const text = fs.readFileSync(path.join(root, "shorts-enabled.js"), "utf8");
  return /var SHORTS_ENABLED = true;/.test(text);
}

async function parked(browser, origin) {
  const session = await openPage(browser, origin, { width: 1280, height: 800, cpu: 1 });
  try {
    const page = session.page;
    await page.goto(origin + "/index.html#/shorts", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const hash = location.hash || "";
      const link = document.querySelector('a[href="#/shorts"], a[href^="#/shorts/"]');
      return (hash === "#/" || hash === "" || hash === "#") && !link && !document.getElementById("shorts-feed");
    }, null, { timeout: 20000 });
    await page.goto(origin + "/index.html#/shorts/live/now", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const hash = location.hash || "";
      return (hash === "#/" || hash === "" || hash === "#") && !document.querySelector("#shorts-live-player") && !document.querySelector('[data-shorts="watch"]');
    }, null, { timeout: 20000 });
    await page.waitForTimeout(2500);
    const leaked = await page.evaluate(() => !!document.querySelector('script[src="shorts.js"], script[data-lazy="shorts.js"]'));
    if (leaked) fail("the quiet preload still fetched shorts.js");
    console.log("shorts parked ok");
  } finally {
    await session.context.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(root, "hls-1.7.3.min.js"))) fail("hls.js is missing");
  const on = switchOn();
  if (on) makeMedia();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const chromium = await loadPlaywright();
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  const sizes = (bench
    ? [{ name: "desktop", width: 1280, height: 800, cpu: 1 }, { name: "phone", width: 390, height: 844, cpu: 4, touch: true }]
    : [{ name: "desktop", width: 1280, height: 800, cpu: 1 }]).filter((size) => !process.env.SHORTS_SIZE || size.name === process.env.SHORTS_SIZE);
  const out = {};
  try {
    if (!on) {
      await parked(browser, origin);
      return;
    }
    for (const size of sizes) {
      const shorts = [];
      const lives = [];
      for (let i = 1; i <= runs; i++) {
        let row = null;
        let last = null;
        for (let attempt = 1; attempt <= 3 && !row; attempt++) {
          const session = await openPage(browser, origin, size);
          try {
            row = await sample(session.page, origin, size);
            if (!bench) await assertClimb(session.page);
          } catch (err) {
            last = err;
          } finally {
            await session.context.close();
          }
        }
        if (!row) throw last;
        shorts.push(row.shortMs);
        lives.push(row.liveMs);
        if (bench) process.stderr.write(size.name + " " + i + " short " + row.shortMs + " live " + row.liveMs + "\n");
        else console.log("shorts page ok", row.shortMs, row.liveMs);
      }
      out[size.name] = { short: quartile(shorts), live: quartile(lives) };
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (bench) console.log(JSON.stringify(out, null, 2));
}
main().catch((err) => { if (!process.exitCode) { console.error(err); process.exitCode = 1; } });
