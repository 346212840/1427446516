const assert = require("assert");
const fs = require("fs");

console.log("Testing customizable sidebar navigation and folders...");

// Read app.js and extract the nav logic into an isolated sandbox
const appCode = fs.readFileSync("app.js", "utf-8");

// Mock global browser environment
global.window = {
  innerWidth: 1200,
  SI18n: {
    t: (k) => k,
    getLang: () => "en"
  },
  ViktorychShorts: { visible: () => true },
  ViktorychServerFeature: () => true,
  ViktorychVault: { visible: () => true },
  ViktorychAccounts: null,
  SIntelMusic: null
};

global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] || null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; }
};

// Evaluate the relevant parts
const tr = (k) => (global.window.SI18n ? global.window.SI18n.t(k) : k);
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const icon = (name) => `<svg data-icon="${name}"></svg>`;

// Extract DEFAULT_NAV_CUSTOM, ALL_NAV_IDS, cleanNavCustom, navItemDef, folderDisplayName, etc.
const scriptSandbox = `
function featureOn() { return true; }
function shortsEnabled() {
  return typeof SHORTS_ENABLED !== "undefined" && SHORTS_ENABLED === true;
}
${appCode.slice(appCode.indexOf("const DEFAULT_NAV_CUSTOM ="), appCode.indexOf("function brandLink() {"))}
`;

const contextFn = new Function("tr", "esc", "icon", "PATH", "STATE", "subsHash", "bellBadgeHtml", "render", scriptSandbox + `
  return {
    DEFAULT_NAV_CUSTOM,
    ALL_NAV_IDS,
    cleanNavCustom,
    navItemDef,
    getNavCustom,
    saveNavCustom,
    folderDisplayName,
    getNavOpenFolders,
    toggleNavFolder,
    renderNavLinks
  };
`);

const STATE = {
  settings: {},
  navEditingFolder: null
};

const navModule = contextFn(
  tr,
  esc,
  icon,
  {},
  STATE,
  () => "#/subscriptions",
  () => "",
  () => {}
);

const {
  DEFAULT_NAV_CUSTOM,
  ALL_NAV_IDS,
  cleanNavCustom,
  navItemDef,
  getNavCustom,
  saveNavCustom,
  folderDisplayName,
  getNavOpenFolders,
  toggleNavFolder,
  renderNavLinks
} = navModule;

// Test 1: Verify DEFAULT_NAV_CUSTOM
console.log("  Testing DEFAULT_NAV_CUSTOM...");
assert(Array.isArray(DEFAULT_NAV_CUSTOM.folders), "folders should be an array");
assert.strictEqual(DEFAULT_NAV_CUSTOM.folders.length, 2, "should have 2 default folders (Media and Library)");
assert(DEFAULT_NAV_CUSTOM.folders.some((f) => f.id === "media" && f.items.includes("music") && f.items.includes("tv")), "media folder should contain music and tv");
assert(DEFAULT_NAV_CUSTOM.folders.some((f) => f.id === "library" && f.items.includes("history")), "library folder should contain history");
assert(DEFAULT_NAV_CUSTOM.order.includes("folder:media"), "order must include folder:media");
assert(DEFAULT_NAV_CUSTOM.order.includes("folder:library"), "order must include folder:library");
assert(DEFAULT_NAV_CUSTOM.order.includes("home"), "order must include home");

// Test 2: cleanNavCustom
console.log("  Testing cleanNavCustom...");
const cleanEmpty = cleanNavCustom(null);
assert.deepStrictEqual(cleanEmpty.folders.length, 2, "null config should fallback to default 2 folders");

