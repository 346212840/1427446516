/* Call history you can edit. Removing a row only hides it for you: the other person keeps theirs.
   Signed-in people sync the hidden rows through the Worker; guests keep a local list on this device.
   Shared by the Calls page and Contacts. */
export const LOCAL_KEY = "viktorych_calls_local_v1";
const LOCAL_MAX = 60;

export function loadLocal(storage) {
  try {
    const rows = JSON.parse(storage.getItem(LOCAL_KEY) || "[]");
    return Array.isArray(rows) ? rows.filter((r) => r && r.id) : [];
  } catch (err) { return []; }
}
export function saveLocal(storage, rows) {
  try { storage.setItem(LOCAL_KEY, JSON.stringify(rows.slice(0, LOCAL_MAX))); } catch (err) { /* private mode */ }
}
/* A guest's finished call goes into the local list, newest first, one row per call id. */
export function recordLocal(storage, row) {
  if (!row || !row.id) return loadLocal(storage);
  const rows = loadLocal(storage).filter((r) => r.id !== row.id);
  rows.unshift({ id: String(row.id), name: String(row.name || ""), handle: "", createdAt: Number(row.createdAt) || Date.now(), duration: Number(row.duration) || 0, incoming: !!row.incoming, missed: !!row.missed, local: true });
  saveLocal(storage, rows);
  return rows;
}
export function removeRows(list, ids) {
  const gone = new Set(ids);
  return { kept: list.filter((r) => !gone.has(r.id)), removed: list.filter((r) => gone.has(r.id)) };
}
export function restoreRows(list, rows) {
  const seen = new Set(list.map((r) => r.id));
  const merged = list.concat(rows.filter((r) => !seen.has(r.id)));
  return merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
/* Swipe a row left far enough, mostly sideways, to remove it. */
export function swipeAction(dx, dy, width) {
  const need = Math.max(90, Math.round((width || 320) * 0.3));
  return dx <= -need && Math.abs(dx) > Math.abs(dy) * 2 ? "delete" : "none";
}
export function toggleSet(set, id) {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/* One store per page. `api(path, init)` answers { ok, data }. Rows are shaped like the Worker's /history. */
export function createHistory(opts) {
  const api = opts.api;
  const storage = opts.storage;
  const signed = opts.signedIn;
  const store = {
    rows: [],
    async load() {
      if (!signed()) { store.rows = loadLocal(storage); return store.rows; }
      const res = await api("/v1/calls/history").catch(() => null);
      if (res && res.ok && res.data && Array.isArray(res.data.calls)) store.rows = res.data.calls;
      return store.rows;
    },
    /* Hide rows for me. Resolves to an undo token, or null when nothing changed. */
    async remove(ids) {
      const picked = removeRows(store.rows, ids);
      if (!picked.removed.length) return null;
      store.rows = picked.kept;
      const token = { ids: picked.removed.map((r) => r.id), rows: picked.removed };
      if (!signed()) { saveLocal(storage, store.rows); return token; }
      const res = await api("/v1/calls/history/hide", { method: "POST", body: JSON.stringify({ ids: token.ids }) }).catch(() => null);
      if (!res || !res.ok) { store.rows = restoreRows(store.rows, picked.removed); throw new Error("hide"); }
      return token;
    },
    async clear() {
      const before = store.rows.slice();
      if (!before.length) return null;
      store.rows = [];
      if (!signed()) { saveLocal(storage, []); return { ids: before.map((r) => r.id), rows: before }; }
      const res = await api("/v1/calls/history/clear", { method: "POST", body: "{}" }).catch(() => null);
      if (!res || !res.ok) { store.rows = before; throw new Error("clear"); }
      const ids = (res.data && res.data.ids) || before.map((r) => r.id);
      return { ids: ids, rows: before };
    },
    async restore(token) {
      if (!token || !token.rows) return store.rows;
      store.rows = restoreRows(store.rows, token.rows);
      if (!signed()) { saveLocal(storage, store.rows); return store.rows; }
      const res = await api("/v1/calls/history/unhide", { method: "POST", body: JSON.stringify({ ids: token.ids.slice(0, 100) }) }).catch(() => null);
      if (!res || !res.ok) await store.load();
      return store.rows;
    }
  };
  return store;
}

/* The same Worker calls the Calls page makes, for pages that do not load calls.js (Contacts). */
export function makeApi(win) {
  return async function api(path, init) {
    const bag = win.VIKTORYCH_ACCOUNTS || {};
    const accounts = win.ViktorychAccounts;
    const base = String(bag.api || (accounts && accounts.currentApi && accounts.currentApi()) || "").replace(/\/$/, "");
    const tok = accounts && accounts.token && accounts.token();
    const headers = { "content-type": "application/json" };
    if (tok) headers.Authorization = "Bearer " + tok;
    const res = await fetch(base + path, Object.assign({ headers: headers, cache: "no-store" }, init || {}));
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  };
}
