/* Owner-managed member settings (switch owner_user_settings).
   The site owner (accounts.owner = 1, checked here on the server) can change
   another account's synced settings and lock any of them. A locked setting
   keeps the owner's value: every /v1/sync read and write of that account
   passes through enforceLocks(), so a device, an old app or a hand-made
   request cannot change it. Unlocking gives the choice back to the member.
   Only plain, well-known settings from settings-registry.js are listed
   (look, feed, media, privacy protections, language); never lists, blocks,
   follows, history, messages or anything secret. Other accounts that are
   owners cannot be managed. Each change writes an owner_access_log row.

   GET /v1/owner/user-settings/:id   settings, locks and the schema
   PUT /v1/owner/user-settings/:id   { values: { key: value }, locks: { key: true|false } }
   :id is the account public id, or the account's username. */

import { inspectHandle } from "../../shared/handle-skeleton.js";
import { logOwnerView } from "./owner-view.js";
import { readFlags } from "./feature-flags.js";

export const LOCKS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS owner_setting_locks (public_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, owner_id TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', PRIMARY KEY (public_id, key))",
  "CREATE TABLE IF NOT EXISTS owner_setting_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, owner_id TEXT NOT NULL, public_id TEXT NOT NULL, key TEXT NOT NULL, old_value TEXT NOT NULL DEFAULT '', new_value TEXT NOT NULL DEFAULT '', change TEXT NOT NULL)"
];

const bool = (key, label, def, group) => ({ key, type: "bool", label, def, group });
const pick = (key, label, values, valueLabels, def, group) => ({ key, type: "enum", label, values, valueLabels, def, group });

/* Same ids, types, labels and defaults as settings-registry.js for the rows
   that come from it (Theme also has the app's Auto). device: true means the
   value normally stays on one device; a lock still syncs the owner's value
   and the device applies it on load. extra: true means the row is not in the
   registry (desktop size, scrollbar, friend connection, profile text).
   worker/test/owner-settings.test.mjs fails when a registry setting is neither
   here nor in UNCOVERED. */
