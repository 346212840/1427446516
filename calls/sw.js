/* ViktorychCalls service worker. Its scope is this folder only, so it never
   installs or caches the main app. The shell opens from the cache and is
   refreshed in the background. Calls themselves always use the network. */
const CACHE = "viktorych-calls-shell-v3";
const SHELL = [
  "./", "./boot.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./icon-180.png", "./favicon.svg",
  "../calls.js", "../calls.css", "../accounts.config.js", "../shared/call-langs.js", "../shared/call-audio.js", "../shared/call-mode.js",
  "../shared/call-voice.js", "../shared/call-setup.js", "../shared/call-privacy.js", "../shared/call-quality.js", "../shared/call-gemini.js",
  "../shared/call-engine.js", "../vendor/qrcode-1.4.4.js", "../shared/call-speakers.js"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.indexOf("viktorych-calls-") === 0 && name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (/\/v1\//.test(url.pathname) || /\/version\.json$/.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = request.mode === "navigate" ? new Request(new URL("./", self.registration.scope).href) : request;
    const cached = await cache.match(key, { ignoreSearch: request.mode === "navigate" });
    const refresh = fetch(request).then((res) => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    const res = await refresh;
    return res || Response.error();
  })());
});
