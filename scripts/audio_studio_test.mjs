/* Audio Studio tabs on a desktop and a phone. No account and no microphone. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function mime(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file) });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port + "/index.html";
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
  } catch (err) {
    browser = await chromium.launch({ headless: true });
  }
  try {
    for (const size of [
      { name: "desktop", width: 1280, height: 860 },
      { name: "phone", width: 390, height: 844, mobile: true }
    ]) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: !!size.mobile,
        hasTouch: !!size.mobile,
        serviceWorkers: "block"
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(String(err)));
      await page.addInitScript(() => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("superintelapp-lang", "en");
      });
      await page.route("**/*", (route) => (route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort()));
      await page.goto(origin + "#/studio", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#ac-root .ac-title", { timeout: 20000 });
      const tabs = await page.evaluate(() => ({
        title: document.querySelector(".ac-title").textContent,
        hrefs: [...document.querySelectorAll(".ac-pills a")].map((a) => a.getAttribute("href")),
        file: !!document.querySelector("[data-ac-files]"),
        nav: [...document.querySelectorAll(".nav-label")].some((n) => n.textContent === "Audio Studio")
      }));
      if (tabs.title !== "Audio Studio") throw new Error(size.name + " title");
      if (tabs.hrefs.join(" ") !== "#/studio/convert #/studio/voice #/studio/type #/studio/music") throw new Error(size.name + " tabs");
      if (!tabs.file) throw new Error(size.name + " convert input");
      await page.click('a[href="#/studio/voice"]');
      await page.waitForSelector("[data-ac-rec]", { timeout: 10000 });
      const voice = await page.evaluate(() => ({
        rec: !!document.querySelector("[data-ac-rec]"),
        send: document.body.innerText.includes("Send"),
        vk: document.body.innerText.includes("VK")
      }));
      if (!voice.rec) throw new Error(size.name + " record");
      await page.click('a[href="#/studio/type"]');
      await page.waitForSelector("#ac-root", { timeout: 10000 });
      await page.click('a[href="#/studio/music"]');
      await page.waitForSelector("[data-flow-root]", { timeout: 10000 });
      const music = await page.evaluate(() => {
        const desk = matchMedia("(min-width: 700px)").matches && matchMedia("(hover: hover) and (pointer: fine)").matches;
        const text = document.querySelector("[data-flow-root]").innerText;
        return { desk, library: text.includes("Flow Music"), phone: text.includes("desktop only") };
      });
      if (music.desk && !music.library) throw new Error("desktop music library note");
      if (!music.desk && !music.phone) throw new Error("phone music gate");
      if (errors.length) throw new Error(errors[0]);
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log("audio studio page ok");
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
