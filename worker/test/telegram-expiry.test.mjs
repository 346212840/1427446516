import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { expiryHint, telegramFileGone } from "../../shared/telegram-expiry.js";
import { freshExpired } from "../src/telegram-expiry.js";

const BOT = "123456:probe-token";
const calls = [];

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "ownerlock",
      ALLOWED_ORIGINS: "https://346212840.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      TELEGRAM_BOT_TOKEN: BOT,
      TELEGRAM_CHANNEL_ID: "-1004242"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      calls.push(url.pathname + (url.search || ""));
      if (url.pathname.endsWith("/getFile")) {
        const id = url.searchParams.get("file_id") || "";
        if (id === "TEMP") return Response.json({ ok: false, error_code: 400, description: "Bad Request: file is temporarily unavailable" });
        if (id === "BIG") return Response.json({ ok: false, error_code: 400, description: "Bad Request: file is too big or permanently unavailable" });
        if (id === "WRONG") return Response.json({ ok: false, error_code: 400, description: "Bad Request: wrong file identifier/HTTP URL specified" });
        if (id === "MISS") return Response.json({ ok: true, result: { file_path: "documents/MISS" } });
        if (id === "KEPT") return Response.json({ ok: false, error_code: 400, description: "Bad Request: file not found" });
        return Response.json({ ok: false, error_code: 400, description: "Bad Request: file not found" });
      }
      if (url.pathname.includes("/file/bot")) return new Response("missing", { status: 404 });
      return new Response("missing", { status: 404 });
    }
  };
}

async function call(mf, path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.10");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.json) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.json ? JSON.stringify(opts.json) : undefined
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (err) { body = null; }
  const packed = new TextDecoder().decode(bytes);
  assert.equal(packed.includes(BOT), false);
  assert.equal(packed.includes("file_id"), false);
  return { status: res.status, body, bytes };
}

async function signup(mf, ip, handle, claim) {
  const body = { displayName: "Reader", handle };
  if (claim) body.claimCode = claim;
  return call(mf, "/v1/signup", { method: "POST", ip, json: body });
}

function getFiles() {
  return calls.filter((item) => item.includes("/getFile")).length;
}

test("telegram wording for a deleted file is expiry, and a short outage is not", () => {
  assert.equal(telegramFileGone({ ok: false, description: "Bad Request: file not found" }), true);
  assert.equal(telegramFileGone({ ok: false, description: "Bad Request: file is too big or permanently unavailable" }), true);
  assert.equal(telegramFileGone({ ok: false, description: "Bad Request: wrong file identifier/HTTP URL specified" }), true);
  assert.equal(telegramFileGone({ ok: false, description: "Bad Request: file is temporarily unavailable" }), false);
  assert.equal(telegramFileGone({ ok: true, description: "file not found" }), false);
  const uploaded = Date.UTC(2025, 10, 17);
  const hint = expiryHint(uploaded, Date.UTC(2026, 10, 1));
  assert.equal(hint.expiresAt, uploaded + 365 * 24 * 60 * 60 * 1000);
  assert.equal(hint.soon, true);
  assert.equal(freshExpired({ expired_at: 0 }), false);
  assert.equal(freshExpired({ expired_at: 2e12, updated_at: 1e12 }), true);
  assert.equal(freshExpired({ expired_at: 1e12, updated_at: 2e12 }), false);
});

test("a deleted telegram file is marked expired and is not fetched again", async () => {
  calls.length = 0;
  const mf = new Miniflare(workerOptions());
  try {
    const reader = await signup(mf, "203.0.113.20", "expiryreader");
    assert.equal(reader.status, 201);
    const env = await mf.getBindings();
    const inserted = "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'single', 0, 'viktorych-data', ?, 4, 4, ?, 'image/jpeg', 0, 1, 1, 0, ?)";
    await env.DB.prepare(inserted).bind("photos/gone.jpg", "GONE", "abc", 1700000000).run();
    await env.DB.prepare(inserted).bind("photos/temp.jpg", "TEMP", "abd", 1700000000).run();
    await env.DB.prepare(inserted).bind("photos/kept.jpg", "KEPT", "abe", 1700000000).run();
    await env.DATA.put("photos/kept.jpg", new Uint8Array([4, 5, 6, 7]));

    const gone = await call(mf, "/tg/photos/gone.jpg", { ip: "203.0.113.21", token: reader.body.token });
    assert.equal(gone.status, 410);
    assert.equal(gone.body.error, "expired");
    assert.ok(gone.body.expiresAt > gone.body.uploadedAt);
    const after = getFiles();
    assert.equal(after, 1);
    const again = await call(mf, "/tg/photos/gone.jpg", { ip: "203.0.113.21", token: reader.body.token });
    assert.equal(again.status, 410);
    assert.equal(getFiles(), after);
    const row = await env.DB.prepare("SELECT file_id, sha256, expired_at FROM telegram_files WHERE object_key = ?").bind("photos/gone.jpg").first();
    assert.equal(row.file_id, "GONE");
    assert.equal(row.sha256, "abc");
    assert.ok(Number(row.expired_at) > 0);

    const temp = await call(mf, "/tg/photos/temp.jpg", { ip: "203.0.113.22", token: reader.body.token });
    assert.equal(temp.status, 502);
    assert.equal(temp.body.error, "unavailable");
    const tempRow = await env.DB.prepare("SELECT expired_at FROM telegram_files WHERE object_key = ?").bind("photos/temp.jpg").first();
    assert.equal(Number(tempRow.expired_at) || 0, 0);

    const beforeKept = getFiles();
    const kept = await call(mf, "/tg/photos/kept.jpg", { ip: "203.0.113.23", token: reader.body.token });
    assert.equal(kept.status, 200);
    assert.deepEqual(Array.from(kept.bytes), [4, 5, 6, 7]);
    const keptCalls = getFiles();
    assert.equal(keptCalls, beforeKept + 1);
    const keptAgain = await call(mf, "/tg/photos/kept.jpg", { ip: "203.0.113.23", token: reader.body.token });
    assert.equal(keptAgain.status, 200);
    assert.equal(getFiles(), keptCalls);
    const keptRow = await env.DB.prepare("SELECT file_id, expired_at FROM telegram_files WHERE object_key = ?").bind("photos/kept.jpg").first();
    assert.equal(keptRow.file_id, "KEPT");
    assert.ok(Number(keptRow.expired_at) > 0);
  } finally {
    await mf.dispose();
  }
});

