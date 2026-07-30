---
"@radius-project/core": patch
"@radius-project/canvas": patch
---

Pin the Repo Radius actions to exact commit SHAs and never change a repository's workflows without confirmation.

The workflows the extension commits into a user's repository run with `id-token: write` and exchange that token for cloud credentials, so whoever controls the action code they resolve to controls the user's cloud account for the duration of the run. Those workflows previously referenced `radius-project/radius@main`, and the extension silently re-committed them to the user's default branch on a background timer and before every dispatch — so the code running against a user's cloud could change between two deploys with nothing in the repository history to explain why.

Every `uses:` the extension writes is now rewritten to the exact commit SHA declared in a compiled-in pinset (`radius-core/src/workflows/pinset.ts`), in the conventional `@<sha> # <version>` form that Dependabot also reads and writes. The workflow templates themselves are fetched at that same pinned commit rather than from a moving branch. Rewriting patches the reference token in place instead of re-serializing the YAML, so the resulting commit touches only the reference lines.

Before dispatching a deployment the extension compares the pins already committed in the repository against the pinset. Matching pins cost two file reads, no prompt and no writes. Older pins withhold the dispatch and show exactly which files and actions would change; on confirmation the update is committed to the default branch, or — when that branch is protected — opened as a pull request, with the deployment blocked until it merges. When neither path is available the deployment does not start and the message names what is missing. A repository pinned ahead of the extension is never downgraded, and a delete is never blocked by a stale pin.

`syncRepoWorkflows` is now detection-only and reports drift instead of committing it, `RADIUS_REF` / `DELETE_RADIUS_REF` (and its `RADIUS_DELETE_REF` override) are replaced by the pinset, and `scripts/update-pinset.mjs` resolves and verifies the pinned SHAs against upstream in CI so one can never be hand-edited.
