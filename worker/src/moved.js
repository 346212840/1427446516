/* The app moved: the owner and repository were renamed, so the old github.io
   address answers 404 and an installed app there keeps running from its own
   saved copy. That copy still calls this Worker, with the old Origin.
   For those requests the Worker adds:
   - a post at the top of For you (feeds.json through /v1/data) whose link opens
     the new address with a one-time sign-in code in the URL fragment;
   - a notification saying the same, so the bell shows it too.
   /v1/features also names the new address (`moved`) for any request from a
   retired origin, so a later move can show the new app's own banner.
   The code is stateless (HMAC with ACCOUNT_PEPPER), valid for at most two
   hours and works once: its nonce is stored when it is exchanged. Switch: app_moved. */

import { pagesBaseFor } from "./site-repo.js";

export const RETIRED_ORIGINS = ["https://viktorych" + "group.github.io"];
export const HANDOFF_MS = 2 * 60 * 60 * 1000;
const BUCKET_MS = 60 * 60 * 1000;
export const MOVED_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS moved_handoff_used (nonce TEXT PRIMARY KEY, public_id TEXT NOT NULL, used_at INTEGER NOT NULL)"
];

export function movedTarget(env) {
  const raw = String((env && env.MOVED_TO) || "").trim();
  if (/^https:\/\/[^\s#?]+\/$/.test(raw)) return raw;
  return pagesBaseFor(env);
}

export function retiredOrigins(env) {
  const raw = String((env && env.MOVED_FROM) || "").trim();
  const list = raw ? raw.split(",").map((item) => item.trim()).filter(Boolean) : RETIRED_ORIGINS;
  return list.map((item) => item.replace(/\/+$/, "").toLowerCase());
}

export function fromRetired(request, env) {
  const origin = String((request && request.headers && request.headers.get("origin")) || "").replace(/\/+$/, "").toLowerCase();
  return !!origin && retiredOrigins(env).indexOf(origin) >= 0;
}

/* <publicId>.<expiry, base36 seconds>.<nonce>.<signature> */
export async function mintHandoff(env, publicId, deps, now) {
  if (!env || !env.ACCOUNT_PEPPER || !/^\d{12}$/.test(String(publicId || ""))) return "";
  const at = Number(now) || Date.now();
  /* One code per account per hour, so the feed and notification bodies stay
     the same for the hour and the client's unchanged-body check still works.
     It expires one hour after its hour ends (at most two hours). */
  const bucket = Math.floor(at / BUCKET_MS);
  const nonce = (await deps.hmacHex(env.ACCOUNT_PEPPER, "moved-nonce:" + publicId + ":" + bucket)).slice(0, 16);
  const payload = String(publicId) + "." + Math.floor(((bucket + 1) * BUCKET_MS + HANDOFF_MS / 2) / 1000).toString(36) + "." + nonce;
  const sig = (await deps.hmacHex(env.ACCOUNT_PEPPER, "moved-handoff:" + payload)).slice(0, 32);
  return payload + "." + sig;
}

export async function readHandoff(env, code, deps, now) {
  const text = String(code || "").trim();
  const m = text.match(/^(\d{12})\.([0-9a-z]{1,10})\.([0-9a-f]{16})\.([0-9a-f]{32})$/);
  if (!m || !env || !env.ACCOUNT_PEPPER) return null;
  const payload = m[1] + "." + m[2] + "." + m[3];
  const want = (await deps.hmacHex(env.ACCOUNT_PEPPER, "moved-handoff:" + payload)).slice(0, 32);
  if (!deps.timingEqual(want, m[4])) return null;
  const expires = parseInt(m[2], 36) * 1000;
  if (!(expires > (Number(now) || Date.now()))) return { expired: true };
  return { publicId: m[1], nonce: m[3], expires };
}

export function handoffUrl(env, code) {
  return movedTarget(env) + (code ? "#/moved=" + code : "");
}

const COPY = {
  en: ["This app moved to a new address. Tap below to open it — you stay signed in.", "Open the new app", "The app moved to a new address. Open your home feed and tap the newest post from 1427446516 to continue there, signed in."],
  es: ["Esta app se mudó a una nueva dirección. Toca abajo para abrirla: seguirás con tu sesión iniciada.", "Abrir la nueva app", "La app se mudó a una nueva dirección. Abre tu inicio y toca la publicación más reciente de 1427446516 para seguir allí con tu sesión."],
  ru: ["Приложение переехало на новый адрес. Нажмите ниже, чтобы открыть его — вход сохранится.", "Открыть новое приложение", "Приложение переехало на новый адрес. Откройте ленту и нажмите на свежий пост от 1427446516, чтобы продолжить там без повторного входа."],
  hi: ["यह ऐप नए पते पर चला गया है। खोलने के लिए नीचे टैप करें — आप साइन इन रहेंगे।", "नया ऐप खोलें", "ऐप नए पते पर चला गया है। होम फ़ीड खोलें और वहाँ साइन इन रहकर जारी रखने के लिए 1427446516 की सबसे नई पोस्ट पर टैप करें।"]
};

export function movedCopy(request) {
  const raw = String((request && request.headers && request.headers.get("accept-language")) || "").toLowerCase();
  const first = raw.split(",").map((part) => part.trim().slice(0, 2)).find((code) => COPY[code]);
  return COPY[first || "en"];
}

export function movedPost(env, request, code, now) {
  const at = Number(now) || Date.now();
  const bucket = Math.floor(at / BUCKET_MS);
  const copy = movedCopy(request);
  const url = handoffUrl(env, code);
  const shown = movedTarget(env);
  return {
    id: "app-moved-" + bucket,
    statusId: "app-moved-" + bucket,
    platform: "app",
    feedId: "app:moved",
    kind: "post",
    author: "1427446516",
    handle: "1427446516",
    avatar: "",
    verifiedType: "organization",
    text: copy[0] + "\n\n" + url,
    links: [{ url: url, expanded: url, display: copy[1] }],
    date: new Date(bucket * BUCKET_MS).toISOString(),
    url: shown,
    media: [],
    images: [],
    repostedBy: null,
    replyingTo: null,
    quoted: null
  };
}

export function movedFeed(env) {
  return {
    id: "app:moved",
    platform: "app",
    handle: "1427446516",
    name: "1427446516",
    title: "1427446516",
    avatar: "",
    bio: "",
    url: movedTarget(env),
    verifiedType: "organization",
    configured: true
  };
}

/* Adds the moved post and its source to a feeds.json document. */
export function injectFeed(doc, env, request, code, now) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.posts)) return doc;
  const post = movedPost(env, request, code, now);
  const feeds = Array.isArray(doc.feeds) ? doc.feeds.filter((feed) => !feed || feed.id !== "app:moved") : [];
  feeds.unshift(movedFeed(env));
  const posts = doc.posts.filter((item) => !item || item.feedId !== "app:moved");
  posts.unshift(post);
  return Object.assign({}, doc, { feeds: feeds, posts: posts });
}