const SCALE = [];
for (let n = 100; n <= 200; n += 5) SCALE.push(n);
const jsonDoc = (key, label, group) => ({ key, type: "json", label, def: [], group, max: 20000 });
export const MANAGED = [
  pick("appearance", "Theme", ["lightsout", "dim", "default", "auto"], { lightsout: "Lights out", dim: "Dim", "default": "Light", auto: "Auto" }, "lightsout", "look"),
  pick("accent", "Color", ["blue", "yellow", "pink", "purple", "orange", "green"], { blue: "Blue", yellow: "Yellow", pink: "Pink", purple: "Purple", orange: "Orange", green: "Green" }, "blue", "look"),
  { key: "fontSize", type: "number", label: "Font size", values: [14, 15, 16, 17, 18], def: 15, group: "look" },
  pick("density", "Density", ["compact", "default", "comfy"], { compact: "Compact", "default": "Default", comfy: "Comfortable" }, "default", "look"),
  bool("reduceMotion", "Reduce motion", false, "look"),
  pick("showPictures", "Profile pictures", ["show", "default", "none"], { show: "Show", "default": "Default", none: "None" }, "show", "look"),
  pick("showBanners", "Banners", ["show", "default", "none"], { show: "Show", "default": "Default", none: "None" }, "show", "look"),
  pick("avatarShape", "Profile picture shape", ["round", "square"], { round: "Round", square: "Square" }, "round", "look"),
  bool("haptics", "Haptics", true, "look"),
  bool("aiFab", "Local AI button", false, "look"),
  bool("homePills", "Live pills row", true, "feed"),
  bool("stories", "Stories", true, "feed"),
  bool("storyNotes", "Story notes", true, "feed"),
  bool("forYouReposts", "Show reposts", true, "feed"),
  bool("forYouReplies", "Show replies in tab", true, "feed"),
  pick("followingSort", "Following options", ["recent", "popular"], { recent: "Recent", popular: "Popular" }, "recent", "feed"),
  bool("friendsRail", "Friends panel", true, "feed"),
  pick("autoplay", "Autoplay videos", ["all", "wifi", "never"], { all: "On cellular or Wi-Fi", wifi: "Only on Wi-Fi", never: "Never" }, "all", "media"),
  pick("livePreview", "Live previews", ["auto", "on", "off"], { auto: "Automatic", on: "On", off: "Off" }, "auto", "media"),
  bool("privacyEmbedShield", "Third-party embed shield", false, "privacy"),
  bool("privacyWebRTC", "WebRTC leak protection", true, "privacy"),
  bool("privacyNoReferrer", "Strict no-referrer", true, "privacy"),
  bool("privacyStripTrackers", "Strip tracking parameters", true, "privacy"),
  bool("privacyAntiFingerprint", "Fingerprint resistance", true, "privacy"),
  pick("lang", "Display language", ["en", "es", "ru", "hi"], { en: "English", es: "Español", ru: "Русский", hi: "हिन्दी" }, "en", "language"),
  pick("translateTo", "Translate to", ["ui", "en", "es", "ru", "hi", "fr", "de", "pt", "it"], null, "ui", "language"),
  bool("translateAuto", "Automatically translate posts", true, "language"),
  pick("postAlign", "Alignment", ["left", "justify"], { left: "Left", justify: "Justified" }, "left", "look"),
  bool("postWrapAvatar", "Wrap around profile picture", false, "look"),
  bool("notify", "Push notifications", false, "notifications"),
  pick("reactionsData", "Reactions", ["auto", "full", "lite"], { auto: "Automatic", full: "Full", lite: "Light" }, "auto", "media"),
  pick("communityNotesData", "Community Notes", ["auto", "full", "lite"], { auto: "Automatic", full: "Full", lite: "Light" }, "auto", "media"),
  bool("fullScreen", "Full screen", false, "look"),
  bool("classicHeader", "Classic header", false, "look"),
  bool("statusBar", "Show phone status bar", false, "look"),
  bool("pageZoom", "Allow page zoom", false, "look"),
  bool("sidePanelLeft", "Side panel on the left", false, "look"),
  pick("navLayout", "Navigation layout", ["auto", "bar"], { auto: "Automatic", bar: "Bottom bar" }, "auto", "look"),
  bool("navLayoutLand", "Bottom bar in landscape", false, "look"),
  bool("navLayoutSync", "Same layout on all devices", false, "look"),
  bool("videoHd", "HD video", true, "media"),
  pick("imageLoad", "Load images", ["always", "wifi"], { always: "Always", wifi: "Only on Wi-Fi" }, "always", "media"),
  pick("imageSize", "Image size", ["auto", "small"], { auto: "Automatic", small: "Small" }, "auto", "media"),
  pick("linkPreviews", "Link previews", ["full", "text"], { full: "Full", text: "Text only" }, "full", "media"),
  pick("preload", "Preload", ["idle", "defer"], { idle: "In spare time", defer: "Only when needed" }, "idle", "media"),
  pick("syncEvery", "Refresh speed", ["normal", "slow"], { normal: "Normal", slow: "Slow" }, "normal", "media"),
  bool("backgroundLive", "Live updates in the background", true, "media"),
  pick("updateDownload", "App updates", ["always", "wifi"], { always: "Always", wifi: "Only on Wi-Fi" }, "always", "media"),
  bool("saveData", "Max data saving", false, "media"),
  pick("playbackSource", "Playback source", ["embed", "device", "server"], { embed: "Official player", device: "This device", server: "Server" }, "embed", "media"),
  pick("networkMode", "Network mode", ["auto", "max", "direct"], { auto: "Automatic", max: "Maximum", direct: "Direct" }, "auto", "network"),
  bool("privacyZeroTrace", "Zero-trace browsing", false, "privacy"),
  bool("historyPauseVideos", "Pause watch history", false, "privacy"),
  bool("historyPauseArticles", "Pause reading history", false, "privacy"),
  pick("deviceLevel", "Device performance", ["light", "balanced", "max"], { light: "Light", balanced: "Balanced", max: "Max" }, "balanced", "device"),
  bool("communitiesHome", "Communities on Home", true, "feed"),
  bool("groupsOwn", "Use my own groups", false, "feed"),
  bool("noteTabsSame", "Same tabs as Home", true, "notifications"),
  bool("notifNames", "Show names in notifications", true, "notifications"),
  bool("notifPreview", "Show message previews", true, "notifications"),
  bool("notifBanner", "Banners", true, "notifications"),
  bool("notifBadge", "Badge", true, "notifications"),
  bool("notifCount", "Unread count", true, "notifications"),
  bool("notifType_messages", "Messages", true, "notifications"),
  bool("notifType_mentions", "Mentions", true, "notifications"),
  bool("notifType_replies", "Replies", true, "notifications"),
  bool("notifType_quotes", "Quotes", true, "notifications"),
  bool("notifType_likes", "Likes", true, "notifications"),
  bool("notifType_reposts", "Reposts", true, "notifications"),
  bool("notifType_follows", "New followers", true, "notifications"),
  bool("notifType_notes", "Community Notes", true, "notifications"),
  bool("notifType_posts", "New posts", true, "notifications"),
  { key: "syncUi", type: "bool", label: "Sync settings", def: true, group: "device", extra: true },
  jsonDoc("feedTabs", "Custom tabs", "feed"),
  jsonDoc("noteTabs", "Notification tabs", "notifications"),
  jsonDoc("profileTabs", "Profile tabs", "profile"),
  jsonDoc("groups", "Groups", "feed"),
  jsonDoc("tabViews", "Tab views", "feed"),
  jsonDoc("navCustom", "Sidebar", "look"),
  jsonDoc("bottomNav", "Bottom bar", "look"),
  jsonDoc("drawerMenu", "Menu order", "look"),
  { key: "displayName", type: "text", label: "Display name", def: "", group: "profile", max: 50, extra: true, profile: true },
  { key: "bio", type: "text", label: "Bio", def: "", group: "profile", max: 160, extra: true, profile: true },
  { key: "location", type: "text", label: "Location", def: "", group: "profile", max: 30, extra: true, profile: true },
  { key: "website", type: "text", label: "Website", def: "", group: "profile", max: 100, extra: true, profile: true },
  bool("protected", "Protect your posts", false, "profile"),
  bool("privateFollows", "Private followers and following", false, "profile"),
  bool("profileLess", "Profile-less account", false, "profile"),
  pick("hideAvatar", "Hide my profile picture", ["", "default", "none"], { "": "Show my picture", "default": "Default", none: "None" }, "", "profile"),
  { key: "deskShowScrollbar", type: "bool", label: "Show scrollbar", def: false, group: "device", extra: true, device: true },
  { key: "deskScaleMode", type: "enum", label: "App size", values: ["off", "window", "manual"], valueLabels: { off: "Off", window: "Automatic", manual: "Manual" }, def: "off", group: "device", extra: true, device: true },
  { key: "deskScaleManual", type: "number", label: "App size", values: SCALE, def: 100, group: "device", extra: true, device: true },
  { key: "deskScaleMaximized", type: "number", label: "Maximized with the toolbar", values: SCALE, def: 150, group: "device", extra: true, device: true },
  { key: "deskScaleWindowed", type: "number", label: "In a window", values: SCALE, def: 120, group: "device", extra: true, device: true },
  { key: "friendP2P", type: "bool", label: "Connect directly to friends", def: true, group: "friends", extra: true, device: true },
  { key: "peerMedia", type: "enum", label: "Playback source", values: ["auto", "on", "off"], valueLabels: { auto: "Automatic", on: "On", off: "Off" }, def: "auto", group: "device", extra: true, device: true },
  { key: "aiAutoModel", type: "bool", label: "Pick a model automatically", def: false, group: "device", extra: true, device: true }
];
["fullScreen", "classicHeader", "statusBar", "pageZoom", "sidePanelLeft", "navLayout", "navLayoutLand", "navLayoutSync", "videoHd", "imageLoad", "imageSize", "linkPreviews", "preload", "syncEvery", "backgroundLive", "updateDownload", "saveData", "playbackSource", "networkMode", "privacyZeroTrace", "historyPauseVideos", "historyPauseArticles", "deviceLevel"].forEach((key) => {
  const row = MANAGED.find((item) => item.key === key);
  if (row) row.device = true;
});
["communitiesHome", "protected", "privateFollows", "profileLess", "hideAvatar"].forEach((key) => {
  const row = MANAGED.find((item) => item.key === key);
  if (row) row.server = true;
});
["protected", "privateFollows", "profileLess", "hideAvatar"].forEach((key) => {
  const row = MANAGED.find((item) => item.key === key);
  if (row) row.profile = true;
});
export const GROUPS = ["look", "feed", "media", "privacy", "language", "notifications", "device", "profile", "network", "friends"];