const customWithMissing = {
  folders: [{ id: "custom_fun", name: "Fun", items: ["games"] }],
  order: ["folder:custom_fun", "home"],
  hidden: ["vault"]
};
const cleaned = cleanNavCustom(customWithMissing);
assert.strictEqual(cleaned.folders.length, 1, "custom folder should be kept");
assert.strictEqual(cleaned.folders[0].name, "Fun", "folder name should be Fun");
assert(cleaned.order.includes("explore"), "missing IDs like explore should be automatically appended to order");
assert(!cleaned.order.includes("vault"), "hidden item vault should not be added to order");

// Test 3: folderDisplayName
console.log("  Testing folderDisplayName...");
assert.strictEqual(folderDisplayName({ id: "media", name: "Media" }), "Media");
assert.strictEqual(folderDisplayName({ id: "library", name: "Library" }), "Library");
assert.strictEqual(folderDisplayName({ id: "f_123", name: "My Stuff" }), "My Stuff");

// Test 4: navItemDef
console.log("  Testing navItemDef...");
ALL_NAV_IDS.forEach((id) => {
  const def = navItemDef(id);
  assert(def, "def should exist for " + id);
  assert(def.id === id, "def.id should match " + id);
  assert(typeof def.href === "string", "def.href should be string");
  assert(typeof def.active === "function", "def.active should be function");
});

// Test 5: renderNavLinks in normal desktop state
console.log("  Testing renderNavLinks output...");
STATE.settings.navCustom = DEFAULT_NAV_CUSTOM;
const html = renderNavLinks({ name: "home" });
assert(html.includes('href="#/"'), "must render Home link");
assert(html.includes('data-folder-id="media"'), "must render media folder");
assert(html.includes('data-folder-id="library"'), "must render library folder");
assert(!html.includes('open-nav-customize'), "the old greyed 'Customize sidebar' button must not come back (use the Customize row)");
assert(!html.includes('nav-customize-btn'), "the old greyed 'Customize sidebar' button must not come back");
assert(html.includes('nav-folder-caret'), "must render folder caret arrow");
assert(html.includes('nav-folder-rename-btn'), "must render folder rename pencil button");

// Test 6: folder toggle and expand
console.log("  Testing folder toggle...");
assert.strictEqual(getNavOpenFolders()["media"], undefined, "media folder initially undefined/closed");
toggleNavFolder("media");
assert.strictEqual(getNavOpenFolders()["media"], true, "media folder should now be open");
const htmlOpen = renderNavLinks({ name: "home" });
assert(htmlOpen.includes('data-folder-id="media"'), "renders folder");
assert(htmlOpen.includes('nav-folder-wrapper open'), "folder wrapper has open class");
assert(htmlOpen.includes('nav-folder-children open'), "folder children container has open class");
assert(htmlOpen.includes('href="#/music"'), "nested music item is rendered");

// Test 7: active child in closed folder shows active indicator
console.log("  Testing active child indicator in closed folder...");
toggleNavFolder("media"); // close it
assert.strictEqual(getNavOpenFolders()["media"], false, "media closed");
const htmlActive = renderNavLinks({ name: "tv" }); // route is tv, inside media folder
assert(htmlActive.includes('has-active'), "closed folder has has-active class");
assert(htmlActive.includes('nav-dot'), "closed folder shows nav-dot badge");

// Test 8: inline folder rename mode
console.log("  Testing inline folder rename...");
STATE.navEditingFolder = "media";
const htmlEditing = renderNavLinks({ name: "home" });
assert(htmlEditing.includes('class="nav-folder-rename-form"'), "renders inline rename form");
assert(htmlEditing.includes('id="nav-folder-rename-input"'), "renders inline rename input");
STATE.navEditingFolder = null;

console.log("All customizable sidebar navigation tests passed successfully!");

