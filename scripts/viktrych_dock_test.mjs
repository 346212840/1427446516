/* Corner Viktrych pop-up: the black square opens the same on-device chat as #/ai, Auto lists local models, and a chat continues on the full page. Demo data only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const SHOTS = process.env.SHOTS || "";
const READY = { aiFab: true, theme: "lightsout", aiSetup: { v: 1, done: true, model: "instant", lang: "en", canChange: true, history: "keep" } };

async function open(browser, origin, vp, prefs) {
  const mobile = vp.width < 700;
  const context = await browser.newContext({ serviceWorkers: "block", viewport: vp, hasTouch: mobile, isMobile: mobile });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"stories":[],"ok":true}' }));
  await context.addInitScript((a) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    const k = "viktorychapp-settings-v1";
    const st = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify(Object.assign(st, a.prefs)));
  }, { prefs });
  const page = await context.newPage();
  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app .topbar", { timeout: 20000 });
  await page.waitForSelector('.xdock-panel[data-panel="ai"] .xdock-launcher', { timeout: 20000 });
  await page.waitForTimeout(800);
  return { context, page };
}

function pageVis() {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  return {
    fab: vis("#lai-fab"),
    dock: vis('.xdock-panel[data-panel="ai"] .xdock-launcher'),
    laiOn: document.documentElement.classList.contains("lai-on")
  };
}

const PHRASE = "Dock shared chat 9173";

const server = await startServer();
const origin = `http://127.0.0.1:${server.address().port}`;
const chromium = await loadPlaywright();
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"]
});

try {
  const { context, page } = await open(browser, origin, { width: 1440, height: 900 }, READY);

  const start = await page.evaluate(pageVis);
  if (start.fab) fail("desktop still shows the purple Viktrych button");
  if (!start.dock) fail("desktop is missing the black Viktrych square");
  if (start.laiOn) fail("full-page Viktrych class was on before the pop-up opened");

  await page.click('.xdock-panel[data-panel="ai"] .xdock-launcher');
  await page.waitForSelector(".lai.lai-pop", { timeout: 25000 });
  await page.waitForSelector(".lai.lai-pop .lai-input", { timeout: 15000 });

  const pop = await page.evaluate(() => {
    const vis = (el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      pop: vis(document.querySelector(".lai.lai-pop")),
      input: vis(document.querySelector(".lai.lai-pop .lai-input")),
      back: vis(document.querySelector(".lai.lai-pop .lai-back")),
      close: vis(document.querySelector(".lai.lai-pop .lai-dock-close")),
      laiOn: document.documentElement.classList.contains("lai-on"),
      echo: !!(document.querySelector(".xdock-banner") && getComputedStyle(document.querySelector(".xdock-banner")).display !== "none" && (document.querySelector(".xdock-banner").textContent || "").includes("Local echo")),
      soon: (document.body.innerText || "").includes("AI is coming soon")
    };
  });
  if (!pop.pop || !pop.input) fail("corner pop-up did not show the Viktrych chat");
  if (pop.laiOn) fail("opening the corner pop-up turned on the full-page layout");
  if (!pop.back) fail("corner pop-up is missing the open-in-a-full-page control");
  if (!pop.close) fail("corner pop-up is missing the close control");
  if (pop.echo || pop.soon) fail("corner pop-up still shows the old echo or coming-soon box");

  await page.click('.lai.lai-pop [data-lai="models"]');
  await page.waitForSelector(".lai.lai-pop .lai-menu", { timeout: 8000 });
  const menu = await page.evaluate(() => {
    const text = (document.querySelector(".lai.lai-pop .lai-menu") || {}).innerText || "";
    const names = [...document.querySelectorAll(".lai.lai-pop .lai-menu-name")].map((el) => (el.textContent || "").trim());
    return { text, names };
  });
  if (!/Instant/i.test(menu.text)) fail("Auto model picker is missing the local Instant model");
  if (!/Auto/i.test(menu.text)) fail("model picker is missing Auto");
  if (/ChatGPT|GPT-4|Claude|Gemini API|OpenAI/i.test(menu.text)) fail("model picker listed a cloud model: " + menu.text);
  // Close the menu so it does not cover the box.
  await page.click('.lai.lai-pop [data-lai="models"]');
  await page.waitForTimeout(200);

  await page.fill(".lai.lai-pop .lai-input", PHRASE);
  await page.click('.lai.lai-pop [data-lai="send"]');
  await page.waitForFunction((t) => {
    const root = document.querySelector(".lai.lai-pop");
    return !!(root && root.textContent && root.textContent.includes(t));
  }, PHRASE, { timeout: 20000 });

  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, "pop-1440x900.png"), fullPage: false });
  }

  await page.click(".lai.lai-pop .lai-back");
  await page.waitForFunction(() => location.hash.indexOf("#/ai") === 0 && document.documentElement.classList.contains("lai-on") && document.querySelector(".lai") && !document.querySelector(".lai.lai-pop"), { timeout: 20000 });
  const full = await page.evaluate((t) => {
    const root = document.querySelector(".lai");
    return {
      text: !!(root && root.textContent && root.textContent.includes(t)),
      pop: !!document.querySelector(".lai.lai-pop"),
      laiOn: document.documentElement.classList.contains("lai-on")
    };
  }, PHRASE);
  if (!full.text) fail("the full page did not keep the chat started in the corner");
  if (full.pop) fail("the pop-up class was still on the full-page chat");
  if (!full.laiOn) fail("the full page did not turn on the Viktrych layout");

  if (SHOTS) {
    await page.screenshot({ path: path.join(SHOTS, "pop-full-1440x900.png"), fullPage: false });
  }

  // Leave the page via the same in-app hash change a person uses.
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForFunction(() => {
    const hash = location.hash || "";
    return hash.indexOf("#/ai") !== 0 && !document.documentElement.classList.contains("lai-on");
  }, { timeout: 20000 });

  await context.close();
  console.log("viktrych-dock test ok");
} finally {
  await browser.close();
  server.close();
}
