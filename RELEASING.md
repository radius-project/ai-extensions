# Releasing

The `radius` plugin is released **manually**, on demand, with a chosen [semver](https://semver.org/) bump level. Every release produces an **immutable** `v<MAJOR>.<MINOR>.<PATCH>` tag and a **provenance-attested** canvas bundle.

## What a release contains

| Ref / artifact   | Mutable? | Purpose                                                                      |
| ---------------- | -------- | ---------------------------------------------------------------------------- |
| `main`           | yes      | Source of truth. Gains one `chore(release): v<version>` version-bump commit. |
| `release` branch | yes      | Install target: the `main` tree **plus** the built `extension.mjs`.          |
| `v<version>` tag | **no**   | Immutable annotated tag on the release commit. Never force-moved.            |
| GitHub release   | no       | Generated notes plus `extension.mjs` as an attested asset.                   |

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

`release:check` runs in CI on every pull request, so the manifests cannot drift. Do not edit these versions by hand — the release workflow bumps them.

## Cutting a release

1. Make sure `main` is green and contains everything you want to ship.
2. Run the **Release** workflow: **Actions → Release → Run workflow**.
3. Choose the bump level — `patch` (default), `minor`, or `major`.
4. Optionally tick **dry_run** to build, verify and print the next version without pushing anything.

The workflow ([`.github/workflows/release.yml`](./.github/workflows/release.yml)) then:

1. installs, typechecks and runs unit tests;
2. resolves the next version and **fails if that tag already exists** — released versions are immutable;
3. bumps the version in all three manifests;
4. builds `plugins/radius/extension.mjs`;
5. attests the bundle's build provenance with [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance);
6. pushes the version-bump commit to `main`, force-updates `release` to that tree plus one commit adding the bundle, pushes the `v<version>` tag, and creates the GitHub release.

Everything that can fail (typecheck, test, build, attest) runs **before** the first push, so a failed run leaves `main`, `release` and the tags untouched.

### Requirements

- The workflow pushes to `main`, so branch protection must allow `github-actions[bot]` (otherwise a maintainer has to land the bump commit by hand).
- Protect the `v*` tag pattern in repository settings so tags cannot be deleted or force-moved outside the workflow.

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
