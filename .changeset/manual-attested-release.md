---
"@radius-project/canvas": patch
---

Refactor the release lifecycle onto manual, semver-versioned, immutable releases.
The per-merge publish workflow is replaced by `.github/workflows/release.yml`,
which is dispatched with a bump level (`patch` by default, or `minor`/`major`),
bumps the shared version in `plugin.json`, `package.json` and `marketplace.json`
via `scripts/version.mjs`, and opens a pull request for it. Merging that pull
request builds the canvas bundle, attests its provenance, and publishes the
`release` branch plus an immutable `v<version>` tag and GitHub release. CI now
also verifies that the manifest versions stay in sync.
