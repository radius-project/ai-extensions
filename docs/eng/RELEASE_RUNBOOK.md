# Release runbook

The short version, for whoever is cutting the release. [`RELEASING.md`](./RELEASING.md) explains how and why any of this works; this page is only what you do.

## The two channels

| Channel    | Moves when                              | Version looks like   | Users install                  |
|------------|-----------------------------------------|----------------------|--------------------------------|
| **edge**   | automatically, on every merge to `main` | `0.2.0-edge-0b33186` | `radius` (the default for now) |
| **stable** | never - each release is its own ref     | `0.2.0`              | `radius` (after stable launch) |

Edge is the rolling preview: it exists so a change can be tried the moment it lands, and it is never the recommendation for real use. It is the only moving target - branch `releases/<plugin>/edge` and tag `<plugin>@edge`, both force-replaced on every merge.

A stable release is **identified by its version** and nothing about it moves afterwards: it is frozen at `releases/<plugin>/v<version>` with its `<plugin>@<version>` tag on the same orphan commit, and the GitHub release is cut from that tag. There is no `latest` branch or tag to track.

The marketplace lists one entry per plugin, and each entry's `source.ref` on `main` selects what a plain `marketplace add` installs. Today the only plugin is `radius`, pointing at `radius@edge`; after its first stable release, change that one field to that release's `radius@<version>`, and re-point it when a newer one ships. Generated edge catalogs continue to point to edge, so the switch does not retire the preview channel.

Plugins release **independently**: cutting `radius` never touches another plugin's refs, and pending changesets for the others stay queued for their own release.

Edge needs nothing from you. The rest of this page is the stable release.

## Before you start

