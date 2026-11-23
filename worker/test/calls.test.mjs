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

  assert.equal(minted.body.prefer, "relay", "the EU proxy uses the Worker first");
  assert.equal(minted.body.proxy, "eu");
  const ruMint = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: ada.token, cf: { country: "RU" }, body: { target: "en", source: "ru", key: "k".repeat(30) } });
  assert.equal(ruMint.body.prefer, "relay", "a caller in Russia is told to use the relay first");
  assert.equal(ruMint.body.country, "RU");
  const seMint = await call("/v1/calls/" + created.body.call.id + "/translate", { method: "POST", token: ada.token, cf: { country: "SE" }, body: { target: "en", source: "sv", key: "k".repeat(30) } });
  assert.equal(seMint.body.prefer, "relay", "the EU proxy uses the Worker first even from Sweden");
  assert.equal(seMint.body.proxy, "eu");
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
  const ownerHistory = await call("/v1/calls/history", { token: owner.body.token });
  assert.equal(ownerHistory.body.calls.find((c) => c.id === ownerInvite.body.call.id).name, "Visitor", "the host's history keeps the name the link guest typed");
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

test("scheduled invites can be created, listed, declined, cancelled, and refused early", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  assert.ok(ownerToken, "the first test turned Calls on");
  const iris = await signup(71, "Iris Example", "iris_example");
  const jess = await signup(72, "Jess Example", "jess_example");
  const startsAt = Date.now() + 2 * 60 * 60 * 1000;
  const made = await call("/v1/calls/schedule", { method: "POST", token: iris.token, body: { handle: "jess_example", startsAt, durationMin: 30, title: "Weekly catch-up" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.schedule.title, "Weekly catch-up");
  assert.equal(made.body.schedule.role, "host");
  assert.equal(made.body.schedule.handle, "jess_example");
  assert.ok(/^cs1\.[A-Za-z0-9_-]{8,80}$/.test(made.body.schedule.invite), "the host gets a guest invite");
  assert.equal(made.body.schedule.canJoin, false);

  const tooSoon = await call("/v1/calls/schedule", { method: "POST", token: iris.token, body: { startsAt: Date.now() + 1000, durationMin: 30 } });
  assert.equal(tooSoon.status, 400);
  assert.equal(tooSoon.body.error, "when");

  const listed = await call("/v1/calls/schedule", { token: jess.token });
  assert.equal(listed.status, 200);
  const row = (listed.body.schedules || []).find((item) => item.id === made.body.schedule.id);
  assert.ok(row, "the invitee sees the scheduled call");
  assert.equal(row.role, "peer");
  assert.equal(row.canRsvp, true);
  assert.equal(row.invite, "", "only the host is given the guest token");

  const guest = await call("/v1/calls/schedule/guest?token=" + encodeURIComponent(made.body.schedule.invite));
  assert.equal(guest.status, 200);
  assert.equal(guest.body.schedule.hostHandle, "iris_example");
  assert.equal(guest.body.schedule.canJoin, false);

  const ics = await call("/v1/calls/schedule/" + made.body.schedule.id + "/ics", { token: iris.token });
  assert.equal(ics.status, 200);
  assert.ok(String(ics.text || "").includes("TRIGGER:-PT15M"));
  assert.ok(String(ics.text || "").includes("TRIGGER:PT0S"));

  const early = await call("/v1/calls/schedule/" + made.body.schedule.id + "/start", { method: "POST", token: iris.token, body: {} });
  assert.equal(early.status, 403);
  assert.equal(early.body.error, "not_due");

  const rsvp = await call("/v1/calls/schedule/" + made.body.schedule.id + "/rsvp", { method: "POST", token: jess.token, body: { rsvp: "no" } });
  assert.equal(rsvp.status, 200, JSON.stringify(rsvp.body));
  assert.equal(rsvp.body.schedule.myRsvp, "no");

  const hostRsvp = await call("/v1/calls/schedule/" + made.body.schedule.id + "/rsvp", { method: "POST", token: iris.token, body: { rsvp: "yes" } });
  assert.equal(hostRsvp.status, 403);

  const cancelled = await call("/v1/calls/schedule/" + made.body.schedule.id + "/cancel", { method: "POST", token: iris.token, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.schedule.state, "cancelled");

  const off = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_schedule", off: true } });
  assert.equal(off.status, 200);
  assert.equal((await call("/v1/calls/schedule", { token: iris.token })).status, 204);
  assert.equal((await call("/v1/calls/schedule", { method: "POST", token: iris.token, body: { startsAt: startsAt + 3600000 } })).status, 404);
  const on = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_schedule", off: false } });
  assert.equal(on.status, 200);
});

test("a rotating QR rings the host like an incoming call", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  assert.ok(ownerToken, "the first test turned Calls on");
  const kade = await signup(81, "Kade Example", "kade_example");
  const lina = await signup(82, "Lina Example", "lina_example");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_rotate_qr", off: false } });

  assert.equal((await call("/v1/calls/qr")).status, 401);
  const minted = await call("/v1/calls/qr", { token: kade.token });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.ok(/^cr1\.[A-Za-z0-9_-]{8,80}$/.test(minted.body.token), "the host gets a rotating token");
  assert.equal(minted.body.rotateMs, 2 * 60 * 1000);
  const first = minted.body.token;
  const again = await call("/v1/calls/qr", { token: kade.token });
  assert.equal(again.body.token, first, "a fresh code is reused until it is close to expiry");
  const rotated = await call("/v1/calls/qr/rotate", { method: "POST", token: kade.token });
  assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
  assert.notEqual(rotated.body.token, first, "an explicit rotate issues a new code");
  assert.equal((await call("/v1/calls/qr/info?token=" + encodeURIComponent(first))).status, 200, "the previous code still works during the overlap");

  const info = await call("/v1/calls/qr/info?token=" + encodeURIComponent(rotated.body.token));
  assert.equal(info.status, 200);
  assert.equal(info.body.name, "Kade Example");
  assert.equal(info.body.open, true);

  const selfJoin = await call("/v1/calls/qr/join", { method: "POST", token: kade.token, body: { token: rotated.body.token, name: "Kade" } });
  assert.equal(selfJoin.status, 403);

  const joined = await call("/v1/calls/qr/join", { method: "POST", ip: "198.51.100.11", body: { token: first, name: "Vi" } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.ringing, true);
  assert.equal(joined.body.call.kind, "qr");
  assert.ok(joined.body.guestToken && joined.body.ticket);
  const id = joined.body.call.id;
  assert.equal((await call("/v1/calls/" + id + "/state", { guest: joined.body.guestToken })).body.state, "ringing");
  const incoming = await call("/v1/calls/incoming", { token: kade.token });
  assert.equal(incoming.body.calls.some((row) => row.id === id), true, "the host sees it as an incoming call");
  const early = await call("/v1/calls/" + id + "/translate", { method: "POST", guest: joined.body.guestToken, body: { target: "en", key: "k".repeat(30) } });
  assert.equal(early.body.reason, "ringing");
  const answered = await call("/v1/calls/" + id + "/answer", { method: "POST", token: kade.token });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal((await call("/v1/calls/" + id + "/answer", { method: "POST", token: lina.token })).status === 200, false);
  const hist = await call("/v1/calls/history", { token: kade.token });
  const row = hist.body.calls.find((item) => item.id === id);
  assert.equal(row.name, "Vi");
  assert.equal(row.incoming, true);

  await call("/v1/calls/prefs", { method: "PUT", token: kade.token, body: { who: "nobody" } });
  assert.equal((await call("/v1/calls/qr/info?token=" + encodeURIComponent(rotated.body.token))).body.open, false);
  assert.equal((await call("/v1/calls/qr/join", { method: "POST", ip: "198.51.100.12", body: { token: rotated.body.token, name: "Vi" } })).status, 403);
  await call("/v1/calls/prefs", { method: "PUT", token: kade.token, body: { who: "everyone", guests: true } });

  const off = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_rotate_qr", off: true } });
  assert.equal(off.status, 200);
  assert.equal((await call("/v1/calls/qr", { token: kade.token })).status, 204);
  assert.equal((await call("/v1/calls/qr/join", { method: "POST", ip: "198.51.100.13", body: { token: rotated.body.token, name: "Vi" } })).status, 404);
  const on = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_rotate_qr", off: false } });
  assert.equal(on.status, 200);
});

test("a practice partner can be started and replies on its own", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  assert.ok(ownerToken, "the first test turned Calls on");
  const nia = await signup(91, "Nia Example", "nia_example");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_practice", off: false } });

  assert.equal((await call("/v1/calls", { method: "POST", body: { practice: true } })).status, 401);
  const made = await call("/v1/calls", { method: "POST", token: ownerToken, body: { practice: true } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.practice, true);
  assert.equal(made.body.call.kind, "practice");
  assert.ok(made.body.invite && made.body.ticket);
  const id = made.body.call.id;

  const guest = await call("/v1/calls/join/" + made.body.invite, { method: "POST", ip: "198.51.100.21", body: { name: "Practice partner" } });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));

  const noText = await call("/v1/calls/practice", { method: "POST", token: ownerToken, body: { id, text: "  ", lang: "es" } });
  assert.equal(noText.status, 400);

  const replied = await call("/v1/calls/practice", { method: "POST", token: ownerToken, body: { id, text: "Hello, how are you?", lang: "es", turns: [] } });
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  assert.ok(replied.body.reply, "the mock key returns a spoken reply");
  assert.equal(JSON.stringify(replied.body).includes("test-key"), false, "the key is not returned");
  const greeted = await call("/v1/calls/practice", { method: "POST", token: ownerToken, body: { id, greet: true, voice: true, lang: "ru", turns: [] } });
  assert.equal(greeted.status, 200, JSON.stringify(greeted.body));
  assert.ok(greeted.body.reply, "the partner says hello first when the call connects");
  assert.equal(typeof greeted.body.audio, "string", "a voice reply field is always present");
  assert.equal(JSON.stringify(greeted.body).includes("test-key"), false, "the key is not returned with a voice reply");

  const noKey = await call("/v1/calls", { method: "POST", token: nia.token, body: { practice: true } });
  assert.equal(noKey.status, 201, JSON.stringify(noKey.body));
  const need = await call("/v1/calls/practice", { method: "POST", token: nia.token, body: { id: noKey.body.call.id, text: "Hello", lang: "es" } });
  assert.equal(need.status, 200, JSON.stringify(need.body));
  assert.equal(need.body.reason, "nokey", "a caller without a key is told to add one");

  const stranger = await signup(92, "Oli Example", "oli_example");
  assert.equal((await call("/v1/calls/practice", { method: "POST", token: stranger.token, body: { id, text: "Hi", lang: "es" } })).status, 403);

  const off = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_practice", off: true } });
  assert.equal(off.status, 200);
  assert.equal((await call("/v1/calls", { method: "POST", token: nia.token, body: { practice: true } })).status, 404);
  assert.equal((await call("/v1/calls/practice", { method: "POST", token: nia.token, body: { id, text: "Hi", lang: "es" } })).status, 404);
  const on = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_practice", off: false } });
  assert.equal(on.status, 200);
});

