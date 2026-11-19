/* Two directories of the same files. An old service worker is dropped and
   the sign-in value stored for the host is still there. */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = { URL, Promise };
vm.runInNewContext(fs.readFileSync(path.join(root, "shared/app-base.js"), "utf8"), sandbox);
const base = sandbox.ViktorychAppBase;

test("a different directory is an old install and the current one is kept", () => {
  assert.equal(base.directoryOf("https://viktorychgroup.github.io/Alpha/index.html"), "/Alpha/");
  assert.equal(base.directoryOf("https://viktorychgroup.github.io/Beta/sw.js"), "/Beta/");
  assert.equal(base.foreignScope("https://viktorychgroup.github.io/Beta/", "https://viktorychgroup.github.io/Alpha/"), true);
  assert.equal(base.foreignScope("https://viktorychgroup.github.io/Beta/", "https://viktorychgroup.github.io/Beta/"), false);
  assert.equal(base.foreignScope("https://viktorychapp.pages.dev/", "https://viktorychapp.pages.dev/"), false);
});

test("adopting the new path unregisters only the other directory", async () => {
  const dropped = [];
  const regs = [
    { scope: "https://viktorychgroup.github.io/Alpha/", unregister: () => { dropped.push("Alpha"); return Promise.resolve(true); } },
    { scope: "https://viktorychgroup.github.io/Beta/", unregister: () => { dropped.push("Beta"); return Promise.resolve(true); } }
  ];
  const gone = await base.adopt(regs, "https://viktorychgroup.github.io/Beta/app.html");
  assert.equal(String(gone[0]), "https://viktorychgroup.github.io/Alpha/");
  assert.equal(dropped.map(String).join(","), "Alpha");
});

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "";
  if (!spec) return null;
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    rel = rel.replace(/^\/(?:Alpha|Beta)/, "") || "/";
    if (rel === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      res.end("self.addEventListener('install', function (e) { self.skipWaiting(); }); self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });");
      return;
    }
    if (rel === "/" || rel === "/index.html") {
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(`<!doctype html><html><body><script src="shared/app-base.js"></script><script>
        ViktorychAppBase.adoptHere().then(function () {
          return navigator.serviceWorker.register("sw.js", { scope: "./" });
        }).then(function () { document.body.dataset.ready = "1"; });
      </script></body></html>`);
      return;
    }
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("an old service worker gives way when the new path opens, and the sign-in value stays", async () => {
  const chromium = await loadPlaywright();
  if (!chromium) return;
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(origin + "/Alpha/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.dataset.ready === "1");
    await page.evaluate(() => localStorage.setItem("viktorychapp-account-v1", "kept-sign-in"));
    const first = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((reg) => new URL(reg.scope).pathname));
    assert.ok(first.indexOf("/Alpha/") >= 0, first.join(","));
    await page.goto(origin + "/Beta/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.dataset.ready === "1");
    const after = await page.evaluate(async () => ({
      token: localStorage.getItem("viktorychapp-account-v1"),
      scopes: (await navigator.serviceWorker.getRegistrations()).map((reg) => new URL(reg.scope).pathname),
      path: location.pathname
    }));
    assert.equal(after.token, "kept-sign-in");
    assert.equal(after.path, "/Beta/");
    assert.ok(after.scopes.indexOf("/Beta/") >= 0, after.scopes.join(","));
    assert.equal(after.scopes.indexOf("/Alpha/"), -1, after.scopes.join(","));
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }
});
