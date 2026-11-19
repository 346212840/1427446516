import assert from "node:assert/strict";
import test from "node:test";
import { configuredRepository, pagesBase, repoFromRedirect, resolveRepository } from "../src/site-repo.js";

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
