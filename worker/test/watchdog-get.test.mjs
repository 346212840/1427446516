/* The public watchdog is a stored summary. It must answer when the
   database is missing, which is the same failure the setup throws. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

test("GET /v1/watchdog answers without a database", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    r2Buckets: ["DATA"],
    bindings: { ACCOUNT_PEPPER: "pepper-test", ALLOWED_ORIGINS: "https://346212840.github.io" }
  });
  try {
    const res = await mf.dispatchFetch("https://accounts.test/v1/watchdog", { headers: { "CF-Connecting-IP": "203.0.113.10" } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.problems, []);
    assert.deepEqual(body.paused, []);
  } finally {
    await mf.dispose();
  }
});
