const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Mock environment for Node.js
const storage = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; }
};

global.location = {
  href: "http://localhost:8080/#/shorts",
  hash: "#/shorts",
  search: "",
  pathname: "/"
};

global.navigator = { userAgent: "test", plugins: [] };
global.window = global;
global.t = (k) => k;
global.esc = (s) => String(s == null ? "" : s);
global.VIKTORYCH_ACCOUNTS = { api: "http://localhost:8787", gate: true, tiktokAudience: "owner" };
global.ViktorychAccounts = {
  account: () => ({ handle: "owner_user", owner: true }),
  token: () => "mock-token"
};

const mockElements = {};
global.document = {
  body: {
    appendChild: (el) => {
      if (el && el.id) mockElements[el.id] = el;
      return el;
    }
  },
  documentElement: {
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false
    }
  },
  createElement: (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      attributes: {},
      setAttribute: (k, v) => { el.attributes[k] = String(v); },
      getAttribute: (k) => el.attributes[k],
      querySelector: () => null,
      querySelectorAll: () => [],
      classList: { add: () => {}, remove: () => {} }
    };
    return el;
  },
  getElementById: (id) => mockElements[id] || null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
};

// Load shorts.js
const shortsCode = fs.readFileSync(path.join(__dirname, "../shorts.js"), "utf8");
eval(shortsCode);

assert(global.ViktorychShorts, "ViktorychShorts must be exported on window");
const shorts = global.ViktorychShorts;

assert.strictEqual(typeof shorts.isLocked, "function", "isLocked must be a function");
assert.strictEqual(typeof shorts.isUnlocked, "function", "isUnlocked must be a function");
assert.strictEqual(typeof shorts.setLocked, "function", "setLocked must be a function");
assert.strictEqual(typeof shorts.toggleLock, "function", "toggleLock must be a function");
assert.strictEqual(typeof shorts.showCaptcha, "function", "showCaptcha must be a function");
assert.strictEqual(typeof shorts.closeCaptcha, "function", "closeCaptcha must be a function");
assert.strictEqual(typeof global.showTikTokCaptcha, "function", "window.showTikTokCaptcha must be a function");

// Bind mock hooks
shorts.bind({
  icon: (name) => `<svg class="${name}"></svg>`,
  esc: (v) => String(v == null ? "" : v),
  avatar: (src, name) => `<img src="${src || ''}" alt="${name || ''}">`,
  formatCount: (n) => String(n || 0),
  fullTime: (iso) => iso || "",
  posts: () => [
    {
      id: "tiktok:sampleclip:1",
      platform: "tiktok",
      handle: "sampleclip",
      author: "Sample",
      text: "Open clip",
      url: "https://www.tiktok.com/@sampleclip/video/1",
      media: [{ type: "video", url: "https://example.com/v0.mp4" }]
    },
    {
      id: "tiktok:lockclip:1",
      platform: "tiktok",
      handle: "lockclip",
      author: "Lock",
      text: "Dance video #dance",
      url: "https://www.tiktok.com/@lockclip/video/1",
      media: [{ type: "video", url: "https://example.com/v1.mp4" }]
    },
    {
      id: "youtube:short1",
      platform: "youtube",
      short: true,
      handle: "yt_creator",
      author: "Creator",
      text: "Fun clip",
      url: "https://youtube.com/shorts/short1",
      media: [{ type: "video", url: "https://example.com/v2.mp4" }]
    }
  ],
  data: () => ({ feeds: [], posts: [] }),
  settings: () => ({ follows: [], likes: {}, bookmarks: {} }),
  save: () => {},
  toggle: () => false,
  token: () => "mock-token",
  productName: () => "ViktorychApp",
  logo: () => "<svg class=\"logo\"></svg>"
});

shorts.setUnlocked(["sampleclip"]);
shorts.setAdded([{ handle: "lockclip", name: "Lock" }]);

console.log("Testing default locked state (initial state)...");
assert.strictEqual(shorts.isLocked(), true, "Shorts should be locked by default");

console.log("Testing unlocked mode...");
shorts.setLocked(false);
assert.strictEqual(shorts.isLocked(), false, "Shorts should be unlocked");

