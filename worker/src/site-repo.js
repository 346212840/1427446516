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

export function repoFromRedirect(location) {
  const match = String(location || "").match(/\/repos\/([^/?#]+)\/([^/?#]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]) + "/" + decodeURIComponent(match[2]);
  } catch (err) {
    return match[1] + "/" + match[2];
  }
}

export async function resolveRepository(env, fetcher) {
  const start = configuredRepository(env);
  if (cache.has(start)) return cache.get(start);
  const f = fetcher || fetch;
  let found = start;
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "viktorych-accounts",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    const token = String((env && env.GITHUB_DISPATCH_TOKEN) || "").trim();
    if (token) headers.Authorization = "Bearer " + token;
    const res = await f("https://api.github.com/repos/" + start, { method: "GET", redirect: "manual", headers });
    const status = res && res.status;
    const location = res && res.headers && res.headers.get && res.headers.get("location");
    if ((status === 301 || status === 302 || status === 307 || status === 308) && location) {
      const next = repoFromRedirect(location);
      if (next) found = next;
    }
  } catch (err) { /* the configured name still works when GitHub cannot be asked */ }
  cache.set(start, found);
  return found;
}

export function githubApi(repo, path) {
  const suffix = String(path || "");
  return "https://api.github.com/repos/" + repo + (suffix.charAt(0) === "/" ? suffix : "/" + suffix);
}
