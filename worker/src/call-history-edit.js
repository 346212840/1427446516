/* Per-user history titles, notes, and transcript corrections. */

import { readFlags } from "./feature-flags.js";

export const CALL_HISTORY_EDIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS call_history_meta (
    public_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (public_id, call_id)
  )`,
  `CREATE TABLE IF NOT EXISTS call_transcripts (
    public_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    who TEXT NOT NULL DEFAULT '',
    mine INTEGER NOT NULL DEFAULT 0,
    original TEXT NOT NULL DEFAULT '',
    translation TEXT NOT NULL DEFAULT '',
    corrected INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, call_id, line_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_call_transcripts_call ON call_transcripts(public_id, call_id, at)`
];

function cleanTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}
function cleanNote(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
function cleanLineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
function viewLine(row) {
  return {
    id: String(row.line_id),
    at: Number(row.at) || 0,
    who: String(row.who || ""),
    mine: Number(row.mine) === 1,
    original: String(row.original || ""),
    translation: String(row.translation || ""),
    corrected: Number(row.corrected) === 1
  };
}

async function ownCall(env, me, id) {
  if (!/^[a-f0-9]{32}$/.test(id) && !/^[a-f0-9]{16,64}$/.test(id)) return null;
  return env.DB.prepare("SELECT id FROM call_sessions WHERE id = ? AND (host_id = ? OR peer_id = ?)").bind(id, me, me).first();
}

export async function attachHistoryMeta(env, me, calls) {
  if (!calls.length) return calls;
  const ids = calls.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const meta = await env.DB.prepare(
    "SELECT call_id, title, note FROM call_history_meta WHERE public_id = ? AND call_id IN (" + placeholders + ")"
  ).bind(me, ...ids).all();
  const counts = await env.DB.prepare(
    "SELECT call_id, COUNT(*) AS n FROM call_transcripts WHERE public_id = ? AND call_id IN (" + placeholders + ") GROUP BY call_id"
  ).bind(me, ...ids).all();
  const titles = new Map();
  for (const row of (meta && meta.results) || []) titles.set(String(row.call_id), row);
  const trans = new Map();
  for (const row of (counts && counts.results) || []) trans.set(String(row.call_id), Number(row.n) || 0);
  return calls.map((item) => {
    const extra = titles.get(item.id);
    item.title = extra ? String(extra.title || "") : "";
    item.note = extra ? String(extra.note || "") : "";
    item.hasTranscript = (trans.get(item.id) || 0) > 0;
    return item;
  });
}

export async function handleCallHistoryEdit(request, env, path, url, deps, h) {
  const off = await readFlags(env);
  const editPath = path === "/v1/calls/history/edit" || path === "/v1/calls/history/transcript" || /^\/v1\/calls\/history\/[A-Za-z0-9_-]+\/(transcript|correct)$/.test(path);
  if (!editPath) return null;
  if (off.calls || off.calls_hist_edit) {
    const read = request.method === "GET" || request.method === "HEAD";
    return new Response(null, { status: read ? 204 : 404, headers: { "x-feature-off": "1" } });
  }

  const who = await h.member(env, request, deps);
  if (!who.account) return deps.json(401, { error: "unauthorized" });
  const me = who.account.public_id;
  const paced = await deps.rateHit(env, "callhistedit:" + me, 80, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);

  if (path === "/v1/calls/history/edit" && request.method === "POST") {
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: "clone" });
    const id = String((body && body.id) || "");
    if (!(await ownCall(env, me, id))) return deps.json(404, { error: "not_found" });
    const prev = await env.DB.prepare("SELECT title, note FROM call_history_meta WHERE public_id = ? AND call_id = ?").bind(me, id).first();
    const title = body.title != null ? cleanTitle(body.title) : String((prev && prev.title) || "");
    const note = body.note != null ? cleanNote(body.note) : String((prev && prev.note) || "");
    await env.DB.prepare(
      "INSERT INTO call_history_meta (public_id, call_id, title, note, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(public_id, call_id) DO UPDATE SET title = excluded.title, note = excluded.note, updated_at = excluded.updated_at"
    ).bind(me, id, title, note, Date.now()).run();
    return deps.json(200, { id: id, title: title, note: note });
  }

  if (path === "/v1/calls/history/transcript" && request.method === "POST") {
    const body = await deps.readJson(request, 20000);
    if (body.error) return deps.json(400, { error: "clone" });
    const id = String((body && body.id) || "");
    if (!(await ownCall(env, me, id))) return deps.json(404, { error: "not_found" });
    const incoming = Array.isArray(body.lines) ? body.lines.slice(0, 80) : [];
    const now = Date.now();
    let saved = 0;
    for (const line of incoming) {
      const lineId = String((line && (line.id || line.lineId)) || "").slice(0, 64);
      if (!lineId) continue;
      const original = cleanLineText(line.original);
      const translation = cleanLineText(line.translation);
      if (!original && !translation) continue;
      const at = Number(line.at) || now;
      const whoLabel = String((line && line.who) || "").slice(0, 80);
      const mine = line && line.mine ? 1 : 0;
      await env.DB.prepare(
        "INSERT INTO call_transcripts (public_id, call_id, line_id, at, who, mine, original, translation, corrected) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(public_id, call_id, line_id) DO UPDATE SET at = excluded.at, who = excluded.who, mine = excluded.mine, original = CASE WHEN call_transcripts.corrected = 1 THEN call_transcripts.original ELSE excluded.original END, translation = CASE WHEN call_transcripts.corrected = 1 THEN call_transcripts.translation ELSE excluded.translation END"
      ).bind(me, id, lineId, at, whoLabel, mine, original, translation).run();
      saved += 1;
    }
    return deps.json(200, { id: id, saved: saved });
  }

  const one = path.match(/^\/v1\/calls\/history\/([A-Za-z0-9_-]+)\/(transcript|correct)$/);
  if (!one) return deps.json(404, { error: "not_found" });
  const id = one[1];
  if (!(await ownCall(env, me, id))) return deps.json(404, { error: "not_found" });
  if (one[2] === "transcript" && request.method === "GET") {
    const listed = await env.DB.prepare(
      "SELECT * FROM call_transcripts WHERE public_id = ? AND call_id = ? ORDER BY at ASC, line_id ASC LIMIT 80"
    ).bind(me, id).all();
    const meta = await env.DB.prepare("SELECT title, note FROM call_history_meta WHERE public_id = ? AND call_id = ?").bind(me, id).first();
    return deps.json(200, {
      id: id,
      title: String((meta && meta.title) || ""),
      note: String((meta && meta.note) || ""),
      lines: ((listed && listed.results) || []).map(viewLine)
    });
  }
  if (one[2] === "correct" && request.method === "POST") {
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: "clone" });
    const lineId = String((body && (body.lineId || body.id)) || "").slice(0, 64);
    if (!lineId) return deps.json(400, { error: "ids" });
    const row = await env.DB.prepare(
      "SELECT * FROM call_transcripts WHERE public_id = ? AND call_id = ? AND line_id = ?"
    ).bind(me, id, lineId).first();
    if (!row) return deps.json(404, { error: "not_found" });
    const original = body.original != null ? cleanLineText(body.original) : String(row.original || "");
    const translation = body.translation != null ? cleanLineText(body.translation) : String(row.translation || "");
    await env.DB.prepare(
      "UPDATE call_transcripts SET original = ?, translation = ?, corrected = 1 WHERE public_id = ? AND call_id = ? AND line_id = ?"
    ).bind(original, translation, me, id, lineId).run();
    return deps.json(200, { id: id, line: viewLine({ line_id: lineId, at: row.at, who: row.who, mine: row.mine, original: original, translation: translation, corrected: 1 }) });
  }
  return deps.json(405, { error: "method" });
}