const liveHtmlUnlocked = shorts.page({ live: true });
assert(liveHtmlUnlocked.includes("@sampleclip"), "Unlocked live must include the unlocked account");
assert(liveHtmlUnlocked.includes("@lockclip"), "Unlocked live must include the added account");
assert(liveHtmlUnlocked.includes("data-shorts=\"toggle-lock\""), "Live HTML must include lock button");
assert(liveHtmlUnlocked.includes("tiktok-captcha-modal"), "Live HTML must include captcha modal");

const forYouHtmlUnlocked = shorts.page({ live: false });
assert(forYouHtmlUnlocked.includes("@sampleclip"), "Unlocked For You must include the unlocked account");
assert(forYouHtmlUnlocked.includes("@lockclip"), "Unlocked For You must include the added account");
assert(forYouHtmlUnlocked.includes("@yt_creator"), "Unlocked For You must include @yt_creator");
assert(forYouHtmlUnlocked.includes("tiktok-captcha-modal"), "For You HTML must include captcha modal");

console.log("Testing locked mode in Shorts...");
shorts.setLocked(true);
assert.strictEqual(shorts.isLocked(), true, "Shorts should be locked");

const liveHtmlLocked = shorts.page({ live: true });
assert(liveHtmlLocked.includes("@sampleclip"), "Locked live must include the unlocked account");
assert(!liveHtmlLocked.includes("@lockclip"), "Locked live must hide the added account");
assert(liveHtmlLocked.includes("is-locked"), "Lock button must have is-locked class");

const forYouHtmlLocked = shorts.page({ live: false });
assert(forYouHtmlLocked.includes("@sampleclip"), "Locked For You must include the unlocked account");
assert(!forYouHtmlLocked.includes("@lockclip"), "Locked For You must hide the added account");
assert(!forYouHtmlLocked.includes("@yt_creator"), "Locked For You must lock behind youtube creator");

console.log("Testing lock toggle...");
shorts.toggleLock();
assert.strictEqual(shorts.isLocked(), false, "toggleLock should unlock");
shorts.toggleLock();
assert.strictEqual(shorts.isLocked(), true, "toggleLock should lock again");

console.log("Testing account sheet...");
assert(liveHtmlLocked.includes("shorts-lock-panel"), "Account sheet must contain locked mode panel");
assert(liveHtmlLocked.includes("Unlocked accounts"), "Account sheet must contain Unlocked accounts heading");
assert(liveHtmlLocked.includes("added accounts"), "Account sheet must contain added accounts heading");
assert(liveHtmlUnlocked.includes("@lockclip"), "Account sheet must list the added account when unlocked");
assert(liveHtmlUnlocked.includes("Locked behind"), "Account sheet must show Locked behind pill");

console.log("Testing empty Live states...");
shorts.setUnlocked([]);
shorts.setLocked(true);
const emptyLocked = shorts.page({ live: true, livePane: "now" });
assert(emptyLocked.includes("Shorts is locked") && emptyLocked.includes("shorts-empty"), "Locked Live with nothing unlocked must say Shorts is locked");
assert(/shorts-empty[\s\S]*data-shorts="toggle-lock"/.test(emptyLocked), "The locked empty state must offer Unlock");
assert(/id="shorts-accounts" hidden/.test(emptyLocked), "The account sheet starts closed");
shorts.setUnlocked(["sampleclip"]);
shorts.setLocked(true);

console.log("Testing stale live rows...");
{
  const now = Date.parse("2026-11-24T12:00:00Z");
  shorts.setLiveState([
    { handle: "freshclip", live: true, checkedAt: "2026-11-24T11:59:30Z" },
    { handle: "oldclip", live: false, checkedAt: "2026-11-24T11:50:00Z" },
    { handle: "nocheck", live: false }
  ]);
  const due = shorts.staleRows([{ handle: "freshclip" }, { handle: "oldclip" }, { handle: "nocheck" }], now).map((row) => row.handle);
  assert.deepStrictEqual(due, ["nocheck", "oldclip"], "Only rows checked over two minutes ago (or never) are re-checked, never-checked first");
  shorts.setLiveState(Array.from({ length: 30 }, (_, i) => ({ handle: "aged" + i, live: false, checkedAt: new Date(now - (i + 3) * 60000).toISOString() })));
  const oldest = shorts.staleRows(Array.from({ length: 30 }, (_, i) => ({ handle: "aged" + i })), now).map((row) => row.handle);
  assert.strictEqual(oldest.length, 12, "Still at most 12 re-checks per pass with many accounts");
  assert.strictEqual(oldest[0], "aged29", "The account checked longest ago goes first");
  assert(!oldest.includes("aged0"), "The most recently checked account waits for a later pass");
  const many = Array.from({ length: 20 }, (_, i) => ({ handle: "bulk" + i }));
  assert.strictEqual(shorts.staleRows(many, now).length, 12, "At most 12 re-checks per pass");
  shorts.setLiveState([]);
}

