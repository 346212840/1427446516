import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configuredRepository, githubFetch, pagesBase, repoFromRedirect, repositoryIdFromRedirect, resolveRepository } from "../src/site-repo.js";

test("the configured name is the current repository", () => {
  assert.equal(configuredRepository({}), "346212840/1427446516");
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

test("a numeric repository redirect is followed once and the new name is cached", async () => {
  assert.deepEqual(repositoryIdFromRedirect("https://api.github.com/repositories/90796663"), { id: "90796663", suffix: "", search: "" });
  assert.equal(repositoryIdFromRedirect("https://evil.example/repositories/90796663"), null);
  assert.equal(repositoryIdFromRedirect("http://api.github.com/repositories/90796663"), null);
  assert.equal(repoFromRedirect("https://api.github.com/repositories/90796663"), "");

  const seen = [];
  const body = JSON.stringify({ ref: "main" });
  const fetcher = async (url, init) => {
    seen.push(init.method + " " + url);
    if (url === "https://api.github.com/repos/Example/Numbered/actions/workflows/sync.yml/dispatches") {
      return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/90796663" } });
    }
    if (url === "https://api.github.com/repositories/90796663/actions/workflows/sync.yml/dispatches") {
      assert.equal(init.method, "POST");
      assert.equal(init.body, body);
      return new Response(null, { status: 204 });
    }
    if (url === "https://api.github.com/repositories/90796663" && init.method === "GET") {
      return new Response(JSON.stringify({ full_name: "Example/AfterNumber" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.github.com/repos/Example/AfterNumber/actions/workflows/sync.yml/dispatches") {
      assert.equal(init.method, "POST");
      assert.equal(init.body, body);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected " + init.method + " " + url);
  };
  const init = { method: "POST", body };
  const env = { GITHUB_REPOSITORY: "Example/Numbered" };
  const first = await githubFetch(env, "/actions/workflows/sync.yml/dispatches", init, fetcher);
  const second = await githubFetch(env, "/actions/workflows/sync.yml/dispatches", init, fetcher);
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.deepEqual(seen, [
    "POST https://api.github.com/repos/Example/Numbered/actions/workflows/sync.yml/dispatches",
    "POST https://api.github.com/repositories/90796663/actions/workflows/sync.yml/dispatches",
    "GET https://api.github.com/repositories/90796663",
    "POST https://api.github.com/repos/Example/AfterNumber/actions/workflows/sync.yml/dispatches"
  ]);
});

test("a numeric Location that already names the path is used as given", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push(init.method + " " + url);
    if (String(url).includes("/repos/Example/Pathed/")) {
      return new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/55/actions/workflows/sync.yml/dispatches" }
      });
    }
    if (url === "https://api.github.com/repositories/55/actions/workflows/sync.yml/dispatches") {
      assert.equal(init.body, "{\"ref\":\"main\"}");
      return new Response(null, { status: 204 });
    }
    if (url === "https://api.github.com/repositories/55") {
      return new Response(JSON.stringify({ full_name: "Example/PathedNow" }), { status: 200 });
    }
    throw new Error("unexpected " + url);
  };
  const res = await githubFetch({ GITHUB_REPOSITORY: "Example/Pathed" }, "/actions/workflows/sync.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: "main" })
  }, fetcher);
  assert.equal(res.status, 204);
  assert.deepEqual(seen.slice(0, 3), [
    "POST https://api.github.com/repos/Example/Pathed/actions/workflows/sync.yml/dispatches",
    "POST https://api.github.com/repositories/55/actions/workflows/sync.yml/dispatches",
    "GET https://api.github.com/repositories/55"
  ]);
});

test("a numeric rename redirect becomes the Pages directory", async () => {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    if (url === "https://api.github.com/repos/Example/OldNumeric") {
      return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/42" } });
    }
    if (url === "https://api.github.com/repositories/42") {
      return new Response(JSON.stringify({ full_name: "Example/After" }), { status: 200 });
    }
    throw new Error(url);
  };
  const env = { GITHUB_REPOSITORY: "Example/OldNumeric" };
  const name = await resolveRepository(env, fetcher);
  assert.equal(name, "Example/After");
  assert.equal(pagesBase(name), "https://example.github.io/After/");
  assert.equal(await resolveRepository(env, fetcher), "Example/After");
  assert.deepEqual(seen, [
    "https://api.github.com/repos/Example/OldNumeric",
    "https://api.github.com/repositories/42"
  ]);
});