test("owner age rows and drive chunks expire without dropping their metadata", async () => {
  calls.length = 0;
  const mf = new Miniflare(workerOptions());
  try {
    const owner = await signup(mf, "203.0.113.30", "ownerlock", "claim-test");
    assert.equal(owner.status, 201);
    assert.equal(owner.body.account.owner, true);
    const env = await mf.getBindings();
    await env.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES ('vsr/manifest.age', 'age', 0, '', 'WRONG', 8, 4, ?, 'application/octet-stream', 0, 1, 0, 1, 1700000000)"
    ).bind("ab".repeat(32)).run();
    const first = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.31", token: owner.body.token });
    assert.equal(first.status, 410);
    assert.equal(first.body.error, "expired");
    const used = getFiles();
    const second = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.31", token: owner.body.token });
    assert.equal(second.status, 410);
    assert.equal(getFiles(), used);
    const age = await env.DB.prepare("SELECT file_id, sha256, expired_at FROM telegram_files WHERE object_key = 'vsr/manifest.age'").first();
    assert.equal(age.file_id, "WRONG");
    assert.equal(age.sha256, "ab".repeat(32));
    assert.ok(Number(age.expired_at) > 0);

    const now = Date.now();
    const item = "expiryitem00000001";
    await env.DB.prepare(
      "INSERT INTO drive_items (id, public_id, parent_id, kind, wrapped_key, wrap_iv, meta, meta_iv, thumb, thumb_iv, created_at, updated_at, deleted_at) VALUES (?, ?, '', 'file', 'aaaa', 'bbbb', 'cccc', 'dddd', '', '', ?, ?, 0)"
    ).bind(item, owner.body.account.publicId, now - 340 * 24 * 60 * 60 * 1000, now).run();
    await env.DB.prepare(
      "INSERT INTO drive_chunks (item_id, part_index, message_id, file_id, size, iv) VALUES (?, 0, 9, 'BIG', 4, 'eeee')"
    ).bind(item).run();
    const before = getFiles();
    const chunk = await call(mf, "/v1/drive/items/" + item + "/chunks/0", { ip: "203.0.113.32", token: owner.body.token });
    assert.equal(chunk.status, 410);
    assert.equal(chunk.body.error, "expired");
    assert.equal(getFiles(), before + 1);
    const listed = await call(mf, "/v1/drive/items", { ip: "203.0.113.33", token: owner.body.token });
    assert.equal(listed.status, 200);
    const found = (listed.body.items || []).find((row) => row.id === item);
    assert.ok(found);
    assert.equal(found.chunks[0].expiredAt > 0, true);
    assert.equal(JSON.stringify(found).includes("BIG"), false);
    const saved = await env.DB.prepare("SELECT file_id, expired_at FROM drive_chunks WHERE item_id = ?").bind(item).first();
    assert.equal(saved.file_id, "BIG");
    assert.ok(Number(saved.expired_at) > 0);
    const quiet = getFiles();
    const replay = await call(mf, "/v1/drive/items/" + item + "/chunks/0", { ip: "203.0.113.32", token: owner.body.token });
    assert.equal(replay.status, 410);
    assert.equal(getFiles(), quiet);
  } finally {
    await mf.dispose();
  }
});

test("a file URL that disappears is confirmed once and then left alone", async () => {
  calls.length = 0;
  const mf = new Miniflare(workerOptions());
  try {
    const reader = await signup(mf, "203.0.113.40", "missreader");
    const env = await mf.getBindings();
    await env.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES ('photos/miss.jpg', 'single', 0, 'viktorych-data', 'MISS', 5, 4, 'abc', 'image/jpeg', 0, 1, 1, 0, 1700000000)"
    ).run();
    const gone = await call(mf, "/tg/photos/miss.jpg", { ip: "203.0.113.41", token: reader.body.token });
    assert.equal(gone.status, 410);
    assert.equal(getFiles(), 2);
    const later = await call(mf, "/tg/photos/miss.jpg", { ip: "203.0.113.41", token: reader.body.token });
    assert.equal(later.status, 410);
    assert.equal(getFiles(), 2);
    const row = await env.DB.prepare("SELECT file_id, expired_at FROM telegram_files WHERE object_key = 'photos/miss.jpg'").first();
    assert.equal(row.file_id, "MISS");
    assert.ok(Number(row.expired_at) > 0);
  } finally {
    await mf.dispose();
  }
});