console.log("Testing site-wide isolation when locked...");
assert.strictEqual(shorts.isUnlocked("sampleclip"), true, "the configured account is unlocked");
assert.strictEqual(shorts.isUnlocked("lockclip"), false, "the added account stays locked");

// Mock site data with TikTok accounts
const sitePosts = [
  { id: "x:1", platform: "x", handle: "copperlane", text: "Mars!" },
  { id: "tiktok:sampleclip:pinned", platform: "tiktok", handle: "sampleclip", text: "Sampleclip post" },
  { id: "tiktok:lockclip:1", platform: "tiktok", handle: "lockclip", text: "Secret dance" },
  { id: "tiktok:another_locked:1", platform: "tiktok", handle: "another_locked", text: "Hidden" }
];

const siteFeeds = [
  { id: "x:copperlane", platform: "x", handle: "copperlane", name: "Copper Lane" },
  { id: "tiktok:sampleclip", platform: "tiktok", handle: "sampleclip", name: "Sampleclip" },
  { id: "tiktok:lockclip", platform: "tiktok", handle: "lockclip", name: "Gabii" },
  { id: "tiktok:another_locked", platform: "tiktok", handle: "another_locked", name: "Another" }
];

function isShortsLocked() {
  return window.ViktorychShorts && window.ViktorychShorts.isLocked();
}

function isTiktokUnlocked(handle) {
  return window.ViktorychShorts.isUnlocked(handle);
}

function isLockedTiktok(entity) {
  if (!entity) return false;
  const platform = entity.platform || (entity.id && String(entity.id).startsWith("tiktok:") ? "tiktok" : "");
  if (platform !== "tiktok") return false;
  return isShortsLocked() && !isTiktokUnlocked(entity.handle || entity.account);
}

// When locked:
shorts.setLocked(true);
const lockedVisiblePosts = sitePosts.filter((p) => !isLockedTiktok(p));
assert(lockedVisiblePosts.some((p) => p.handle === "sampleclip"), "Sampleclip post should be visible while locked");
assert(lockedVisiblePosts.some((p) => p.handle === "copperlane"), "Non-tiktok posts should be visible");
assert(!lockedVisiblePosts.some((p) => p.handle === "lockclip"), "Locked TikTok account lockclip must NOT be visible");
assert(!lockedVisiblePosts.some((p) => p.handle === "another_locked"), "Locked TikTok account another_locked must NOT be visible");

const lockedVisibleFeeds = siteFeeds.filter((f) => !isLockedTiktok(f));
assert(lockedVisibleFeeds.some((f) => f.handle === "sampleclip"), "Sampleclip feed should be visible while locked");
assert(!lockedVisibleFeeds.some((f) => f.handle === "lockclip"), "Locked TikTok account lockclip feed must NOT be visible");
assert(!lockedVisibleFeeds.some((f) => f.handle === "another_locked"), "Locked TikTok account another_locked feed must NOT be visible");

// When unlocked:
shorts.setLocked(false);
const unlockedVisiblePosts = sitePosts.filter((p) => !isLockedTiktok(p));
assert.strictEqual(unlockedVisiblePosts.length, sitePosts.length, "All posts visible when unlocked");
const unlockedVisibleFeeds = siteFeeds.filter((p) => !isLockedTiktok(p));
assert.strictEqual(unlockedVisibleFeeds.length, siteFeeds.length, "All feeds visible when unlocked");