test("a caller can rename a history row, add a note, and correct a transcript", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  assert.ok(ownerToken, "the first test turned Calls on");
  const pip = await signup(101, "Pip Example", "pip_example");
  const quin = await signup(102, "Quin Example", "quin_example");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_hist_edit", off: false } });

  const made = await call("/v1/calls", { method: "POST", token: pip.token, body: { handle: "quin_example" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.call.id;
  await call("/v1/calls/" + id + "/end", { method: "POST", token: pip.token });

  const edited = await call("/v1/calls/history/edit", { method: "POST", token: pip.token, body: { id, title: "Weekly catch-up", note: "Ask about the draft." } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.title, "Weekly catch-up");
  assert.equal(edited.body.note, "Ask about the draft.");

  const listed = await call("/v1/calls/history", { token: pip.token });
  const row = (listed.body.calls || []).find((item) => item.id === id);
  assert.ok(row, "the call is in history");
  assert.equal(row.title, "Weekly catch-up");
  assert.equal(row.note, "Ask about the draft.");

  const theirs = await call("/v1/calls/history", { token: quin.token });
  const other = (theirs.body.calls || []).find((item) => item.id === id);
  assert.ok(other, "the other person still has the call");
  assert.equal(other.title || "", "", "a rename is only for the person who saved it");

  const saved = await call("/v1/calls/history/transcript", { method: "POST", token: pip.token, body: { id, lines: [{ id: "l1", at: Date.now(), who: "Pip", mine: true, original: "Hello there", translation: "Hola" }] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.saved, 1);

  const got = await call("/v1/calls/history/" + id + "/transcript", { token: pip.token });
  assert.equal(got.status, 200, JSON.stringify(got.body));
  assert.equal(got.body.lines[0].original, "Hello there");
  const fixed = await call("/v1/calls/history/" + id + "/correct", { method: "POST", token: pip.token, body: { lineId: "l1", original: "Hello there.", translation: "Hola." } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.line.original, "Hello there.");
  assert.equal(fixed.body.line.corrected, true);

  const again = await call("/v1/calls/history/transcript", { method: "POST", token: pip.token, body: { id, lines: [{ id: "l1", original: "should not overwrite", translation: "no" }] } });
  assert.equal(again.status, 200);
  const kept = await call("/v1/calls/history/" + id + "/transcript", { token: pip.token });
  assert.equal(kept.body.lines[0].original, "Hello there.", "a later save does not overwrite a correction");

  assert.equal((await call("/v1/calls/history/edit", { method: "POST", token: quin.token, body: { id, title: "Nope" } })).status, 200);
  assert.equal((await call("/v1/calls/history/" + id + "/correct", { method: "POST", token: quin.token, body: { lineId: "l1", original: "x" } })).status, 404);
  assert.equal((await call("/v1/calls/history/edit", { method: "POST", body: { id, title: "x" } })).status, 401);

  const off = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_hist_edit", off: true } });
  assert.equal(off.status, 200);
  assert.equal((await call("/v1/calls/history/edit", { method: "POST", token: pip.token, body: { id, title: "Hidden" } })).status, 404);
  const on = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_hist_edit", off: false } });
  assert.equal(on.status, 200);
});

test("the EU proxy prefers the Worker relay and never puts the API key on a URL or in the response", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  assert.ok(ownerToken, "the first test turned Calls on");
  const rio = await signup(103, "Rio Example", "rio_example");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_eu_proxy", off: false } });

  const made = await call("/v1/calls", { method: "POST", token: rio.token, body: { invite: true } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = made.body.call.id;
  const minted = await call("/v1/calls/" + id + "/translate", { method: "POST", token: rio.token, cf: { country: "SE" }, body: { target: "es", key: "k".repeat(30) } });
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(minted.body.mode, "token");
  assert.equal(minted.body.prefer, "relay");
  assert.equal(minted.body.proxy, "eu");
  const packed = JSON.stringify(minted.body);
  assert.equal(packed.includes("test-key"), false, "the owner key is not in the body");
  assert.equal(packed.includes("k".repeat(30)), false, "a pasted key is not in the body");
  assert.equal(String(minted.body.url || "").includes("key="), false);

  const off = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_eu_proxy", off: true } });
  assert.equal(off.status, 200);
  const direct = await call("/v1/calls/" + id + "/translate", { method: "POST", token: rio.token, cf: { country: "SE" }, body: { target: "es", key: "k".repeat(30) } });
  assert.equal(direct.status, 200, JSON.stringify(direct.body));
  assert.equal(direct.body.prefer, undefined, "off restores the earlier country-based order");
  assert.equal(direct.body.proxy, undefined);
  const ru = await call("/v1/calls/" + id + "/translate", { method: "POST", token: rio.token, cf: { country: "RU" }, body: { target: "es", key: "k".repeat(30) } });
  assert.equal(ru.body.prefer, "relay");
  assert.equal(ru.body.proxy, undefined);

  const on = await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_eu_proxy", off: false } });
  assert.equal(on.status, 200);
});

test("a guest can resume the same call after a reload, and leaving revokes the token", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  const host = await signup(81, "Host Rejoin", "host_rejoin");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  const invite = await call("/v1/calls", { method: "POST", token: host.token, body: { invite: true } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const first = await call("/v1/calls/join/" + invite.body.invite, { method: "POST", body: { name: "Guest" } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.guestToken && first.body.guestExpiresAt);
  const id = first.body.call.id;
  const again = await call("/v1/calls/join/" + invite.body.invite, { method: "POST", guest: first.body.guestToken, body: { name: "Guest" } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.guestId, first.body.guestId);
  assert.ok(again.body.ticket);
  const taken = await call("/v1/calls/join/" + invite.body.invite, { method: "POST", ip: "198.51.100.30", body: { name: "Other" } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "in_call");
  const ticket = await call("/v1/calls/" + id + "/ticket", { method: "POST", guest: first.body.guestToken, body: {} });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
  assert.ok(ticket.body.ticket);
  const ended = await call("/v1/calls/" + id + "/end", { method: "POST", guest: first.body.guestToken, body: {} });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const after = await call("/v1/calls/" + id + "/ticket", { method: "POST", guest: first.body.guestToken, body: {} });
  assert.ok(after.status === 401 || after.status === 410, "the guest token is no longer valid after leaving");
});

test("call the owner and request a call: availability, anti-spam, and Accept / Suggest / Decline", async () => {
  const ownerToken = globalThis.__callsOwnerToken;
  assert.ok(ownerToken, "the first test turned Calls on");
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls", off: false } });
  await call("/v1/calls/prefs", { method: "PUT", token: ownerToken, body: { who: "everyone", guests: true, dnd: false } });
  const mona = await signup(91, "Mona Example", "mona_example");

  const closed = await call("/v1/calls/reach", { ip: "198.51.100.40" });
  assert.equal(closed.status, 200);
  assert.deepEqual(Object.keys(closed.body).sort(), ["available", "requests", "self"], "nothing about the owner is shown");
  assert.equal(closed.body.available, false, "availability starts off");
  assert.equal((await call("/v1/calls/reach/call", { method: "POST", ip: "198.51.100.40", body: { name: "Vi" } })).status, 403);
  assert.equal((await call("/v1/calls/reach", { token: ownerToken })).body.self, true);
  assert.equal((await call("/v1/calls/reach/availability", { method: "PUT", token: mona.token, body: { available: true } })).status, 403, "only the owner switches it");

  const on = await call("/v1/calls/reach/availability", { method: "PUT", token: ownerToken, body: { available: true } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.available, true);
  assert.equal((await call("/v1/calls/reach", { ip: "198.51.100.40" })).body.available, true);
  const rang = await call("/v1/calls/reach/call", { method: "POST", ip: "198.51.100.40", body: { name: "Vi", device: "dev-aaaaaaaa" } });
  assert.equal(rang.status, 200, JSON.stringify(rang.body));
  assert.equal(rang.body.ringing, true);
  assert.ok(rang.body.guestToken && rang.body.ticket);
  assert.equal(rang.body.call.hostId, "", "the owner's id is not handed out");
  const incoming = await call("/v1/calls/incoming", { token: ownerToken });
  assert.equal(incoming.body.calls.some((row) => row.id === rang.body.call.id), true, "it rings the owner");

  await call("/v1/calls/prefs", { method: "PUT", token: ownerToken, body: { dnd: true, dndFrom: "00:00", dndTo: "23:59" } });
  await call("/v1/calls/prefs", { method: "PUT", token: ownerToken, body: { dnd: false } });

  const soon = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const spam = await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.41", body: { name: "Vi", note: "visit https://spam.example", startsAt: soon } });
  assert.equal(spam.status, 400, "links are refused");
  const bot = await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.42", body: { name: "Vi", website: "x", startsAt: soon } });
  assert.equal(bot.status, 400, "the hidden field catches bots");
  assert.equal((await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.43", body: { name: "Vi", startsAt: Date.now() + 60 * 1000 } })).status, 400, "too soon");

  const made = await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.44", body: { name: "Vi", note: "About the trip", startsAt: soon, zone: "Europe/Madrid", device: "dev-bbbbbbbb" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.ok(/^cq1\./.test(made.body.token));
  assert.equal(made.body.request.state, "pending");
  assert.equal((await call("/v1/calls/reach/requests", { token: mona.token })).status, 403, "only the owner lists requests");
  const listed = await call("/v1/calls/reach/requests", { token: ownerToken });
  assert.equal(listed.status, 200);
  const row = listed.body.requests.find((r) => r.name === "Vi" && r.note === "About the trip");
  assert.ok(row, "the owner sees the request");
  assert.equal(row.zone, "Europe/Madrid");
  assert.equal(JSON.stringify(listed.body).includes("198.51.100"), false, "no IP is kept or shown");

  for (let i = 0; i < 2; i++) assert.equal((await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.44", body: { name: "Vi" + i, startsAt: soon } })).status, 201);
  assert.equal((await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.44", body: { name: "Vi3", startsAt: soon } })).status, 429, "a source can only have a few open requests");

  const later = soon + 60 * 60 * 1000;
  const suggested = await call("/v1/calls/reach/requests/" + row.id + "/suggest", { method: "POST", token: ownerToken, body: { startsAt: later } });
  assert.equal(suggested.status, 200, JSON.stringify(suggested.body));
  const seen = await call("/v1/calls/reach/request?token=" + encodeURIComponent(made.body.token));
  assert.equal(seen.body.request.state, "suggested");
  assert.equal(seen.body.request.suggestedAt, later);
  assert.equal((await call("/v1/calls/reach/requests/" + row.id + "/accept", { method: "POST", token: ownerToken, body: {} })).status, 409, "after Suggest another time only the visitor can take the new time");
  const took = await call("/v1/calls/reach/request/take", { method: "POST", body: { token: made.body.token } });
  assert.equal(took.status, 200, JSON.stringify(took.body));
  assert.equal(took.body.request.state, "accepted");
  assert.ok(/^cs1\./.test(took.body.request.invite), "the visitor gets the scheduled-call link");
  const sched = await call("/v1/calls/schedule", { token: ownerToken });
  assert.equal(sched.body.schedules.some((s) => s.startsAt === later), true, "Accept creates a scheduled call with reminders");
  const ics = await call("/v1/calls/schedule/guest/ics?token=" + encodeURIComponent(took.body.request.invite));
  assert.equal(ics.status, 200);
  assert.ok(ics.text.includes("BEGIN:VCALENDAR"));

  const second = (await call("/v1/calls/reach/requests", { token: ownerToken })).body.requests.find((r) => r.name === "Vi0");
  assert.equal((await call("/v1/calls/reach/requests/" + second.id + "/decline", { method: "POST", token: ownerToken, body: {} })).body.request.state, "declined");
  const third = (await call("/v1/calls/reach/requests", { token: ownerToken })).body.requests.find((r) => r.name === "Vi1");
  assert.equal((await call("/v1/calls/reach/requests/" + third.id + "/accept", { method: "POST", token: ownerToken, body: {} })).body.request.state, "accepted");

  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_owner_reach", off: true } });
  assert.equal((await call("/v1/calls/reach", { ip: "198.51.100.45" })).status, 204);
  assert.equal((await call("/v1/calls/reach/request", { method: "POST", ip: "198.51.100.45", body: { name: "Vi", startsAt: soon } })).status, 404);
  await call("/v1/owner/features", { method: "POST", token: ownerToken, body: { name: "calls_owner_reach", off: false } });
  await call("/v1/calls/reach/availability", { method: "PUT", token: ownerToken, body: { available: false } });
});
