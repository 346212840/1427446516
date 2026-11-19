/* The GitHub repository this Worker calls, and the Pages address under it.
   Actions sets GITHUB_REPOSITORY on deploys. A Worker isolate uses the var
   of the same name when it is set, and this constant otherwise. The
   Cloudflare mirror stays viktorychapp.pages.dev and is not this path. */
export const REPO = "ViktorychGroup/ViktorychApp1427446516";
export const PAGES_MIRROR = "https://viktorychapp.pages.dev/";

export function repository(env) {
  const raw = String((env && (env.GITHUB_REPOSITORY || env.REPO)) || "").trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) return raw;
  return REPO;
}

export function pagesBase(env) {
  const parts = repository(env).split("/");
  return "https://" + parts[0].toLowerCase() + ".github.io/" + parts[1] + "/";
}

export function appContact(env) {
  return pagesBase(env).replace(/\/$/, "");
}

export function githubApi(env, path) {
  const suffix = String(path || "");
  return "https://api.github.com/repos/" + repository(env) + (suffix.charAt(0) === "/" ? suffix : "/" + suffix);
}
