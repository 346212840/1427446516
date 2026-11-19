/* Send-as-my-account login: phone, code, 2FA, sealed session, one voice send.
   The mock stands in for GramJS. Nothing here talks to Telegram. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../telegram-account.js", import.meta.url), "utf8");
for (const needle of ["TelegramClient", "StringSession", "auth.SignIn", "auth.LogOut", "DocumentAttributeAudio", "sendFile", "floodSleepThreshold: 0", "AES-GCM", "sessionStorage.removeItem"]) {
  assert.ok(src.includes(needle), needle);
}

const kv = new Map();
function request(result) {
  const req = {};
  queueMicrotask(() => {
    req.result = result;
    if (req.onsuccess) req.onsuccess();
  });
  return req;
}
const indexedDB = {
  open() {
    const req = {};
    const db = {
      objectStoreNames: { contains(name) { return kv.has(name); } },
      createObjectStore(name) { kv.set(name, new Map()); },
      transaction(name) {
        const map = kv.get(name);
        return {
          objectStore() {
            return {
              get(key) { return request(map.get(key)); },
              put(value, key) { map.set(key, value); return request(true); }
            };
          }
        };
      }
    };
    queueMicrotask(() => {
      req.result = db;
      if (!kv.has("kv") && req.onupgradeneeded) req.onupgradeneeded();
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  }
};

const calls = [];
let gate = null;
let flood = false;
const client = {
  async sendCode(creds, phone) {
    calls.push(["sendCode", phone, creds.apiHash]);
    if (String(phone).endsWith("99999")) {
      const err = new Error("flood");
      err.errorMessage = "FLOOD_WAIT_3";
      err.seconds = 3;
      throw err;
    }
    return { phoneCodeHash: "hash-one" };
  },
  async signInCode(body) {
    calls.push(["signIn", body.code]);
    if (body.code === "00000") {
      const err = new Error("bad code");
      err.errorMessage = "PHONE_CODE_INVALID";
      throw err;
    }
    if (body.code === "22222") {
      const err = new Error("password");
      err.errorMessage = "SESSION_PASSWORD_NEEDED";
      throw err;
    }
    if (body.code === "33333") return { className: "auth.AuthorizationSignUpRequired" };
    return { className: "auth.Authorization" };
  },
  async checkPassword(password) {
    calls.push(["password", password.length]);
    if (password !== "yes") {
      const err = new Error("bad");
      err.errorMessage = "PASSWORD_HASH_INVALID";
      throw err;
    }
    return { className: "auth.Authorization" };
  },
  session: { save() { return "session-test-value"; } },
  async checkAuthorization() { return true; },
  async logOut() { calls.push(["logOut"]); },
  disconnect() { calls.push(["disconnect"]); },
  async sendFile(peer, opts) {
    const wave = opts.attributes[0].waveform;
    calls.push(["sendFile", peer, opts.voiceNote, opts.attributes[0].voice, opts.attributes[0].duration, wave.length, opts.caption]);
    if (flood) {
      const err = new Error("flood");
      err.errorMessage = "FLOOD_WAIT_4";
      err.seconds = 4;
      throw err;
    }
    if (gate) await gate;
    return { ok: true };
  }
};

const removed = [];
const sandbox = {
  crypto,
  indexedDB,
  sessionStorage: { removeItem(key) { removed.push(key); } },
  ViktorychServerFeature(name) { return name === "telegram_account_send"; },
  ViktorychTgMock: {
    createClient() { return client; }
  },
  File,
  Blob,
  TextEncoder,
  TextDecoder,
  btoa,
  atob,
  Uint8Array,
  Promise,
  Date,
  Math,
  JSON,
  Error,
  Object,
  String,
  Number
};
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox, { filename: "telegram-account.js" });
const account = sandbox.ViktorychTgAccount;

const one = account.packWaveform([1]);
assert.equal(one.length, 1);
assert.equal(one[0], 1);
const packed = account.packWaveform(new Uint8Array(100).fill(31));
assert.equal(packed.length, 63);
assert.ok(packed[0] > 0);

assert.equal(await account.prepare(), "app");
assert.match(account.markup(), /App id/);
assert.equal(removed.includes("viktorych-tg-account-v1"), true);
await assert.rejects(account.saveApp("nope", "apptesthashvalue"), (err) => err.code === "auth");
await account.saveApp("10001", "apptesthashvalue");
assert.equal(account.step(), "phone");
assert.match(account.markup(), /Phone number/);
const stored = kv.get("kv").get("vault");
assert.deepEqual(Object.keys(stored).sort(), ["ct", "iv"]);
assert.equal(stored.ct.includes("apptesthashvalue"), false);
assert.equal(JSON.stringify(stored).includes("apptesthashvalue"), false);

await assert.rejects(account.beginPhone("12"), (err) => err.code === "auth");
const flooded = await account.beginPhone("00099999").then(() => null, (err) => err);
assert.equal(flooded.code, "flood");
assert.ok(account.floodWait() > 2000);

await account.beginPhone("000111222");
assert.equal(account.step(), "code");
assert.equal(calls.some((row) => row[0] === "sendCode" && row[1] === "+000111222" && row[2] === "apptesthashvalue"), true);
assert.match(account.markup(), /Login code/);
await assert.rejects(account.submitCode("00000"), (err) => err.code === "auth");
assert.equal(account.step(), "code");
await assert.rejects(account.submitCode("33333"), (err) => err.code === "auth");
assert.equal(account.step(), "code");
const need = await account.submitCode("22222");
assert.equal(need.step, "password");
assert.match(account.markup(), /Two-factor password/);
await assert.rejects(account.submitPassword("no"), (err) => err.code === "auth");
assert.equal(account.step(), "password");
assert.equal(account.signedIn(), false);
await account.submitPassword("yes");
assert.equal(account.signedIn(), true);
assert.match(account.markup(), /Signed in on this device/);
await new Promise((resolve) => setTimeout(resolve, account.floodWait() + 30));
const sealed = kv.get("kv").get("vault");
assert.equal(JSON.stringify(sealed).includes("session-test-value"), false);
assert.equal(JSON.stringify(sealed).includes("apptesthashvalue"), false);

const blob = new Blob([new Uint8Array(8000)]);
let release;
gate = new Promise((resolve) => { release = resolve; });
const first = account.send(blob, "hello", "person");
const second = await account.send(blob, "hello", "person").then(() => null, (err) => err);
assert.equal(second.code, "busy");
release();
await first;
gate = null;
assert.equal(calls.filter((row) => row[0] === "sendFile").length, 1);
const sent = calls.find((row) => row[0] === "sendFile");
assert.equal(sent[1], "person");
assert.equal(sent[2], true);
assert.equal(sent[3], true);
assert.equal(sent[4], 1);
assert.equal(sent[5], 63);
assert.equal(sent[6], "hello");

flood = true;
const waited = await account.send(blob, "", "person").then(() => null, (err) => err);
assert.equal(waited.code, "flood");
const before = calls.filter((row) => row[0] === "sendFile").length;
const again = await account.send(blob, "", "person").then(() => null, (err) => err);
assert.equal(again.code, "flood");
assert.equal(calls.filter((row) => row[0] === "sendFile").length, before);

await account.signOut();
assert.equal(account.signedIn(), false);
assert.equal(account.step(), "phone");
assert.equal(calls.some((row) => row[0] === "logOut"), true);
await new Promise((resolve) => setTimeout(resolve, account.floodWait() + 30));
const after = await account.send(blob, "", "person").then(() => null, (err) => err);
assert.equal(after.code, "auth");

const lib = await import(new URL("../vendor/gramjs/telegram.js", import.meta.url).href);
assert.equal(typeof lib.TelegramClient, "function");
assert.equal(typeof lib.StringSession, "function");
assert.equal(typeof lib.Api.auth.SignIn, "function");
assert.equal(typeof lib.Api.auth.LogOut, "function");
assert.equal(typeof lib.Api.DocumentAttributeAudio, "function");
const attr = new lib.Api.DocumentAttributeAudio({ voice: true, duration: 2, waveform: Buffer.from([1, 2, 3]) });
assert.equal(attr.voice, true);
assert.equal(attr.duration, 2);

console.log("telegram account login ok");
