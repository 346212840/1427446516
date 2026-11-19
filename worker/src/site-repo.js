/* The GitHub repository the Worker calls.
   GITHUB_REPOSITORY is the one configured name. After a rename, GitHub
   answers a request for the old name with a redirect, and that target is
   the name used for Pages and for workflow dispatch. */
export const REPO = "ViktorychGroup/ViktorychApp";
const cache = new Map();

export function configuredRepository(env) {
  const raw = String((env && (env.GITHUB_REPOSITORY || env.REPO)) || "").trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  return REPO;
}

export function pagesBase(repo) {
  const parts = String(repo || REPO).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
  return "https://" + parts[0].toLowerCase() + ".github.io/" + parts[1] + "/";
}

export function pagesBaseFor(env) {
  return pagesBase(configuredRepository(env));
}

export function appContact(env) {
  return pagesBaseFor(env).replace(/\/$/, "");
}

function apiUrl(location) {
  let url;
  try { url = new URL(String(location || "")); }
  catch (err) { return null; }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com") return null;
  if (url.username || url.password || url.port) return null;
  return url;
}

export function repoFromRedirect(location) {
  const url = apiUrl(location);
  if (!url) return "";
  const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]) + "/" + decodeURIComponent(match[2]);
  } catch (err) {
    return match[1] + "/" + match[2];
  }
}

/* A rename or transfer answers with /repositories/<id>, not /repos/owner/name. */
export function repositoryIdFromRedirect(location) {
  const url = apiUrl(location);
  if (!url) return null;
  const match = url.pathname.match(/^\/repositories\/(\d+)(\/.*)?$/);
  if (!match) return null;
  const suffix = match[2] && match[2] !== "/" ? match[2].replace(/\/$/, "") : "";
  return { id: match[1], suffix };
}

function githubHeaders(env) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "viktorych-accounts",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const token = String((env && env.GITHUB_DISPATCH_TOKEN) || "").trim();
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

function moved(status) {
  return status === 301 || status === 302 || status === 307 || status === 308;
}

async function nameForRepositoryId(env, id, fetcher) {
  const res = await fetcher("https://api.github.com/repositories/" + id, {
    method: "GET",
    redirect: "manual",
    headers: githubHeaders(env)
  });
  if (!res || !res.ok) return "";
  let data = null;
  try { data = await res.json(); }
  catch (err) { return ""; }
  const name = data && data.full_name;
  return /^[^/\s]+\/[^/\s]+$/.test(name) ? name : "";
}

function idTarget(byId, path) {
  if (byId.suffix) return "https://api.github.com/repositories/" + byId.id + byId.suffix;
  const extra = String(path || "");
  const tail = !extra ? "" : (extra.charAt(0) === "/" ? extra : "/" + extra);
  return "https://api.github.com/repositories/" + byId.id + tail;
}

export async function resolveRepository(env, fetcher) {
  const start = configuredRepository(env);
  if (cache.has(start)) return cache.get(start);
  const f = fetcher || fetch;
  try {
    const res = await f("https://api.github.com/repos/" + start, {
      method: "GET",
      redirect: "manual",
      headers: githubHeaders(env)
    });
    const status = res && res.status;
    const location = res && res.headers && res.headers.get && res.headers.get("location");
    if (moved(status) && location) {
      const named = repoFromRedirect(location);
      if (named) {
        cache.set(start, named);
        return named;
      }
      const byId = repositoryIdFromRedirect(location);
      if (byId) {
        const full = await nameForRepositoryId(env, byId.id, f);
        if (full) {
          cache.set(start, full);
          return full;
        }
        return start;
      }
    }
    cache.set(start, start);
  } catch (err) { /* the configured name still works when GitHub cannot be asked */ }
  return start;
}

export function githubApi(repo, path) {
  const suffix = String(path || "");
  return "https://api.github.com/repos/" + repo + (suffix.charAt(0) === "/" ? suffix : "/" + suffix);
}

/* One API call when the name is current. A rename redirect is followed once.
   GitHub sends /repositories/<id>; that URL gets the same method and body,
   and GET /repositories/<id> supplies the full_name for the next call. */
export async function githubFetch(env, path, init, fetcher) {
  const f = fetcher || fetch;
  const key = configuredRepository(env);
  const repo = cache.has(key) ? cache.get(key) : key;
  const opts = Object.assign({}, init || {}, { redirect: "manual" });
  const res = await f(githubApi(repo, path), opts);
  const status = res && res.status;
  const location = res && res.headers && res.headers.get && res.headers.get("location");
  if (!moved(status) || !location) return res;
  const named = repoFromRedirect(location);
  if (named && named !== repo) {
    cache.set(key, named);
    return f(githubApi(named, path), opts);
  }
  const byId = repositoryIdFromRedirect(location);
  if (!byId) return res;
  const sent = await f(idTarget(byId, path), opts);
  try {
    const full = await nameForRepositoryId(env, byId.id, f);
    if (full) cache.set(key, full);
  } catch (err) { /* the resent call still stands; the next one can ask again */ }
  return sent;
}