- You do not pick the version or write the changelog. Changesets derives both from the `.changeset/*.md` files that merged since the last release.
- At least one changeset must be pending, or the workflow stops with nothing to release.
- The previous release must have finished. If its run failed partway, re-run that run first - see [If something fails](#if-something-fails).
- Immutable releases are optional. To enforce them later, enable the GitHub setting and set repository variable `REQUIRE_IMMUTABLE_RELEASES=true`.
- The release GitHub App needs Contents and Pull requests write permissions. It writes every release commit and tag ref; GitHub signs the commits, and each tag must resolve to a **Verified** commit. It additionally needs Administration read only when immutable enforcement is enabled.
- You need write access to the repository to start the workflow.
- For a release candidate that includes Azure environment creation, complete [Environment creation readiness](./ENVIRONMENT_CREATION_READINESS.md). A record with `BLOCKED` or `NOT RUN` production gates is not release approval.

Each of these is enforced by the workflow, so a mistake here fails fast rather than shipping something wrong.

## Cut the release

1. **Start it.** GitHub → **Actions** → **Release** → **Run workflow**, from `main`. Leave **plugin** empty to release everything with a pending changeset, or type one plugin name to release only that one.
2. **Wait for the release pull request.** Its title names the selected plugin scope and it uses the `changeset-release/main` branch. Only one scope can have an open release PR; a differently scoped dispatch fails instead of overwriting it.
3. **Review it** like any other pull request. It should contain only the selected version bumps, changelog entries, derived manifests, and deletion of the consumed changesets. Read each changelog the way a user would. To include one more change for the same scope, land it on `main` with its changeset and re-run step 1; the same pull request updates in place. Never push a commit to `changeset-release/main` yourself - the branch is rebuilt from `main` on every version run, so a hand-written commit is both lost and outside the changelog Changesets generates.
4. **Merge it, squashing.** This is the point of no return: merging is what publishes. The release is derived from the merge's first-parent diff, so it must land as one commit; a rebase merge of a release pull request that carries more than one commit publishes nothing and fails the run.
5. **Watch the Release run** that the merge triggers. It rebuilds and re-checks that exact commit before it touches anything public.

Nothing has shipped until step 4, so steps 1 to 3 are safe to repeat.

## Confirm it shipped

The workflow run summary lists every ref it wrote. To check independently:

```bash
gh release view "radius@<version>"
git ls-remote origin "refs/tags/radius@<version>" \
  "refs/heads/releases/radius/v<version>"
```

A stable release publishes exactly one tag, `radius@<version>`, and it points at the artifact commit that `releases/radius/v<version>` holds. Each released plugin gets its own release carrying two static asset names: `<plugin>-plugin.tar.gz` and `<plugin>-plugin.spdx.json`. CI downloads and compares both, then requires the branch, tag, published release, and asset set to verify together before it reports success. Every install branch is also checked to be a zero-parent orphan commit that GitHub signed. Then install or update the plugin from the marketplace and confirm it reports the new version.

Every commit targeted by a release tag should report `verified: true`, attributed to the release GitHub App. The generated tags are lightweight refs, so verification belongs to their target commit. Confirm it from the command line with:

```bash
gh api "repos/{owner}/{repo}/commits/$(git rev-parse "refs/tags/radius@<version>")" \
  --jq .commit.verification
```

## Update the Awesome Copilot listing

After confirming that the stable release shipped, open a pull request in [`github/awesome-copilot`](https://github.com/github/awesome-copilot) to update each released plugin already listed there. Publishing here does not automatically update that marketplace. Use [github/awesome-copilot#3966](https://github.com/github/awesome-copilot/pull/3966), which updated Radius from `0.1.1` to `0.2.0`, as an example.

1. **Resolve the published artifact commit.** Use the commit targeted by the release tag, not the source or release-PR merge commit. For Radius, run `git ls-remote origin "refs/tags/radius@<version>" "refs/tags/radius@<version>^{}"` from this repository; use the peeled `^{}` commit if the tag is annotated, otherwise the tag ref's SHA.
2. **Update the existing entry in `plugins/external.json` in `github/awesome-copilot`.** Set `version` to `<version>`, `source.ref` to `radius@<version>`, and `source.sha` to the full 40-character artifact commit SHA. Keep `source.repo` as `radius-project/ai-extensions` and `source.path` as `plugins/radius`. Substitute the released plugin's name if updating another listing.
3. **Regenerate and check the marketplace output.** Follow that repository's current [contributing guidance](https://github.com/github/awesome-copilot/blob/main/CONTRIBUTING.md#updating-listed-external-plugins-via-pr) and run `npm start` in its checkout. Confirm that the matching entry in `.github/plugin/marketplace.json` has the same version, ref, and SHA, and include both files in the pull request.
4. **Open the version-update pull request against `github/awesome-copilot`'s `main`.** Use a title such as `chore(plugin): update radius plugin to <version>`, link the published GitHub release in the description, and complete the upstream pull request checklist. Follow through on the external-plugin quality checks and review until the update merges.

This updates an existing approved listing; adding a new external plugin follows Awesome Copilot's separate intake process. Do not point the stable listing at `main`, `radius@edge`, or an unpublished version.

## If something fails

Re-run **the same failed run**. Do not push a new commit to force it, and do not create the tags or branches by hand — a human-made ref would be unsigned, and the workflow refuses to reuse an install branch GitHub has not verified. The publish is written to be resumable: it redoes only what did not finish, refuses to overwrite anything already published, and never moves the stable channel back to an older release. A fresh run cannot stand in for the original, because the signed build provenance is tied to the run that produced the artifact.

For a mutable published release, a rerun reconciles assets with `--clobber` before checking them. For any actually immutable release, the workflow reuses its native SBOM and verifies protected assets without modifying them. If that verification fails, fix the problem on `main` and cut the next version.

If the run fails at **Detect a stable release** with `versions no plugin`, the merge did not carry the whole release pull request, so nothing was published and `main` now carries a version that has no release. The event cannot be replayed, so recover by reverting that merge on `main` - which restores the consumed changesets and the previous version - and then repeating [Cut the release](#cut-the-release) from step 1, squashing the merge this time.

If a release turns out to be broken, fix it on `main` and cut the next version. Do not rewrite versioned branches or their release tags even while GitHub releases are operating in mutable mode.
