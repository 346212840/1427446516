import assert from "node:assert/strict";
import test from "node:test";
import { parseTikTokInput, normalizeTikTokInput, resolveTikTokShort } from "../src/tiktok-input.js";

const ok = (input, handle) => assert.equal(normalizeTikTokInput(input), handle, JSON.stringify(input));

test("the exact link the owner pasted", () => {
  ok("https://www.tiktok.com/@kikuska7?_r=1&_t=ZN-9BYeGkJAh5K", "kikuska7");
});

test("every link form", () => {
  ok("tiktok.com/@kikuska7", "kikuska7");
  ok("http://tiktok.com/@kikuska7/", "kikuska7");
  ok("https://m.tiktok.com/@kikuska7?is_from_webapp=1&sender_device=pc", "kikuska7");
  ok("https://www.tiktok.com/@kikuska7/live", "kikuska7");
  ok("https://www.tiktok.com/@kikuska7/live?enter_from=live_head", "kikuska7");
  ok("https://www.tiktok.com/@kikuska7/video/7300000000000000000?lang=en#top", "kikuska7");
  ok("https://www.tiktok.com/%40kikuska7", "kikuska7");
  ok("HTTPS://WWW.TIKTOK.COM/@KikuSka7", "KikuSka7");
  ok("https://us.tiktok.com/@kikuska7", "kikuska7");
  ok("https://www.tiktok.com/@some.user_name9", "some.user_name9");
});

test("plain handles, spaces and pasted text", () => {
  ok("@kikuska7", "kikuska7");
  ok("kikuska7", "kikuska7");
  ok("  @@kikuska7  ", "kikuska7");
  ok("KIKUSKA7", "KIKUSKA7");
  ok("a_b.c", "a_b.c");
  ok("\u200b@kikuska7\u200b", "kikuska7");
  ok("＠kikuska7", "kikuska7");
  ok("Check this out https://www.tiktok.com/@kikuska7?_r=1&_t=ZN-9BYeGkJAh5K it is live!", "kikuska7");
  ok("(https://www.tiktok.com/@kikuska7/live).", "kikuska7");
  ok("follow @kikuska7, she streams", "kikuska7");
  ok("https://www.tiktok.com/@kikuska7\nhttps://www.tiktok.com/@other", "kikuska7");
});

test("things that are not an account", () => {
  ok("", "");
  ok("x", "");
  ok("https://example.com/@kikuska7", "");
  ok("https://www.tiktok.com/discover", "");
  ok("https://www.tiktok.com/", "");
  ok("two words", "");
  ok("a".repeat(25), "");
  ok("bad!handle", "");
  assert.equal(parseTikTokInput("x".repeat(1200)), null);
});

test("short links are recognised and resolved by redirect, only to tiktok.com", async () => {
  assert.deepEqual(parseTikTokInput("https://vm.tiktok.com/ZMabc123/"), { short: "https://vm.tiktok.com/ZMabc123/" });
  assert.deepEqual(parseTikTokInput("see https://vt.tiktok.com/ZSxyz789/ now"), { short: "https://vt.tiktok.com/ZSxyz789/" });
  assert.deepEqual(parseTikTokInput("https://www.tiktok.com/t/ZTabc123/"), { short: "https://www.tiktok.com/t/ZTabc123/" });
  const hops = [];
  const fake = (map) => async (url) => { hops.push(url); const to = map[url]; return { headers: { get: () => to || "" } }; };
  const direct = fake({ "https://vm.tiktok.com/ZMabc123/": "https://www.tiktok.com/@kikuska7?_r=1&_t=x" });
  assert.equal(await resolveTikTokShort("https://vm.tiktok.com/ZMabc123/", direct), "kikuska7");
  const twice = fake({ "https://vt.tiktok.com/ZSx/": "https://www.tiktok.com/t/ZTy/", "https://www.tiktok.com/t/ZTy/": "https://m.tiktok.com/@kikuska7/live" });
  assert.equal(await resolveTikTokShort("https://vt.tiktok.com/ZSx/", twice), "kikuska7");
  const evil = fake({ "https://vm.tiktok.com/ZMevil/": "https://evil.example/@kikuska7" });
  assert.equal(await resolveTikTokShort("https://vm.tiktok.com/ZMevil/", evil), "", "never follows off tiktok.com");
  const none = fake({});
  assert.equal(await resolveTikTokShort("https://vm.tiktok.com/ZMnone/", none), "");
  const loop = fake({ "https://vm.tiktok.com/a1b2c3/": "https://vm.tiktok.com/a1b2c3/" });
  assert.equal(await resolveTikTokShort("https://vm.tiktok.com/a1b2c3/", loop), "", "gives up after three hops");
});
