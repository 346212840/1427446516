# Stop the service worker stamp from conflicting

Every open PR that changes a cached file edits the same line of `sw.js`:

```js
// cache-bust: <UTC ISO time>-<label>
```

That is why those PRs conflict with each other even when they do not otherwise touch the worker. The published worker does not need that hand edit. `publish-app.yml` already rewrites the copy in the Pages artifact:

```sh
sed -i "s|__SW_VERSION__|${GITHUB_SHA}|g; s|__SW_BUILT__|${VERSION_BUILT}|g" _site/sw.js
```

`__SW_VERSION__` sits in the worker's cache name, so the published `sw.js` is a different script on every deploy. Browsers pick up a new worker because those bytes changed. The hand-written comment only exists to force the same byte change in git.

## Change

Keep one fixed line in git, on line 7:

```js
// cache-bust: source
```

In the same publish `sed`, rewrite that line in the artifact only:

```sh
sed -i "s|__SW_VERSION__|${GITHUB_SHA}|g; s|__SW_BUILT__|${VERSION_BUILT}|g; s|// cache-bust: source|// cache-bust: ${GITHUB_SHA}|" _site/sw.js
```

`scripts/assemble_site.py` already substitutes `__SW_VERSION__` when it builds a site. Do the same replacement of `// cache-bust: source` there, using the sha it already receives. A local site then matches a published one.

PRs stop editing `sw.js` for the stamp. A real change to the worker still merges normally.

## Tests that stay

`scripts/sw_update_test.mjs` does not read the comment. It drives `version.json` and checks that a downloaded build applies, that a composer holds it, and that What's new shows once. Leave that file as it is.

Add two checks, and do not loosen any existing one:

- The source `sw.js` contains exactly one line `// cache-bust: source`.
- A built `_site/sw.js` contains `// cache-bust:` plus the build sha, and does not contain `__SW_VERSION__` or `// cache-bust: source`.

This patch is not applied here. It edits `.github/workflows/publish-app.yml`, which stays for the owner to land.
