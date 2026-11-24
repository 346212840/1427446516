/* A merged linked X account keeps its posts and replies when fxtwitter
   answers with its flaky empty 404: the read is retried, falls back to the
   Worker mirror, pages further for replies, and a failed refresh keeps
   what the profile already showed (switch linked_x_steady). */
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
      return res.end('{"posts":[]}');
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

const ACCOUNT = {
  publicId: "100000000001",
  handle: "user_a",
  displayName: "User A",
  identities: [{ id: "ident-x", platform: "x", handle: HANDLE, merged: true, verified: true, hidden: false, audience: "public" }]
};

function fxStatus(id, text, reply, minutesAgo) {
  const row = {
    id: id,
    text: text,
    created_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
    author: { screen_name: HANDLE, name: "North Wind" }
  };
  if (reply) row.replying_to = { screen_name: "otherlane", status: "1" };
  return row;
}
const EMPTY_404 = { status: 404, contentType: "application/json", body: JSON.stringify({ code: 404, results: [], cursor: { top: null, bottom: null } }) };

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
    await page.addInitScript((account) => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: [], lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: account }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    }, ACCOUNT);
    const mode = { down: false, mirror: 0, timeline: 0 };
    await page.route("**/v1/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/v1/profile/user_a") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ account: ACCOUNT, reposts: [] }) });
      }
      if (url.pathname === "/v1/x/2/profile/" + HANDLE + "/statuses" && !url.searchParams.get("with_replies")) {
        mode.mirror += 1;
        if (mode.down) return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"upstream"}' });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, results: [fxStatus("9001", "Mirror north wind note", false, 30)] }) });
      }
      if (url.pathname.startsWith("/v1/x/")) return route.fulfill({ status: 502, contentType: "application/json", body: '{"error":"upstream"}' });
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"posts":[]}' });
    });
    await page.route("https://api.fxtwitter.com/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/" + HANDLE) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ user: { screen_name: HANDLE, name: "North Wind" } }) });
      }
      mode.timeline += 1;
      if (mode.down) return route.fulfill(EMPTY_404);
      if (url.pathname.endsWith("/media")) return route.fulfill({ status: 200, contentType: "application/json", body: '{"code":200,"results":[]}' });
      if (url.searchParams.get("with_replies") !== "1") return route.fulfill(EMPTY_404);
      const cursor = url.searchParams.get("cursor") || "";
      const pages = {
        "": { results: [fxStatus("9101", "First north wind reply", true, 10)], cursor: { bottom: "c2" } },
        c2: { results: [fxStatus("9102", "Second north wind reply", true, 70)], cursor: { bottom: "c3" } },
        c3: { results: [fxStatus("9103", "Third north wind reply", true, 130)], cursor: { bottom: null } }
      };
      const pack = pages[cursor] || { results: [], cursor: { bottom: null } };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Object.assign({ code: 200 }, pack)) });
    });

    await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("text=Mirror north wind note", { timeout: 25000 }).catch(() => fail("a post did not come through the mirror after fxtwitter kept answering 404"));
    await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_a?tab=replies", { waitUntil: "domcontentloaded" });
    for (const text of ["First north wind reply", "Second north wind reply", "Third north wind reply"]) {
      await page.waitForSelector("text=" + text, { timeout: 20000 }).catch(() => fail("the replies tab is missing a reply from a later page: " + text));
    }

    /* Everything fails now. A refresh two minutes later must keep the list. */
    mode.down = true;
    const before = mode.timeline;
    await page.evaluate(() => {
      const real = Date.now.bind(Date);
      Date.now = () => real() + 5 * 60 * 1000;
      location.hash = "#/@user_a";
    });
    await page.waitForFunction(() => true);
    const start = Date.now();
    while (mode.timeline === before && Date.now() - start < 20000) await new Promise((r) => setTimeout(r, 200));
    if (mode.timeline === before) fail("the profile did not refresh the live read");
    await new Promise((r) => setTimeout(r, 6000));
    await page.waitForSelector("text=Mirror north wind note", { timeout: 10000 }).catch(() => fail("a failed refresh emptied the posts"));
    await page.evaluate(() => { location.hash = "#/@user_a?tab=replies"; });
    await page.waitForSelector("text=Third north wind reply", { timeout: 10000 }).catch(() => fail("a failed refresh emptied the replies"));
    if (errors.length) fail(errors[0]);
    console.log("linked x steady ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
