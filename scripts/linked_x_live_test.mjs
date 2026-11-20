/* A merged linked X account shows its live posts and replies on the
   internal profile, not only the last synced catalog copy. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HANDLE = "northwind";
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
      return res.end(CATALOG);
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

const CATALOG = JSON.stringify({
  updated: "2026-11-07T00:00:00.000Z",
  feeds: [{ id: "x:" + HANDLE, platform: "x", handle: HANDLE, name: "North Wind" }],
  posts: [{
    id: "x:" + HANDLE + ":8001",
    statusId: "8001",
    platform: "x",
    kind: "post",
    handle: HANDLE,
    author: "North Wind",
    text: "Catalog north wind note",
    date: "2026-11-18T12:00:00.000Z",
    url: "https://example.com/status/8001"
  }]
});

const ACCOUNT = {
  publicId: "100000000001",
  handle: "user_a",
  displayName: "User A",
  identities: [{
    id: "ident-x",
    platform: "x",
    handle: HANDLE,
    merged: true,
    verified: true,
    hidden: false,
    audience: "public"
  }]
};

function fxUser() {
  return { user: { screen_name: HANDLE, name: "North Wind" } };
}
function fxStatus(id, text, reply) {
  const row = {
    id: id,
    text: text,
    created_at: "2026-11-19T12:00:00.000Z",
    author: { screen_name: HANDLE, name: "North Wind" }
  };
  if (reply) row.replying_to = { screen_name: "otherlane", status: "1" };
  return row;
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  let releaseFx = () => {};
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.addInitScript((account) => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: [], lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: account }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    }, ACCOUNT);
    await page.route("**/v1/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/v1/profile/user_a") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ account: ACCOUNT, reposts: [] })
        });
      }
      if (url.pathname.endsWith("/feeds.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: CATALOG });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"posts":[]}' });
    });
    const fxGate = new Promise((resolve) => { releaseFx = resolve; });
    await page.route("https://api.fxtwitter.com/**", async (route) => {
      await fxGate;
      const url = new URL(route.request().url());
      if (url.pathname === "/" + HANDLE) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fxUser()) });
      }
      const replies = url.searchParams.get("with_replies") === "1";
      const media = url.pathname.endsWith("/media");
      const results = media ? [] : replies
        ? [fxStatus("9002", "Fresh north wind reply", true)]
        : [fxStatus("9001", "Fresh north wind note", false)];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: results }) });
    });
    await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Catalog north wind note", { timeout: 20000 }).catch(() => fail("the catalog post did not show while the live read was in flight"));
    await page.waitForSelector(".lp-pills", { timeout: 20000 }).catch(() => fail("the profile did not offer filter pills"));
    await page.locator('.lp-pill[data-src="app"]').click();
    const postsPill = await page.evaluate(() => {
      const pills = document.querySelector(".lp-pills");
      const all = document.querySelector('.lp-pill[data-src="all"]');
      const loading = Array.from(document.querySelectorAll(".reply-empty")).some((el) => (el.textContent || "").indexOf("Loading") >= 0);
      return { pills: !!pills, all: !!(all && all.isConnected), loading: loading };
    });
    if (!postsPill.pills || !postsPill.all || postsPill.loading) fail("the Posts filter replaced the pills with Loading " + JSON.stringify(postsPill));
    await page.locator('.lp-pill[data-src="all"]').click();
    await page.waitForSelector("text=Catalog north wind note", { timeout: 5000 }).catch(() => fail("All did not bring the catalog post back"));
    await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a?tab=replies", { waitUntil: "domcontentloaded" });
    const waitingReplies = await page.waitForFunction(() => {
      const pills = document.querySelector(".lp-pills");
      const box = document.querySelector(".reply-empty");
      const text = document.body.innerText || "";
      if (!pills || !box || box.textContent.indexOf("Loading") < 0) return false;
      if (text.indexOf("No replies yet") >= 0) return false;
      return true;
    }, null, { timeout: 20000 }).catch(() => null);
    if (!waitingReplies) fail("the replies tab did not keep the pills while the live read was in flight");
    releaseFx();
    await page.waitForSelector("text=Fresh north wind reply", { timeout: 20000 }).catch(() => fail("the live reply did not join the profile"));
    await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Fresh north wind note", { timeout: 20000 }).catch(() => fail("the live post did not join the profile"));
    await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a?tab=replies", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Fresh north wind reply", { timeout: 20000 }).catch(() => fail("the live reply did not join the profile"));
    const note = await page.locator("text=Fresh north wind note").count();
    if (note) fail("a reply tab showed the post");
    if (errors.length) fail(errors[0]);
    const zeroAccount = Object.assign({}, ACCOUNT, { postsCount: 0 });
    const zero = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
    const zeroPage = await zero.newPage();
    zeroPage.on("pageerror", (err) => errors.push(String(err)));
    await zeroPage.addInitScript((account) => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: [], lists: [], likes: {}, bookmarks: {}, reposts: {} }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: account }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    }, zeroAccount);
    await zeroPage.route("**/v1/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/v1/profile/user_a") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ account: zeroAccount, reposts: [] })
        });
      }
      if (url.pathname.endsWith("/feeds.json")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[]}' });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"posts":[]}' });
    });
    let releaseZero = () => {};
    const zeroGate = new Promise((resolve) => { releaseZero = resolve; });
    await zeroPage.route("https://api.fxtwitter.com/**", async (route) => {
      await zeroGate;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) });
    });
    await zeroPage.goto("http://127.0.0.1:" + port + "/index.html#/@user_a", { waitUntil: "domcontentloaded" });
    const waitingCount = await zeroPage.waitForFunction(() => {
      const loading = Array.from(document.querySelectorAll(".reply-empty")).some((el) => (el.textContent || "").indexOf("Loading") >= 0);
      if (!loading) return null;
      const count = document.querySelector(".profile-chrome-count");
      return { text: count ? count.textContent.trim() : "" };
    }, null, { timeout: 20000 }).catch(() => null);
    if (!waitingCount) {
      releaseZero();
      await zero.close();
      fail("the empty profile did not stay on Loading while the live read was in flight");
    }
    const headerCount = await waitingCount.jsonValue();
    releaseZero();
    await zero.close();
    if (headerCount.text && /^0(\s|$)/.test(headerCount.text)) fail("the header showed a stale zero while the live read was in flight: " + headerCount.text);
    if (errors.length) fail(errors[0]);
    console.log("linked x live ok");
  } finally {
    releaseFx();
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
