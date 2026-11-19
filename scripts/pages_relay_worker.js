/* Pages advanced-mode worker for the Calls relay. _routes.json sends only
   /v1/calls/live here; every other path is served as static files. It is the
   same stateless socket the main Worker offers: it forwards frames to Gemini
   Live with the short-lived token the browser already holds. It has no key,
   no database and no logs. A second hostname helps where workers.dev is
   blocked or throttled. */
const GEMINI = "https://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/calls/live") return env.ASSETS.fetch(request);
    if (String(request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response('{"error":"upgrade"}', { status: 426, headers: { "content-type": "application/json" } });
    const token = String(url.searchParams.get("t") || "");
    if (!/^[A-Za-z0-9_.~-]{8,400}$/.test(token)) return new Response('{"error":"token"}', { status: 400, headers: { "content-type": "application/json" } });
    let upstream = null;
    try { upstream = await fetch(GEMINI + encodeURIComponent(token), { headers: { Upgrade: "websocket" } }); } catch (err) { upstream = null; }
    const up = upstream && upstream.webSocket;
    if (!up) return new Response('{"error":"upstream"}', { status: 502, headers: { "content-type": "application/json" } });
    try { up.binaryType = "arraybuffer"; } catch (err) { /* the default is fine on newer runtimes */ }
    up.accept();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const closeBoth = (code) => {
      try { server.close(code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000); } catch (err) { /* closed */ }
      try { up.close(1000); } catch (err) { /* closed */ }
    };
    server.addEventListener("message", (event) => { try { up.send(event.data); } catch (err) { /* closed */ } });
    /* Gemini sends binary text frames. A Blob cannot be sent on as is (it turns into "[object Blob]"), so frames are
       turned into bytes first and kept in order. */
    let chain = Promise.resolve();
    up.addEventListener("message", (event) => {
      chain = chain.then(async () => {
        let data = event.data;
        if (data && typeof data !== "string" && typeof data.arrayBuffer === "function") data = await data.arrayBuffer();
        try { server.send(data); } catch (err) { /* closed */ }
      });
    });
    server.addEventListener("close", (event) => closeBoth(event.code));
    up.addEventListener("close", (event) => closeBoth(event.code));
    server.addEventListener("error", () => closeBoth(1011));
    up.addEventListener("error", () => closeBoth(1011));
    return new Response(null, { status: 101, webSocket: client });
  }
};