// Guard: the legacy greyed "Customize sidebar" entry and its old modal stay removed.
// Customize (data-act="customize-page") -> Edit menu (data-act="drawer-edit") is the only path.
console.log("  Checking the legacy Customize sidebar entry stays removed...");
const cssCode = fs.readFileSync("styles.css", "utf-8");
["open-nav-customize", "nav-customize-btn", "navCustomizeModal", "\"nav-customize\"", "nav-cust-", "nav-create-folder-submit", "nav-select-folder", "navNewFolderOpen", "Customize sidebar"].forEach((needle) => {
  assert(!appCode.includes(needle), "app.js must not bring back legacy sidebar customizer: " + needle);
});
["nav-customize-btn", "nav-cust-", "nav-customize-intro", "nav-new-folder-form", "nav-move-select"].forEach((needle) => {
  assert(!cssCode.includes(needle), "styles.css must not bring back legacy sidebar customizer CSS: " + needle);
});
["en", "es", "ru", "hi"].forEach((lang) => {
  const pack = fs.readFileSync("i18n/" + lang + ".js", "utf-8");
  assert(!pack.includes('"Customize sidebar"'), lang + " pack must not keep the legacy 'Customize sidebar' string");
});
assert(appCode.includes('if (id === "customize") return { id: id, href: "", icon: "sliders", label: tr("Customize"), locked: true, act: "customize-page" };'), "the white Customize row must stay in the menu");
assert(appCode.includes('data-act="drawer-edit"'), "the Customize page must keep its Edit menu row");
console.log("  Legacy entry guard OK");

