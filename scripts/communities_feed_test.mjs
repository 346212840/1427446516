/* Communities feed: a busy catalog (429, retry-after) is retried and its
   posts show up. Catalog reads stay at two in flight. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const now = Math.floor(Date.now() / 1000);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function post(name, title) {
  return {
    id: name + "_p0",
    title: title,
    text: "Body " + title,
    author: "author_p",
    score: 4,
    comments: 0,
    created: now - 90,
    media: []
  };
}

function doc(name, titles) {
  return { name: name, title: name, posts: titles.map((title) => post(name + "_" + titles.indexOf(title), title)), recordings: [] };
}

function catalogName(url) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const file = parts.pop() || "";
  if (parts[parts.length - 1] !== "communities") return "";
  if (!file.endsWith(".json") || file === "index.json") return "";
  return file.replace(/\.json$/, "");
}

async function openPage(browser) {
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.error("pageerror", err && err.message ? err.message : err));
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true}' }));
  return page;
}

/* First catalog read is 429 with retry-after 1. The next read returns the
   posts, and both of them show. The feed stays on Loading in between. */
async function busyThenPosts(page, origin) {
  const index = { communities: [
    { name: "placeholder_one", title: "Placeholder One", subscribers: 9000000001, icon: "", banner: "", about: "A placeholder." },
    { name: "placeholder_two", title: "Placeholder Two", subscribers: 9000000000, icon: "", banner: "", about: "Another placeholder." }
  ] };
  const docs = {
    placeholder_one: doc("placeholder_one", ["North wind note"]),
    placeholder_two: doc("placeholder_two", ["South lamp note"])
  };
  const hits = { placeholder_one: [], placeholder_two: [] };
  await page.route("**/data/communities/**", async (route) => {
    const name = catalogName(route.request().url());
    if (!name) {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(index) });
    }
    if (!docs[name]) return route.fulfill({ status: 404, headers: { "cache-control": "no-store" }, body: "missing" });
    hits[name] = hits[name] || [];
    hits[name].push(Date.now());
    if (hits[name].length === 1) {
      return route.fulfill({
        status: 429,
        headers: { "retry-after": "1", "x-limit-scope": "device", "cache-control": "no-store" },
        body: "busy"
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(docs[name]) });
  });
  const gone = page.goto(origin + "/#/communities", { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(hits.placeholder_one.length && hits.placeholder_two.length)) await sleep(15);
  if (!hits.placeholder_one.length || !hits.placeholder_two.length) fail("catalog was not read: " + JSON.stringify({ one: hits.placeholder_one.length, two: hits.placeholder_two.length }));
  const mid = await page.evaluate(() => {
    const hub = document.querySelector(".cm-hub");
    const text = hub ? hub.innerText : "";
    return {
      loading: /Loading/.test(text),
      empty: /No posts yet/.test(text),
      posts: document.querySelectorAll(".cm-x-post").length
    };
  });
  if (!mid.loading || mid.empty || mid.posts) fail("feed left Loading while a retry is pending: " + JSON.stringify(mid));
  await gone;
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.indexOf("North wind note") >= 0 && text.indexOf("South lamp note") >= 0;
  }, null, { timeout: 15000 });
  for (const name of ["placeholder_one", "placeholder_two"]) {
    const times = hits[name];
    if (!times || times.length < 2) fail(name + " was not retried");
    const gap = times[1] - times[0];
    if (gap < 800) fail(name + " ignored retry-after: " + gap + "ms");
  }
  const shown = await page.evaluate(() => ({
    empty: /No posts yet/.test((document.querySelector(".cm-hub") || {}).innerText || ""),
    posts: Array.from(document.querySelectorAll(".cm-x-post")).map((el) => el.innerText)
  }));
  if (shown.empty) fail("empty state after the posts arrived");
  if (shown.posts.length < 2) fail("both posts did not appear: " + shown.posts.length);
  await page.unroute("**/data/communities/**");
}

/* Slow catalog reads overlap. A third one must wait. */
async function twoAtATime(page, origin) {
  const names = ["lane_aa", "lane_bb", "lane_cc", "lane_dd"];
  const index = { communities: names.map((name, i) => ({
    name: name,
    title: "Lane " + name,
    subscribers: 8000000000 - i,
    icon: "",
    banner: "",
    about: "A placeholder lane."
  })) };
  const docs = {};
  names.forEach((name, i) => { docs[name] = doc(name, ["Lane " + (i + 1) + " note"]); });
  let measuring = true;
  let open = 0;
  let max = 0;
  const held = [];
  await page.route("**/data/communities/**", async (route) => {
    const name = catalogName(route.request().url());
    if (!name) {
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(index) });
    }
    const send = () => docs[name]
      ? route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(docs[name]) })
      : route.fulfill({ status: 404, headers: { "cache-control": "no-store" }, body: "missing" });
    if (!measuring) return send();
    open += 1;
    if (open > max) max = open;
    await new Promise((resolve) => held.push(resolve));
    open -= 1;
    return send();
  });
  const gone = page.goto(origin + "/#/communities", { waitUntil: "domcontentloaded" });
  const deadline = Date.now() + 8000;
  while (open < 2 && Date.now() < deadline) await sleep(20);
  if (open < 2) fail("two catalog reads did not overlap (open " + open + ")");
  const until = Date.now() + 400;
  while (Date.now() < until) {
    if (open > 2 || max > 2) fail("more than 2 catalog reads in flight: " + max);
    await sleep(20);
  }
  if (max > 2 || open > 2) fail("more than 2 catalog reads in flight: " + max);
  measuring = false;
  held.splice(0).forEach((release) => release());
  await gone;
  await page.waitForFunction(() => document.querySelectorAll(".cm-x-post").length >= 4, null, { timeout: 15000 });
  await page.unroute("**/data/communities/**");
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const first = await openPage(browser);
    await busyThenPosts(first, origin);
    await first.close();
    const second = await openPage(browser);
    await twoAtATime(second, origin);
    await second.close();
    console.log("communities feed ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
