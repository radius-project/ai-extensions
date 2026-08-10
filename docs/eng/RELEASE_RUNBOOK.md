# Release runbook

The short version, for whoever is cutting the release. [`RELEASING.md`](./RELEASING.md) explains how and why any of this works; this page is only what you do.

## The two channels

| Channel    | Moves when                              | Version looks like          | Users install the catalog entry |
|------------|-----------------------------------------|-----------------------------|---------------------------------|
| **edge**   | automatically, on every merge to `main` | `0.2.0-edge-20260810161038` | `radius-edge`                   |
| **latest** | only when you cut a release             | `0.2.0`                     | `radius`                        |

Edge is the rolling preview: it exists so a change can be tried the moment it lands, and it is never the recommendation for real use. `latest` is the supported channel. Both are moving refs, so an installed plugin follows its channel forward. Every release is also frozen at `releases/radius/v<version>` for anyone who needs to pin an exact version.

Edge needs nothing from you. The rest of this page is the stable release.

## Before you start

- You do not pick the version or write the changelog. Changesets derives both from the `.changeset/*.md` files that merged since the last release.
- At least one changeset must be pending, or the workflow stops with nothing to release.
- The previous release must have finished. If its run failed partway, re-run that run first - see [If something fails](#if-something-fails).
- You need write access to the repository to start the workflow.

Each of these is enforced by the workflow, so a mistake here fails fast rather than shipping something wrong.

## Cut the release

1. **Start it.** GitHub → **Actions** → **Release** → **Run workflow**, from `main`.
2. **Wait for the release pull request.** It is titled `chore(release): version packages` on the `changeset-release/main` branch, and its body lists everything that will ship.
3. **Review it** like any other pull request. It should contain only the version bump, the changelog entry, the derived manifests, and deletion of the consumed `.changeset/*.md` files. Read the changelog the way a user would and fix the wording here if it needs it. To include one more change, land it on `main` with its changeset and re-run step 1 - the same pull request updates in place.
4. **Merge it.** This is the point of no return: merging is what publishes.
5. **Watch the Release run** that the merge triggers. It rebuilds and re-checks that exact commit before it touches anything public.

Nothing has shipped until step 4, so steps 1 to 3 are safe to repeat.

## Confirm it shipped

The workflow run summary lists every ref it wrote. To check independently:

```bash
gh release view "radius@<version>"
git ls-remote origin refs/tags/latest "refs/tags/radius/v<version>"
```

Then install or update the `radius` plugin from the marketplace and confirm it reports the new version.

## If something fails

Re-run **the same failed run**. Do not push a new commit to force it, and do not create the tags or branches by hand. The publish is written to be resumable: it redoes only what did not finish, refuses to overwrite anything already published, and never moves the stable channel back to an older release. A fresh run cannot stand in for the original, because the signed build provenance is tied to the run that produced the artifact.

If the release itself turns out to be broken, do not rewrite it - published refs are immutable. Fix it on `main` and cut the next version.