/* Registry settings this panel does not edit, each with the reason. */
export const UNCOVERED = [
  { id: "statusIcons", reason: "A set of several icon switches. Each one is a layout detail of this phone, and the owner locks the rest of Display instead." },
  { id: "sideFold", reason: "Which side sections are folded is a momentary layout, not a preference to force on every device." },
  { id: "brandLogo", reason: "The sidebar logo can be the person's own text. The owner does not rewrite that text." },
  { id: "navCustomAt", reason: "A timestamp that travels with the sidebar order, not a setting of its own. Sidebar order is covered." },
  { id: "bottomNavCustom", reason: "A flag that travels with the bottom bar. The bottom bar order is covered." },
  { id: "inboxLayout", reason: "Inbox sections name mail and chat sources. The owner does not rearrange someone's inbox." },
  { id: "keyboard", reason: "Shortcut choices are per computer and include no shared control." },
  { id: "peopleLinks", reason: "Merged profiles name other accounts. The owner does not edit that list." },
  { id: "busyPrefs", reason: "Posting-volume limits name other accounts." },
  { id: "translateNever", reason: "A personal language list. Translate-to and automatic translation are covered." },
  { id: "bells", reason: "Per-account alerts name other people." },
  { id: "notePrefs", reason: "Notification list filters. The notification type switches are covered." },
  { id: "communityTabs", reason: "Tabs inside communities the person joined. Home tabs are covered." },
  { id: "communityFolders", reason: "The person's own folders of communities." },
  { id: "lists", reason: "Lists of accounts. That is the person's collection, not a display setting." },
  { id: "subsGroup", reason: "Which group the Subscriptions page shows." },
  { id: "discoverable", reason: "Stored on the suggestions service, separate from the settings sync the lock enforces." },
  { id: "searchable", reason: "Stored on the search-preference service, separate from the settings sync the lock enforces." },
  { id: "onlineStatus", reason: "Who can see online status is an audience on the presence service, not one synced field." },
  { id: "mutedWords", reason: "The words themselves are the person's private filter. The owner does not read or rewrite that list." },
  { id: "mutedAccounts", reason: "A list of people the person muted." },
  { id: "blocks", reason: "A list of people, posts and sources the person blocked." },
  { id: "repostOff", reason: "Accounts whose reposts the person hid." },
  { id: "notifPrivacy", reason: "The group object. Each switch inside it is covered on its own." },
  { id: "devicePerf", reason: "The group object. Device performance and the peer-media choice are covered on their own." },
  { id: "friendsSwitch", reason: "Turning Friends off is an account action with requests and counts, not one stored value." },
  { id: "appLock", reason: "The passkey, PIN or fingerprint stays on the device. The owner cannot set it." },
  { id: "passkeys", reason: "A sign-in credential. The owner cannot create or read it." },
  { id: "devices", reason: "Signing other sessions out is an action, not a setting value." },
  { id: "logout", reason: "Signing out is an action." },
  { id: "deleteAccount", reason: "Deleting an account is not a setting the owner panel changes." },
  { id: "clearStorage", reason: "Clearing this device's cache is an action." },
  { id: "usernames", reason: "Usernames and who may see each one are identity records, not a single setting." },
  { id: "gamesPrivacy", reason: "Who sees games and invites is its own privacy screen, not one synced field." },
  { id: "liveTranslate", reason: "Live captions are a tool the person starts, not a stored switch." },
  { id: "keys", reason: "Connected keys are secrets. The owner never reads or sets them." },
  { id: "nostr", reason: "Nostr keys and relays are secrets." },
  { id: "xPosting", reason: "Cross-posting uses the person's own X connection." },
  { id: "tvLink", reason: "Linking a TV is a one-time code, not a stored setting." },
  { id: "tempLabel", reason: "An owner-only label, not a member setting." },
  { id: "runSetup", reason: "Running setup again is an action." },
  { id: "emojiFallback", reason: "There is no setting. The app uses the system emoji font and adds the web font only when that font cannot draw the character." },
  { id: "notifyPermission", reason: "The browser asks the person. The owner can lock Push notifications, and a lock of on still opens that prompt." }
];
const BY_KEY = new Map(MANAGED.map((row) => [row.key, row]));
const NO_STORE = { "cache-control": "private, no-store" };