console.log("Testing captcha modal APIs...");
let retryCalled = false;
const mockModal = { hidden: true, setAttribute: () => {} };
mockElements["tiktok-captcha-modal"] = mockModal;
shorts.showCaptcha({
  handle: "sampleclip",
  url: "https://www.tiktok.com/@sampleclip/live",
  onRetry: () => { retryCalled = true; }
});
assert.strictEqual(mockModal.hidden, false, "Modal must be shown after showCaptcha");
shorts.closeCaptcha();
assert.strictEqual(mockModal.hidden, true, "Modal must be hidden after closeCaptcha");

console.log("Testing live order, past lives, and playback steps...");
shorts.setLocked(false);
const ordered = shorts.orderLiveNow([
  { handle: "lockclip", live: true, viewers: 40 },
  { handle: "sampleclip", live: true, viewers: 2 },
  { handle: "other", live: false, viewers: 0 }
], []);
assert.deepStrictEqual(ordered.map((row) => row.handle), ["sampleclip", "lockclip", "other"]);
assert.strictEqual(shorts.neighborHandle(ordered, "sampleclip", 1), "lockclip");
assert.strictEqual(shorts.neighborHandle(ordered, "lockclip", -1), "sampleclip");
assert.strictEqual(shorts.neighborHandle(ordered, "sampleclip", -1), "");
const tied = shorts.orderLiveNow([
  { handle: "b_name", live: true, viewers: 5 },
  { handle: "a_name", live: true, viewers: 5 }
], ["b_name", "a_name"]);
assert.strictEqual(tied[0].handle, "b_name");
const sortRows = [
  { handle: "big", live: true, viewers: 90, since: 1000 },
  { handle: "small", live: true, viewers: 3, since: 3000 },
  { handle: "mid", live: true, viewers: 30, since: 2000 },
  { handle: "old", live: false, lastLiveAt: "2026-11-01T10:00:00Z" },
  { handle: "recent", live: false, lastLiveAt: "2026-11-19T10:00:00Z" },
  { handle: "aaa", live: false }
];
const names = (mode) => shorts.orderLiveNow(sortRows, [], mode).map((row) => row.handle);
assert.deepStrictEqual(names("few"), ["small", "mid", "big", "recent", "old", "aaa"], "fewest viewers first, then the most recently live");
assert.deepStrictEqual(names("most"), ["big", "mid", "small", "recent", "old", "aaa"], "most viewers first");
assert.deepStrictEqual(names("recent"), ["small", "mid", "big", "recent", "old", "aaa"], "newest live first");
assert.deepStrictEqual(names("name"), ["big", "mid", "small", "aaa", "old", "recent"], "A to Z keeps live on top");
assert.strictEqual(shorts.setLiveSortMode("nope"), "few", "an unknown sort falls back to the default");
assert.strictEqual(shorts.setLiveSortMode("most"), "most");
assert.strictEqual(shorts.liveSortMode(), "most", "the sort is remembered");
shorts.setLiveSortMode("few");
const oldT = global.window && global.window.t;
if (global.window) global.window.t = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? vars[name] : m));
assert.strictEqual(shorts.sinceText(0), "");
assert.ok(/Just went live/.test(shorts.sinceText(Date.now() - 5000)));
assert.ok(/Seen live for 12 min/.test(shorts.sinceText(Date.now() - 12 * 60000 - 500)));
assert.ok(/Seen live for 1 h 5 min/.test(shorts.sinceText(Date.now() - 65 * 60000 - 500)));
if (global.window) global.window.t = oldT;
shorts.setLiveState([
  { handle: "lockclip", live: true, viewers: 40 },
  { handle: "sampleclip", live: true, viewers: 2 }
]);
const nowHtml = shorts.page({ live: true, livePane: "now" });
assert(nowHtml.includes("shorts-preview"), "A live card has a muted preview video");
assert(nowHtml.includes("Live now"), "Live now sub-tab is present");
assert(nowHtml.includes("Past lives"), "Past lives sub-tab is present");
assert(nowHtml.indexOf("@sampleclip") < nowHtml.indexOf("@lockclip"), "Fewer viewers stay above more viewers");
assert(!nowHtml.includes('data-shorts="saved"'), "Live now does not embed past playback");
const strip = shorts.switchHtml("lockclip");
assert(strip.includes('data-handle="lockclip"') && strip.includes('data-handle="sampleclip"'), "the quick switch lists every live account");
assert(strip.includes('is-current'), "the quick switch marks the one that is playing");
assert.strictEqual((strip.match(/data-shorts="switch-live"/g) || []).length, 2);
shorts.setLiveState([{ handle: "lockclip", live: true, viewers: 40 }]);
assert.strictEqual(shorts.switchHtml("lockclip"), "", "a lone live has nothing to switch to");
shorts.setLiveState([{ handle: "lockclip", live: true, viewers: 40 }, { handle: "sampleclip", live: true, viewers: 2 }]);
const emptyPast = shorts.page({ live: true, livePane: "past" });
assert(emptyPast.includes("No recordings yet."), "An empty past list says there are no recordings yet");
shorts.setRecordings({
  cap: 12,
  active: 1,
  items: {
    lockclip: { state: "recording", endedAt: "2026-10-02T00:00:00Z", title: "current-only" },
    sampleclip: { state: "saved", key: "tiktok/sampleclip/1/live", endedAt: "2026-10-01T00:00:00Z" }
  },
  past: [
    { handle: "lockclip", state: "recording", startedAt: "2026-10-02T00:00:00Z", key: "tiktok/lockclip/1/live" },
    { handle: "sampleclip", state: "saved", startedAt: "2026-10-01T00:00:00Z", key: "tiktok/sampleclip/1/live", title: "earlier", bytes: 2 * 1024 * 1024, duration: 125, roomId: "7699647509498710805", thumb: "owner/live-thumbs/sampleclip/7699647509498710805.mp4" }
  ]
});
const pastHtml = shorts.page({ live: true, livePane: "past" });
assert(pastHtml.indexOf("@lockclip") < pastHtml.indexOf("@sampleclip"), "Past lives are newest first");
assert(pastHtml.includes("Recording ({n} of {cap})"), "In-progress captures are marked Recording");
assert(pastHtml.includes("earlier"), "Past lives read the per-handle history");
assert(!pastHtml.includes("current-only"), "Past lives do not fall back to the current row when history exists");
assert(pastHtml.includes(">2<"), "Past lives count badge is shown");
assert(pastHtml.includes("Size {size}"), "Past lives show the recording size");
assert(pastHtml.includes("2:05"), "Past lives show the duration");
assert(pastHtml.includes("data-thumb="), "A stored keyframe is the card thumbnail");
assert(pastHtml.includes("Download original") === false, "Download stays inside the player");
assert.strictEqual(shorts.formatBytes(1536), "1.5 KB");
assert.equal(shorts.previewsAllowed("auto", true, "all", "wifi"), false);
assert.equal(shorts.previewsAllowed("on", true, "never", "cellular"), true);
assert.equal(shorts.previewsAllowed("off", false, "all", "wifi"), false);
assert.equal(shorts.previewsAllowed("auto", false, "never", "wifi"), false);
assert.equal(shorts.lowestPreview({ variants: [{ quality: "origin", hls: "https://cdn.example/o.m3u8" }, { quality: "ld", hls: "https://cdn.example/l.m3u8" }, { quality: "ao", flv: "https://cdn.example/a.flv" }] }).url, "https://cdn.example/l.m3u8");
localStorage.setItem("viktorych_shorts_live_pane", "past");
const remembered = shorts.page({ live: true });
assert(remembered.includes('class="tab on" href="#/shorts/live/past"'), "The past sub-tab stays selected");
assert.strictEqual(shorts.hlsFatalPlan("mediaError", 0, true), "recover-media");
assert.strictEqual(shorts.hlsFatalPlan("networkError", 0, true), "live-edge");
const steps = shorts.playbackSteps({
  variants: [
    { quality: "origin", hls: "https://cdn.example/o.m3u8?expire=1", flv: "" },
    { quality: "hd", hls: "https://cdn.example/h.m3u8", flv: "" }
  ]
}, Date.now());
assert.strictEqual(steps[0].url, "https://cdn.example/h.m3u8");
const appSrc = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
assert(appSrc.includes("livePane"), "Shorts routes keep a live pane");

console.log("All Shorts locked mode and site-wide isolation tests passed successfully!");
