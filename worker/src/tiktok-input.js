/* Turn whatever a person pastes into a TikTok handle. Accepts @handle or handle, any tiktok.com link (www, m, no scheme,
   %40, query strings like ?_r=1&_t=..., /live, /video/123, trailing slash), text with a link inside it, and the short
   vm. / vt. / tiktok.com/t/ links, which need one redirect lookup (see resolveTikTokShort). */
const HANDLE = /^[A-Za-z0-9._]{2,24}$/;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;
const LINK = /(?:https?:\/\/)?(?:(?:www|m|vm|vt|us|lite)\.)?tiktok\.com\/[^\s<>"'“”‘’)\]]*/i;

function clean(raw) {
  return String(raw == null ? "" : raw).normalize("NFKC").replace(INVISIBLE, "").replace(/[\u00a0\u3000]/g, " ").trim();
}

function handleOf(value) {
  const h = String(value || "").replace(/^@+/, "").replace(/[.]+$/, "");
  return HANDLE.test(h) ? h : "";
}

/* Returns { handle } for a direct match, { short: url } for a short link that must be resolved, or null. */
export function parseTikTokInput(raw) {
  const text = clean(raw);
  if (!text || text.length > 1000) return null;
  const link = text.match(LINK);
  if (link) {
    let url = link[0].replace(/[.,;:!?]+$/, "");
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    let u;
    try { u = new URL(url); } catch (err) { return null; }
    const host = u.hostname.toLowerCase();
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch (err) { /* keep it as it is */ }
    const named = path.match(/^\/@([A-Za-z0-9._]{2,24})(?:\/|$)/);
    if (named) { const h = handleOf(named[1]); return h ? { handle: h } : null; }
    if (/^(?:vm|vt)\.tiktok\.com$/.test(host) && /^\/[A-Za-z0-9_-]{4,40}\/?$/.test(path)) return { short: u.origin + path };
    if (/^(?:www\.|m\.)?tiktok\.com$/.test(host) && /^\/t\/[A-Za-z0-9_-]{4,40}\/?$/.test(path)) return { short: u.origin + path };
    return null;
  }
  const bare = text.match(/^@*([A-Za-z0-9._]{2,24})$/);
  if (bare) { const h = handleOf(bare[1]); return h ? { handle: h } : null; }
  const inText = text.match(/(?:^|\s)@([A-Za-z0-9._]{2,24})(?=$|[\s,;:!?)])/);
  if (inText) { const h = handleOf(inText[1]); return h ? { handle: h } : null; }
  return null;
}

export function normalizeTikTokInput(raw) {
  const got = parseTikTokInput(raw);
  return got && got.handle ? got.handle : "";
}

/* Follow a short link by hand, at most three hops, and only to tiktok.com hosts. fetchFn is fetch in the Worker. */
export async function resolveTikTokShort(url, fetchFn) {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    let res;
    try { res = await fetchFn(current, { method: "GET", redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (compatible; ViktorychApp)" } }); } catch (err) { return ""; }
    const where = res && res.headers && res.headers.get ? res.headers.get("location") : "";
    if (!where) return "";
    let next;
    try { next = new URL(where, current); } catch (err) { return ""; }
    if (!/(?:^|\.)tiktok\.com$/i.test(next.hostname) || next.protocol !== "https:") return "";
    const got = parseTikTokInput(next.href);
    if (got && got.handle) return got.handle;
    current = next.href;
  }
  return "";
}
