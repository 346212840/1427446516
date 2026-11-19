/* A background paint of Home, a parked route, must leave the compose box
   the reader is typing in attached and focused. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }
function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "text/javascript";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds: [], posts: [] }));
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file) + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const HANDSET = "Mozilla/5.0 (Phone; OpenHarmony 5.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 HuaweiBrowser/15.0.4.300";

function arm(page) {
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}
async function prepare(page) {
  await page.addInitScript(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
    }));
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: [], lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  await page.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"posts":[]}' }));
}
async function draftSurvives(page, label, where) {
  const result = await page.evaluate((place) => {
    const box = document.getElementById("compose-text");
    const main = document.querySelector("main.center");
    if (!box) return { error: "compose is missing" };
    if (place === "column" && !box.closest("main.center")) return { error: "compose is not in the centre column" };
    if (!document.querySelector("#app .view-slot")) return { error: "home is not parked" };
    box.focus();
    box.value = "still writing";
    const mark = document.createElement("span");
    mark.id = "paint-mark";
    mark.textContent = "changed";
    (main || box.parentElement).appendChild(mark);
    window.ViktorychAccounts.requestRender("background");
    const live = document.getElementById("compose-text");
    return {
      same: live === box,
      connected: !!(live && live.isConnected),
      focused: document.activeElement === live,
      value: live ? live.value : ""
    };
  }, where);
  if (result.error) fail(label + ": " + result.error);
  if (!result.same || !result.connected) fail(label + ": background paint replaced the compose box " + JSON.stringify(result));
  if (!result.focused) fail(label + ": background paint moved focus off the compose box");
  if (result.value !== "still writing") fail(label + ": background paint cleared the draft " + JSON.stringify(result));
  console.log("keep column ok " + label);
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const origin = "http://127.0.0.1:" + port + "/index.html#/";
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    const deskPage = await desktop.newPage();
    const deskErrors = arm(deskPage);
    await prepare(deskPage);
    await deskPage.goto(origin, { waitUntil: "domcontentloaded" });
    await deskPage.waitForSelector("#compose-text", { timeout: 20000 });
    await deskPage.waitForSelector("#app .view-slot", { timeout: 20000 });
    await draftSurvives(deskPage, "desktop", "column");
    if (deskErrors.length) fail("desktop: " + deskErrors[0]);
    await desktop.close();

    const handset = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: HANDSET,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block"
    });
    const phone = await handset.newPage();
    const phoneErrors = arm(phone);
    await prepare(phone);
    await phone.addInitScript(() => localStorage.setItem("viktorychapp-compose-open", "1"));
    await phone.goto(origin, { waitUntil: "domcontentloaded" });
    await phone.waitForSelector("main.center #compose-text", { timeout: 20000 });
    await phone.waitForSelector("#app .view-slot", { timeout: 20000 });
    await phone.waitForSelector("button.fab", { timeout: 20000 });
    await draftSurvives(phone, "handset", "column");
    if (phoneErrors.length) fail("handset: " + phoneErrors[0]);
    await handset.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
