/* contacts-ui.js - Contacts in the look and feel of Google Contacts, in ViktorychApp's X style.
   Left navigation (Contacts, Frequent, Recent calls, Other contacts, Labels, Merge & fix, Trash), an alphabetical list with
   sticky letters and a letter rail, a search bar, multi-select with bulk actions, a contact detail page, a create/edit
   sheet with several phones and emails, and labels. Signed-in people get Calls built in: a call button on every
   contact, scheduling, call history that they can edit, frequent and recent people, and contacts as call suggestions.
   Contacts stay on this device (local first). Guests on the stand-alone Calls page never load this file. */
(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ViktorychContacts = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORE_KEY = "viktorych_contacts_v3";
  const OLD_KEYS = ["viktorych_contacts_v2", "viktorych_contacts_v1"];
  const LABEL_KEY = "viktorych_contact_labels_v1";
  const TRASH_DAYS = 30;
  const PHONE_LABELS = ["Mobile", "Work", "Home", "Other"];
  const EMAIL_LABELS = ["Home", "Work", "Other"];

  const S = {
    contacts: [], labels: [], loaded: false, view: "contacts", query: "", sel: null, activeId: null, edit: null,
    nav: false, calls: [], callsLoaded: false, callSel: null, dialog: null, menu: "", toast: null, schedule: null, bound: false
  };
  let history = null;
  let toastTimer = 0;

  function tr(key, vars) {
    const fn = typeof window !== "undefined" ? (window.t || (window.SI18n && window.SI18n.t)) : null;
    return fn ? fn(key, vars) : String(key || "");
  }
  function trn(key, n) {
    const i = typeof window !== "undefined" ? window.SI18n : null;
    const out = i && i.tn ? i.tn(key, n) : "";
    return out && out.indexOf(key + ".") !== 0 ? out : String(n);
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; });
  }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  /* ---------- icons: X-style outlines, 24px, currentColor ---------- */
  const IC = {
    menu: "M4 6.5h16M4 12h16M4 17.5h16",
    search: "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5",
    close: "M6 6l12 12M18 6 6 18",
    plus: "M12 5v14M5 12h14",
    phone: "M21.5 16.9v2.6a2 2 0 0 1-2.2 2 18.7 18.7 0 0 1-8.1-2.9 18.4 18.4 0 0 1-5.7-5.7A18.7 18.7 0 0 1 2.6 4.7a2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.7a2 2 0 0 1-.5 2.1L8 10.2a14.7 14.7 0 0 0 5.8 5.8l1.2-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2z",
    mail: "M3.5 5.5h17v13h-17zM3.8 6l8.2 7 8.2-7",
    star: "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9-4.3-4.1 5.9-.8z",
    edit: "M4 20l1-4L16.5 4.5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8 19zM14.5 6.5l3 3",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7M9 7V4.5h6V7",
    more: "M12 6.2h.01M12 12h.01M12 17.8h.01",
    label: "M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0zM8 8h.01",
    merge: "M4 4.5l7 7M20 4.5l-7 7M12 11.5v8M8.5 16l3.5 3.5 3.5-3.5",
    clock: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zM12 7v5.5l3.5 2",
    person: "M12 12a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4zM4 20.5c.8-3.6 4-5.5 8-5.5s7.2 1.9 8 5.5",
    users: "M9 11.5a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2zM2.5 20c.6-3.2 3.3-5 6.5-5s5.9 1.8 6.5 5M16.5 5a3.2 3.2 0 0 1 0 6.3M18 15.2c1.8.5 3.2 2 3.6 4.8",
    back: "M19 12H5M11 6l-6 6 6 6",
    check: "M5 12.5l4.5 4.5L19 7.5",
    calendar: "M4 6.5h16V20H4zM4 10.5h16M8 3.5v4M16 3.5v4",
    work: "M4 8h16v11H4zM9 8V5h6v3",
    pin: "M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11zM12 12a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z",
    cake: "M4 20h16v-6H4zM4 14c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2M12 12V8M12 6.2v-.4",
    note: "M5 4h14v16H5zM8.5 9h7M8.5 13h7M8.5 17h4",
    download: "M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14",
    upload: "M12 16V5M7.5 9L12 4.5 16.5 9M5 20h14",
    restore: "M4 12a8 8 0 1 0 2.5-5.8L4 8.5M4 4v4.5h4.5",
    chat: "M4 5h16v11H9l-5 4z",
    sms: "M4 5h16v11H8l-4 4zM8 9.5h8M8 12.5h5",
    incoming: "M18 6L7 17M7 8v9h9",
    outgoing: "M6 18L17 7M8 7h9v9"
  };
  function ico(name, cls) {
    const filled = name === "starOn";
    const path = IC[filled ? "star" : name] || "";
    return '<svg class="gc-ico' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true" fill="' + (filled ? "currentColor" : "none") + '" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
  }

  /* ---------- people ---------- */
  const COLORS = ["#1d9bf0", "#00ba7c", "#f91880", "#7856ff", "#ff7a00", "#e0a800", "#0a8f6a", "#c2185b"];
  function colorFor(name) {
    let hash = 0;
    const str = String(name || "x");
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return COLORS[Math.abs(hash) % COLORS.length];
  }
  function cleanHandle(h) { return String(h || "").replace(/^@/, "").trim().toLowerCase(); }
  function digits(v) { return String(v || "").replace(/[^0-9+]/g, ""); }
  function splitName(full) {
    const parts = String(full || "").trim().split(/\s+/);
    return { first: parts.shift() || "", last: parts.join(" ") };
  }
  function normalize(c) {
    if (!c || typeof c !== "object") return null;
    const n = {
      id: String(c.id || uid("c_")),
      first: String(c.first || ""),
      last: String(c.last || ""),
      company: String(c.company || ""),
      title: String(c.title || ""),
      phones: Array.isArray(c.phones) ? c.phones.filter((p) => p && p.v) : (c.phone ? [{ v: String(c.phone), label: "Mobile" }] : []),
      emails: Array.isArray(c.emails) ? c.emails.filter((p) => p && p.v) : (c.email ? [{ v: String(c.email), label: "Home" }] : []),
      handle: cleanHandle(c.handle),
      pid: String(c.pid || ""),
      birthday: String(c.birthday || ""),
      address: String(c.address || ""),
      notes: String(c.notes || ""),
      labels: Array.isArray(c.labels) ? c.labels.slice() : [],
      favorite: !!c.favorite,
      created: Number(c.created) || Date.now(),
      trashedAt: Number(c.trashedAt) || 0
    };
    if (!n.first && !n.last && c.name) { const s = splitName(c.name); n.first = s.first; n.last = s.last; }
    return n;
  }
  function nameOf(c) {
    const full = (c.first + " " + c.last).trim();
    if (full) return full;
    if (c.company) return c.company;
    if (c.phones[0]) return c.phones[0].v;
    if (c.emails[0]) return c.emails[0].v;
    if (c.handle) return "@" + c.handle;
    return tr("No name");
  }
  function letterOf(c) {
    const ch = nameOf(c).charAt(0).toUpperCase();
    return /\p{L}/u.test(ch) ? ch : "#";
  }
  function sub(c) {
    return (c.phones[0] && c.phones[0].v) || (c.emails[0] && c.emails[0].v) || (c.handle ? "@" + c.handle : "") || c.company || "";
  }

  /* ---------- storage ---------- */
  function load() {
    if (S.loaded) return;
    S.loaded = true;
    let list = [];
    try {
      let raw = localStorage.getItem(STORE_KEY);
      for (let i = 0; !raw && i < OLD_KEYS.length; i++) raw = localStorage.getItem(OLD_KEYS[i]);
      list = raw ? JSON.parse(raw) : [];
    } catch (err) { list = []; }
    S.contacts = (Array.isArray(list) ? list : []).map(normalize).filter(Boolean);
    const cut = Date.now() - TRASH_DAYS * 86400000;
    S.contacts = S.contacts.filter((c) => !c.trashedAt || c.trashedAt > cut);
    try { S.labels = JSON.parse(localStorage.getItem(LABEL_KEY) || "[]").filter((l) => l && l.id && l.name); } catch (err) { S.labels = []; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S.contacts)); } catch (err) { /* private mode */ }
    try { localStorage.setItem(LABEL_KEY, JSON.stringify(S.labels)); } catch (err) { /* private mode */ }
  }
  function byId(id) { return S.contacts.find((c) => c.id === id) || null; }
  function live() { return S.contacts.filter((c) => !c.trashedAt); }

  /* ---------- Calls ---------- */
  function signedIn() {
    const a = typeof window !== "undefined" ? window.ViktorychAccounts : null;
    try { return !!(a && a.token && a.token()); } catch (err) { return false; }
  }
  function loadCalls() {
    if (!signedIn()) { S.calls = []; return Promise.resolve(); }
    return import("./shared/call-history.js").then((mod) => {
      if (!history) history = mod.createHistory({ api: mod.makeApi(window), storage: localStorage, signedIn: signedIn });
      return history.load().then(() => { S.calls = history.rows; S.callsLoaded = true; if (mounted()) paint(); });
    }).catch(() => {});
  }
  function callCounts() {
    const out = {};
    S.calls.forEach((row) => {
      const h = cleanHandle(row.handle);
      if (!h) return;
      const o = out[h] || (out[h] = { count: 0, last: 0, name: row.name || "" });
      o.count += 1;
      o.last = Math.max(o.last, row.createdAt || 0);
      if (!o.name && row.name) o.name = row.name;
    });
    return out;
  }
  function frequent() {
    const counts = callCounts();
    return live().map((c) => ({ c: c, n: (c.handle && counts[c.handle] ? counts[c.handle].count : 0) }))
      .filter((x) => x.n > 0 || x.c.favorite)
      .sort((a, b) => (b.n + (b.c.favorite ? 0.5 : 0)) - (a.n + (a.c.favorite ? 0.5 : 0)))
      .map((x) => x.c);
  }
  function others() {
    const counts = callCounts();
    const known = {};
    live().forEach((c) => { if (c.handle) known[c.handle] = true; });
    return Object.keys(counts).filter((h) => !known[h]).sort((a, b) => counts[b].last - counts[a].last).map((h) => ({ handle: h, name: counts[h].name || "@" + h, count: counts[h].count }));
  }
  function callsFor(c) {
    if (!c || !c.handle) return [];
    return S.calls.filter((row) => cleanHandle(row.handle) === c.handle);
  }

  /* ---------- lists for each view ---------- */
  function matches(c, q) {
    if (!q) return true;
    const hay = [nameOf(c), c.company, c.title, c.handle, c.notes, c.phones.map((p) => p.v).join(" "), c.emails.map((p) => p.v).join(" ")].join(" ").toLowerCase();
    return hay.indexOf(q) >= 0 || (digits(q) && digits(hay).indexOf(digits(q)) >= 0);
  }
  function sortByName(list) {
    return list.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }));
  }
  function visible() {
    const q = S.query.trim().toLowerCase();
    const v = S.view;
    let list;
    if (v === "trash") list = S.contacts.filter((c) => c.trashedAt);
    else if (v === "frequent") return frequent().filter((c) => matches(c, q));
    else if (v.indexOf("label:") === 0) { const id = v.slice(6); list = live().filter((c) => c.labels.indexOf(id) >= 0); }
    else list = live();
    return sortByName(list.filter((c) => matches(c, q)));
  }
  function duplicates() {
    const keys = {};
    live().forEach((c) => {
      const ks = [];
      const nm = nameOf(c).toLowerCase();
      if (c.first || c.last) ks.push("n:" + nm);
      c.phones.forEach((p) => { const d = digits(p.v); if (d.length >= 5) ks.push("p:" + d); });
      c.emails.forEach((p) => ks.push("e:" + p.v.toLowerCase()));
      if (c.handle) ks.push("h:" + c.handle);
      ks.forEach((k) => { (keys[k] = keys[k] || []).push(c.id); });
    });
    const merged = [];
    Object.keys(keys).forEach((k) => {
      const ids = keys[k];
      if (ids.length < 2) return;
      const hit = merged.find((m) => m.some((id) => ids.indexOf(id) >= 0));
      if (hit) ids.forEach((id) => { if (hit.indexOf(id) < 0) hit.push(id); });
      else merged.push(ids.slice());
    });
    return merged;
  }
  function missingInfo() {
    return live().filter((c) => !c.phones.length && !c.emails.length && !c.handle);
  }

  /* ---------- html ---------- */
  function avatar(c, size) {
    const inner = '<span class="gc-ava' + (size ? " " + size : "") + '" style="background:' + colorFor(nameOf(c)) + '">' + esc(nameOf(c).charAt(0).toUpperCase()) + "</span>";
    if (c.pid && window.ViktorychPresence && window.ViktorychPresence.wrap) return window.ViktorychPresence.wrap(c.pid, inner);
    return inner;
  }
  function callLink(handle, label, cls) {
    return '<a class="' + cls + '" href="#/calls?to=' + esc(encodeURIComponent(handle)) + '" data-act="call-open" data-handle="' + esc(handle) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + ico("phone") + (cls === "gc-act" ? "<span>" + esc(label) + "</span>" : "") + "</a>";
  }
  function navItem(view, icon, label, count) {
    return '<button type="button" class="gc-nav-item' + (S.view === view ? " on" : "") + '" data-act="ct-view-set" data-view="' + esc(view) + '">' + ico(icon) + "<span>" + esc(label) + "</span>" + (count != null && count !== "" ? '<em class="gc-count">' + esc(count) + "</em>" : "") + "</button>";
  }
  function navHtml() {
    const calls = signedIn();
    const dupes = duplicates().length;
    const labels = S.labels.map((l) => navItem("label:" + l.id, "label", l.name, live().filter((c) => c.labels.indexOf(l.id) >= 0).length)).join("");
    return '<aside class="gc-nav" aria-label="' + esc(tr("Contacts menu")) + '">' +
      '<button type="button" class="gc-create" data-act="ct-new">' + ico("plus") + "<span>" + esc(tr("Create contact")) + "</span></button>" +
      navItem("contacts", "person", tr("Contacts"), live().length) +
      (calls ? navItem("frequent", "star", tr("Frequent")) + navItem("recent", "clock", tr("Recent calls")) + navItem("other", "users", tr("Other contacts"), others().length || "") : "") +
      '<div class="gc-nav-h">' + esc(tr("Labels")) + '<button type="button" class="gc-mini" data-act="ct-label-new" aria-label="' + esc(tr("Create label")) + '">' + ico("plus") + "</button></div>" +
      labels +
      '<div class="gc-nav-sep"></div>' +
      navItem("merge", "merge", tr("Merge & fix"), dupes || "") +
      navItem("trash", "trash", tr("Trash"), S.contacts.filter((c) => c.trashedAt).length || "") +
      '<div class="gc-nav-sep"></div>' +
      '<button type="button" class="gc-nav-item" data-act="ct-import">' + ico("upload") + "<span>" + esc(tr("Import")) + "</span></button>" +
      '<button type="button" class="gc-nav-item" data-act="ct-export-all">' + ico("download") + "<span>" + esc(tr("Export")) + "</span></button>" +
      "</aside>";
  }
  function barHtml() {
    if (S.sel) return selBar();
    return '<header class="gc-bar"><button type="button" class="gc-icon gc-burger" data-act="ct-nav" aria-label="' + esc(tr("Menu")) + '">' + ico("menu") + "</button>" +
      '<label class="gc-search">' + ico("search") + '<input type="search" name="q" value="' + esc(S.query) + '" placeholder="' + esc(tr("Search contacts")) + '" aria-label="' + esc(tr("Search contacts")) + '" autocomplete="off">' +
      (S.query ? '<button type="button" class="gc-icon sm" data-act="ct-search-clear" aria-label="' + esc(tr("Clear")) + '">' + ico("close") + "</button>" : "") + "</label></header>";
  }
  function iconBtn(act, icon, label) {
    return '<button type="button" class="gc-icon" data-act="' + act + '" aria-label="' + esc(label) + '" title="' + esc(label) + '">' + ico(icon) + "</button>";
  }
  function selBar() {
    const n = S.sel.size;
    const trash = S.view === "trash";
    return '<header class="gc-bar sel">' + iconBtn("ct-sel-clear", "close", tr("Cancel")) + '<b class="gc-seln">' + esc(trn("ctSelected", n)) + "</b>" + iconBtn("ct-sel-all", "check", tr("Select all")) +
      (trash
        ? iconBtn("ct-sel-restore", "restore", tr("Restore")) + iconBtn("ct-sel-purge", "trash", tr("Delete forever"))
        : iconBtn("ct-sel-star", "star", tr("Star")) + iconBtn("ct-sel-label", "label", tr("Manage labels")) + (n >= 2 ? iconBtn("ct-sel-merge", "merge", tr("Merge")) : "") + iconBtn("ct-sel-export", "download", tr("Export")) + iconBtn("ct-sel-delete", "trash", tr("Delete"))) +
      "</header>";
  }
  function rowHtml(c) {
    const picked = S.sel && S.sel.has(c.id);
    const call = signedIn() && c.handle ? callLink(c.handle, tr("Call"), "gc-icon sm") : "";
    return '<div class="gc-row' + (picked ? " picked" : "") + (S.activeId === c.id ? " active" : "") + '" data-id="' + esc(c.id) + '" data-act="ct-open" tabindex="0">' +
      '<span class="gc-pick" data-act="ct-pick" data-id="' + esc(c.id) + '" role="checkbox" aria-checked="' + (picked ? "true" : "false") + '" aria-label="' + esc(nameOf(c)) + '">' + avatar(c) + '<span class="gc-tick">' + ico("check") + "</span></span>" +
      '<span class="gc-rname"><b>' + esc(nameOf(c)) + "</b></span>" +
      '<span class="gc-rsub">' + esc(sub(c)) + "</span>" +
      '<span class="gc-rco">' + esc([c.title, c.company].filter(Boolean).join(", ")) + "</span>" +
      '<span class="gc-racts" data-act="stop">' + call + '<button type="button" class="gc-icon sm' + (c.favorite ? " on" : "") + '" data-act="ct-star" data-id="' + esc(c.id) + '" aria-label="' + esc(tr("Star")) + '">' + ico(c.favorite ? "starOn" : "star") + "</button></span></div>";
  }
  function listHtml(list) {
    if (!list.length) return emptyHtml();
    if (S.view === "frequent") return '<div class="gc-group">' + list.map(rowHtml).join("") + "</div>";
    let out = "";
    let cur = "";
    const letters = [];
    list.forEach((c) => {
      const l = letterOf(c);
      if (l !== cur) { cur = l; letters.push(l); out += '<div class="gc-letter" id="gc-l-' + esc(l) + '">' + esc(l) + "</div>"; }
      out += rowHtml(c);
    });
    const rail = letters.length > 6 && !S.query ? '<nav class="gc-rail" aria-hidden="true">' + letters.map((l) => '<button type="button" tabindex="-1" data-act="ct-jump" data-l="' + esc(l) + '">' + esc(l) + "</button>").join("") + "</nav>" : "";
    return '<div class="gc-group">' + out + "</div>" + rail;
  }
  function emptyHtml() {
    const box = (title, text, extra) => '<div class="gc-empty"><b>' + esc(title) + "</b><span>" + esc(text) + "</span>" + (extra || "") + "</div>";
    if (S.query) return box(tr("No matching contacts"), tr("Try a different name or number."));
    if (S.view === "trash") return box(tr("Trash is empty"), tr("Deleted contacts stay here for 30 days."));
    if (S.view === "frequent") return box(tr("No frequent contacts yet"), tr("People you call or star show up here."));
    if (S.view.indexOf("label:") === 0) return box(tr("No contacts with this label"), tr("Select contacts and use the label button."));
    return box(tr("No contacts yet"), tr("Add a contact or import them from your phone."), '<div class="gc-empty-acts"><button type="button" class="gc-btn primary" data-act="ct-new">' + esc(tr("Create contact")) + '</button><button type="button" class="gc-btn" data-act="ct-sync-device">' + esc(tr("Import from phone")) + "</button></div>");
  }
  function relTime(ms) {
    try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)); } catch (err) { return ""; }
  }
  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }
  function callRows(rows, selectable) {
    return rows.slice(0, 40).map((row) => {
      const label = row.name || (row.handle ? "@" + row.handle : tr("Guest"));
      const kind = row.missed ? tr("Missed call") : (row.incoming ? tr("Incoming call") : tr("Outgoing call"));
      const picked = selectable && S.callSel && S.callSel.has(row.id);
      const lead = selectable && S.callSel ? '<button type="button" class="gc-check' + (picked ? " on" : "") + '" data-act="ct-call-pick" data-id="' + esc(row.id) + '" role="checkbox" aria-checked="' + (picked ? "true" : "false") + '" aria-label="' + esc(label) + '">' + (picked ? ico("check") : "") + "</button>" : "";
      return '<div class="gc-crow' + (row.missed ? " missed" : "") + '" data-cid="' + esc(row.id) + '">' + lead +
        '<span class="gc-ava sm" style="background:' + colorFor(label) + '">' + esc(label.charAt(0).toUpperCase()) + "</span>" +
        '<span class="gc-ctext"><b>' + esc(label) + "</b><small>" + ico(row.incoming ? "incoming" : "outgoing", "tiny") + esc(kind) + " · " + esc(relTime(row.createdAt)) + (row.duration ? " · " + esc(clock(row.duration)) : "") + "</small></span>" +
        (row.handle && !S.callSel ? callLink(row.handle, tr("Call back"), "gc-icon sm") : "") +
        (!S.callSel ? '<button type="button" class="gc-icon sm" data-act="ct-call-del" data-id="' + esc(row.id) + '" aria-label="' + esc(tr("Remove from history")) + '" title="' + esc(tr("Remove from history")) + '">' + ico("close") + "</button>" : "") +
        "</div>";
    }).join("");
  }
  function recentHtml() {
    if (!signedIn()) return '<div class="gc-empty"><b>' + esc(tr("Sign in to see your calls.")) + "</b></div>";
    if (!S.calls.length) return '<div class="gc-empty"><b>' + esc(tr("No calls yet")) + "</b><span>" + esc(tr("Calls you make or take show up here.")) + "</span></div>";
    const sel = S.callSel;
    const bar = sel
      ? '<div class="gc-hbar sel"><button type="button" class="gc-link" data-act="ct-call-cancel">' + esc(tr("Cancel")) + "</button><b>" + esc(trn("callsSelected", sel.size)) + '</b><button type="button" class="gc-link" data-act="ct-call-all">' + esc(tr("Select all")) + '</button><button type="button" class="gc-btn danger" data-act="ct-call-delete"' + (sel.size ? "" : " disabled") + ">" + ico("trash") + esc(tr("Delete")) + "</button></div>"
      : '<div class="gc-hbar"><button type="button" class="gc-link" data-act="ct-call-select">' + esc(tr("Select")) + '</button><button type="button" class="gc-link" data-act="ct-call-clear">' + esc(tr("Clear all")) + "</button></div>";
    return '<div class="gc-calls">' + bar + callRows(S.calls, true) + "</div>";
  }
  function otherHtml() {
    const list = others();
    if (!list.length) return '<div class="gc-empty"><b>' + esc(tr("No other contacts")) + "</b><span>" + esc(tr("People you call who are not in your contacts show up here.")) + "</span></div>";
    return '<div class="gc-group">' + list.map((o) => '<div class="gc-row" data-act="stop"><span class="gc-pick"><span class="gc-ava" style="background:' + colorFor(o.name) + '">' + esc(o.name.charAt(0).toUpperCase()) + "</span></span>" +
      '<span class="gc-rname"><b>' + esc(o.name) + '</b></span><span class="gc-rsub">@' + esc(o.handle) + " · " + esc(trn("ctCalls", o.count)) + '</span><span class="gc-rco"></span>' +
      '<span class="gc-racts always">' + callLink(o.handle, tr("Call"), "gc-icon sm") + '<button type="button" class="gc-btn" data-act="ct-add-other" data-handle="' + esc(o.handle) + '" data-name="' + esc(o.name) + '">' + esc(tr("Add to contacts")) + "</button></span></div>").join("") + "</div>";
  }
  function mergeHtml() {
    const groups = duplicates();
    const missing = missingInfo();
    let out = '<section class="gc-card"><h3>' + esc(tr("Merge duplicates")) + "</h3>";
    if (!groups.length) out += '<p class="gc-muted">' + esc(tr("No duplicates found.")) + "</p>";
    groups.forEach((g, i) => {
      out += '<div class="gc-dupe"><div class="gc-dupe-list">' + g.map((id) => { const c = byId(id); return c ? '<span class="gc-chip">' + avatar(c, "xs") + esc(nameOf(c)) + "<small>" + esc(sub(c)) + "</small></span>" : ""; }).join("") + '</div><button type="button" class="gc-btn primary" data-act="ct-merge-group" data-i="' + i + '">' + esc(tr("Merge")) + "</button></div>";
    });
    out += '</section><section class="gc-card"><h3>' + esc(tr("Contacts without a number or email")) + "</h3>";
    if (!missing.length) out += '<p class="gc-muted">' + esc(tr("Everything has a way to reach it.")) + "</p>";
    else out += '<div class="gc-group">' + missing.map(rowHtml).join("") + "</div>";
    return out + "</section>";
  }
  function viewTitle() {
    const v = S.view;
    if (v === "contacts") return tr("Contacts") + " (" + live().length + ")";
    if (v === "frequent") return tr("Frequent");
    if (v === "recent") return tr("Recent calls");
    if (v === "other") return tr("Other contacts");
    if (v === "merge") return tr("Merge & fix");
    if (v === "trash") return tr("Trash");
    const l = S.labels.find((x) => "label:" + x.id === v);
    return l ? l.name : tr("Contacts");
  }
  function titleHtml() {
    let extra = "";
    if (S.view.indexOf("label:") === 0) extra = '<span class="gc-title-acts"><button type="button" class="gc-btn" data-act="ct-label-rename">' + esc(tr("Rename")) + '</button><button type="button" class="gc-btn danger" data-act="ct-label-delete">' + esc(tr("Delete label")) + "</button></span>";
    if (S.view === "trash" && S.contacts.some((c) => c.trashedAt)) extra = '<span class="gc-title-acts"><button type="button" class="gc-btn danger" data-act="ct-trash-empty">' + esc(tr("Empty trash")) + "</button></span>";
    return '<div class="gc-title"><h2>' + esc(viewTitle()) + "</h2>" + extra + "</div>";
  }
  function mainBody() {
    if (S.view === "recent") return recentHtml();
    if (S.view === "other") return otherHtml();
    if (S.view === "merge") return mergeHtml();
    return listHtml(visible());
  }

  function infoRow(icon, body) {
    return '<div class="gc-info">' + ico(icon) + '<div class="gc-info-t">' + body + "</div></div>";
  }
  function actBtn(act, icon, label, id) {
    return '<button type="button" class="gc-act" data-act="' + act + '" data-id="' + esc(id) + '">' + ico(icon) + "<span>" + esc(label) + "</span></button>";
  }
  function detailHtml(c) {
    const calls = signedIn();
    const trash = !!c.trashedAt;
    const pri = c.phones[0] ? c.phones[0].v : "";
    const callBtn = calls && c.handle ? callLink(c.handle, tr("Call"), "gc-act")
      : (pri ? '<a class="gc-act" href="tel:' + esc(pri) + '">' + ico("phone") + "<span>" + esc(tr("Call")) + "</span></a>" : "");
    const acts = trash ? actBtn("ct-restore", "restore", tr("Restore"), c.id)
      : callBtn + (calls ? actBtn("ct-schedule", "calendar", tr("Schedule"), c.id) : "") +
        (pri ? '<a class="gc-act" href="sms:' + esc(pri) + '">' + ico("sms") + "<span>" + esc(tr("Text")) + "</span></a>" : "") +
        (c.emails[0] ? '<a class="gc-act" href="mailto:' + esc(c.emails[0].v) + '">' + ico("mail") + "<span>" + esc(tr("Email")) + "</span></a>" : "");
    const chips = c.labels.map((id) => S.labels.find((l) => l.id === id)).filter(Boolean).map((l) => '<span class="gc-chip">' + ico("label") + esc(l.name) + "</span>").join("");
    const phones = c.phones.map((p) => infoRow("phone", '<a href="tel:' + esc(p.v) + '">' + esc(p.v) + "</a><small>" + esc(tr(p.label || "Mobile")) + "</small>")).join("");
    const emails = c.emails.map((p) => infoRow("mail", '<a href="mailto:' + esc(p.v) + '">' + esc(p.v) + "</a><small>" + esc(tr(p.label || "Home")) + "</small>")).join("");
    const hRow = c.handle ? '<div class="gc-info"><span class="gc-at">@</span><div class="gc-info-t"><b>@' + esc(c.handle) + "</b><small>" + esc(tr("Viktorych username")) + "</small></div></div>" : "";
    const about = [c.birthday ? infoRow("cake", esc(c.birthday)) : "", c.address ? infoRow("pin", esc(c.address)) : "", c.notes ? infoRow("note", esc(c.notes).replace(/\n/g, "<br>")) : "", (c.company || c.title) ? infoRow("work", esc([c.title, c.company].filter(Boolean).join(", "))) : ""].join("");
    const rows = calls ? callsFor(c) : [];
    const recent = calls && c.handle ? '<section class="gc-card"><h3>' + esc(tr("Recent calls")) + "</h3>" + (rows.length ? callRows(rows, false) : '<p class="gc-muted">' + esc(tr("No calls with this person yet.")) + "</p>") + "</section>" : "";
    const menu = S.menu === "detail" ? '<div class="gc-menu" role="menu"><button type="button" role="menuitem" data-act="ct-share-vcf" data-id="' + esc(c.id) + '">' + esc(tr("Export")) + "</button>" +
      (trash ? '<button type="button" role="menuitem" data-act="ct-purge" data-id="' + esc(c.id) + '">' + esc(tr("Delete forever")) + "</button>" : '<button type="button" role="menuitem" data-act="ct-delete" data-id="' + esc(c.id) + '">' + esc(tr("Delete")) + "</button>") + "</div>" : "";
    return '<div class="gc-dtop"><button type="button" class="gc-icon gc-dback" data-act="ct-back" aria-label="' + esc(tr("Back")) + '">' + ico("back") + '</button><span class="gc-grow"></span>' +
      (trash ? "" : '<button type="button" class="gc-icon' + (c.favorite ? " on" : "") + '" data-act="ct-star" data-id="' + esc(c.id) + '" aria-label="' + esc(tr("Star")) + '">' + ico(c.favorite ? "starOn" : "star") + "</button>" + iconBtn("ct-edit\" data-id=\"" + esc(c.id), "edit", tr("Edit"))) +
      iconBtn("ct-menu", "more", tr("More")) + menu + "</div>" +
      '<div class="gc-dhead">' + avatar(c, "xl") + "<h2>" + esc(nameOf(c)) + "</h2>" + ((c.title || c.company) ? "<p>" + esc([c.title, c.company].filter(Boolean).join(", ")) + "</p>" : "") + (chips ? '<div class="gc-chips">' + chips + "</div>" : "") + "</div>" +
      '<div class="gc-acts">' + acts + "</div>" +
      ((phones || emails || hRow) ? '<section class="gc-card"><h3>' + esc(tr("Contact info")) + "</h3>" + phones + emails + hRow + "</section>" : "") +
      (about ? '<section class="gc-card"><h3>' + esc(tr("About")) + "</h3>" + about + "</section>" : "") + recent;
  }
  function fieldRows(kind, list, labels) {
    const items = list.length ? list : [{ v: "", label: labels[0] }];
    return items.map((p, i) => '<div class="gc-frow"><input name="' + kind + '-v" type="' + (kind === "phone" ? "tel" : "email") + '" value="' + esc(p.v) + '" placeholder="' + esc(kind === "phone" ? tr("Phone") : tr("Email")) + '" aria-label="' + esc(kind === "phone" ? tr("Phone") : tr("Email")) + '"><select name="' + kind + '-l" aria-label="' + esc(tr("Label")) + '">' + labels.map((l) => '<option value="' + l + '"' + ((p.label || labels[0]) === l ? " selected" : "") + ">" + esc(tr(l)) + "</option>").join("") + "</select>" +
      (items.length > 1 ? '<button type="button" class="gc-icon sm" data-act="ct-field-del" data-kind="' + kind + '" data-i="' + i + '" aria-label="' + esc(tr("Remove")) + '">' + ico("close") + "</button>" : "") + "</div>").join("");
  }
  function fgroup(icon, inner) { return '<div class="gc-fgroup">' + (icon === "@" ? '<span class="gc-at">@</span>' : ico(icon)) + "<div>" + inner + "</div></div>"; }
  function frow(inner) { return '<div class="gc-frow">' + inner + "</div>"; }
  function editHtml() {
    const d = S.edit;
    const isNew = !d.id;
    const field = (name, label, value, extra) => '<input name="' + name + '" value="' + esc(value) + '" placeholder="' + esc(label) + '" aria-label="' + esc(label) + '"' + (extra || "") + ">";
    return '<div class="gc-modal-wrap" data-scrim="edit"><form class="gc-sheet" data-form="edit" role="dialog" aria-modal="true" aria-labelledby="gc-edit-t">' +
      '<header class="gc-sheet-h"><button type="button" class="gc-icon" data-act="ct-edit-cancel" aria-label="' + esc(tr("Cancel")) + '">' + ico("close") + '</button><h2 id="gc-edit-t">' + esc(isNew ? tr("Create contact") : tr("Edit contact")) + '</h2><button type="submit" class="gc-btn primary">' + esc(tr("Save")) + "</button></header>" +
      '<div class="gc-sheet-b"><div class="gc-sheet-ava"><span class="gc-ava xl" style="background:' + colorFor(d.first + d.last) + '">' + esc((d.first || d.last || "?").charAt(0).toUpperCase()) + "</span></div>" +
      '<div class="gc-two"><label>' + ico("person") + field("first", tr("First name"), d.first, ' autocomplete="off"') + '</label><label class="plain">' + field("last", tr("Last name"), d.last, ' autocomplete="off"') + "</label></div>" +
      '<div class="gc-two"><label>' + ico("work") + field("company", tr("Company"), d.company) + '</label><label class="plain">' + field("title", tr("Job title"), d.title) + "</label></div>" +
      fgroup("phone", fieldRows("phone", d.phones, PHONE_LABELS) + '<button type="button" class="gc-link" data-act="ct-field-add" data-kind="phone">' + esc(tr("Add phone")) + "</button>") +
      fgroup("mail", fieldRows("email", d.emails, EMAIL_LABELS) + '<button type="button" class="gc-link" data-act="ct-field-add" data-kind="email">' + esc(tr("Add email")) + "</button>") +
      fgroup("@", frow(field("handle", tr("Viktorych username"), d.handle, ' autocapitalize="off" autocomplete="off"'))) +
      fgroup("cake", frow('<input name="birthday" type="date" value="' + esc(d.birthday) + '" aria-label="' + esc(tr("Birthday")) + '">')) +
      fgroup("pin", frow(field("address", tr("Address"), d.address))) +
      fgroup("note", frow('<textarea name="notes" rows="3" placeholder="' + esc(tr("Notes")) + '" aria-label="' + esc(tr("Notes")) + '">' + esc(d.notes) + "</textarea>")) +
      (S.labels.length ? fgroup("label", '<div class="gc-chips pick">' + S.labels.map((l) => '<label class="gc-chip pick"><input type="checkbox" name="lab" value="' + esc(l.id) + '"' + (d.labels.indexOf(l.id) >= 0 ? " checked" : "") + ">" + esc(l.name) + "</label>").join("") + "</div>") : "") +
      "</div></form></div>";
  }
  function dialogHtml() {
    const d = S.dialog;
    return '<div class="gc-modal-wrap" data-scrim="dialog"><div class="gc-dialog" role="dialog" aria-modal="true" aria-labelledby="gc-dlg-t"><h2 id="gc-dlg-t">' + esc(d.title) + "</h2>" + (d.text ? '<p class="gc-muted">' + esc(d.text) + "</p>" : "") + (d.html || "") +
      '<div class="gc-dlg-btns"><button type="button" class="gc-btn" data-act="ct-dialog-no">' + esc(d.no || tr("Cancel")) + '</button><button type="button" class="gc-btn ' + (d.danger ? "danger" : "primary") + '" data-act="ct-dialog-yes">' + esc(d.yes || tr("OK")) + "</button></div></div></div>";
  }
  function toastHtml() {
    const t = S.toast;
    return t ? '<div class="gc-toast" role="status"><span>' + esc(t.text) + "</span>" + (t.undo ? '<button type="button" data-act="ct-undo">' + esc(tr("Undo")) + "</button>" : "") + "</div>" : "";
  }
  function body() {
    load();
    if (!signedIn()) return '<div class="gc-root gc-guest" data-view="guest"><div class="gc-empty"><b>' + esc(tr("Contacts")) + "</b><span>" + esc(tr("Contacts are for signed-in accounts. Sign in to use them.")) + "</span></div></div>";
    const active = S.activeId ? byId(S.activeId) : null;
    const showDetail = !!active && S.view !== "recent" && S.view !== "other";
    const fab = (S.view === "contacts" || S.view.indexOf("label:") === 0) && !S.sel ? '<button type="button" class="gc-fab" data-act="ct-new" aria-label="' + esc(tr("Create contact")) + '">' + ico("plus") + "<span>" + esc(tr("Create contact")) + "</span></button>" : "";
    return '<div class="gc-root" data-view="' + esc(S.view.split(":")[0]) + '" data-detail="' + (showDetail ? "1" : "0") + '" data-nav="' + (S.nav ? "1" : "0") + '" data-sel="' + (S.sel ? "1" : "0") + '">' +
      navHtml() + '<div class="gc-scrim" data-act="ct-nav-close"></div>' +
      '<main class="gc-main">' + barHtml() + titleHtml() + '<div class="gc-scroll" data-scroll>' + mainBody() + "</div>" + fab + "</main>" +
      '<section class="gc-detail" aria-live="polite">' + (showDetail ? detailHtml(active) : '<div class="gc-detail-empty">' + ico("person") + "<span>" + esc(tr("Select a contact")) + "</span></div>") + "</section>" +
      (S.edit ? editHtml() : "") + (S.dialog ? dialogHtml() : "") + toastHtml() + "</div>";
  }

  /* ---------- painting ---------- */
  function mounted() { return typeof document !== "undefined" && !!document.querySelector(".gc-root"); }
  function paint() {
    const el = document.querySelector(".gc-root");
    if (!el) return;
    const focus = document.activeElement;
    const keep = focus && focus.name === "q" ? { start: focus.selectionStart, end: focus.selectionEnd } : null;
    const scroller = el.querySelector("[data-scroll]");
    const top = scroller ? scroller.scrollTop : 0;
    const detail = el.querySelector(".gc-detail");
    const dscroll = detail ? detail.scrollTop : 0;
    el.outerHTML = body();
    const fresh = document.querySelector(".gc-root");
    const sc = fresh && fresh.querySelector("[data-scroll]");
    if (sc) sc.scrollTop = top;
    const dt = fresh && fresh.querySelector(".gc-detail");
    if (dt) dt.scrollTop = dscroll;
    if (keep && fresh) { const q = fresh.querySelector('input[name="q"]'); if (q) { q.focus(); try { q.setSelectionRange(keep.start, keep.end); } catch (err) { /* no range */ } } }
    if (S.edit && fresh && !S.edit.focused) { const f = fresh.querySelector('input[name="first"]'); if (f) { S.edit.focused = true; f.focus(); } }
    if (S.dialog && S.dialog.focus && fresh && !S.dialog.focused) { const i = fresh.querySelector(".gc-dialog " + S.dialog.focus); if (i) { S.dialog.focused = true; i.focus(); } }
  }
  function toastDom() {
    const root = document.querySelector(".gc-root");
    if (!root) return;
    const old = root.querySelector(".gc-toast");
    if (old) old.remove();
    if (S.toast) root.insertAdjacentHTML("beforeend", toastHtml());
  }
  function say(text, undo) {
    clearTimeout(toastTimer);
    S.toast = { text: text, undo: undo || null };
    if (S.edit || S.dialog) toastDom(); else paint();
    toastTimer = setTimeout(() => { S.toast = null; toastDom(); }, 7000);
  }
  function ask(opts) {
    return new Promise((resolve) => { S.dialog = Object.assign({ resolve: resolve }, opts); paint(); });
  }
  function closeDialog(value) {
    const d = S.dialog;
    S.dialog = null;
    paint();
    if (d && d.resolve) d.resolve(value);
  }

  /* ---------- vCard + files ---------- */
  function vcardOf(c) {
    const line = (k, v) => k + ":" + String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
    const out = ["BEGIN:VCARD", "VERSION:3.0", "N:" + [c.last, c.first, "", "", ""].map((x) => String(x).replace(/[;,]/g, " ")).join(";"), line("FN", nameOf(c))];
    if (c.company) out.push(line("ORG", c.company));
    if (c.title) out.push(line("TITLE", c.title));
    c.phones.forEach((p) => out.push("TEL;TYPE=" + String(p.label || "Mobile").toUpperCase() + ":" + p.v));
    c.emails.forEach((p) => out.push("EMAIL;TYPE=" + String(p.label || "Home").toUpperCase() + ":" + p.v));
    if (c.birthday) out.push("BDAY:" + c.birthday);
    if (c.address) out.push(line("ADR;TYPE=HOME", ";;" + c.address + ";;;;"));
    if (c.notes) out.push(line("NOTE", c.notes));
    if (c.handle) out.push("URL:https://viktorych.app/#/calls?to=" + encodeURIComponent(c.handle));
    out.push("END:VCARD");
    return out.join("\r\n");
  }
  function parseVcf(text) {
    const unfolded = String(text || "").replace(/\r?\n[ \t]/g, "");
    const cards = unfolded.split(/BEGIN:VCARD/i).slice(1);
    const un = (v) => String(v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    return cards.map((card) => {
      const c = { phones: [], emails: [] };
      card.split(/\r?\n/).forEach((ln) => {
        const i = ln.indexOf(":");
        if (i < 0) return;
        const head = ln.slice(0, i).toUpperCase();
        const val = ln.slice(i + 1).trim();
        const key = head.split(";")[0];
        const type = (/TYPE=([A-Z]+)/.exec(head) || [])[1] || "";
        const label = type === "WORK" ? "Work" : type === "HOME" ? "Home" : type === "CELL" || type === "MOBILE" ? "Mobile" : "Other";
        if (key === "N") { const p = val.split(";"); c.last = un(p[0]); c.first = un(p[1]); }
        else if (key === "FN" && !c.first && !c.last) { const s = splitName(un(val)); c.first = s.first; c.last = s.last; }
        else if (key === "ORG") c.company = un(val.split(";")[0]);
        else if (key === "TITLE") c.title = un(val);
        else if (key === "TEL" && val) c.phones.push({ v: val, label: label === "Home" || label === "Work" ? label : "Mobile" });
        else if (key === "EMAIL" && val) c.emails.push({ v: val, label: label === "Mobile" ? "Home" : label });
        else if (key === "BDAY") c.birthday = val.slice(0, 10);
        else if (key === "NOTE") c.notes = un(val);
        else if (key === "ADR") c.address = un(val.split(";").filter(Boolean).join(", "));
      });
      return normalize(c);
    }).filter((c) => c && (c.first || c.last || c.company || c.phones.length || c.emails.length));
  }
  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function icsFor(c, whenIso, minutes) {
    const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const start = new Date(whenIso);
    const end = new Date(start.getTime() + (minutes || 30) * 60000);
    const link = location.origin + "/#/calls?to=" + encodeURIComponent(c.handle || "");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Viktorych//Contacts//EN", "BEGIN:VEVENT", "UID:" + uid("ev") + "@viktorych", "DTSTAMP:" + stamp(new Date()), "DTSTART:" + stamp(start), "DTEND:" + stamp(end), "SUMMARY:" + tr("Call with {name}", { name: nameOf(c) }), "DESCRIPTION:" + link, "URL:" + link, "BEGIN:VALARM", "TRIGGER:-PT5M", "ACTION:DISPLAY", "DESCRIPTION:" + tr("Call with {name}", { name: nameOf(c) }), "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  }
  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".vcf,text/vcard,text/x-vcard,.csv"; input.style.display = "none";
      input.onchange = () => { const f = input.files && input.files[0]; input.remove(); if (!f) return resolve(""); f.text().then(resolve, () => resolve("")); };
      document.body.appendChild(input);
      input.click();
    });
  }

  /* ---------- changes ---------- */
  function trashIds(ids) {
    const now = Date.now();
    const hit = [];
    ids.forEach((id) => { const c = byId(id); if (c && !c.trashedAt) { c.trashedAt = now; hit.push(id); } });
    save();
    return hit;
  }
  function restoreIds(ids) { ids.forEach((id) => { const c = byId(id); if (c) c.trashedAt = 0; }); save(); }
  function afterDelete(ids) {
    if (S.activeId && ids.indexOf(S.activeId) >= 0) S.activeId = null;
    S.sel = null;
    say(trn("ctDeleted", ids.length), () => { restoreIds(ids); S.toast = null; paint(); });
  }
  function startEdit(c) {
    const base = c ? JSON.parse(JSON.stringify(c)) : normalize({});
    if (!c) { base.id = ""; if (S.view.indexOf("label:") === 0) base.labels = [S.view.slice(6)]; }
    S.edit = base;
    paint();
  }
  function readForm(form) {
    const get = (n) => { const e = form.elements[n]; return e ? String(e.value || "").trim() : ""; };
    const pair = (kind) => {
      const vs = Array.from(form.querySelectorAll('[name="' + kind + '-v"]'));
      const ls = Array.from(form.querySelectorAll('[name="' + kind + '-l"]'));
      return vs.map((e, i) => ({ v: String(e.value || "").trim(), label: ls[i] ? ls[i].value : "" })).filter((p) => p.v);
    };
    return { first: get("first"), last: get("last"), company: get("company"), title: get("title"), phones: pair("phone"), emails: pair("email"), handle: cleanHandle(get("handle")), birthday: get("birthday"), address: get("address"), notes: get("notes"), labels: Array.from(form.querySelectorAll('[name="lab"]:checked')).map((e) => e.value) };
  }
  function syncDraft(form) {
    if (!S.edit || !form) return;
    const v = readForm(form);
    ["first", "last", "company", "title", "handle", "birthday", "address", "notes", "labels"].forEach((k) => { S.edit[k] = v[k]; });
    S.edit.phones = Array.from(form.querySelectorAll('[name="phone-v"]')).map((e, i) => ({ v: e.value, label: (form.querySelectorAll('[name="phone-l"]')[i] || {}).value || "Mobile" }));
    S.edit.emails = Array.from(form.querySelectorAll('[name="email-v"]')).map((e, i) => ({ v: e.value, label: (form.querySelectorAll('[name="email-l"]')[i] || {}).value || "Home" }));
  }
  function saveEdit(form) {
    const v = readForm(form);
    if (!v.first && !v.last && !v.company && !v.phones.length && !v.emails.length && !v.handle) { say(tr("Add a name, number or email first.")); return; }
    let c = S.edit.id ? byId(S.edit.id) : null;
    if (!c) { c = normalize({ created: Date.now() }); S.contacts.push(c); }
    Object.assign(c, v);
    save();
    S.activeId = c.id;
    S.edit = null;
    paint();
    say(tr("Contact saved"));
  }
  function mergeInto(ids) {
    const list = ids.map(byId).filter(Boolean);
    if (list.length < 2) return null;
    const keep = list[0];
    list.slice(1).forEach((o) => {
      ["first", "last", "company", "title", "handle", "pid", "birthday", "address"].forEach((k) => { if (!keep[k] && o[k]) keep[k] = o[k]; });
      o.phones.forEach((p) => { if (!keep.phones.some((q) => digits(q.v) === digits(p.v))) keep.phones.push(p); });
      o.emails.forEach((p) => { if (!keep.emails.some((q) => q.v.toLowerCase() === p.v.toLowerCase())) keep.emails.push(p); });
      if (o.notes && keep.notes.indexOf(o.notes) < 0) keep.notes = (keep.notes ? keep.notes + "\n" : "") + o.notes;
      o.labels.forEach((l) => { if (keep.labels.indexOf(l) < 0) keep.labels.push(l); });
      keep.favorite = keep.favorite || o.favorite;
      S.contacts.splice(S.contacts.indexOf(o), 1);
    });
    save();
    return keep;
  }
  function labelDialog(ids) {
    const rows = S.labels.map((l) => {
      const all = ids.every((id) => (byId(id) || { labels: [] }).labels.indexOf(l.id) >= 0);
      return '<label class="gc-lab"><input type="checkbox" value="' + esc(l.id) + '"' + (all ? " checked" : "") + "><span>" + esc(l.name) + "</span></label>";
    }).join("") || '<p class="gc-muted">' + esc(tr("No labels yet.")) + "</p>";
    return ask({ title: tr("Manage labels"), html: '<div class="gc-labs" data-labs>' + rows + '</div><input class="gc-newlab" name="newlab" placeholder="' + esc(tr("New label")) + '" aria-label="' + esc(tr("New label")) + '">', yes: tr("Apply") }).then((ok) => {
      if (!ok) return;
      ids.forEach((id) => { const c = byId(id); if (!c) return; c.labels = c.labels.filter((x) => ok.on.indexOf(x) < 0 && ok.off.indexOf(x) < 0).concat(ok.on); });
      save();
      paint();
    });
  }
  function readDialog() {
    const el = document.querySelector(".gc-dialog");
    if (!el) return null;
    const on = [], off = [];
    el.querySelectorAll("[data-labs] input").forEach((i) => { (i.checked ? on : off).push(i.value); });
    const nl = el.querySelector('input[name="newlab"]');
    const name = nl ? nl.value.trim() : "";
    if (name) { const lab = { id: uid("l_"), name: name }; S.labels.push(lab); on.push(lab.id); }
    const text = el.querySelector('input[name="text"]');
    const when = el.querySelector('input[name="when"]');
    return { on: on, off: off, text: text ? text.value.trim() : "", when: when ? when.value : "" };
  }

  /* ---------- actions ---------- */
  function selected() { return S.sel ? Array.from(S.sel) : []; }
  function onAct(act, el) {
    const id = el && el.dataset ? el.dataset.id : "";
    switch (act) {
      case "stop": return;
      case "ct-nav": S.nav = !S.nav; return paint();
      case "ct-nav-close": S.nav = false; return paint();
      case "ct-view-set":
        S.view = el.dataset.view || "contacts"; S.nav = false; S.sel = null; S.callSel = null; S.activeId = null; S.query = "";
        if (S.view === "recent" || S.view === "other" || S.view === "frequent") loadCalls();
        return paint();
      case "ct-search-clear": S.query = ""; return paint();
      case "ct-new": return startEdit(null);
      case "ct-edit": return startEdit(byId(id));
      case "ct-edit-cancel": S.edit = null; return paint();
      case "ct-field-add": { const f = document.querySelector('form[data-form="edit"]'); syncDraft(f); const k = el.dataset.kind === "phone" ? "phones" : "emails"; S.edit[k].push({ v: "", label: k === "phones" ? "Mobile" : "Home" }); return paint(); }
      case "ct-field-del": { const f = document.querySelector('form[data-form="edit"]'); syncDraft(f); const k = el.dataset.kind === "phone" ? "phones" : "emails"; S.edit[k].splice(Number(el.dataset.i), 1); return paint(); }
      case "ct-open": {
        if (S.sel) return onAct("ct-pick", el);
        S.activeId = id; S.menu = ""; paint();
        const root = document.querySelector(".gc-detail");
        if (root) root.scrollTop = 0;
        if (!callsLoadedOnce) loadCalls();
        return;
      }
      case "ct-back": S.activeId = null; S.menu = ""; return paint();
      case "ct-pick": {
        if (!S.sel) S.sel = new Set();
        if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
        if (!S.sel.size) S.sel = null;
        return paint();
      }
      case "ct-sel-clear": S.sel = null; return paint();
      case "ct-sel-all": S.sel = new Set(visible().map((c) => c.id)); return paint();
      case "ct-star": { const c = byId(id); if (c) { c.favorite = !c.favorite; save(); paint(); } return; }
      case "ct-sel-star": { const ids = selected(); const all = ids.every((i) => byId(i) && byId(i).favorite); ids.forEach((i) => { const c = byId(i); if (c) c.favorite = !all; }); save(); S.sel = null; return paint(); }
      case "ct-sel-label": return labelDialog(selected());
      case "ct-sel-merge": { const keep = mergeInto(selected()); S.sel = null; if (keep) S.activeId = keep.id; paint(); return say(tr("Contacts merged")); }
      case "ct-sel-export": { const list = selected().map(byId).filter(Boolean); download("contacts.vcf", "text/vcard", list.map(vcardOf).join("\r\n")); S.sel = null; return paint(); }
      case "ct-sel-delete": return afterDelete(trashIds(selected()));
      case "ct-delete": S.menu = ""; return afterDelete(trashIds([id]));
      case "ct-menu": S.menu = S.menu ? "" : "detail"; return paint();
      case "ct-share-vcf": { const c = byId(id); S.menu = ""; if (c) download(nameOf(c).replace(/[^\p{L}\p{N}]+/gu, "_") + ".vcf", "text/vcard", vcardOf(c)); return paint(); }
      case "ct-restore": restoreIds([id]); S.activeId = null; paint(); return say(tr("Contact restored"));
      case "ct-sel-restore": { const ids = selected(); restoreIds(ids); S.sel = null; paint(); return say(tr("Contact restored")); }
      case "ct-purge": return ask({ title: tr("Delete forever?"), text: tr("This cannot be undone."), yes: tr("Delete forever"), danger: true }).then((ok) => { if (!ok) return; S.contacts = S.contacts.filter((c) => c.id !== id); save(); S.activeId = null; paint(); });
      case "ct-sel-purge": return ask({ title: tr("Delete forever?"), text: tr("This cannot be undone."), yes: tr("Delete forever"), danger: true }).then((ok) => { if (!ok) return; const ids = selected(); S.contacts = S.contacts.filter((c) => ids.indexOf(c.id) < 0); save(); S.sel = null; paint(); });
      case "ct-trash-empty": return ask({ title: tr("Empty trash?"), text: tr("This cannot be undone."), yes: tr("Empty trash"), danger: true }).then((ok) => { if (!ok) return; S.contacts = S.contacts.filter((c) => !c.trashedAt); save(); paint(); });
      case "ct-jump": { const t = document.getElementById("gc-l-" + el.dataset.l); if (t) t.scrollIntoView({ block: "start" }); return; }
      case "ct-label-new": return ask({ title: tr("Create label"), html: '<input class="gc-newlab" name="text" placeholder="' + esc(tr("Label name")) + '" aria-label="' + esc(tr("Label name")) + '">', yes: tr("Save"), focus: 'input[name="text"]' }).then((ok) => { if (!ok || !ok.text) return; const lab = { id: uid("l_"), name: ok.text }; S.labels.push(lab); save(); S.view = "label:" + lab.id; paint(); });
      case "ct-label-rename": { const cur = S.labels.find((l) => "label:" + l.id === S.view); if (!cur) return; return ask({ title: tr("Rename"), html: '<input class="gc-newlab" name="text" value="' + esc(cur.name) + '" aria-label="' + esc(tr("Label name")) + '">', yes: tr("Save"), focus: 'input[name="text"]' }).then((ok) => { if (!ok || !ok.text) return; cur.name = ok.text; save(); paint(); }); }
      case "ct-label-delete": { const cur = S.labels.find((l) => "label:" + l.id === S.view); if (!cur) return; return ask({ title: tr("Delete label?"), text: tr("Contacts keep existing; only the label goes away."), yes: tr("Delete label"), danger: true }).then((ok) => { if (!ok) return; S.labels = S.labels.filter((l) => l.id !== cur.id); S.contacts.forEach((c) => { c.labels = c.labels.filter((x) => x !== cur.id); }); save(); S.view = "contacts"; paint(); }); }
      case "ct-merge-group": { const g = duplicates()[Number(el.dataset.i)]; if (!g) return; const keep = mergeInto(g); paint(); if (keep) say(tr("Contacts merged")); return; }
      case "ct-import": return pickFile().then((text) => { if (!text) return; const list = parseVcf(text); if (!list.length) return say(tr("No contacts found in that file.")); list.forEach((c) => S.contacts.push(c)); save(); paint(); say(trn("ctImported", list.length)); });
      case "ct-export-all": { const list = live(); if (!list.length) return say(tr("No contacts yet")); download("contacts.vcf", "text/vcard", list.map(vcardOf).join("\r\n")); return; }
      case "ct-sync-device": return syncDevice();
      case "ct-add-other": { const c = normalize({ first: el.dataset.name || "", handle: el.dataset.handle }); S.contacts.push(c); save(); paint(); say(tr("Contact saved")); return; }
      case "ct-schedule": {
        const c = byId(id);
        if (!c) return;
        let scheduleOn = true;
        try {
          const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
          scheduleOn = !(Array.isArray(list) && list.indexOf("calls_schedule") >= 0);
        } catch (err) { scheduleOn = true; }
        if (scheduleOn && c.handle) {
          location.hash = "#/calls?schedule=1&with=" + encodeURIComponent(c.handle);
          return;
        }
        const d = new Date(Date.now() + 3600000);
        d.setMinutes(0, 0, 0);
        const pad = (n) => String(n).padStart(2, "0");
        const val = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":00";
        return ask({ title: tr("Schedule a call with {name}", { name: nameOf(c) }), text: tr("Adds a reminder to your calendar with a link that starts the call."), html: '<input class="gc-newlab" type="datetime-local" name="when" value="' + val + '" aria-label="' + esc(tr("Date and time")) + '">', yes: tr("Add to calendar") }).then((ok) => {
          if (!ok || !ok.when) return;
          download("call.ics", "text/calendar", icsFor(c, ok.when, 30));
          say(tr("Call reminder created"));
        });
      }
      case "ct-dialog-yes": { const v = readDialog() || {}; return closeDialog(Object.assign({ ok: true }, v)); }
      case "ct-dialog-no": return closeDialog(false);
      case "ct-undo": { const u = S.toast && S.toast.undo; if (u) u(); return; }
      case "ct-call-select": S.callSel = new Set(); return paint();
      case "ct-call-cancel": S.callSel = null; return paint();
      case "ct-call-pick": { const n = new Set(S.callSel); if (n.has(id)) n.delete(id); else n.add(id); S.callSel = n; return paint(); }
      case "ct-call-all": S.callSel = new Set(S.calls.map((r) => r.id)); return paint();
      case "ct-call-del": return removeCalls([id]);
      case "ct-call-delete": return removeCalls(Array.from(S.callSel || []));
      case "ct-call-clear": return ask({ title: tr("Clear all call history?"), text: tr("This only removes it for you. The other person keeps theirs."), yes: tr("Clear all"), danger: true }).then((ok) => { if (!ok || !history) return; return history.clear().then((token) => { S.calls = history.rows; S.callSel = null; paint(); if (token) say(trn("callsRemoved", token.ids.length), () => history.restore(token).then(() => { S.calls = history.rows; S.toast = null; paint(); })); }).catch(() => say(tr("Could not update your history. Try again."))); });
      default: return;
    }
  }
  let callsLoadedOnce = false;
  let lastTarget = null;
  function removeCalls(ids) {
    if (!history || !ids.length) return Promise.resolve();
    return history.remove(ids).then((token) => {
      S.calls = history.rows; S.callSel = null; paint();
      if (token) say(token.ids.length === 1 ? tr("Removed from your history") : trn("callsRemoved", token.ids.length), () => history.restore(token).then(() => { S.calls = history.rows; S.toast = null; paint(); }));
    }).catch(() => { S.calls = history ? history.rows : []; paint(); say(tr("Could not update your history. Try again.")); });
  }
  function syncDevice() {
    const api = typeof navigator !== "undefined" && navigator.contacts;
    if (!api || !api.select) return say(tr("Your browser cannot read phone contacts. Import a .vcf file instead."));
    api.select(["name", "tel", "email"], { multiple: true }).then((picked) => {
      const list = (picked || []).map((p) => normalize({ first: (p.name && p.name[0]) || "", phones: (p.tel || []).map((v) => ({ v: v, label: "Mobile" })), emails: (p.email || []).map((v) => ({ v: v, label: "Home" })) })).filter((c) => c.first || c.phones.length || c.emails.length);
      if (!list.length) return;
      list.forEach((c) => S.contacts.push(c));
      save(); paint(); say(trn("ctImported", list.length));
    }).catch(() => {});
  }

  /* ---------- events ---------- */
  function bind() {
    if (S.bound || typeof document === "undefined") return;
    S.bound = true;
    document.addEventListener("pointerdown", (e) => { lastTarget = e.target; }, true);
    document.addEventListener("input", (e) => {
      const t = e.target;
      if (!t || !t.closest || !t.closest(".gc-root")) return;
      if (t.name === "q") { S.query = t.value; paintList(); }
    });
    document.addEventListener("submit", (e) => {
      const f = e.target;
      if (f && f.dataset && f.dataset.form === "edit") { e.preventDefault(); saveEdit(f); }
    });
    document.addEventListener("keydown", (e) => {
      if (!mounted()) return;
      if (e.key === "Escape") {
        if (S.dialog) return closeDialog(false);
        if (S.edit) { S.edit = null; return paint(); }
        if (S.sel) { S.sel = null; return paint(); }
        if (S.nav) { S.nav = false; return paint(); }
      }
      if (e.key === "Enter" && S.dialog && e.target && e.target.matches && e.target.matches(".gc-dialog input")) { e.preventDefault(); onAct("ct-dialog-yes", e.target); }
      if ((e.key === "Enter" || e.key === " ") && e.target && e.target.classList && e.target.classList.contains("gc-row")) { e.preventDefault(); onAct("ct-open", e.target); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest) return;
      const root = e.target.closest(".gc-root");
      if (!root) return;
      if (S.menu && !e.target.closest(".gc-menu,[data-act=ct-menu]")) { S.menu = ""; paint(); }
      const scrim = e.target.closest("[data-scrim]");
      if (scrim && e.target === scrim) { if (lastTarget === scrim) { if (scrim.dataset.scrim === "dialog") closeDialog(false); else { S.edit = null; paint(); } } return; }
      const el = e.target.closest("[data-act]");
      if (!el || !root.contains(el)) return;
      const act = el.dataset.act;
      if (act === "call-open" || act === "stop") return;
      if (el.matches("a[href]") && act.indexOf("ct-") !== 0) return;
      if (act === "ct-open" && e.target.closest("[data-act=ct-star],[data-act=call-open],.gc-racts")) return;
      e.preventDefault();
      onAct(act, el);
    }, true);
    window.addEventListener("storage", (e) => { if (e.key === STORE_KEY && mounted()) { S.loaded = false; load(); paint(); } });
  }
  function paintList() {
    const sc = document.querySelector("[data-scroll]");
    const title = document.querySelector(".gc-title h2");
    if (!sc) return paint();
    sc.innerHTML = mainBody();
    if (title) title.textContent = viewTitle();
    const bar = document.querySelector(".gc-search");
    if (bar) { const has = bar.querySelector("[data-act=ct-search-clear]"); if (!!S.query !== !!has) paint(); }
  }

  /* ---------- public ---------- */
  function page() { return '<div class="gc-host">' + body() + "</div>"; }
  function mount(route) {
    load(); bind();
    const qs = route && route.query && route.query.get ? route.query : null;
    const add = qs && qs.get("add");
    const q = qs && qs.get("q");
    if (add && !S.edit) { startEdit(null); S.edit.handle = cleanHandle(add); paint(); }
    else if (q) { S.query = String(q); paint(); }
    if (signedIn() && !callsLoadedOnce) { callsLoadedOnce = true; loadCalls(); }
    if (!signedIn() && (S.view === "recent" || S.view === "other" || S.view === "frequent")) { S.view = "contacts"; paint(); }
  }
  function unmount() { S.edit = null; S.dialog = null; S.sel = null; S.callSel = null; S.menu = ""; S.nav = false; }

  /* Contacts offered when starting a call. Only signed-in people get them. */
  function suggestions(query) {
    if (!signedIn()) return [];
    load();
    const q = String(query || "").trim().toLowerCase();
    const counts = callCounts();
    return live().filter((c) => c.handle && (!q || matches(c, q)))
      .map((c) => ({ id: c.id, name: nameOf(c), handle: c.handle, favorite: c.favorite, n: counts[c.handle] ? counts[c.handle].count : 0 }))
      .sort((a, b) => (b.n + (b.favorite ? 2 : 0)) - (a.n + (a.favorite ? 2 : 0)) || a.name.localeCompare(b.name))
      .slice(0, 8);
  }
  function remember(handle, name) {
    if (!signedIn() || !handle) return;
    load();
    const h = cleanHandle(handle);
    if (!h || S.contacts.some((c) => c.handle === h && !c.trashedAt)) return;
    S.contacts.push(normalize({ first: name || "", handle: h }));
    save();
  }

  return { page: page, mount: mount, unmount: unmount, onAct: onAct, suggestions: suggestions, remember: remember, _parseVcf: parseVcf, _vcardOf: vcardOf, _state: S };
});
