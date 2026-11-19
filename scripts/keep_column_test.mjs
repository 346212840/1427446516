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

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
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
    await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#compose-text", { timeout: 20000 });
    await page.waitForSelector("#app .view-slot", { timeout: 20000 });
    const result = await page.evaluate(() => {
      const box = document.getElementById("compose-text");
      if (!box || !box.closest("main.center")) return { error: "compose is not in the centre column" };
      if (!document.querySelector("#app .view-slot")) return { error: "home is not parked" };
      box.focus();
      box.value = "still writing";
      window.ViktorychAccounts.requestRender("background");
      const live = document.getElementById("compose-text");
      return {
        same: live === box,
        connected: !!(live && live.isConnected),
        focused: document.activeElement === live,
        value: live ? live.value : ""
      };
    });
    if (result.error) fail(result.error);
    if (!result.same || !result.connected) fail("background paint replaced the compose box " + JSON.stringify(result));
    if (!result.focused) fail("background paint moved focus off the compose box");
    if (result.value !== "still writing") fail("background paint cleared the draft " + JSON.stringify(result));
    if (errors.length) fail(errors[0]);
    console.log("keep column ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
