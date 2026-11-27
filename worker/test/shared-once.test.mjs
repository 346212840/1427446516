import assert from "node:assert/strict";
import test from "node:test";
import { awaitShared, orphanedPromise } from "../src/shared-once.js";
import { readFlags, forgetFlags } from "../src/feature-flags.js";

const ORPHAN = "This promise was created by a request that has since ended, so it can never settle.";

/* What a cancelled request leaves behind: awaiting it always throws, and
   it never runs the .catch reset attached when it was created. */
function orphaned() {
  return { then(ok, fail) { return Promise.reject(new Error(ORPHAN)).then(ok, fail); }, catch() { return orphaned(); } };
}

test("orphanedPromise knows the runtime's cross-request errors only", () => {
  assert.equal(orphanedPromise(new Error(ORPHAN)), true);
  assert.equal(orphanedPromise(new Error("Cannot perform I/O on behalf of a different request.")), true);
  assert.equal(orphanedPromise(new Error("D1_ERROR: no such table")), false);
});

test("awaitShared drops an orphaned setup and runs it again in this request", async () => {
  let cached = orphaned();
  let starts = 0;
  const get = () => { if (!cached) { starts += 1; cached = Promise.resolve("ready"); } return cached; };
  assert.equal(await awaitShared(get, () => { cached = null; }), "ready");
  assert.equal(starts, 1);
  // The fresh setup is kept for the next request.
  assert.equal(await awaitShared(get, () => { cached = null; }), "ready");
  assert.equal(starts, 1);
});

test("awaitShared passes other errors through and retries only once", async () => {
  await assert.rejects(awaitShared(() => Promise.reject(new Error("boom")), () => {}), /boom/);
  let resets = 0;
  await assert.rejects(awaitShared(() => orphaned(), () => { resets += 1; }), /since ended/);
  assert.equal(resets, 1);
});

test("readFlags recovers after the flag table setup was orphaned", async () => {
  forgetFlags();
  let runs = 0;
  const env = {
    DB: {
      prepare(sql) {
        return {
          run() { runs += 1; return runs === 1 ? orphaned() : Promise.resolve({}); },
          all() { return Promise.resolve({ results: [{ name: "shorts", off: 1 }] }); }
        };
      }
    }
  };
  // The first setup is cancelled; the same call starts it again and reads the switches.
  const first = await readFlags(env, 1);
  assert.equal(first.shorts, true, "the retry inside the same call reads the table");
  assert.equal(runs, 2);
  forgetFlags();
  const second = await readFlags(env, 2);
  assert.equal(second.shorts, true);
  assert.equal(runs, 2, "a healthy setup is not run again");
  forgetFlags();
});
