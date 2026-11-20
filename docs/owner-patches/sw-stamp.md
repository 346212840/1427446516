# Service worker stamp at publish

The owner approved this change. It is in the branch, not waiting as a patch.

`sw.js` line 7 stays `// cache-bust: source` in git. `scripts/assemble_site.py` and the assemble step in `.github/workflows/publish-app.yml` rewrite that line to `// cache-bust: <commit sha>` in `_site/sw.js`. GitHub Pages and pages.dev both upload that same directory, so both hosts get the sha. A new commit publishes a different worker. A rerun of the same commit stays byte-identical, which is the same rule `__SW_BUILT__` already follows.

PRs do not edit the stamp line. A real change to the worker still merges normally.