export function movedNote(request, now) {
  const copy = movedCopy(request);
  const at = Number(now) || Date.now();
  return {
    id: "app-moved",
    kind: "dm",
    at: Math.floor(at / BUCKET_MS) * BUCKET_MS,
    handle: "1427446516",
    name: "1427446516",
    text: copy[2],
    hash: "#/"
  };
}

export function injectNotes(view, request, now) {
  if (!view || typeof view !== "object" || !Array.isArray(view.items)) return view;
  if (view.items.some((item) => item && item.id === "app-moved")) return view;
  return Object.assign({}, view, { items: [movedNote(request, now)].concat(view.items) });
}

/* POST /v1/moved/exchange { code } from the new address: one session.
   POST /v1/moved/handoff (signed in): a code and URL for this account. */
export async function handleMoved(request, env, path, deps) {
  if (request.method !== "POST") return deps.json(405, { error: "method" });
  if (path === "/v1/moved/handoff") {
    const row = await deps.sessionAccount(env, request);
    if (!row || !/^\d{12}$/.test(String(row.public_id || ""))) return deps.json(401, { error: "unauthorized" });
    const gate = await deps.rateHit(env, "mvh:" + row.public_id, 20, 60 * 60 * 1000);
    if (!gate.ok) return deps.limited(gate);
    const code = await mintHandoff(env, row.public_id, deps);
    if (!code) return deps.json(503, { error: "not_configured" });
    return deps.json(200, { url: handoffUrl(env, code), expiresIn: HANDOFF_MS / 1000 });
  }
  if (path === "/v1/moved/exchange") {
    const ip = deps.clientIp(request);
    const gate = await deps.rateHit(env, "mvx:" + ip, 10, 60 * 60 * 1000);
    if (!gate.ok) return deps.limited(gate);
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const read = await readHandoff(env, body.code, deps);
    if (!read) return deps.json(401, { error: "handoff_invalid" });
    if (read.expired) return deps.json(401, { error: "handoff_expired" });
    if (await deps.blockDeletedLogin(env, read.publicId)) return deps.json(410, { error: "account_deleted" });
    const row = await env.DB.prepare("SELECT " + deps.accountCols + " FROM accounts WHERE public_id = ?").bind(read.publicId).first();
    if (!row) return deps.json(401, { error: "handoff_invalid" });
    await env.DB.prepare(MOVED_SCHEMA[0]).run();
    const marked = await env.DB.prepare("INSERT OR IGNORE INTO moved_handoff_used (nonce, public_id, used_at) VALUES (?, ?, ?)").bind(read.nonce, read.publicId, Date.now()).run();
    if (!marked || !marked.meta || Number(marked.meta.changes) !== 1) return deps.json(401, { error: "handoff_used" });
    const token = await deps.mintSession(env, read.publicId);
    return deps.json(200, { token: token, account: await deps.presentAccount(env, request, row, true) });
  }
  return deps.json(404, { error: "not_found" });
}
