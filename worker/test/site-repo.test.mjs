import assert from "node:assert/strict";
import test from "node:test";
import { configuredRepository, githubFetch, pagesBase, repoFromRedirect, resolveRepository } from "../src/site-repo.js";

test("the configured name is the current repository", () => {
  assert.equal(configuredRepository({}), "ViktorychGroup/ViktorychApp");
  assert.equal(configuredRepository({ GITHUB_REPOSITORY: "Example/Renamed" }), "Example/Renamed");
  assert.equal(pagesBase("Example/Renamed"), "https://example.github.io/Renamed/");
});

test("a GitHub rename redirect becomes the Pages directory", async () => {
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, "manual");
    assert.match(url, /\/repos\/Example\/OldName$/);
    return new Response(null, { status: 301, headers: { location: "https://api.github.com/repos/Example/NewName" } });
  };
  const name = await resolveRepository({ GITHUB_REPOSITORY: "Example/OldName" }, fetcher);
  assert.equal(name, "Example/NewName");
  assert.equal(pagesBase(name), "https://example.github.io/NewName/");
  assert.equal(repoFromRedirect("https://api.github.com/repos/Example/NewName"), "Example/NewName");
});

test("a workflow call is one request, and a rename keeps the method and body", async () => {
  const current = [];
  const once = await githubFetch({ GITHUB_REPOSITORY: "Example/Current" }, "/actions/workflows/sync.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: "main" })
  }, async (url, init) => {
    current.push(init.method + " " + url);
    return new Response(null, { status: 204 });
  });
  assert.equal(once.status, 204);
  assert.deepEqual(current, ["POST https://api.github.com/repos/Example/Current/actions/workflows/sync.yml/dispatches"]);

  const seen = [];
  const fetcher = async (url, init) => {
    seen.push(init.method + " " + url);
    if (String(url).includes("/repos/Example/Moved/")) {
      return new Response(null, { status: 301, headers: { location: "https://api.github.com/repos/Example/Live/actions/workflows/sync.yml/dispatches" } });
    }
    assert.equal(init.body, JSON.stringify({ ref: "main" }));
    return new Response(null, { status: 204 });
  };
  const init = { method: "POST", body: JSON.stringify({ ref: "main" }) };
  const first = await githubFetch({ GITHUB_REPOSITORY: "Example/Moved" }, "/actions/workflows/sync.yml/dispatches", init, fetcher);
  const second = await githubFetch({ GITHUB_REPOSITORY: "Example/Moved" }, "/actions/workflows/sync.yml/dispatches", init, fetcher);
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.deepEqual(seen, [
    "POST https://api.github.com/repos/Example/Moved/actions/workflows/sync.yml/dispatches",
    "POST https://api.github.com/repos/Example/Live/actions/workflows/sync.yml/dispatches",
    "POST https://api.github.com/repos/Example/Live/actions/workflows/sync.yml/dispatches"
  ]);
});
