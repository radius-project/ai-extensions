# Releasing

The `radius` plugin is released **manually**, on demand, with a chosen [semver](https://semver.org/) bump level. Every release produces an **immutable** `v<MAJOR>.<MINOR>.<PATCH>` tag and a **provenance-attested** canvas bundle.

## What a release contains

| Ref / artifact   | Mutable? | Purpose                                                                       |
| ---------------- | -------- | ----------------------------------------------------------------------------- |
| `main`           | yes      | Source of truth. Gains one squash-merged `chore(release): v<version>` commit. |
| `release` branch | yes      | Install target: the `main` tree **plus** the built `extension.mjs`.           |
| `v<version>` tag | **no**   | Immutable annotated tag on the release commit. Never force-moved.             |
| GitHub release   | no       | Generated notes plus `extension.mjs` as an attested asset.                    |

`release` is the only moving pointer, because the plugin `source` in `.github/plugin/marketplace.json` pins `ref: release`. Version tags let anyone pin or audit an exact published artifact.

## Version source of truth

One version is shared by three tracked manifests, kept in lockstep by [`scripts/version.mjs`](./scripts/version.mjs):

- `plugins/radius/plugin.json` — the plugin manifest Copilot reads
- `plugins/radius/package.json` — the canvas extension package
- `.github/plugin/marketplace.json` — `metadata.version` and the plugin entry

```bash
pnpm run release:version          # print the current version
pnpm run release:check            # fail if the manifests disagree
```

`release:check` runs in CI on every pull request, so the manifests cannot drift. It is also how a push to `main` decides whether there is a new version to publish. Do not edit these versions by hand — the release workflow bumps them.

## Cutting a release

A release runs in two phases, because the `main` ruleset requires a reviewed pull request, a verified signature, a DCO check and linear history, and grants GitHub Actions no bypass. CI therefore never pushes to `main`; it proposes the version bump and publishes once a human merges it.

### Phase 1 — prepare (manual)

1. Make sure `main` is green and contains everything you want to ship.
2. Run the **Release** workflow: **Actions → Release → Run workflow**.
3. Choose the bump level — `patch` (default), `minor`, or `major`.

The `prepare` job resolves the next version, **fails if that tag already exists** (released versions are immutable), bumps all three manifests on a `release/v<version>` branch, and opens a pull request. Re-running for the same version updates that branch and pull request instead of creating a second one.

### Phase 2 — publish (on merge)

Review and **squash-merge** the pull request. GitHub creates and signs the squash commit, which satisfies the ruleset's signature requirement.

The push to `main` then runs the `check` job, which compares the manifest version against the existing tags. If the version is already released it stops there, so ordinary merges cost one short job. Otherwise the `publish` job:

1. installs, typechecks and runs unit tests;
2. builds `plugins/radius/extension.mjs`;
3. attests the bundle's build provenance with [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance);
4. force-updates `release` to the merged `main` tree plus one commit adding the bundle, pushes the immutable `v<version>` tag, and creates the GitHub release.

The bundle is built from the pushed commit itself — the same ref and SHA the attestation records — so provenance always describes the revision that was actually built. Everything that can fail runs **before** the first push, so a failed run leaves `release` and the tags untouched.

### Notes

- The version bump pull request is opened with `GITHUB_TOKEN`, so it does **not** trigger `build.yml`. The `publish` job re-runs typecheck, tests and the build before anything is published.
- The bump commit is created with `git commit -s` so the DCO check passes.
- `release` and the `v*` tags carry no ruleset, which is what lets CI write to them. Consider adding a tag ruleset that blocks deletion and updates of `v*`, so tags stay immutable even outside this workflow.

## Verifying a released bundle

Every published `extension.mjs` carries a signed provenance attestation tying it to the workflow, repository and commit that built it:

```bash
gh release download v0.1.1 --pattern extension.mjs
gh attestation verify extension.mjs --repo radius-project/ai-extensions
```

## Changesets: per-package changelogs

This is a [pnpm](https://pnpm.io/) workspace monorepo whose internal packages are versioned and changelogged with [Changesets](https://github.com/changesets/changesets). That is **separate** from the plugin release version above: Changesets documents changes per package, while the plugin version is what users install.

### Packages & naming convention

| Package directory  | npm name                 | Notes                                  |
| ------------------ | ------------------------ | -------------------------------------- |
| `radius-core/`     | `@radius-project/core`   | UI-agnostic product core.              |
| `adapters/shared/` | `@radius-project/shared` | Shared adapter utilities.              |
| `adapters/canvas/` | `@radius-project/canvas` | Copilot canvas adapter (builds bundle).|

- All packages live under the **`@radius-project`** org scope to match the GitHub organization.
- Internal dependencies use the pnpm **`workspace:*`** protocol; Changesets rewrites these to real version ranges at publish time.
- Packages are `private`, so Changesets versions and changelogs them but does not publish to a registry.

### Changeset flow

1. **Add a changeset with your change** (also done as part of normal PRs):

   ```bash
   pnpm changeset
   ```

   Select the affected packages, the bump level (`patch` / `minor` / `major`), and write a user-facing summary. Commit the generated `.changeset/*.md` file.

2. **Apply pending changesets** to bump package versions and write changelogs:

   ```bash
   pnpm version          # runs `changeset version`
   ```

   This updates each package's `version`, rewrites internal `workspace:*` dependents, and writes/updates a `CHANGELOG.md` per package. Review and commit the result.

## Why Changesets (vs. changie / git-cliff)

| Tool           | Model                                   | Fit for this repo |
| -------------- | --------------------------------------- | ----------------- |
| **Changesets** | Developer-authored change fragments; JS/pnpm-native. Bumps per-package versions, rewrites `workspace:*` ranges, writes per-package changelogs, and can publish. | **Chosen.** Purpose-built for pnpm/TS monorepos with independently versioned packages. |
| changie        | Developer-authored fragments (YAML/TOML), language-agnostic. | Similar dev-managed model, but not workspace-aware — it won't bump versions or rewrite internal dependency ranges, so we'd hand-roll that. |
| git-cliff      | Automated changelog from [Conventional Commits](https://www.conventionalcommits.org/); no per-change files. | Great for single packages, but it generates changelog text only — it does not decide per-package version bumps or update workspace deps, and quality depends entirely on commit hygiene. |

Changesets gives us the same **developer-curated** changelog quality as changie while also handling the **monorepo versioning mechanics** (per-package bumps + `workspace:*` propagation) that changie and git-cliff leave to us. If we later prefer commit-driven automation, git-cliff can be layered on without removing Changesets' version management.
