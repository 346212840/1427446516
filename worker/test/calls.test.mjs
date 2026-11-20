import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const ORIGIN = "https://viktorychgroup.github.io";
let mf;

function workerOptions(extra) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    durableObjects: { ACCOUNT_CHANNEL: { className: "AccountChannel", useSQLite: true } },
    bindings: Object.assign({
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "owner_test",
      ALLOWED_ORIGINS: ORIGIN,
      PBKDF2_ITERATIONS: "1000"
    }, extra || {})
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.40");
  headers.set("Origin", ORIGIN);
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.guest) headers.set("x-call-guest", opts.guest);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cf: opts.cf
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

async function signup(n, name, handle) {
  const res = await call("/v1/signup", { method: "POST", ip: "203.0.113." + n, body: { displayName: name, handle: handle } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test.before(async () => {
  mf = new Miniflare(workerOptions({ GEMINI_API_KEY: "test-key", CALLS_GEMINI_MOCK: "1", KEYS_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" }));
});
test.after(async () => {
  if (mf) await mf.dispose();
});

test("calls stay off until the owner turns them on, then privacy is enforced", async () => {
  const owner = await call("/v1/signup", { method: "POST", ip: "203.0.113.21", body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" } });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  globalThis.__callsOwnerToken = owner.body.token;
  const ada = await signup(22, "Ada Example", "ada_example");
  const bea = await signup(23, "Bea Example", "bea_example");
  assert.equal((await call("/v1/calls/status")).status, 204);
  const on = await call("/v1/owner/features", { method: "POST", token: owner.body.token, body: { name: "calls", off: false } });
  assert.equal(on.status, 200);
  const status = await call("/v1/calls/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, true);
  assert.equal(status.body.video, false);
  assert.equal(status.body.languages.includes("ca"), true);
  assert.equal(status.body.languages.includes("sv"), true);
  assert.equal(JSON.stringify(status.body).includes("test-key"), false);

  const closed = await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { who: "nobody", dnd: false, guests: false } });
  assert.equal(closed.status, 200);
  const denied = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(denied.status, 403);

  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { who: "everyone", guests: true } });
  await call("/v1/blocks", { method: "POST", token: bea.token, body: { accountId: ada.account.publicId } });
  const blocked = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(blocked.status, 403);
  await call("/v1/blocks", { method: "DELETE", token: bea.token, body: { accountId: ada.account.publicId } });

  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { dnd: true, dndStart: "00:00", dndEnd: "23:59", tz: 0 } });
  const quiet = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(quiet.status, 403);
  await call("/v1/calls/prefs", { method: "PUT", token: bea.token, body: { dnd: false, who: "everyone", guests: true } });

  const created = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "bea_example" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.video, false);
  assert.equal(created.body.call.peerId, bea.account.publicId);

  /* The owner's key never pays for a call between two other people. */
  const nokey = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: ada.token, body: { target: "sv", source: "en" } });
  assert.equal(nokey.status, 200, JSON.stringify(nokey.body));
  assert.equal(nokey.body.mode, "text");
  assert.equal(nokey.body.reason, "nokey");
  const fakeFlag = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: ada.token, body: { target: "sv", owner: true, useOwnerKey: true, source: "en" } });
  assert.equal(fakeFlag.body.reason, "nokey", "a client flag cannot unlock the owner key");

  const minted = await call("/v1/calls/" + created.body.call.id + "/translate", {
    method: "POST",
    token: ada.token,
    body: { target: "sv", source: "en", voice: "Leda", key: "k".repeat(30), lexicon: [{ word: "Nova", say: "NO-vah" }] }
  });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(minted.body.mode, "token");
  assert.equal(minted.body.direct, true);
  assert.ok(String(minted.body.url).includes("access_token="));
  assert.equal(String(minted.body.url).includes("key="), false);
  assert.equal(JSON.stringify(minted.body).includes("test-key"), false);
  assert.equal(JSON.stringify(minted.body).includes("k".repeat(30)), false);
  assert.equal(minted.body.setup.generationConfig.translationConfig.targetLanguageCode, "sv");
  assert.equal(minted.body.path, "translate");
  assert.ok(minted.body.setup.systemInstruction.parts[0].text.includes("Speaker language: en."));
  assert.ok(minted.body.setup.contextWindowCompression);

  const liveMint = await call("/v1/calls/" + created.body.call.id + "/translate", {
    method: "POST",
    token: ada.token,
    body: { target: "sv", source: "en", voice: "Leda", key: "k".repeat(30), fallback: true }
  });
  assert.equal(liveMint.status, 200, JSON.stringify(liveMint.body));
  assert.equal(liveMint.body.path, "live");
  assert.equal(liveMint.body.setup.generationConfig.translationConfig, undefined);
  assert.ok(liveMint.body.setup.systemInstruction.parts[0].text.includes("simultaneous interpreter"));
  assert.equal(JSON.stringify(liveMint.body).includes("k".repeat(30)), false);

  assert.equal(minted.body.prefer, undefined, "an unknown country keeps the default order");
  const ruMint = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: ada.token, cf: { country: "RU" }, body: { target: "en", source: "ru", key: "k".repeat(30) } });
  assert.equal(ruMint.body.prefer, "relay", "a caller in Russia is told to use the relay first");
  assert.equal(ruMint.body.country, "RU");
  const seMint = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: ada.token, cf: { country: "SE" }, body: { target: "en", source: "sv", key: "k".repeat(30) } });
  assert.equal(seMint.body.prefer, undefined);
  assert.equal(seMint.body.country, "SE");

  const invite = await call("/v1/calls", { method: "POST", token: ada.token, body: { invite: true } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const guest = await call("/v1/calls/join/" + invite.body.invite, { method: "POST", body: { name: "Guest" } });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  assert.ok(guest.body.guestToken);
  assert.equal(guest.body.video, false);
  const noKeyGuest = await call("/v1/calls/" + invite.body.call.id + "/translate", { method: "POST", guest: guest.body.guestToken, body: { target: "es" } });
  assert.equal(noKeyGuest.body.reason, "nokey", "a guest of a non-owner host needs a key");
  const pastedGuest = await call("/v1/calls/" + invite.body.call.id + "/translate", { method: "POST", guest: guest.body.guestToken, body: { target: "es", key: "g".repeat(32) } });
  assert.equal(pastedGuest.body.mode, "token");
  assert.equal(pastedGuest.body.keySource, "own");

  /* A saved host key covers the guest. It is stored encrypted and never returned. */
  assert.equal((await call("/v1/calls/key", { method: "PUT", token: ada.token, body: { key: "short" } })).status, 400);
  const saved = await call("/v1/calls/key", { method: "PUT", token: ada.token, body: { key: "h".repeat(32) } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved, true);
  assert.equal(JSON.stringify(saved.body).includes("h".repeat(32)), false);
  const listed = await call("/v1/calls/key", { token: ada.token });
  assert.equal(listed.body.saved, true);
  assert.equal(JSON.stringify(listed.body).includes("h".repeat(32)), false);
  const covered = await call("/v1/calls/" + invite.body.call.id + "/translate", { method: "POST", guest: guest.body.guestToken, body: { target: "es" } });
  assert.equal(covered.body.mode, "token");
  assert.equal(covered.body.keySource, "host");
  const speakCovered = await call("/v1/calls/" + invite.body.call.id + "/speak", { method: "POST", guest: guest.body.guestToken, body: { text: "Hold on", target: "es" } });
  assert.equal(speakCovered.status, 200);
  assert.equal(speakCovered.body.video, false);
  assert.notEqual(speakCovered.body.reason, "nokey");
  const previewed = await call("/v1/calls/" + invite.body.call.id + "/preview", { method: "POST", guest: guest.body.guestToken, body: { text: " Hold on a second ", target: "es", source: "en" } });
  assert.equal(previewed.status, 200);
  assert.equal(previewed.body.text, "Hold on a second", "the preview echoes the trimmed text");
  assert.equal(typeof previewed.body.translation, "string");
  assert.equal(typeof previewed.body.back, "string");
  assert.notEqual(previewed.body.reason, "nokey");
  assert.equal((await call("/v1/calls/" + invite.body.call.id + "/preview", { method: "POST", guest: guest.body.guestToken, body: { text: "Hi there", target: "xx" } })).status, 400, "an unknown language is refused");
  assert.equal((await call("/v1/calls/" + invite.body.call.id + "/preview", { method: "POST", guest: guest.body.guestToken, body: { text: "   ", target: "es" } })).status, 400, "an empty message is refused");
  assert.equal((await call("/v1/calls/" + invite.body.call.id + "/preview", { method: "GET", guest: guest.body.guestToken })).status === 200, false, "preview is POST only");
  /* Bea has no key and is not the host, so Ada's saved key covers her only as the host's guest. */
  const calleeNoKey = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: bea.token, body: { target: "en" } });
  assert.equal(calleeNoKey.body.keySource, "host");
  await call("/v1/calls/key", { method: "DELETE", token: ada.token });
  assert.equal((await call("/v1/calls/key", { token: ada.token })).body.saved, false);

  /* The owner's key covers calls the owner is in: hosting, or answering. */
  const ownerInvite = await call("/v1/calls", { method: "POST", token: owner.body.token, body: { invite: true } });
  assert.equal(ownerInvite.status, 201, JSON.stringify(ownerInvite.body));
  const ownerGuest = await call("/v1/calls/join/" + ownerInvite.body.invite, { method: "POST", body: { name: "Visitor" } });
  const ownerMint = await call("/v1/calls/" + ownerInvite.body.call.id + "/translate", { method: "POST", guest: ownerGuest.body.guestToken, body: { target: "en" } });
  assert.equal(ownerMint.body.mode, "token");
  assert.equal(ownerMint.body.keySource, "owner");
  const toOwner = await call("/v1/calls", { method: "POST", token: ada.token, body: { handle: "owner_test" } });
  assert.equal(toOwner.status, 201, JSON.stringify(toOwner.body));
  const ringing = await call("/v1/calls/" + toOwner.body.call.id + "/translate", { method: "POST", token: ada.token, body: { target: "en" } });
  assert.equal(ringing.body.reason, "ringing", "the owner's key waits until the owner answers");
  const answered = await call("/v1/calls/" + toOwner.body.call.id + "/answer", { method: "POST", token: owner.body.token });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const afterAnswer = await call("/v1/calls/" + toOwner.body.call.id + "/translate", { method: "POST", token: ada.token, body: { target: "en" } });
  assert.equal(afterAnswer.body.keySource, "owner");
  const peerKey = await call("/v1/calls/" + toOwner.body.call.id + "/translate", { method: "POST", token: owner.body.token, body: { target: "es" } });
  assert.equal(peerKey.body.keySource, "owner");
  assert.equal((await call("/v1/calls/live?t=" + "x".repeat(20))).status, 426, "the relay only speaks WebSocket");
});