function DRAWER_ALL_BUT_HOME(d) { return Object.keys(d.DRAWER_NAV).filter((id) => ["home", "settings", "logout", "customize"].indexOf(id) < 0 && id !== "calls" && id !== "contacts"); }
// Calls and Contacts in the sidebar, the phone menu and the bottom bar, including for layouts saved before they existed.
{
  console.log("  Checking Calls and Contacts reach saved layouts...");
  const ctx = navModule;
  assert(ctx.ALL_NAV_IDS.includes("calls") && ctx.ALL_NAV_IDS.includes("contacts"), "ALL_NAV_IDS lists calls and contacts");
  const saved = { folders: [], order: ["home", "explore", "notifications", "messages", "feeds", "lists", "settings"], hidden: [] };
  const clean = ctx.cleanNavCustom(saved);
  const mi = clean.order.indexOf("messages");
  const ci = clean.order.indexOf("calls");
  assert(ci > mi && clean.order.slice(mi + 1, ci).every((id) => id.indexOf("inbox-") === 0), "a saved sidebar gets Calls right under Inbox");
  assert.strictEqual(clean.order[ci + 1], "contacts");
  const hiddenKept = ctx.cleanNavCustom({ folders: [], order: saved.order, hidden: ["calls"] });
  assert(!hiddenKept.order.includes("calls"), "a hidden Calls stays hidden");
  assert(ctx.cleanNavCustom(null).order.includes("calls"), "the default sidebar has Calls");

  const drawerSrc = appCode.slice(appCode.indexOf("const DRAWER_LOCKED ="), appCode.indexOf("function getDrawerMenu()"));
  const drawer = new Function("tr", "window", drawerSrc + "; return { cleanDrawerMenu, defaultDrawerMenu, DRAWER_EXTRA, DRAWER_NAV };")(tr, global.window);
  assert(!drawer.DRAWER_EXTRA.includes("calls") && !drawer.DRAWER_EXTRA.includes("contacts"), "Calls is not tucked behind More");
  assert.strictEqual(drawer.DRAWER_NAV.calls, "calls");
  const def = drawer.defaultDrawerMenu();
  assert(def.order.indexOf("calls") > 0 && def.order.indexOf("calls") < def.order.indexOf("profile"), "the default phone menu lists Calls near the top");
  // A menu saved before v2 had Calls appended at the end (behind More).
  const old = drawer.cleanDrawerMenu({ order: ["home", "explore", "notifications", "profile", "tv", "messages", "calls", "contacts"], hidden: [], sections: [], popup: ["settings", "logout"] });
  assert.deepStrictEqual(old.order.slice(0, 5), ["home", "explore", "notifications", "calls", "contacts"], "an old saved menu lifts Calls under Notifications");
  assert.strictEqual(old.v, 3);
  // Once stamped, the person's own placement is kept.
  const mine = drawer.cleanDrawerMenu({ v: 3, order: ["home", "calls", "explore", "notifications"], hidden: [], sections: [], popup: ["settings", "logout"] });
  assert.strictEqual(mine.order[1], "calls");
  const hid = drawer.cleanDrawerMenu({ v: 3, order: ["home", "calls"], hidden: ["calls"], sections: [], popup: ["settings", "logout"] });
  assert(hid.hidden.includes("calls"), "hiding Calls in the menu sticks");
  const missing = drawer.cleanDrawerMenu({ v: 3, order: ["home", "explore"], hidden: [], sections: [], popup: ["settings", "logout"] });
  assert(missing.order.includes("calls") && missing.order.includes("contacts"), "an id missing from a saved menu is appended");

  // The owner's phone: Calls and Contacts hidden, Notifications hidden, Vault and History in the popup, saved as v2.
  const his = {
    v: 2,
    sections: [{ id: "f1", name: "Folder", emoji: "", items: ["calls", "bookmarks"] }],
    order: ["home", "explore", "notifications", "profile", "messages", "section:f1", "feeds", "subscriptions", "storage", "games", "music", "packages", "audiostudio"],
    hidden: ["explore", "notifications", "calls", "contacts", "profile"],
    popup: ["settings", "vault", "history", "logout"]
  };
  const migrated = drawer.cleanDrawerMenu(his);
  assert.strictEqual(migrated.v, 3);
  ["calls", "contacts"].forEach((id) => {
    assert(!migrated.hidden.includes(id), id + " is unhidden once");
    assert(!migrated.popup.includes(id) && migrated.sections.every((sec) => !sec.items.includes(id)), id + " is in the main list");
    assert(migrated.order.includes(id));
  });
  assert.deepStrictEqual(migrated.order.slice(0, 4), ["home", "calls", "contacts", "explore"], "with Notifications hidden they follow the first visible main item (Home)");
  assert(migrated.hidden.includes("notifications") && migrated.popup.includes("vault"), "the rest of his choices stay");
  // Re-cleaning the stamped result changes nothing, and a hide after v3 sticks.
  assert.deepStrictEqual(drawer.cleanDrawerMenu(migrated), migrated);
  const hiddenAfter = drawer.cleanDrawerMenu(Object.assign({}, migrated, { hidden: migrated.hidden.concat(["calls"]) }));
  assert(hiddenAfter.hidden.includes("calls"), "a hide after v3 stays hidden");
  // Notifications visible: they go right under it, in a v1 menu without v too.
  const nv = drawer.cleanDrawerMenu({ order: ["home", "explore", "notifications", "profile"], hidden: ["calls"], popup: ["settings", "logout"], sections: [] });
  assert.deepStrictEqual(nv.order.slice(0, 5), ["home", "explore", "notifications", "calls", "contacts"]);
  // Only Home visible: still reachable.
  const lone = drawer.cleanDrawerMenu({ v: 2, order: ["home"], hidden: DRAWER_ALL_BUT_HOME(drawer), popup: ["settings", "logout"], sections: [] });
  assert(lone.order.indexOf("calls") > 0 && !lone.hidden.includes("calls"));
  // Settings always carries a Calls row, and the sidebar migration is wired.
  assert(/settingsRow\("#\/calls", tr\("Calls"\)/.test(appCode), "Settings lists Calls");
  assert(/navCustom\.hidden = parsed\.navCustom\.hidden\.filter\(\(id\) => id !== "calls"/.test(appCode), "a sidebar saved with Calls hidden is unhidden once");

  assert(/const BOTTOM_NAV_IDS = \[[^\]]*"calls"/.test(appCode), "the bottom bar can pin Calls");
  console.log("  Calls and Contacts OK");
}