test("a numeric redirect keeps the workflow query", async () => {
  const seen = [];
  const path = "/actions/workflows/discord-live.yml/runs?per_page=5";
  const fetcher = async (url, init) => {
    seen.push(init.method + " " + url);
    if (url.startsWith("https://api.github.com/repos/Example/QueryRoot/")) {
      return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/88" } });
    }
    if (url.startsWith("https://api.github.com/repos/Example/QueryPath/")) {
      return new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/89/actions/workflows/discord-live.yml/runs?per_page=5" } });
    }
    if (url === "https://api.github.com/repositories/88" || url === "https://api.github.com/repositories/89") {
      const name = url.endsWith("/88") ? "Example/QueryRootNow" : "Example/QueryPathNow";
      return new Response(JSON.stringify({ full_name: name }), { status: 200 });
    }
    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  };
  const root = await githubFetch({ GITHUB_REPOSITORY: "Example/QueryRoot" }, path, { method: "GET" }, fetcher);
  const pathed = await githubFetch({ GITHUB_REPOSITORY: "Example/QueryPath" }, path, { method: "GET" }, fetcher);
  assert.equal(root.status, 200);
  assert.equal(pathed.status, 200);
  assert.ok(seen.includes("GET https://api.github.com/repositories/88/actions/workflows/discord-live.yml/runs?per_page=5"));
  assert.ok(seen.includes("GET https://api.github.com/repositories/89/actions/workflows/discord-live.yml/runs?per_page=5"));
});

test("a redirect off api.github.com is not followed", async () => {
  const seen = [];
  const res = await githubFetch({ GITHUB_REPOSITORY: "Example/Offhost" }, "/actions/workflows/sync.yml/dispatches", {
    method: "POST",
    body: "{}"
  }, async (url, init) => {
    seen.push(init.method + " " + url);
    return new Response(null, { status: 301, headers: { location: "https://evil.example/repositories/1/actions/workflows/sync.yml/dispatches" } });
  });
  assert.equal(res.status, 301);
  assert.deepEqual(seen, ["POST https://api.github.com/repos/Example/Offhost/actions/workflows/sync.yml/dispatches"]);
});

test("worker source does not call api.github.com with raw fetch", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
  const allow = new Set(["site-repo.js"]);
  const bad = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith(".js") || allow.has(name)) continue;
      const text = fs.readFileSync(full, "utf8");
      const raw = /(?:^|[^.\w])fetch(?:er)?\s*\(\s*(?:githubApi\s*\(|["'`][^"'`]*api\.github\.com)/;
      if (raw.test(text)) bad.push(path.relative(root, full));
    }
  };
  walk(root);
  assert.deepEqual(bad, []);
});

test("an owner rename that answers 404 is found again by the repository id", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push(init.method + " " + url);
    if (url.startsWith("https://api.github.com/repos/OldOwner/Gone")) return new Response("{}", { status: 404 });
    if (url === "https://api.github.com/repositories/1427446516") {
      return new Response(JSON.stringify({ full_name: "NewOwner/Kept" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://api.github.com/repos/NewOwner/Kept/actions/workflows/sync.yml/dispatches") return new Response(null, { status: 204 });
    return new Response("{}", { status: 500 });
  };
  const env = { GITHUB_REPOSITORY: "OldOwner/Gone" };
  const init = { method: "POST", body: JSON.stringify({ ref: "main" }) };
  const first = await githubFetch(env, "/actions/workflows/sync.yml/dispatches", init, fetcher);
  const second = await githubFetch(env, "/actions/workflows/sync.yml/dispatches", init, fetcher);
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  assert.deepEqual(seen, [
    "POST https://api.github.com/repos/OldOwner/Gone/actions/workflows/sync.yml/dispatches",
    "GET https://api.github.com/repositories/1427446516",
    "POST https://api.github.com/repos/NewOwner/Kept/actions/workflows/sync.yml/dispatches",
    "POST https://api.github.com/repos/NewOwner/Kept/actions/workflows/sync.yml/dispatches"
  ]);
  const name = await resolveRepository({ GITHUB_REPOSITORY: "OldOwner/Gone2" }, async (url) => {
    if (url.endsWith("/repos/OldOwner/Gone2")) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ full_name: "NewOwner/Kept" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(name, "NewOwner/Kept");
});

test("a real 404 under the current name costs one id lookup, then none", async () => {
  const seen = [];
  const fetcher = async (url, init) => {
    seen.push(init.method + " " + url);
    if (url === "https://api.github.com/repositories/1427446516") {
      return new Response(JSON.stringify({ full_name: "Same/Repo" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  const env = { GITHUB_REPOSITORY: "Same/Repo" };
  assert.equal((await githubFetch(env, "/contents/missing", { method: "GET" }, fetcher)).status, 404);
  assert.equal((await githubFetch(env, "/contents/missing", { method: "GET" }, fetcher)).status, 404);
  assert.equal(seen.length, 3);
});