test("a permanent call-me link follows the same rules and the owner-key rule", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  const cy = await signup(52, "Cy Example", "cy_example");
  const di = await signup(53, "Di Example", "di_example");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });

  assert.equal((await call("/v1/calls/link", { token: cy.token })).body.link, null);
  const made = await call("/v1/calls/link", { method: "PUT", token: cy.token, body: {} });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const slug = made.body.link.slug;
  assert.match(slug, /^[a-z0-9-]{10}$/);
  assert.equal((await call("/v1/calls/link", { method: "PUT", token: cy.token, body: { slug: "Admin" } })).status, 400);
  assert.equal((await call("/v1/calls/link", { method: "PUT", token: cy.token, body: { slug: "a--b" } })).status, 400);
  assert.equal((await call("/v1/calls/link", { method: "PUT", token: di.token, body: { slug: "cy-line" } })).status, 200);
  assert.equal((await call("/v1/calls/link", { method: "PUT", token: cy.token, body: { slug: "cy-line" } })).status, 409);
  const custom = await call("/v1/calls/link", { method: "PUT", token: cy.token, body: { slug: "talk-to-cy" } });
  assert.equal(custom.body.link.slug, "talk-to-cy");
  assert.equal((await call("/v1/calls/link/" + slug)).status, 404, "the old slug stops working");

  const info = await call("/v1/calls/link/talk-to-cy");
  assert.equal(info.status, 200);
  assert.equal(info.body.open, true);
  assert.equal(info.body.name, "Cy Example");

  /* privacy, quiet hours */
  await call("/v1/calls/prefs", { method: "PUT", token: cy.token, body: { who: "nobody" } });
  assert.equal((await call("/v1/calls/link/talk-to-cy")).body.open, false);
  assert.equal((await call("/v1/calls/link/talk-to-cy/join", { method: "POST", ip: "198.51.100.5", body: { name: "Vi" } })).status, 403);
  await call("/v1/calls/prefs", { method: "PUT", token: cy.token, body: { who: "everyone", guests: false } });
  assert.equal((await call("/v1/calls/link/talk-to-cy/join", { method: "POST", ip: "198.51.100.5", body: { name: "Vi" } })).status, 403);
  await call("/v1/calls/prefs", { method: "PUT", token: cy.token, body: { guests: true, dnd: true, dndStart: "00:00", dndEnd: "23:59", tz: 0 } });
  assert.equal((await call("/v1/calls/link/talk-to-cy/join", { method: "POST", ip: "198.51.100.5", body: { name: "Vi" } })).status, 403);
  await call("/v1/calls/prefs", { method: "PUT", token: cy.token, body: { dnd: false } });

  /* a blocked account cannot use it */
  await call("/v1/blocks", { method: "POST", token: cy.token, body: { accountId: di.account.publicId } });
  assert.equal((await call("/v1/calls/link/talk-to-cy/join", { method: "POST", token: di.token, ip: "198.51.100.6", body: { name: "Di" } })).status, 403);
  await call("/v1/blocks", { method: "DELETE", token: cy.token, body: { accountId: di.account.publicId } });

  /* a guest rings the owner of the link, and needs a key until someone adds one */
  const joined = await call("/v1/calls/link/talk-to-cy/join", { method: "POST", ip: "198.51.100.7", body: { name: "Vi" } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.ringing, true);
  assert.ok(joined.body.guestToken && joined.body.ticket);
  const id = joined.body.call.id;
  assert.equal((await call("/v1/calls/" + id + "/state", { guest: joined.body.guestToken })).body.state, "ringing");
  const incoming = await call("/v1/calls/incoming", { token: cy.token });
  assert.equal(incoming.body.calls.some((row) => row.id === id), true);
  const early = await call("/v1/calls/" + id + "/translate", { method: "POST", guest: joined.body.guestToken, body: { target: "en", key: "k".repeat(30) } });
  assert.equal(early.body.reason, "ringing");
  const answered = await call("/v1/calls/" + id + "/answer", { method: "POST", token: cy.token });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal((await call("/v1/calls/" + id + "/answer", { method: "POST", token: di.token })).status === 200, false);
  const nokey = await call("/v1/calls/" + id + "/translate", { method: "POST", guest: joined.body.guestToken, body: { target: "en" } });
  assert.equal(nokey.body.reason, "nokey");
  const hist = await call("/v1/calls/history", { token: cy.token });
  const row = hist.body.calls.find((item) => item.id === id);
  assert.equal(row.name, "Vi");
  assert.equal(row.incoming, true);

  /* the owner's own link uses the owner's key */
  await call("/v1/calls/link", { method: "PUT", token: ownerToken, body: { slug: "call-the-owner" } });
  const ownerJoin = await call("/v1/calls/link/call-the-owner/join", { method: "POST", ip: "198.51.100.8", body: { name: "Fan" } });
  assert.equal(ownerJoin.status, 200, JSON.stringify(ownerJoin.body));
  const waiting = await call("/v1/calls/" + ownerJoin.body.call.id + "/translate", { method: "POST", guest: ownerJoin.body.guestToken, body: { target: "en" } });
  assert.equal(waiting.body.reason, "ringing");
  await call("/v1/calls/" + ownerJoin.body.call.id + "/answer", { method: "POST", token: ownerToken });
  const ownerMint = await call("/v1/calls/" + ownerJoin.body.call.id + "/translate", { method: "POST", guest: ownerJoin.body.guestToken, body: { target: "en" } });
  assert.equal(ownerMint.body.keySource, "owner");

  /* turning it off and regenerating */
  await call("/v1/calls/link", { method: "PUT", token: cy.token, body: { enabled: false } });
  assert.equal((await call("/v1/calls/link/talk-to-cy")).status, 404);
  await call("/v1/calls/link", { method: "PUT", token: cy.token, body: { enabled: true } });
  const regen = await call("/v1/calls/link/regenerate", { method: "POST", token: cy.token });
  assert.notEqual(regen.body.link.slug, "talk-to-cy");
  assert.equal((await call("/v1/calls/link/talk-to-cy")).status, 404);
  assert.equal((await call("/v1/calls/link/" + regen.body.link.slug)).status, 200);
  assert.equal((await call("/v1/calls/link", { method: "DELETE", token: cy.token })).body.link, null);

  /* the join route is rate limited per address */
  let limited = 0;
  for (let i = 0; i < 14; i++) {
    const res = await call("/v1/calls/link/call-the-owner/join", { method: "POST", ip: "198.51.100.99", body: { name: "Spam" } });
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited >= 1, "abuse is rate limited");
});

