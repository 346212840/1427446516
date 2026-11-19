/* Feeds page: an X-style list with platform chips, a switch and a "..." menu.
   Adding a source shows a row at once and its posts reach Home without a deploy. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widths = [
  { width: 1280, height: 800, name: "desktop" },
  { width: 320, height: 640, name: "phone" }
];
const ME = "100000000001";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

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




function account(id, name, extra) {
  return Object.assign({
    id, platform: "telegram", handle: name, name: name, label: "", avatar: "", url: "", channelId: "", groupId: "",
    order: 0, pinned: false, muted: false, paused: false, tabs: [], addedAt: new Date().toISOString(), posts: [],
    health: { status: "ok", code: "", text: "", lastOk: new Date().toISOString(), updatedAt: new Date().toISOString(), nextAt: 0 }
  }, extra || {});
}

async function noOverflow(page, tag, what) {
  const bad = await page.evaluate(() => {
    const org = document.querySelector(".feeds-org");
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push("page " + document.documentElement.scrollWidth + ">" + innerWidth);
    if (org && org.scrollWidth > org.clientWidth + 1) out.push("list " + org.scrollWidth + ">" + org.clientWidth);
    if (org) {
      const box = org.getBoundingClientRect();
      org.querySelectorAll(".feeds-row, .feeds-menu, .feeds-add, .feeds-tools, .feeds-empty, .feeds-banner").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > box.right + 1) out.push(el.className + " " + Math.round(r.right) + ">" + Math.round(box.right));
      });
    }
    return out;
  });
  if (bad.length) fail(tag + ": no overflow " + what + " " + JSON.stringify(bad));
}

async function run(browser, origin, vp) {
  const phoneUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const context = await browser.newContext(Object.assign({ serviceWorkers: "block", viewport: { width: vp.width, height: vp.height }, hasTouch: vp.name === "phone", isMobile: vp.name === "phone" }, vp.name === "phone" ? { userAgent: phoneUa } : {}));
  const tag = vp.name;
  let accounts = [
    account("telegram:member_test", "member_test"),
    account("telegram:device_user", "device_user", { health: { status: "failing", code: "not_found", text: "Account not found.", lastOk: "", updatedAt: new Date().toISOString(), nextAt: 0 } })
  ];
  let listFails = true;
  const sent = [];
  let release = null;
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const where = new URL(req.url()).pathname;
    const reply = (body, status) => route.fulfill({ status: status || 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (err) { body = {}; }
    if (where === "/v1/owner/feeds" && req.method() === "GET") {
      if (listFails) { listFails = false; return reply({ error: "down" }, 503); }
      return reply({ accounts, groups: [], places: [] });
    }
    if (where === "/v1/owner/feeds" && req.method() === "POST") {
      sent.push("add:" + body.input + ":" + body.confirm);
      if (/sync_user/.test(body.input)) {
        await new Promise((resolve) => { release = resolve; });
        const row = account("telegram:sync_user", "sync_user", { name: "Sync User", posts: [{ id: "9001", text: "Fresh post from the new source", date: new Date().toISOString(), url: "https://t.me/sync_user/9001" }] });
        accounts = [row].concat(accounts);
        return reply({ account: row, dispatched: true });
      }
      return reply({ error: "not_found", message: "Account not found." }, 404);
    }
    if (where.indexOf("/v1/owner/feeds/") === 0 && req.method() === "PATCH") {
      sent.push("patch:" + decodeURIComponent(where.slice(16)) + ":" + JSON.stringify(body));
      const id = decodeURIComponent(where.slice(16));
      accounts = accounts.map((row) => row.id === id ? Object.assign({}, row, body) : row);
      return reply({ account: accounts.find((row) => row.id === id) });
    }
    return reply({ posts: [], ok: true });
  });
  const page = await context.newPage();
  await page.addInitScript(([me]) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: me, handle: "owner_test", displayName: "Owner Test", avatar: "", owner: true } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  }, [ME]);
  await page.goto(origin + "/#/feeds", { waitUntil: "domcontentloaded" });
  await page.locator(".feeds-banner.is-error").waitFor({ timeout: 20000 }).catch(() => fail(tag + ": a failed load shows the error banner"));
  await noOverflow(page, tag, "error state");
  await page.evaluate(() => document.querySelector('[data-feed-act="reload"]').click());
  await page.locator('.feeds-row[data-id="telegram:member_test"]').waitFor({ timeout: 10000 }).catch(() => fail(tag + ": retry loads the list"));
  const shape = await page.evaluate(() => {
    const row = document.querySelector('.feeds-row[data-id="telegram:member_test"]');
    const bad = document.querySelector('.feeds-row[data-id="telegram:device_user"]');
    return {
      plat: !!row.querySelector(".feeds-face .feeds-plat"),
      ok: (row.querySelector(".feeds-status") || {}).className || "",
      switchOn: (row.querySelector(".feeds-switch") || {}).getAttribute && row.querySelector(".feeds-switch").getAttribute("aria-checked"),
      more: !!row.querySelector(".feeds-more"),
      bad: (bad.querySelector(".feeds-status") || {}).textContent || "",
      chips: Array.from(document.querySelectorAll(".feeds-chip")).map((b) => b.textContent),
      oldButtons: document.querySelectorAll(".feeds-row-actions").length
    };
  });
  if (!shape.plat || !/is-ok/.test(shape.ok) || shape.switchOn !== "true" || !shape.more) fail(tag + ": row has icon, status, switch and menu " + JSON.stringify(shape));
  if (!/Account not found/.test(shape.bad)) fail(tag + ": a failing source says why " + JSON.stringify(shape));
  if (shape.chips[0] !== "All" || shape.chips.indexOf("Telegram") < 0) fail(tag + ": platform chips " + JSON.stringify(shape.chips));
  if (shape.oldButtons) fail(tag + ": the button wall is gone");
  await noOverflow(page, tag, "list");

  await page.evaluate(() => document.querySelector('.feeds-row[data-id="telegram:member_test"] .feeds-more').click());
  await page.locator('.feeds-row[data-id="telegram:member_test"] .feeds-menu').waitFor({ timeout: 5000 }).catch(() => fail(tag + ": the menu opens"));
  const items = await page.evaluate(() => Array.from(document.querySelectorAll(".feeds-menu-items button")).map((b) => b.textContent));
  for (const want of ["Refresh", "Pin", "Mute", "Remove"]) if (items.indexOf(want) < 0) fail(tag + ": the menu has " + want + " " + JSON.stringify(items));
  await noOverflow(page, tag, "menu open");
  await page.evaluate(() => document.querySelector('.feeds-row[data-id="telegram:member_test"] .feeds-switch').click());
  await page.waitForFunction(() => {
    const sw = document.querySelector('.feeds-row[data-id="telegram:member_test"] .feeds-switch');
    return sw && sw.getAttribute("aria-checked") === "false";
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": the switch turns the source off"));
  if (!sent.some((s) => s === 'patch:telegram:member_test:{"paused":true}')) fail(tag + ": the switch saves paused " + JSON.stringify(sent));

  await page.fill("#feeds-q", "zzzz-nothing");
  await page.locator(".feeds-empty").waitFor({ timeout: 5000 }).catch(() => fail(tag + ": a search with no hits shows the empty state"));
  if (!/No matches/.test(await page.textContent(".feeds-empty"))) fail(tag + ": the empty state says no matches");
  await noOverflow(page, tag, "empty state");
  await page.evaluate(() => document.querySelector('[data-feed-act="clear-filters"]').click());
  await page.locator('.feeds-row[data-id="telegram:member_test"]').waitFor({ timeout: 5000 }).catch(() => fail(tag + ": clear filters brings the list back"));

  // A redraw while typing keeps the text, the caret and the focus in the add box.
  await page.click("#add-account");
  await page.keyboard.type("https://t.me/sync_us");
  await page.evaluate(() => {
    const el = document.getElementById("add-account");
    el.setSelectionRange(5, 5);
    el.dataset.oldNode = "1";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await page.waitForFunction(() => {
    const el = document.getElementById("add-account");
    return el && !el.dataset.oldNode;
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": the page redraws the add box"));
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === "add-account", null, { timeout: 2000 }).catch(() => {});
  const kept = await page.evaluate(() => {
    const el = document.getElementById("add-account");
    return { value: el.value, focus: document.activeElement === el, start: el.selectionStart, end: el.selectionEnd, hint: (document.getElementById("feeds-add-hint") || {}).textContent || "" };
  });
  if (kept.value !== "https://t.me/sync_us") fail(tag + ": a redraw keeps the typed text " + JSON.stringify(kept));
  if (!kept.focus || kept.start !== 5 || kept.end !== 5) fail(tag + ": a redraw keeps focus and caret " + JSON.stringify(kept));
  if (!/Detected: Telegram/.test(kept.hint)) fail(tag + ": a redraw keeps the detected platform " + JSON.stringify(kept));
  await page.keyboard.press("End");
  await page.keyboard.type("er");
  if (await page.inputValue("#add-account") !== "https://t.me/sync_user") fail(tag + ": typing carries on after a redraw");
  await page.fill("#add-account", "https://t.me/sync_user");
  await page.waitForFunction(() => /Detected: Telegram/.test((document.getElementById("feeds-add-hint") || {}).textContent || ""), null, { timeout: 5000 }).catch(() => fail(tag + ": the platform is detected while typing"));
  const t0 = Date.now();
  await page.evaluate(() => document.querySelector("form.add-account button[type=submit]").click());
  await page.locator('.feeds-row.is-pending[aria-busy="true"]').waitFor({ timeout: 2000 }).catch(() => fail(tag + ": the new source shows at once with a progress state"));
  const pendingStatus = await page.evaluate(() => {
    const el = document.querySelector(".feeds-row.is-pending .feeds-status");
    if (!el) return { missing: true };
    const style = getComputedStyle(el);
    return {
      text: (el.textContent || "").trim(),
      w: Math.round(el.getBoundingClientRect().width),
      white: style.whiteSpace,
      cut: el.scrollWidth > el.clientWidth + 2
    };
  });
  if (pendingStatus.missing || pendingStatus.w < 80 || pendingStatus.white === "nowrap" || pendingStatus.cut) fail(tag + ": the pending status is clipped " + JSON.stringify(pendingStatus));
  if (Date.now() - t0 > 2000) fail(tag + ": the pending row took too long");
  if (sent.filter((s) => s.indexOf("add:") === 0).length !== 1 || sent.indexOf("add:https://t.me/sync_user:true") < 0) fail(tag + ": one add request, no separate preview " + JSON.stringify(sent));
  await noOverflow(page, tag, "pending row");
  release();
  await page.locator('.feeds-row[data-id="telegram:sync_user"]').waitFor({ timeout: 5000 }).catch(() => fail(tag + ": the saved row replaces the pending one"));
  if (await page.locator(".feeds-row.is-pending").count()) fail(tag + ": the pending row is gone");
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("article.post")).some((a) => /Fresh post from the new source/.test(a.textContent)), null, { timeout: 8000 }).catch(() => fail(tag + ": the new source's posts are on Home without a deploy"));

  await page.evaluate(() => { location.hash = "#/feeds"; });
  await page.locator("#add-account").waitFor({ timeout: 5000 });
  await page.fill("#add-account", "https://t.me/member_test_gone");
  await page.evaluate(() => document.querySelector("form.add-account button[type=submit]").click());
  await page.locator(".feeds-row.is-pending.is-error").waitFor({ timeout: 5000 }).catch(() => fail(tag + ": a failed add keeps an error row"));
  if (!/Account not found/.test(await page.textContent(".feeds-row.is-pending.is-error"))) fail(tag + ": the error row says why");
  if (!(await page.locator('.feeds-row.is-error [data-feed-act="pending-retry"]').count())) fail(tag + ": the error row offers retry");
  await noOverflow(page, tag, "error row");
  await page.evaluate(() => document.querySelector('[data-feed-act="pending-dismiss"]').click());
  await page.waitForFunction(() => !document.querySelector(".feeds-row.is-pending"), null, { timeout: 5000 }).catch(() => fail(tag + ": dismiss drops the error row"));

  const reload = await context.newPage();
  await reload.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  // A reload resumes the last screen (localfirst.js). The first page may have
  // saved #/feeds before it closed, so open Home explicitly.
  await reload.waitForFunction(() => document.getElementById("app") && document.getElementById("app").childElementCount > 0, null, { timeout: 15000 }).catch(() => {});
  await reload.evaluate(() => { if (location.hash !== "#/") location.hash = "#/"; });
  await reload.waitForFunction(() => { if (location.hash !== "#/") location.hash = "#/"; return Array.from(document.querySelectorAll("article.post")).some((a) => /Fresh post from the new source/.test(a.textContent)); }, null, { timeout: 15000 }).catch(() => fail(tag + ": after a reload Home still has the new posts from the local catalog"));
  await context.close();
  console.log("feeds page ok " + tag);
}

async function runLarge(browser, origin, vp) {
  const phoneUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const context = await browser.newContext(Object.assign({ serviceWorkers: "block", viewport: { width: vp.width, height: vp.height }, hasTouch: vp.name === "phone", isMobile: vp.name === "phone" }, vp.name === "phone" ? { userAgent: phoneUa } : {}));
  const tag = "large-" + vp.name;
  const accounts = [];
  for (let i = 0; i < 240; i++) {
    const platform = ["x", "telegram", "youtube", "rss"][i % 4];
    accounts.push(account(platform + ":feed" + i, "feed" + i, { platform: platform, name: "Feed " + i, order: i }));
  }
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const where = new URL(req.url()).pathname;
    const reply = (body, status) => route.fulfill({ status: status || 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    if (where === "/v1/owner/feeds" && req.method() === "GET") return reply({ accounts: accounts, groups: [], places: [] });
    return reply({ posts: [], ok: true });
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "owner_test", displayName: "Owner Test", avatar: "", owner: true } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  await page.goto(origin + "/#/feeds", { waitUntil: "domcontentloaded" });
  await page.locator(".feeds-fold, .feeds-row").first().waitFor({ timeout: 20000 }).catch(() => fail(tag + ": the list did not paint"));
  const mounted = await page.evaluate(() => ({
    rows: document.querySelectorAll(".feeds-row").length,
    nodes: document.querySelectorAll(".feeds-org *").length,
    height: document.documentElement.scrollHeight,
    view: window.innerHeight,
    folds: document.querySelectorAll(".feeds-fold").length
  }));
  if (mounted.folds < 2) fail(tag + ": platforms are not collapsible " + JSON.stringify(mounted));
  if (mounted.rows >= 80) fail(tag + ": a collapsed list still mounts every row " + JSON.stringify(mounted));
  await page.locator(".feeds-fold").first().click();
  await page.locator(".feeds-row").first().waitFor({ timeout: 5000 }).catch(() => fail(tag + ": opening a section shows its rows"));
  const opened = await page.evaluate(() => ({
    rows: document.querySelectorAll(".feeds-row").length,
    nodes: document.querySelectorAll(".feeds-org *").length,
    height: document.documentElement.scrollHeight,
    view: window.innerHeight
  }));
  if (opened.rows >= 80) fail(tag + ": offscreen rows are still mounted " + JSON.stringify(opened));
  if (opened.rows < 8) fail(tag + ": the open section did not render " + JSON.stringify(opened));
  if (opened.height < opened.view * 2) fail(tag + ": the list is not still scrollable " + JSON.stringify(opened));
  await page.locator(".feeds-expand").first().click();
  await page.waitForFunction(() => {
    const row = document.querySelector(".feeds-row.is-open");
    return row && row.querySelector(".feeds-status");
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": expand shows the details"));
  const openStatus = await page.evaluate(() => {
    const span = document.querySelector(".feeds-row.is-open .feeds-status > span");
    if (!span) return { missing: true };
    return { pos: getComputedStyle(span).position, w: span.getBoundingClientRect().width };
  });
  if (openStatus.missing || openStatus.pos === "absolute" || openStatus.w < 20) fail(tag + ": open details hide the status " + JSON.stringify(openStatus));
  await page.keyboard.press("Escape");
  const more = page.locator(".feeds-row .feeds-more").first();
  await more.focus();
  await page.keyboard.press("ArrowDown");
  const moved = await page.evaluate(() => {
    const el = document.activeElement;
    return !!(el && el.classList.contains("feeds-more"));
  });
  if (!moved) fail(tag + ": arrow keys do not move between rows");
  await page.fill("#feeds-q", "feed200");
  await page.locator('.feeds-row[data-id$="feed200"]').waitFor({ timeout: 5000 }).catch(() => fail(tag + ": search still finds a feed that was not on screen"));
  await noOverflow(page, tag, "large list");
  await context.close();
  console.log("feeds page large ok " + vp.name + " rows " + mounted.rows + " nodes " + mounted.nodes);
}

async function runWindow(browser, origin, vp) {
  const tag = "window-" + vp.name;
  const accounts = [];
  for (let i = 0; i < 80; i++) accounts.push(account("rss:lane" + i, "lane" + i, { platform: "rss", name: i === 70 ? "Zeta Offscreen Source" : "Lane " + i, order: i }));
  for (let i = 0; i < 40; i++) accounts.push(account("telegram:fold" + i, "fold" + i, { platform: "telegram", name: i === 3 ? "Zeta Folded Source" : "Fold " + i, order: 100 + i }));
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: vp.width, height: vp.height } });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const where = new URL(req.url()).pathname;
    const body = where === "/v1/owner/feeds" && req.method() === "GET" ? { accounts: accounts, groups: [], places: [] } : { posts: [], ok: true };
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "owner_test", displayName: "Owner Test", avatar: "", owner: true } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  await page.goto(origin + "/#/feeds", { waitUntil: "domcontentloaded" });
  await page.locator(".feeds-fold").first().waitFor({ timeout: 20000 }).catch(() => fail(tag + ": the list did not paint"));
  const foldedHit = await page.evaluate(() => window.find("Zeta Folded Source", false, false, true));
  if (!foldedHit) fail(tag + ": a folded account name is not findable");
  const hiddenFind = await page.evaluate(() => {
    const span = document.querySelector(".feeds-find");
    return !!(span && span.getAttribute("aria-hidden") === "true");
  });
  if (!hiddenFind) fail(tag + ": an offscreen name is exposed to assistive tech");
  const folds = await page.locator(".feeds-fold").count();
  if (folds < 2) fail(tag + ": expected two sections");
  await page.locator(".feeds-fold").first().focus();
  const foldId = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-id"));
  await page.keyboard.press("Enter");
  await page.locator(".feeds-row").first().waitFor({ timeout: 5000 }).catch(() => fail(tag + ": the section did not open"));
  const foldFocus = await page.evaluate(() => {
    const el = document.activeElement;
    return el && el.classList.contains("feeds-fold") ? el.getAttribute("data-id") : "";
  });
  if (!foldFocus || foldFocus !== foldId) fail(tag + ": the fold control lost keyboard focus");
  const sharedRows = await page.evaluate(() => {
    const closed = document.querySelector(".feeds-window .feeds-row:not(.is-open) .feeds-status > span");
    const probe = document.createElement("article");
    probe.className = "feeds-row";
    probe.innerHTML = '<span class="feeds-copy"><span class="feeds-name">List Name</span><span class="feeds-sub">@list_name</span><span class="feeds-status is-ok"><i class="feeds-dot"></i><span>Posts: 12</span></span></span>';
    document.body.appendChild(probe);
    const copy = getComputedStyle(probe.querySelector(".feeds-copy")).flexDirection;
    const span = probe.querySelector(".feeds-status > span");
    const shown = getComputedStyle(span).position !== "absolute" && span.getBoundingClientRect().width > 40;
    probe.remove();
    return {
      clipped: !!(closed && getComputedStyle(closed).position === "absolute"),
      copy: copy,
      shown: shown
    };
  });
  if (!sharedRows.clipped) fail(tag + ": a closed feed row no longer keeps its status off the row");
  if (sharedRows.copy !== "column" || !sharedRows.shown) fail(tag + ": a shared feed row hides its name or status " + JSON.stringify(sharedRows));
  const dragged = await page.evaluate(() => new Promise((resolve) => {
    const row = document.querySelector('.feeds-row[data-id="rss:lane0"]');
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
    const box = document.querySelector("[data-feed-window]");
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + 900));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const live = document.querySelector('.feeds-row[data-id="rss:lane0"]');
      const same = live === row && !!(live && live.isConnected);
      document.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      resolve({ same: same });
    }));
  }));
  if (!dragged.same) fail(tag + ": a scroll unmounted the row being dragged");
  const stillFrozen = await page.evaluate(() => !!document.querySelector('.feeds-row[data-id="rss:lane0"]'));
  if (stillFrozen) fail(tag + ": dragend left the window frozen");
  async function endDrag(how) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('.feeds-row[data-id="rss:lane0"]').waitFor({ timeout: 5000 }).catch(() => fail(tag + ": " + how + " could not find the first row"));
    const frozen = await page.evaluate(() => new Promise((resolve) => {
      const row = document.querySelector('.feeds-row[data-id="rss:lane0"]');
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
      const box = document.querySelector("[data-feed-window]");
      const top = box.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top + 1400));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(document.querySelector('.feeds-row[data-id="rss:lane0"]') === row);
      }));
    }));
    if (!frozen) fail(tag + ": " + how + " did not start from a frozen drag");
    await page.evaluate((name) => {
      if (name === "drop") {
        const target = document.querySelector('.feeds-row[data-id="rss:lane1"]');
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
      } else if (name === "noop") {
        const head = document.querySelector(".feeds-section-head");
        head.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
      } else if (name === "dragend") {
        document.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      } else if (name === "escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else if (name === "pointercancel") {
        document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true }));
        const still = document.querySelector('.feeds-row[data-id="rss:lane0"]');
        if (!still) window.__pointerCancelReleased = true;
        document.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
      } else if (name === "remount") {
        const chip = document.querySelector('[data-feed-act="platform"][data-platform=""]');
        if (chip) chip.click();
      }
    }, how);
    const released = await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(!document.querySelector('.feeds-row[data-id="rss:lane0"]'));
      }));
    }));
    if (!released) fail(tag + ": " + how + " left the window frozen");
    if (how === "pointercancel" && await page.evaluate(() => window.__pointerCancelReleased)) fail(tag + ": pointercancel aborted a drag that was still moving");
  }
  for (const how of ["drop", "noop", "dragend", "escape", "pointercancel", "remount"]) await endDrag(how);
  await page.evaluate(() => window.scrollTo(0, 0));
  const offscreenHit = await page.evaluate(() => window.find("Zeta Offscreen Source", false, false, true));
  if (!offscreenHit) fail(tag + ": an offscreen account name is not findable");
  if (await page.locator(".feeds-row").count() >= 80) fail(tag + ": findability mounted every row");
  await page.evaluate(() => window.scrollTo(0, 2200));
  await page.waitForFunction(() => window.scrollY > 1500, null, { timeout: 3000 }).catch(() => fail(tag + ": the page did not scroll"));
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll(".feeds-row")).some((el) => {
      const r = el.getBoundingClientRect();
      return r.top > 80 && r.bottom < window.innerHeight;
    });
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": scrolling did not bring a row into view"));
  const target = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll(".feeds-row")).find((el) => {
      const r = el.getBoundingClientRect();
      return r.top > 80 && r.bottom < window.innerHeight;
    });
    return row ? row.getAttribute("data-id") : "";
  });
  if (!target) fail(tag + ": no row to expand");
  await page.locator('.feeds-row[data-id="' + target + '"] .feeds-expand').click();
  const stayed = await page.evaluate((id) => {
    const row = document.querySelector('.feeds-row[data-id="' + id + '"]');
    if (!row) return { ok: false, reason: "missing" };
    const r = row.getBoundingClientRect();
    return { ok: r.bottom > 0 && r.top < window.innerHeight, top: r.top };
  }, target);
  if (!stayed.ok) fail(tag + ": a redraw while scrolled left the row " + JSON.stringify(stayed));
  await page.locator('.feeds-row[data-id="' + target + '"] .feeds-expand').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.feeds-row[data-id="rss:lane0"] .feeds-more').focus();
  await page.keyboard.press("ArrowDown");
  await page.evaluate(() => {
    const box = document.querySelector("[data-feed-window]");
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + box.offsetHeight - window.innerHeight + 8));
  });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll(".feeds-row")).some((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
  }, null, { timeout: 3000 }).catch(() => fail(tag + ": the list did not settle at the bottom"));
  const spanned = await page.locator(".feeds-row").count();
  if (spanned >= 70) fail(tag + ": one arrow key mounted the rows in between (" + spanned + ")");
  const firstGone = await page.locator('.feeds-row[data-id="rss:lane0"]').count();
  if (firstGone) fail(tag + ": the pinned first rows stayed mounted after scrolling away");
  await page.locator(".feeds-row .feeds-more").first().click();
  await page.locator(".feeds-menu input").first().waitFor({ timeout: 5000 }).catch(() => fail(tag + ": the menu has no label field"));
  const menuFit = await page.evaluate(() => {
    const menu = document.querySelector(".feeds-menu");
    const row = menu && menu.closest(".feeds-row");
    const next = row && row.nextElementSibling;
    if (!menu || !next || !next.getBoundingClientRect) return { ok: false, reason: "no neighbour" };
    const menuBox = menu.getBoundingClientRect();
    const nextBox = next.getBoundingClientRect();
    return { ok: menuBox.bottom <= nextBox.top + 1, menuH: Math.round(menu.offsetHeight), gap: Math.round(nextBox.top - menuBox.bottom) };
  });
  if (!menuFit.ok) fail(tag + ": the open menu is taller than the reserved row " + JSON.stringify(menuFit));
  await page.locator(".feeds-menu input").first().focus();
  await page.keyboard.press("ArrowDown");
  const inputStays = await page.evaluate(() => document.activeElement && document.activeElement.tagName === "INPUT");
  if (!inputStays) fail(tag + ": ArrowDown left the menu field");
  await page.locator(".feeds-menu select").first().focus();
  await page.keyboard.press("ArrowDown");
  const selectStays = await page.evaluate(() => document.activeElement && document.activeElement.tagName === "SELECT" && document.activeElement.closest(".feeds-menu"));
  if (!selectStays) fail(tag + ": ArrowDown left the menu list");
  await page.locator(".feeds-menu [role='menuitem']").first().focus();
  await page.keyboard.press("ArrowDown");
  const itemStays = await page.evaluate(() => {
    const el = document.activeElement;
    return !!(el && el.closest && el.closest(".feeds-menu"));
  });
  if (!itemStays) fail(tag + ": ArrowDown left the open menu");
  await page.locator(".feeds-more.on").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.feeds-row[data-id="rss:lane0"] .feeds-expand').click();
  await page.waitForFunction(() => {
    const row = document.querySelector('.feeds-row[data-id="rss:lane0"].is-open');
    if (!row) return false;
    const r = row.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": details did not open"));
  await page.evaluate(() => {
    const box = document.querySelector("[data-feed-window]");
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + box.offsetHeight - window.innerHeight + 8));
  });
  const heldOpen = await page.waitForFunction(() => {
    const row = document.querySelector('.feeds-row[data-id="rss:lane0"]');
    const n = document.querySelectorAll(".feeds-row").length;
    if (!row || n >= 70 || !row.closest(".feeds-window-pin") || row.getBoundingClientRect().bottom >= 0) return false;
    return { n: n, pin: true, off: true };
  }, null, { timeout: 5000 }).catch(() => null);
  const openPlace = heldOpen ? await heldOpen.jsonValue() : null;
  if (!openPlace || !openPlace.pin || !openPlace.off) fail(tag + ": an open row stretched the window " + JSON.stringify(openPlace));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.feeds-row[data-id="rss:lane0"] .feeds-more').click();
  const label = page.locator("#feeds-label-rss\\:lane0");
  await label.waitFor({ timeout: 5000 }).catch(() => fail(tag + ": the rename field did not open"));
  await page.waitForFunction(() => {
    const input = document.querySelector("#feeds-label-rss\\:lane0");
    if (!input) return false;
    const r = input.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": the rename field is off screen"));
  await label.fill("Half written");
  await page.evaluate(() => {
    const box = document.querySelector("[data-feed-window]");
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + box.offsetHeight - window.innerHeight + 8));
  });
  const typed = await page.waitForFunction(() => {
    const input = document.querySelector("#feeds-label-rss\\:lane0");
    const n = document.querySelectorAll(".feeds-row").length;
    if (!input || input.value !== "Half written" || n >= 70) return false;
    return { value: input.value, n: n };
  }, null, { timeout: 5000 }).catch(() => null);
  if (!typed) fail(tag + ": scrolling cleared the rename");
  await page.locator('[data-feed-act="ask-remove"]').click();
  await page.waitForFunction(() => {
    const box = document.querySelector(".feeds-confirm");
    if (!box) return false;
    const r = box.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }, null, { timeout: 5000 }).catch(() => fail(tag + ": remove confirm did not open"));
  await page.evaluate(() => {
    const box = document.querySelector("[data-feed-window]");
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + box.offsetHeight - 40));
  });
  const confirmed = await page.waitForFunction(() => {
    const box = document.querySelector(".feeds-confirm");
    const n = document.querySelectorAll(".feeds-row").length;
    if (!box || n >= 70 || !box.closest(".feeds-window-pin") || box.getBoundingClientRect().bottom >= 0) return false;
    return { n: n, pin: true };
  }, null, { timeout: 5000 }).catch(() => null);
  if (!confirmed) fail(tag + ": the remove confirm stretched the window");
  await page.evaluate(() => {
    const cancel = document.querySelector("[data-feed-act='cancel-remove']");
    if (cancel) cancel.click();
    const open = document.querySelector('.feeds-row[data-id="rss:lane0"] .feeds-expand');
    if (open && open.getAttribute("aria-expanded") === "true") open.click();
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => {
    const button = document.querySelector("[data-feed-act='selecting']");
    if (button) button.click();
  });
  await page.locator(".feeds-check input").first().waitFor({ timeout: 5000 }).catch(() => fail(tag + ": select mode did not add checkboxes"));
  const scrolled = await page.evaluate(() => new Promise((resolve) => {
    const box = document.querySelector("[data-feed-window]");
    const top = box.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top + box.offsetHeight - window.innerHeight + 8));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve({
        n: document.querySelectorAll(".feeds-row").length,
        first: !!document.querySelector('.feeds-row[data-id="rss:lane0"]'),
        checks: document.querySelectorAll(".feeds-check input").length,
        pins: document.querySelectorAll(".feeds-window-pin").length
      });
    }));
  }));
  if (!scrolled.checks || scrolled.n >= 70 || scrolled.first || scrolled.pins) fail(tag + ": select mode kept the rows that scrolled away " + JSON.stringify(scrolled));
  await context.close();
  console.log("feeds window ok " + vp.name);
}

async function runDrop(browser, origin) {
  const accounts = [
    account("rss:loose1", "loose1", { platform: "rss", name: "Loose One", groupId: "" }),
    account("rss:alpha1", "alpha1", { platform: "rss", name: "Alpha One", groupId: "galpha" }),
    account("telegram:beta1", "beta1", { platform: "telegram", name: "Beta One", groupId: "gbeta" })
  ];
  const longName = "Alpha " + "North ".repeat(24);
  const groups = [{ id: "galpha", name: longName, order: 0 }, { id: "gbeta", name: "Beta", order: 1 }];
  const reorders = [];
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const where = new URL(req.url()).pathname;
    const reply = (body, status) => route.fulfill({ status: status || 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    let body = {};
    try { body = JSON.parse(req.postData() || "{}"); } catch (err) { body = {}; }
    if (where === "/v1/owner/feeds" && req.method() === "GET") return reply({ accounts: accounts, groups: groups, places: [] });
    if (where === "/v1/owner/feeds/reorder" && req.method() === "POST") {
      reorders.push(body);
      return reply({ ok: true, accounts: accounts, groups: groups, places: [] });
    }
    return reply({ posts: [], ok: true });
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "owner_test", displayName: "Owner Test", avatar: "", owner: true } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  await page.goto(origin + "/#/feeds", { waitUntil: "domcontentloaded" });
  await page.locator('[data-feed-drag="group:galpha"]').waitFor({ timeout: 20000 }).catch(() => fail("drop: the group head did not paint"));
  await page.locator('.feeds-section-head[data-id="platform:rss"]').waitFor({ timeout: 5000 }).catch(() => fail("drop: the platform head did not paint"));
  const longHead = await page.waitForFunction(() => {
    const head = document.querySelector('.feeds-section-head[data-id="galpha"]');
    const short = document.querySelector('.feeds-section-head[data-id="gbeta"] [data-sp-marquee]');
    if (!head || !short) return null;
    const fold = head.querySelector(".feeds-fold");
    const title = head.querySelector(".sp-marquee-text");
    const count = head.querySelector(".feeds-count");
    const marquee = head.querySelector("[data-sp-marquee]");
    if (!fold || !title || !count || !marquee || !marquee.classList.contains("is-on")) return null;
    const headR = head.getBoundingClientRect();
    const foldR = fold.getBoundingClientRect();
    const countR = count.getBoundingClientRect();
    const below = document.elementFromPoint(Math.min(headR.right - 8, headR.left + 24), headR.bottom + 4);
    return {
      headH: Math.round(headR.height),
      foldH: Math.round(foldR.height),
      nowrap: getComputedStyle(fold).whiteSpace,
      scrolling: true,
      shortStill: short.classList.contains("is-on"),
      countInside: countR.right <= headR.right + 1 && countR.left >= headR.left,
      steals: !!(below && (below === fold || fold.contains(below)))
    };
  }, null, { timeout: 5000 }).catch(() => null);
  if (!longHead) fail("drop: a long section title did not stay on one scrolling line");
  const headShape = await longHead.jsonValue();
  if (headShape.headH !== 40 || headShape.foldH > 40 || headShape.nowrap !== "nowrap" || headShape.shortStill || !headShape.countInside || headShape.steals) fail("drop: a long section title overflows the head " + JSON.stringify(headShape));
  const beforePointer = reorders.length;
  const hit = await page.evaluate(() => {
    const head = document.querySelector('.feeds-section-head[data-id="gbeta"]');
    const rect = head.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { drag: !!(top && top.closest && top.closest("[draggable='true']")), button: !!(top && top.closest && top.closest("button")) };
  });
  if (!hit.drag || hit.button) fail("drop: the fold button still takes the pointer " + JSON.stringify(hit));
  await page.locator('.feeds-section-head[data-id="gbeta"]').dragTo(page.locator('.feeds-section-head[data-id="galpha"]'));
  for (let i = 0; i < 30 && reorders.length === beforePointer; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const pointed = reorders[reorders.length - 1] || {};
  if (JSON.stringify(pointed.groups) !== JSON.stringify(["gbeta", "galpha"])) fail("drop: a pointer drag on the group title did not reorder " + JSON.stringify(reorders));
  const beforeLinger = reorders.length;
  const fromBox = await page.locator('.feeds-section-head[data-id="gbeta"]').boundingBox();
  const outsideBox = await page.locator("#feeds-q").boundingBox();
  const toBox = await page.locator('.feeds-section-head[data-id="galpha"]').boundingBox();
  if (!fromBox || !outsideBox || !toBox) fail("drop: a drag target is not on screen");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(outsideBox.x + outsideBox.width / 2, outsideBox.y + outsideBox.height / 2, { steps: 15 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 15 });
  await page.mouse.up();
  for (let i = 0; i < 40 && reorders.length === beforeLinger; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const lingered = reorders[reorders.length - 1] || {};
  if (JSON.stringify(lingered.groups) !== JSON.stringify(["gbeta", "galpha"])) fail("drop: hovering outside the list cancelled the drag " + JSON.stringify(reorders));
  if (!(await page.locator('.feeds-row[data-id="telegram:beta1"]').count())) fail("drop: dragging the group title folded it");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedHead = await page.waitForFunction(() => {
    const marquee = document.querySelector('.feeds-section-head[data-id="galpha"] [data-sp-marquee]');
    if (!marquee || marquee.classList.contains("is-on")) return null;
    marquee.classList.add("is-on");
    const copy = marquee.querySelector('.sp-marquee-copy[aria-hidden="true"]');
    const text = marquee.querySelector(".sp-marquee-text");
    const held = {
      copy: copy ? getComputedStyle(copy).display : "",
      ellipsis: text ? getComputedStyle(text).textOverflow : ""
    };
    marquee.classList.remove("is-on");
    return held;
  }, null, { timeout: 5000 }).catch(() => null);
  if (!reducedHead) fail("drop: reduced motion left the section title scrolling");
  const reducedShape = await reducedHead.jsonValue();
  if (reducedShape.copy !== "none" || reducedShape.ellipsis !== "ellipsis") fail("drop: reduced motion did not keep a single ellipsis " + JSON.stringify(reducedShape));
  await page.locator('[data-feed-act="platform"][data-platform=""]').click();
  const stayedOff = await page.waitForFunction(() => {
    const marquee = document.querySelector('.feeds-section-head[data-id="galpha"] [data-sp-marquee]');
    return !!(marquee && !marquee.classList.contains("is-on"));
  }, null, { timeout: 5000 }).catch(() => null);
  if (!stayedOff) fail("drop: a redraw turned the section title scroll back on");
  const beforePlatform = reorders.length;
  await page.evaluate(() => {
    const from = document.querySelector('[data-feed-drag="group:galpha"]');
    const to = document.querySelector('.feeds-section-head[data-id="platform:rss"]');
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (reorders.length !== beforePlatform) fail("drop: a platform head saved the group at the end " + JSON.stringify(reorders));
  const beforeGroup = reorders.length;
  await page.evaluate(() => {
    const from = document.querySelector('[data-feed-drag="group:gbeta"]');
    const to = document.querySelector('[data-feed-drag="group:galpha"]');
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 20 && reorders.length === beforeGroup; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const grouped = reorders[reorders.length - 1] || {};
  if (JSON.stringify(grouped.groups) !== JSON.stringify(["gbeta", "galpha"])) fail("drop: a group head did not reorder " + JSON.stringify(reorders));
  const beforeFeed = reorders.length;
  await page.evaluate(() => {
    const from = document.querySelector('[data-feed-drag="rss:loose1"]');
    const to = document.querySelector('.feeds-section-head[data-id="platform:rss"]');
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (reorders.length !== beforeFeed) fail("drop: a platform head accepted a feed " + JSON.stringify(reorders));
  await page.locator('.feeds-section-head[data-id="gbeta"]').click();
  await page.waitForFunction(() => !document.querySelector('.feeds-row[data-id="telegram:beta1"]'), null, { timeout: 5000 }).catch(() => fail("drop: the group did not fold"));
  await page.evaluate(() => {
    const from = document.querySelector('[data-feed-drag="rss:loose1"]');
    const to = document.querySelector('.feeds-section-head[data-id="gbeta"]');
    from.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
    to.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 20 && reorders.length === beforeFeed; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  const moved = reorders[reorders.length - 1] || {};
  if (moved.groupId !== "gbeta" || JSON.stringify(moved.ids) !== JSON.stringify(["telegram:beta1", "rss:loose1"])) fail("drop: a folded group head did not take the feed " + JSON.stringify(reorders));
  await context.close();
  console.log("feeds drop ok");
}

async function runKeys(browser, origin) {
  const accounts = [];
  for (let i = 0; i < 8; i++) accounts.push(account("rss:lane" + i, "lane" + i, { platform: "rss", name: "Lane " + i, order: i }));
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const where = new URL(req.url()).pathname;
    const reply = (body) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    if (where === "/v1/owner/feeds" && req.method() === "GET") return reply({ accounts: accounts, groups: [], places: [] });
    if (where.indexOf("/v1/owner/feed-requests") === 0) {
      return reply({ requests: [{ id: "req_sample", input: "https://example.com/sample-feed", name: "Sample Feed", platform: "rss", handle: "samplefeed", state: "pending", count: 1, at: 1763500000000, people: [{ handle: "asker_one", name: "Asker One" }] }], lists: [], pending: 1, unseen: 0 });
    }
    return reply({ posts: [], ok: true });
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "owner_test", displayName: "Owner Test", avatar: "", owner: true } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  await page.goto(origin + "/#/feeds", { waitUntil: "domcontentloaded" });
  await page.locator(".feeds-row").first().waitFor({ timeout: 20000 }).catch(() => fail("keys: feeds did not paint"));
  const bare = await page.evaluate(() => {
    const host = document.querySelector(".feeds-window-rows");
    const row = document.createElement("article");
    row.className = "feeds-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "feeds-pill";
    btn.textContent = "Allow";
    row.appendChild(btn);
    host.appendChild(row);
    btn.focus();
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, still: document.activeElement === btn };
  });
  if (bare.prevented || !bare.still) fail("keys: a row without data-id stole ArrowDown " + JSON.stringify(bare));
  await page.goto(origin + "/#/settings/feed-requests", { waitUntil: "domcontentloaded" });
  await page.locator(".fr-qrow").first().waitFor({ timeout: 20000 }).catch(() => fail("keys: source requests did not paint"));
  const away = await page.evaluate(() => {
    const org = document.querySelector(".feeds-org");
    const row = document.createElement("article");
    row.className = "feeds-row";
    row.setAttribute("data-id", "rss:lane0");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Allow";
    row.appendChild(btn);
    org.appendChild(row);
    btn.focus();
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    const real = document.querySelector(".fr-qrow button");
    real.focus();
    const ev2 = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    real.dispatchEvent(ev2);
    return { prevented: ev.defaultPrevented || ev2.defaultPrevented, still: document.activeElement === real, id: real.closest(".feeds-row").getAttribute("data-id") };
  });
  if (away.prevented || !away.still || away.id) fail("keys: arrow keys left the source requests page " + JSON.stringify(away));
  await context.close();
  console.log("feeds keys ok");
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const vp of widths) await run(browser, origin, vp);
    for (const vp of [{ width: 390, height: 844, name: "phone" }, { width: 1280, height: 800, name: "desktop" }]) {
      await runLarge(browser, origin, vp);
      await runWindow(browser, origin, vp);
    }
    await runDrop(browser, origin);
    await runKeys(browser, origin);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
