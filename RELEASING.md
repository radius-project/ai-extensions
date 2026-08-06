# Releasing

This repo ships exactly one artifact: the **`radius` plugin** under [`plugins/radius/`](./plugins/radius). Everything else — the three `@radius-project/*` packages — is implementation detail that gets bundled into the plugin's `extension.mjs` and is never published to a registry.

Two things follow from that, and they are the two things to understand before releasing:

1. **Only the plugin is versioned.** [Changesets](https://github.com/changesets/changesets) versions and changelogs `plugins/radius` and nothing else. The three `@radius-project/*` packages are build inputs, not artifacts.
2. **Releasing is automatic.** Merging to `main` publishes. There is no manual release command.

## Packages

| Package directory          | npm name                         | Role                                                |
|----------------------------|----------------------------------|-----------------------------------------------------|
| `plugins/radius/`          | `radius`                         | **The shipped artifact.** Manifest, skills, bundle. |
| `packages/core/`           | `@radius-project/core`           | UI-agnostic product core.                           |
| `packages/adapter-shared/` | `@radius-project/adapter-shared` | Shared adapter helpers.                             |
| `packages/adapter-canvas/` | `@radius-project/adapter-canvas` | Copilot canvas adapter; builds the bundle.          |

All four are `private: true` and none is published to a registry. The three `packages/*` entries are listed in `ignore` in [`.changeset/config.json`](./.changeset/config.json), so their `version` fields are inert — nothing consumes them, and internal dependencies use `workspace:*`, which resolves by path rather than by range. No per-package git tags are cut; the only tag this repo moves is `latest` (see below).

## Where the version lives

[`plugins/radius/package.json`](./plugins/radius/package.json) is the **single source of truth**. Every other version string is derived from it:

| File                              | How it gets its version                                             |
|-----------------------------------|---------------------------------------------------------------------|
| `plugins/radius/package.json`     | Bumped by `changeset version`. **Source of truth.**                 |
| `packages/*/package.json`         | Not versioned — ignored by Changesets.                              |

`pnpm run version` runs the sync automatically. CI runs `pnpm run version:check` and fails the build if the derived files drift; `pnpm run version:sync` repairs them.

> The marketplace's `metadata.version` currently tracks the plugin version because there is exactly one plugin. If this marketplace ever lists a second plugin, decouple that field.

## Day-to-day: add a changeset

Include one in any PR that changes behaviour:

```bash
pnpm changeset
```

Changesets offers only `radius`, because that is the only thing this repo ships. Choose `patch` / `minor` / `major` and write a summary aimed at someone who installed the plugin — not at someone reading the source. Commit the generated `.changeset/*.md`.

Describing the change in terms of the internal package that happened to change is the failure mode to avoid: those packages have no changelog, so that detail lands nowhere a user will see it.

## Cutting a release

1. **Apply pending changesets** on a branch:

   ```bash
   pnpm run version
   ```

   This bumps `plugins/radius/package.json`, writes `plugins/radius/CHANGELOG.md`, and syncs `plugin.json` + `marketplace.json`. Review and commit.

2. **Merge to `main`.** That is the release.

## If a package is ever published

Publishing (say) `@radius-project/core` so third parties can build their own adapters would change the model: remove it from `ignore` in `.changeset/config.json`, flip `private` to `false`, and start naming it in changesets alongside `radius`. Nothing here has to be undone first — the `ignore` list is the only thing standing between this setup and full independent per-package versioning.

## What publishing actually does

[`.github/workflows/publish.yml`](./.github/workflows/publish.yml) runs on every push to `main`. It typechecks, tests, and builds the plugin into `plugins/radius/dist/`, then:

- **force-recreates the `releases/edge` branch** at the current `main` commit plus one commit that force-adds the otherwise git-ignored `plugins/radius/dist/`, and
- **force-moves the `edge` tag** to that commit.

`plugins/radius/dist/` is a complete, self-contained plugin: `plugin.json`, `package.json`, `README.md`, all of `skills/`, and the compiled `extension.mjs` (plus its source map). The build assembles it, so nothing is copied separately in CI.

The plugin `source` in [`.github/plugin/marketplace.json`](./.github/plugin/marketplace.json) pins `path: plugins/radius/dist` and `ref: releases/edge`, so every install resolves the skills and a matching canvas from that directory on that branch. This is why the build output can stay git-ignored on `main`.

Both `releases/edge` and `edge` are force-updated on every push to `main` and carry no history. See [docs/design/2026-07-canvas-bundle-publishing.md](./docs/design/2026-07-canvas-bundle-publishing.md) for the full design.

## Why Changesets (vs. changie / git-cliff)

| Tool           | Model                                                                                                                                   | Fit for this repo                                                                                                                                                            |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Changesets** | Developer-authored change fragments; JS/pnpm-native. Bumps versions, rewrites `workspace:*` ranges, writes changelogs, and can publish. | **Chosen.** Native to pnpm workspaces, and its `ignore` list lets one workspace package be the only versioned artifact.                                                      |
| changie        | Developer-authored fragments (YAML/TOML), language-agnostic.                                                                            | Similar dev-managed model, but not workspace-aware — it won't bump versions or rewrite internal dependency ranges, so we'd hand-roll that.                                   |
| git-cliff      | Automated changelog from [Conventional Commits](https://www.conventionalcommits.org/); no per-change files.                             | Great for single packages, but it generates changelog text only — it does not decide version bumps or update workspace deps, and quality depends entirely on commit hygiene. |

Changesets gives us the same **developer-curated** changelog quality as changie while also handling the **workspace versioning mechanics** (lockstep bumps + `workspace:*` propagation) that changie and git-cliff leave to us. If we later prefer commit-driven automation, git-cliff can be layered on without removing Changesets' version management.