export function managedKey(key) { return BY_KEY.has(String(key || "")); }

/* { ok, value } for a value the owner may set; ok false otherwise. */
export function cleanValue(key, value) {
  const row = BY_KEY.get(String(key || ""));
  if (!row) return { ok: false };
  if (row.type === "bool") return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  if (row.type === "number") {
    const n = Number(value);
    return typeof value === "number" && row.values.indexOf(n) >= 0 ? { ok: true, value: n } : { ok: false };
  }
  if (row.type === "text") {
    const text = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
    if (Array.from(text).length > (row.max || 80)) return { ok: false };
    if (row.key === "displayName" && !text) return { ok: false };
    if (row.key === "website" && text && (/[\s<>]/.test(text) || /^(javascript|data|file):/i.test(text))) return { ok: false };
    return { ok: true, value: text };
  }
  if (row.type === "json") {
    if (value == null || typeof value !== "object") return { ok: false };
    let text = "";
    try { text = JSON.stringify(value); } catch (err) { return { ok: false }; }
    if (!text || text.length > (row.max || 20000)) return { ok: false };
    return { ok: true, value: JSON.parse(text) };
  }
  return typeof value === "string" && row.values.indexOf(value) >= 0 ? { ok: true, value } : { ok: false };
}

let ready = null;
function ensureSchema(env) {
  if (!ready) ready = (async () => {
    await env.DB.batch(LOCKS_SCHEMA.map((sql) => env.DB.prepare(sql)));
    try { await env.DB.prepare("ALTER TABLE owner_setting_locks ADD COLUMN note TEXT NOT NULL DEFAULT ''").run(); } catch (err) { /* the column is already there */ }
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

export function lockNotes(locks) {
  const out = {};
  Object.keys(locks || {}).forEach((key) => { if (locks[key] && locks[key].note) out[key] = locks[key].note; });
  return out;
}

function clipNote(value) {
  return String(value || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 140);
}

function auditValue(value) {
  return JSON.stringify(value == null ? null : value).slice(0, 200);
}

/* { key: { value, at } } for one account. Missing table: no locks. */
export async function readLocks(env, publicId) {
  const out = {};
  if (!env || !env.DB || !publicId) return out;
  let rows = [];
  // The owner routes create the table. A member sync must not run that DDL
  // on every check-in; a missing table still reads as no locks.
  try {
    const res = await env.DB.prepare("SELECT key, value, at, note FROM owner_setting_locks WHERE public_id = ?").bind(String(publicId)).all();
    rows = (res && res.results) || [];
  } catch (err) {
    try {
      const res = await env.DB.prepare("SELECT key, value, at FROM owner_setting_locks WHERE public_id = ?").bind(String(publicId)).all();
      rows = (res && res.results) || [];
    } catch (again) { return out; }
  }
  rows.forEach((row) => {
    let value;
    try { value = JSON.parse(row.value); } catch (err) { return; }
    const clean = cleanValue(row.key, value);
    if (clean.ok) out[row.key] = { value: clean.value, at: Number(row.at) || 0, note: String(row.note || "").slice(0, 140) };
  });
  return out;
}

/* Puts every locked value into a sync payload (and its prefsAt stamp, so
   last-write-wins merging on devices never prefers an older local value).
   Returns the keys that were changed. */
export function enforceLocks(payload, locks) {
  const changed = [];
  if (!payload || typeof payload !== "object" || !locks) return changed;
  Object.keys(locks).forEach((key) => {
    const lock = locks[key];
    if (!lock || !managedKey(key)) return;
    if (JSON.stringify(payload[key]) !== JSON.stringify(lock.value)) changed.push(key);
    payload[key] = lock.value;
    shapeLocked(payload, key, lock.value);
    if (key === "lang") return;
    if (!payload.prefsAt || typeof payload.prefsAt !== "object" || Array.isArray(payload.prefsAt)) payload.prefsAt = {};
    payload.prefsAt[key] = Math.max(Number(payload.prefsAt[key]) || 0, lock.at || 0);
  });
  return changed;
}

/* The locked value for one key, or undefined when the switch is off or the key is free. */
export async function activeLock(env, publicId, key) {
  if (!env || !env.DB || !publicId || !key) return undefined;
  try {
    const off = await readFlags(env);
    if (off && off.owner_user_settings) return undefined;
  } catch (err) { /* a missing flag table still honors stored locks */ }
  const locks = await readLocks(env, publicId);
  return locks[key] ? locks[key].value : undefined;
}

/* What the member's devices get with /v1/sync: { key: value }. */
export function lockValues(locks) {
  const out = {};
  Object.keys(locks || {}).forEach((key) => { out[key] = locks[key].value; });
  return out;
}

async function loadPayload(env, id, deps) {
  const row = await env.DB.prepare("SELECT payload, updated_at FROM sync_state WHERE public_id = ?").bind(id).first();
  if (!row) return { payload: {}, updatedAt: 0, exists: false };
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch (err) { payload = null; }
  payload = await deps.openPayload(env, payload);
  return { payload: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, updatedAt: Number(row.updated_at) || 0, exists: true };
}

const NOTIF_FIELD = { notifNames: "names", notifPreview: "preview", notifBanner: "banner", notifBadge: "badge", notifCount: "count" };
function shapeLocked(payload, key, value) {
  if (key === "historyPauseVideos" || key === "historyPauseArticles") {
    if (!payload.historyPause || typeof payload.historyPause !== "object" || Array.isArray(payload.historyPause)) payload.historyPause = {};
    payload.historyPause[key === "historyPauseVideos" ? "videos" : "articles"] = value === true;
    return;
  }
  if (NOTIF_FIELD[key] || key.indexOf("notifType_") === 0) {
    if (!payload.notifPrivacy || typeof payload.notifPrivacy !== "object" || Array.isArray(payload.notifPrivacy)) payload.notifPrivacy = {};
    if (NOTIF_FIELD[key]) payload.notifPrivacy[NOTIF_FIELD[key]] = value === true;
    else {
      if (!payload.notifPrivacy.types || typeof payload.notifPrivacy.types !== "object") payload.notifPrivacy.types = {};
      payload.notifPrivacy.types[key.slice("notifType_".length)] = value === true;
    }
  }
}

function currentValues(payload, account) {
  const out = {};
  MANAGED.forEach((row) => {
    const clean = cleanValue(row.key, payload[row.key]);
    out[row.key] = clean.ok ? clean.value : null;
  });
  if (account) {
    if (out.displayName == null) {
      const name = cleanValue("displayName", account.display_name || "");
      if (name.ok) out.displayName = name.value;
    }
    if (out.bio == null) {
      const bio = cleanValue("bio", account.bio || "");
      if (bio.ok) out.bio = bio.value;
    }
    if (out.location == null) {
      const location = cleanValue("location", account.location || "");
      if (location.ok) out.location = location.value;
    }
    if (out.website == null) {
      const website = cleanValue("website", account.website || "");
      if (website.ok) out.website = website.value;
    }
    if (out.protected == null) out.protected = account.protected_account === 1;
    if (out.privateFollows == null) out.privateFollows = account.private_follows === 1;
    if (out.profileLess == null) out.profileLess = account.profile_less === 1;
    if (out.hideAvatar == null) {
      const face = cleanValue("hideAvatar", account.hide_avatar || "");
      if (face.ok) out.hideAvatar = face.value;
    }
  }
  return out;
}

function schemaOut() {
  return MANAGED.map((row) => {
    const out = { key: row.key, type: row.type, label: row.label, def: row.def, group: row.group };
    if (row.values) out.values = row.values.slice();
    if (row.valueLabels) out.valueLabels = Object.assign({}, row.valueLabels);
    if (row.device) out.device = true;
    if (row.max) out.max = row.max;
    return out;
  });
}

const PROFILE_KEYS = ["displayName", "bio", "location", "website", "protected", "privateFollows", "profileLess", "hideAvatar"];
async function writeCommunitiesHome(env, id, show) {
  const bit = show ? 1 : 0;
  const row = await env.DB.prepare("SELECT show_home FROM community_feed_prefs WHERE public_id = ? AND community_id = ''").bind(id).first();
  if (row && Number(row.show_home) === bit) return;
  await env.DB.prepare("INSERT INTO community_feed_prefs (public_id, community_id, show_home, muted) VALUES (?, '', ?, 0) ON CONFLICT(public_id, community_id) DO UPDATE SET show_home = excluded.show_home").bind(id, bit).run();
}

async function writeProfileColumns(env, id, account, payload) {
  const name = payload.displayName != null ? payload.displayName : (account.display_name || "");
  const bio = payload.bio != null ? payload.bio : (account.bio || "");
  const location = payload.location != null ? payload.location : (account.location || "");
  const website = payload.website != null ? payload.website : (account.website || "");
  const protectedAccount = payload.protected != null ? (payload.protected ? 1 : 0) : (account.protected_account === 1 ? 1 : 0);
  const privateFollows = payload.privateFollows != null ? (payload.privateFollows ? 1 : 0) : (account.private_follows === 1 ? 1 : 0);
  const profileLess = payload.profileLess != null ? (payload.profileLess ? 1 : 0) : (account.profile_less === 1 ? 1 : 0);
  const hideAvatar = payload.hideAvatar != null ? payload.hideAvatar : (account.hide_avatar || "");
  const nameOut = name || account.display_name || "";
  const same = String(account.display_name || "") === String(nameOut)
    && String(account.bio || "") === String(bio || "")
    && String(account.location || "") === String(location || "")
    && String(account.website || "") === String(website || "")
    && (account.protected_account === 1 ? 1 : 0) === protectedAccount
    && (account.private_follows === 1 ? 1 : 0) === privateFollows
    && (account.profile_less === 1 ? 1 : 0) === profileLess
    && String(account.hide_avatar || "") === String(hideAvatar || "");
  if (same) return;
  await env.DB.prepare("UPDATE accounts SET display_name = ?, bio = ?, location = ?, website = ?, protected_account = ?, private_follows = ?, profile_less = ?, hide_avatar = ? WHERE public_id = ?").bind(nameOut, bio, location, website, protectedAccount, privateFollows, profileLess, hideAvatar, id).run();
}

async function findManagedAccount(env, raw) {
  const id = String(raw || "");
  if (!id) return null;
  const cols = "SELECT public_id, handle, owner, display_name, bio, location, website, protected_account, private_follows, profile_less, hide_avatar FROM accounts";
  const byId = await env.DB.prepare(cols + " WHERE public_id = ?").bind(id).first();
  if (byId) return byId;
  const checked = inspectHandle(id.replace(/^@/, ""));
  if (!checked.ok || !checked.skeleton) return null;
  return env.DB.prepare(cols + " WHERE skeleton = ?").bind(checked.skeleton).first();
}

export async function handleOwnerUserSettings(request, env, path, deps) {
  const gate = await deps.requireOwner(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  const ownerId = String(gate.row.public_id);
  const write = request.method === "PUT" || request.method === "POST";
  if (request.method !== "GET" && !write) return deps.json(405, { error: "method_not_allowed" });
  const hit = await deps.rateHit(env, "owner-user-settings:" + (write ? "w:" : "r:") + ownerId, write ? 300 : 600, 10 * 60 * 1000);
  if (!hit.ok) return deps.limited(hit);
  try { await ensureSchema(env); } catch (err) { return deps.json(503, { error: "not_configured" }); }
  if (path === "/v1/owner/user-settings/bulk") return handleBulk(request, env, deps, ownerId);
  const m = path.match(/^\/v1\/owner\/user-settings\/([A-Za-z0-9_-]{1,64})$/);
  if (!m) return deps.json(404, { error: "not_found" });

  const target = await findManagedAccount(env, m[1]);
  if (!target) return deps.json(404, { error: "not_found" });
  const id = String(target.public_id);
  if (Number(target.owner) === 1) return deps.json(403, { error: "owner_account" });

  if (!write) {
    const saved = await loadPayload(env, id, deps);
    const locks = await readLocks(env, id);
    enforceLocks(saved.payload, locks);
    const audit = await readAudit(env, id);
    return deps.json(200, { id, handle: target.handle, settings: currentValues(saved.payload, target), locks: lockValues(locks), notes: lockNotes(locks), schema: schemaOut(), groups: GROUPS, audit, updatedAt: saved.updatedAt }, NO_STORE);
  }

  const body = await deps.readJson(request, 48000);
  if (body.error) return deps.json(400, { error: body.error });
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  const lockAsk = body.locks && typeof body.locks === "object" && !Array.isArray(body.locks) ? body.locks : {};
  const noteAsk = body.notes && typeof body.notes === "object" && !Array.isArray(body.notes) ? body.notes : {};
  const setKeys = Object.keys(values);
  const lockKeys = Object.keys(lockAsk);
  if (!setKeys.length && !lockKeys.length) return deps.json(400, { error: "nothing_to_change" });
  const cleaned = {};
  for (const key of setKeys) {
    const clean = cleanValue(key, values[key]);
    if (!clean.ok) return deps.json(400, { error: "bad_value", key: String(key).slice(0, 40) });
    cleaned[key] = clean.value;
  }
  for (const key of lockKeys) {
    if (!managedKey(key) || typeof lockAsk[key] !== "boolean") return deps.json(400, { error: "bad_lock", key: String(key).slice(0, 40) });
  }

  const now = Date.now();
  const saved = await loadPayload(env, id, deps);
  const payload = saved.payload;
  if (payload.displayName == null && target.display_name) payload.displayName = target.display_name;
  if (payload.bio == null) payload.bio = target.bio || "";
  if (payload.location == null) payload.location = target.location || "";
  if (payload.website == null) payload.website = target.website || "";
  if (payload.protected == null) payload.protected = target.protected_account === 1;
  if (payload.privateFollows == null) payload.privateFollows = target.private_follows === 1;
  if (payload.profileLess == null) payload.profileLess = target.profile_less === 1;
  if (payload.hideAvatar == null) payload.hideAvatar = target.hide_avatar || "";
  const locks = await readLocks(env, id);
  enforceLocks(payload, locks);
  if (!payload.prefsAt || typeof payload.prefsAt !== "object" || Array.isArray(payload.prefsAt)) payload.prefsAt = {};
  const stmts = [];
  Object.keys(cleaned).forEach((key) => {
    const before = payload[key];
    if (JSON.stringify(before) === JSON.stringify(cleaned[key])) return;
    payload[key] = cleaned[key];
    shapeLocked(payload, key, cleaned[key]);
    if (key !== "lang") payload.prefsAt[key] = now;
    stmts.push(auditStmt(env, ownerId, id, key, before, cleaned[key], "set", now));
  });
  // A locked key keeps the value it has now (or its default when the member never set it).
  lockKeys.forEach((key) => {
    if (lockAsk[key]) {
      const row = BY_KEY.get(key);
      const clean = cleanValue(key, payload[key]);
      const value = clean.ok ? clean.value : row.def;
      const before = locks[key] ? locks[key].value : payload[key];
      const note = clipNote(noteAsk[key] != null ? noteAsk[key] : (locks[key] && locks[key].note));
      if (locks[key] && JSON.stringify(locks[key].value) === JSON.stringify(value) && String(locks[key].note || "") === note) return;
      payload[key] = value;
      shapeLocked(payload, key, value);
      if (key !== "lang") payload.prefsAt[key] = now;
      locks[key] = { value, at: now, note };
      stmts.push(env.DB.prepare("INSERT INTO owner_setting_locks (public_id, key, value, owner_id, at, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(public_id, key) DO UPDATE SET value = excluded.value, owner_id = excluded.owner_id, at = excluded.at, note = excluded.note").bind(id, key, JSON.stringify(value), ownerId, now, note));
      stmts.push(auditStmt(env, ownerId, id, key, before, value, "lock", now));
    } else if (!locks[key]) {
      return;
    } else {
      const previous = locks[key] ? locks[key].value : null;
      delete locks[key];
      stmts.push(env.DB.prepare("DELETE FROM owner_setting_locks WHERE public_id = ? AND key = ?").bind(id, key));
      stmts.push(auditStmt(env, ownerId, id, key, previous, null, "unlock", now));
    }
  });
  // A new value for a key that stays locked moves the lock with it.
  Object.keys(cleaned).forEach((key) => {
    if (!locks[key] || lockAsk[key] === false) return;
    if (JSON.stringify(locks[key].value) === JSON.stringify(cleaned[key])) return;
    locks[key] = { value: cleaned[key], at: now };
    if (lockAsk[key] === true) return;
    stmts.push(env.DB.prepare("UPDATE owner_setting_locks SET value = ?, owner_id = ?, at = ? WHERE public_id = ? AND key = ?").bind(JSON.stringify(cleaned[key]), ownerId, now, id, key));
  });
  const changed = stmts.length > 0;
  if (changed) {
    const text = JSON.stringify(await deps.sealPayload(env, payload));
    stmts.push(env.DB.prepare("INSERT INTO sync_state (public_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").bind(id, text, now));
    await env.DB.batch(stmts);
  }
  if (changed && PROFILE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(cleaned, key) || Object.prototype.hasOwnProperty.call(lockAsk, key))) {
    try { await writeProfileColumns(env, id, target, payload); } catch (err) { /* the sync copy still has the value */ }
  }
  if (changed && (Object.prototype.hasOwnProperty.call(cleaned, "communitiesHome") || Object.prototype.hasOwnProperty.call(lockAsk, "communitiesHome"))) {
    try { await writeCommunitiesHome(env, id, payload.communitiesHome !== false); } catch (err) { /* the sync copy still has the value */ }
  }
  if (changed) await logOwnerView(env, ownerId, id, "settings");
  // The member's open devices pull a real change right away.
  if (changed) {
    try { if (deps.publish) await deps.publish(env, id, "sync", { updatedAt: now, device: "owner" }, id); } catch (err) { /* they check on return */ }
  }
  return deps.json(200, { id, handle: target.handle, settings: currentValues(payload, target), locks: lockValues(locks), notes: lockNotes(locks), audit: await readAudit(env, id), updatedAt: changed ? now : saved.updatedAt }, NO_STORE);
}

function auditStmt(env, ownerId, id, key, oldValue, newValue, change, now) {
  return env.DB.prepare("INSERT INTO owner_setting_audit (at, owner_id, public_id, key, old_value, new_value, change) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(now, ownerId, id, key, auditValue(oldValue), auditValue(newValue), change);
}

async function readAudit(env, id) {
  try {
    const res = await env.DB.prepare("SELECT at, key, old_value, new_value, change FROM owner_setting_audit WHERE public_id = ? ORDER BY at DESC LIMIT 40").bind(id).all();
    return ((res && res.results) || []).map((row) => ({ at: Number(row.at) || 0, key: row.key, from: row.old_value, to: row.new_value, change: row.change }));
  } catch (err) { return []; }
}

async function handleBulk(request, env, deps, ownerId) {
  if (request.method !== "POST") return deps.json(405, { error: "method_not_allowed" });
  const body = await deps.readJson(request, 48000);
  if (body.error) return deps.json(400, { error: body.error });
  const locks = body.locks && typeof body.locks === "object" && !Array.isArray(body.locks) ? body.locks : {};
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  const keys = Object.keys(locks);
  if (!keys.length) return deps.json(400, { error: "nothing_to_change" });
  for (const key of keys) {
    if (!managedKey(key) || typeof locks[key] !== "boolean") return deps.json(400, { error: "bad_lock", key: String(key).slice(0, 40) });
  }
  const listed = await env.DB.prepare("SELECT public_id FROM accounts WHERE owner = 0 ORDER BY public_id LIMIT 500").all();
  const ids = ((listed && listed.results) || []).map((row) => String(row.public_id));
  if (body.confirm !== "apply") return deps.json(200, { preview: true, count: ids.length, keys }, NO_STORE);
  if (Number(body.count) !== ids.length) return deps.json(409, { error: "preview_stale", count: ids.length });
  const cleaned = {};
  for (const key of keys) {
    if (!locks[key]) continue;
    const clean = cleanValue(key, values[key]);
    if (!clean.ok) return deps.json(400, { error: "bad_value", key: String(key).slice(0, 40) });
    cleaned[key] = clean.value;
  }
  const now = Date.now();
  for (const id of ids) {
    const saved = await loadPayload(env, id, deps);
    const payload = saved.payload;
    const have = await readLocks(env, id);
    enforceLocks(payload, have);
    const stmts = [];
    if (!payload.prefsAt || typeof payload.prefsAt !== "object" || Array.isArray(payload.prefsAt)) payload.prefsAt = {};
    keys.forEach((key) => {
      if (locks[key]) {
        const value = cleaned[key];
        if (have[key] && JSON.stringify(have[key].value) === JSON.stringify(value)) return;
        payload[key] = value;
        shapeLocked(payload, key, value);
        if (key !== "lang") payload.prefsAt[key] = now;
        stmts.push(env.DB.prepare("INSERT INTO owner_setting_locks (public_id, key, value, owner_id, at, note) VALUES (?, ?, ?, ?, ?, '') ON CONFLICT(public_id, key) DO UPDATE SET value = excluded.value, owner_id = excluded.owner_id, at = excluded.at").bind(id, key, JSON.stringify(value), ownerId, now));
        stmts.push(auditStmt(env, ownerId, id, key, have[key] ? have[key].value : null, value, "lock", now));
      } else if (have[key]) {
        stmts.push(env.DB.prepare("DELETE FROM owner_setting_locks WHERE public_id = ? AND key = ?").bind(id, key));
        stmts.push(auditStmt(env, ownerId, id, key, have[key].value, null, "unlock", now));
      }
    });
    if (!stmts.length) continue;
    const text = JSON.stringify(await deps.sealPayload(env, payload));
    stmts.push(env.DB.prepare("INSERT INTO sync_state (public_id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at").bind(id, text, now));
    await env.DB.batch(stmts);
    if (PROFILE_KEYS.some((key) => locks[key])) {
      try {
        const account = await env.DB.prepare("SELECT display_name, bio, location, website, protected_account, private_follows, profile_less, hide_avatar FROM accounts WHERE public_id = ?").bind(id).first();
        if (account) await writeProfileColumns(env, id, account, payload);
      } catch (err) { /* the sync copy still has the value */ }
    }
    if (locks.communitiesHome) {
      try { await writeCommunitiesHome(env, id, payload.communitiesHome !== false); } catch (err) { /* the sync copy still has the value */ }
    }
    try { if (deps.publish) await deps.publish(env, id, "sync", { updatedAt: now, device: "owner" }, id); } catch (err) { /* they check on return */ }
  }
  return deps.json(200, { preview: false, count: ids.length, keys }, NO_STORE);
}