test("editing call history only hides rows for that user, with undo and clear", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  const ed = await signup(61, "Ed Example", "ed_example");
  const fay = await signup(62, "Fay Example", "fay_example");
  const gus = await signup(63, "Gus Example", "gus_example");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const made = await call("/v1/calls", { method: "POST", token: ed.token, body: { handle: "fay_example" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    ids.push(made.body.call.id);
    await call("/v1/calls/" + made.body.call.id + "/end", { method: "POST", token: ed.token });
  }
  const list = async (token) => ((await call("/v1/calls/history", { token })).body.calls || []).map((row) => row.id);
  assert.deepEqual((await list(ed.token)).sort(), ids.slice().sort());

  /* hiding one row hides it only for me */
  const hid = await call("/v1/calls/history/hide", { method: "POST", token: ed.token, body: { ids: [ids[0]] } });
  assert.equal(hid.status, 200, JSON.stringify(hid.body));
  assert.deepEqual(hid.body.ids, [ids[0]]);
  assert.equal((await list(ed.token)).includes(ids[0]), false);
  assert.equal((await list(fay.token)).includes(ids[0]), true);

  /* a stranger cannot hide rows that are not theirs */
  const nope = await call("/v1/calls/history/hide", { method: "POST", token: gus.token, body: { ids: [ids[1]] } });
  assert.deepEqual(nope.body.ids, []);
  assert.equal((await list(ed.token)).includes(ids[1]), true);

  /* undo brings it back */
  await call("/v1/calls/history/unhide", { method: "POST", token: ed.token, body: { ids: [ids[0]] } });
  assert.equal((await list(ed.token)).includes(ids[0]), true);

  /* clear all hides everything of mine and tells me what to restore */
  const cleared = await call("/v1/calls/history/clear", { method: "POST", token: ed.token, body: {} });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.ids.slice().sort(), ids.slice().sort());
  assert.deepEqual(await list(ed.token), []);
  assert.deepEqual((await list(fay.token)).sort(), ids.slice().sort());
  assert.equal((await call("/v1/calls/history/hide", { method: "POST", body: { ids: [ids[0]] } })).status, 401);
  assert.equal((await call("/v1/calls/history/hide", { method: "POST", token: ed.token, body: { ids: ["x"] } })).status, 400);
});
