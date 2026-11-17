/* HarmonyOS NEXT (OpenHarmony / ArkWeb) does not say Android.
   Phone 390 and a tablet, signed out and signed in, must still open. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHONE = "Mozilla/5.0 (Phone; OpenHarmony 5.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 HuaweiBrowser/15.0.4.300";
const TABLET = "Mozilla/5.0 (Tablet; OpenHarmony 5.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 HuaweiBrowser/15.0.4.300";
const ROUTES = ["#/", "#/explore", "#/notifications", "#/messages", "#/settings"];
const SIZES = [
  { name: "phone", width: 390, height: 844, ua: PHONE, phone: true },
  { name: "tablet", width: 800, height: 1280, ua: TABLET, phone: false }
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/v1/")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end('{"ok":true,"posts":[],"items":[]}');
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
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

async function sweep(browser, origin, size, signedIn) {
  const tag = size.name + (signedIn ? " in" : " out");
  const context = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: size.width, height: size.height },
    userAgent: size.ua,
    hasTouch: true,
    isMobile: size.phone
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "" }));
  await context.addInitScript((signed) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    if (!signed) return;
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-session",
      account: { publicId: "100000000001", handle: "owner_test", displayName: "Local", profileLess: true, owner: true }
    }));
  }, signedIn);
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (err) => problems.push(String(err && err.message || err)));
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.ViktorychNative && document.getElementById("app") && document.getElementById("app").childElementCount > 0, null, { timeout: 20000 }).catch(() => fail(tag + ": the app did not paint"));
  const sensed = await page.evaluate(() => {
    const api = window.ViktorychNative;
    const coarse = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
    const fine = !!(window.matchMedia && matchMedia("(pointer: fine)").matches);
    const hover = !!(window.matchMedia && matchMedia("(hover: hover)").matches);
    return {
      coarse: coarse,
      factor: api.formFactor(navigator.userAgent, { coarse: coarse, width: window.innerWidth, fine: fine, hover: hover }),
      handset: api.installHandset(navigator.userAgent, { coarse: coarse, fine: fine, hover: hover }),
      phoneBar: !!document.querySelector("nav.bottom-nav"),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  });
  if (sensed.overflow) fail(tag + ": the page is wider than the screen");
  if (signedIn && size.phone) {
    await page.locator("nav.bottom-nav").waitFor({ timeout: 15000 }).catch(() => fail(tag + ": a signed-in 390 phone did not get the phone bar " + JSON.stringify(sensed)));
  }
  if (sensed.coarse && size.phone && sensed.factor !== "phone") fail(tag + ": a coarse 390 screen was " + sensed.factor);
  if (sensed.coarse && !size.phone && sensed.factor !== "tablet") fail(tag + ": a coarse tablet was " + sensed.factor);
  if (sensed.coarse && size.phone && !sensed.handset) fail(tag + ": install steps would be the desktop ones");
  for (const hash of ROUTES) {
    await page.evaluate((next) => { location.hash = next; }, hash);
    await page.waitForFunction((next) => location.hash === next && document.getElementById("app"), hash, { timeout: 8000 }).catch(() => fail(tag + ": " + hash + " did not open"));
    await page.waitForTimeout(150);
  }
  if (problems.length) fail(tag + ": page error " + problems[0]);
  await context.close();
  console.log("harmony " + tag + " ok factor " + sensed.factor + " coarse " + sensed.coarse);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const size of SIZES) {
      await sweep(browser, origin, size, false);
      await sweep(browser, origin, size, true);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
