/* Which service-worker scopes belong to this copy of the app.
   The directory in the address is the base. Another directory on the same
   host is an old install: drop that registration. Storage stays, because
   it belongs to the host, not to the directory. */
var ViktorychAppBase = (function (root) {
  function directoryOf(value) {
    var parsed;
    try { parsed = new URL(String(value || ""), "https://app.invalid"); }
    catch (err) { return ""; }
    var path = parsed.pathname || "/";
    if (/\/index\.html$/i.test(path)) path = path.slice(0, -"index.html".length);
    if (/\/sw\.js$/i.test(path)) path = path.slice(0, -"sw.js".length);
    if (/\/[^/]+\.[^/]+$/.test(path)) path = path.replace(/[^/]+$/, "");
    path = path.replace(/\/(?:s|u)\/[^/]+$/, "/");
    if (path.slice(-1) !== "/") path += "/";
    return path;
  }

  function foreignScope(here, scope) {
    var page = directoryOf(here);
    var registered = directoryOf(scope);
    if (!page || !registered) return false;
    return page !== registered;
  }

  function adopt(registrations, here) {
    var list = registrations || [];
    var gone = [];
    var jobs = [];
    for (var i = 0; i < list.length; i++) {
      var reg = list[i];
      var scope = reg && reg.scope ? reg.scope : reg;
      if (!foreignScope(here, scope)) continue;
      gone.push(String(scope));
      if (reg && typeof reg.unregister === "function") jobs.push(reg.unregister());
    }
    return Promise.all(jobs).then(function () { return gone; });
  }

  function here() {
    try { return root.location.href; } catch (err) { return ""; }
  }

  function adoptHere() {
    if (!root.navigator || !root.navigator.serviceWorker || !root.navigator.serviceWorker.getRegistrations) {
      return Promise.resolve([]);
    }
    return root.navigator.serviceWorker.getRegistrations().then(function (regs) {
      return adopt(regs, here());
    }).catch(function () { return []; });
  }

  var api = { directoryOf: directoryOf, foreignScope: foreignScope, adopt: adopt, adoptHere: adoptHere };
  if (root) root.ViktorychAppBase = api;
  return api;
})(typeof globalThis !== "undefined" ? globalThis : this);
if (typeof module !== "undefined" && module.exports) module.exports = ViktorychAppBase;
