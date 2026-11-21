/* ViktorychCalls: the stand-alone call page. It loads only the call code,
   not the app around it. A guest link opens straight to the join screen. */
window.VIKTORYCH_CALLS_STANDALONE = true;

const PACKS = {};
function pickLang() {
  const valid = (code) => { const c = String(code || "").toLowerCase().split("-")[0]; return c === "es" || c === "ru" || c === "hi" ? c : (c === "en" ? "en" : ""); };
  try {
    const saved = valid(localStorage.getItem("superintelapp-lang"));
    if (saved) return saved;
  } catch (err) { /* private mode */ }
  const list = navigator.languages || [navigator.language];
  for (let i = 0; i < list.length; i++) { const hit = valid(list[i]); if (hit) return hit; }
  return "en";
}
const lang = pickLang();
/* The language packs call SIntel-style addPack. Only the chosen one is fetched. */
window.SI18n = {
  addPack(code, table) { PACKS[code] = table; },
  t(key, vars) {
    const table = PACKS[lang] || {};
    let text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    if (vars) text = String(text).replace(/\{(\w+)\}/g, (all, name) => (vars[name] == null ? "" : String(vars[name])));
    return text;
  },
  /* Plural forms by locale (Russian has one, few, many and other). Packs hold key.one, key.few, key.many, key.other. */
  tn(key, n, vars) {
    const value = Number(n) || 0;
    let cat = "other";
    try { cat = new Intl.PluralRules(lang).select(value); } catch (err) { /* one form */ }
    const table = PACKS[lang] || {};
    let chosen = key + "." + cat;
    if (!Object.prototype.hasOwnProperty.call(table, chosen) && cat !== "other") chosen = key + ".other";
    let shown = String(value);
    try { shown = new Intl.NumberFormat(lang).format(value); } catch (err) { /* plain number */ }
    return window.SI18n.t(chosen, Object.assign({ n: shown }, vars || {}));
  },
  getLang() { return lang; }
};
window.t = window.SI18n.t;
document.documentElement.lang = lang;
function loadPack() {
  return new Promise((resolve) => {
    if (lang === "en") { resolve(); return; }
    const el = document.createElement("script");
    el.src = "i18n/" + lang + ".js";
    el.onload = el.onerror = () => resolve();
    document.head.appendChild(el);
  });
}

function routeFromHash() {
  const hash = location.hash.replace(/^#\/?/, "");
  const query = new URLSearchParams(location.search);
  if (/^ci1\.[A-Za-z0-9_-]{8,80}$/.test(hash)) return { name: "callguest", token: hash, query };
  if (/^cs1\.[A-Za-z0-9_-]{8,80}$/.test(hash)) return { name: "callschedule", token: hash, query };
  const link = hash.match(/^u\/([a-z0-9-]{3,30})$/);
  if (link) return { name: "calllink", slug: link[1], query };
  const id = hash.match(/^([a-f0-9]{32})$/);
  return { name: "calls", id: id ? id[1] : "", query };
}

/* Install: the name is the person's to choose. The manifest is rebuilt
   with it, and iOS gets it as the Add to Home Screen title. */
let deferred = null;
const ICONS = [["icon-192.png", "192x192", "any"], ["icon-512.png", "512x512", "any"], ["icon-maskable-512.png", "512x512", "maskable"]];
function chosenName() {
  try { return localStorage.getItem("viktorych-calls-pwa-name") || "ViktorychCalls"; } catch (err) { return "ViktorychCalls"; }
}
let manifestUrl = "";
function buildManifest(name) {
  const root = new URL("calls/", document.baseURI).href;
  const doc = {
    id: new URL("calls/", document.baseURI).pathname,
    name: name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: "Voice and text calls with live translation.",
    start_url: root,
    scope: root,
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    prefer_related_applications: false,
    icons: ICONS.map((row) => ({ src: root + row[0], sizes: row[1], type: "image/png", purpose: row[2] }))
  };
  return new Blob([JSON.stringify(doc)], { type: "application/manifest+json" });
}
window.ViktorychCallsInstall = {
  can() { return !!deferred; },
  async prompt() {
    if (!deferred) return;
    deferred.prompt();
    try { await deferred.userChoice; } catch (err) { /* dismissed */ }
    deferred = null;
    if (window.ViktorychCalls) window.ViktorychCalls.repaint();
  },
  rename(name) {
    const clean = String(name || "ViktorychCalls").slice(0, 30);
    const link = document.getElementById("calls-manifest");
    if (manifestUrl) URL.revokeObjectURL(manifestUrl);
    manifestUrl = URL.createObjectURL(buildManifest(clean));
    if (link) link.setAttribute("href", manifestUrl);
    const ios = document.getElementById("calls-ios-title");
    if (ios) ios.setAttribute("content", clean);
    document.title = clean;
  }
};
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferred = event;
  if (window.ViktorychCalls) window.ViktorychCalls.repaint();
});
window.addEventListener("appinstalled", () => { deferred = null; });

async function start() {
  await loadPack();
  const name = chosenName();
  if (name !== "ViktorychCalls") window.ViktorychCallsInstall.rename(name);
  else {
    const ios = document.getElementById("calls-ios-title");
    if (ios) ios.setAttribute("content", name);
  }
  await import("../calls.js");
  const root = document.getElementById("calls-root");
  const draw = () => {
    const route = routeFromHash();
    root.innerHTML = window.ViktorychCalls.page(route);
    window.ViktorychCalls.mount(route);
  };
  draw();
  window.addEventListener("hashchange", () => {
    if (document.querySelector('.calls-page[data-phase="active"], .calls-page[data-phase="calling"]')) return;
    draw();
  });
  document.addEventListener("click", (event) => {
    const el = event.target.closest && event.target.closest("[data-act]");
    if (!el || el.tagName === "FORM" || el.tagName === "INPUT" || el.tagName === "SELECT") return;
    if (el.closest("form[data-act]") && el.tagName !== "BUTTON") return;
    if (el.type === "submit") return;
    window.ViktorychCalls.onAct(el.dataset.act, el);
  });
  /* Ringing without the app shell: look for a call while the page is open. */
  setInterval(() => {
    if (document.visibilityState === "visible" && window.ViktorychCalls.checkIncoming) window.ViktorychCalls.checkIncoming("");
  }, 7000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("calls/sw.js", { scope: "calls/" }).catch(() => { /* the page works without it */ });
  }
}
start();
