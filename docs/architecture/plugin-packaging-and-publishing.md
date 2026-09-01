# Plugin packaging and publishing

How the `radius` Copilot plugin is laid out, how its canvas bundle is built from the workspace source, and how CI assembles a complete, installable artifact into `plugins/radius/dist/` and publishes it to generated `releases/*` branches without committing build output to `main`.

```mermaid
graph TD
    subgraph Workspace["pnpm workspace (source, tracked)"]
        Core["packages/core<br/>@radius-project/core (src/*.ts)"]
        Shared["packages/adapter-shared<br/>@radius-project/adapter-shared"]
        Canvas["packages/adapter-canvas<br/>@radius-project/adapter-canvas (src/*.ts)"]
        Build["packages/adapter-canvas/build.mjs<br/>(esbuild + assemble)"]
    end

    subgraph PluginSrc["plugins/radius (source, tracked)"]
        Manifest["plugin.json<br/>(Agent Plugins 1.0.0 manifest)"]
        Pkg["package.json<br/>(type: module, main: extension.mjs)"]
        Skills["skills/<br/>(5 SKILL.md trees)"]
    end

    subgraph Dist["plugins/radius/dist (generated, git-ignored)"]
        DistAll["plugin.json + package.json<br/>README.md + skills/"]
        Bundle["extension.mjs (+ .map)"]
    end

    Core -->|workspace:* import| Canvas
    Shared -->|workspace:* import| Canvas
    Canvas -->|entry point| Build
    Build -->|emits bundle| Bundle
    Manifest --> DistAll
    Pkg --> DistAll
    Skills --> DistAll
```

## Key components

- **`packages/core` (`@radius-project/core`)** — UI-agnostic product logic behind ports. `private`, `main: src/index.ts` (consumed as TypeScript source, not a published package).
- **`packages/adapter-shared` (`@radius-project/adapter-shared`)** — shared adapter utilities (for example, `rad` CLI invocation). Depends on core via `workspace:*`.
- **`packages/adapter-canvas` (`@radius-project/adapter-canvas`)** — the canvas adapter whose entry `src/extension.ts` calls `joinSession` / `createCanvas({ id: "radius" })`. Depends on core and shared via `workspace:*`.
- **`packages/adapter-canvas/build.mjs`** — the esbuild step that bundles the adapter plus its `workspace:*` dependencies into one file, then assembles `plugins/radius/dist/`.
- **`plugins/radius/`** — the tracked plugin source: `plugin.json`, `package.json`, `README.md`, and `skills/`.
- **`plugins/radius/dist/`** — the generated, installable plugin: the tracked source above, the built `extension.mjs`, and a complete `workflows/` copy of `.github/extension/`. Git-ignored on `main`.
- **`.github/plugin/marketplace.json`** — the marketplace manifest whose plugin `source` points installs at `plugins/radius/dist` on `radius@edge`.
- **`.changeset/config.json`** — Changesets owns released versions. `privatePackages.version` includes private plugins; `privatePackages.tag` is disabled because the workflow creates one scoped source tag instead of running Changesets' all-package tag scan.
- **`scripts/plugins.mjs`** — the plugin registry: discovers every directory under `plugins/` that has a `package.json` and a `plugin.json`, and builds every published ref name from it. The single source of the `releases/<plugin>/<channel>` and `<plugin>@<channel>` convention; `--json` feeds the workflow matrices and `--env` hands the names to a job.
- **`scripts/version.mjs`** — derives every other version string from `plugins/<name>/package.json`, the version Changesets owns; `--check` fails CI on drift across all plugins, `--set --channel edge` retargets and restamps one plugin's generated edge catalog entry, `--compare` ranks two versions by semver precedence, and `--release-notes` reads that plugin's current Changesets changelog entry.
- **`scripts/release-version.mjs`** — invokes Changesets with an argv array for one selected plugin (ignoring the others), then synchronizes all derived manifests. Both stable and snapshot versioning use this boundary.
- **`scripts/release-plan.mjs`** — classifies a merged release PR from git facts: a plugin is released only when its package version changed from the first parent and the matching changelog heading was added in the same diff.
- **`scripts/validate-plugin-dist.mjs`** — validates the generic artifact contract before attestation or push: matching names and versions, the exact source commit, complete workflow assets, README, license, manifest-declared paths, path confinement, and no symlinks.
- **`scripts/awesome-copilot.mjs`** — builds the four files a maintainer opens as a manual pull request against [`github/awesome-copilot`](https://github.com/github/awesome-copilot), with `source.ref` and `source.sha` both set to the full 40-character artifact-branch commit SHA. The SBOM has no equivalent script: [`pnpm sbom`](https://pnpm.io/cli/sbom) emits it directly.
- **`.github/workflows/build.yml`** — the reusable build: shared checks run once and upload a gate artifact; requested plugins resolve their checked-out full source SHA, bake it into generated workflow fetch/action references and package metadata, then upload disjoint `plugin-dist-<plugin>` artifacts. Publishers require the gate plus their own artifact.
- **`.github/workflows/changesets.yml`** — non-blocking pull request feedback from the Changesets Action v2 `pr-status` and `pr-comment` sub-actions. The read-only status job inspects pull request files; a separate job owns the pull request write token and only publishes the generated comment.
- **`.github/workflows/publish.yml`** — the rolling **edge** channel: on every push to `main`, publishes each plugin's `dist/` to its own `releases/<plugin>/edge` branch and `<plugin>@edge` tag.
- **`.github/workflows/release.yml`** — the **stable** channel: a manual dispatch (optionally naming one plugin) runs `changesets/action` to open a scope-labelled release PR; merging it resolves the exact release plan from the version diff, validates each plugin, creates only its annotated `<plugin>@<version>` source tag, publishes zero-history install branches and release assets, verifies their downloaded bytes, then moves that plugin's rolling stable refs. Immutable-release enforcement is opt-in.

## How it works

### 1. The plugin layout: tracked source vs. generated dist

The repository is a [pnpm](https://pnpm.io/) workspace monorepo (`pnpm-workspace.yaml` lists `packages/*` and `plugins/*`). All workspace packages are `private`; the canvas adapter pulls in the core and shared packages through the `workspace:*` protocol rather than from a registry.

The plugin **source** lives at `plugins/radius/`; the **installable** plugin is assembled into `plugins/radius/dist/`, which is git-ignored:

| Path                                | Origin          | Tracked? | Purpose                                                    |
|-------------------------------------|-----------------|----------|------------------------------------------------------------|
| `plugins/radius/plugin.json`        | source          | yes      | [Agent Plugins 1.0.0](https://agent-plugins.org) manifest. |
| `plugins/radius/package.json`       | source          | yes      | Extension package: `type: module`, `main: extension.mjs`.  |
| `plugins/radius/skills/`            | source          | yes      | The five skill trees (`SKILL.md` plus `references/`).      |
| `plugins/radius/README.md`          | source          | yes      | Plugin documentation.                                      |
| `plugins/radius/dist/`              | built           | no       | The complete installable plugin; git-ignored.              |
| `plugins/radius/dist/extension.mjs` | built (esbuild) | no       | The canvas bundle, plus its `.map`.                        |
| `plugins/radius/dist/workflows/`    | copied          | no       | Complete `.github/extension/` templates, actions, scripts. |

The manifest targets the [Agent Plugins](https://agent-plugins.org) 1.0.0 schema, which is **closed**: the only permitted fields are `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`. Components load from fixed locations rather than manifest paths, so skills are discovered from `skills/` without being declared, and `extensions` — if present at all — is an object keyed by a reverse-domain client namespace, never a path. The canvas `extension.mjs` and its `package.json` sit at the **plugin root**, which for an install is `dist/`; the build copies the tracked source into `dist/` so those relative paths resolve.

### 2. The build: bundling the workspace, then assembling `dist/`

`pnpm run build` delegates to `packages/adapter-canvas/build.mjs`, which invokes esbuild with:

- **entry** `packages/adapter-canvas/src/extension.ts`,
- **outfile** `plugins/radius/dist/extension.mjs`,
- **format** `esm`, **target** derived from `.node-version`,
- **minify** with `keepNames` and an external source map, and
- **external** `@github/copilot-sdk` (and `/extension`) — the loader resolves the SDK at runtime, so it is never bundled.

esbuild transpiles the TypeScript core and inlines the `workspace:*` dependencies, producing a single self-contained `extension.mjs` (~700 KB minified). This file is the reason a build step is unavoidable: the plugin cannot ship hand-authored source because the canvas imports the **TypeScript** core via `workspace:*`, which must be transpiled and inlined first.

The script then uses esbuild's `copy` loader to place `plugin.json`, `package.json`, `README.md`, and `skills/` next to the bundle, adds the repository `LICENSE`, and copies the complete `.github/extension/` tree to `dist/workflows/`. It writes the full checked-out source SHA to `package.json#radiusSourceRef` and compiles that same value into the workflow generator: remote template fetches and every first-party composite-action `uses:` resolve the commit that produced the plugin, never `main`, `edge`, or `latest`. Both the Node bundle and nested browser/resolver builds emit esbuild metafiles; their complete input union drives `THIRD-PARTY-NOTICES.txt`, including packages such as `yaml` that do not appear in the browser-only graph. The generic dist validator checks names, versions, the Agent Plugins manifest schema, source SHA, workflow assets, the fixed `skills/` location, README, license, confinement, and symlinks before upload or publication.

The whole of `dist/` is git-ignored so `main` never carries large generated files that would cause constant merge conflicts.

### 3. The publish: shipping `dist/` on `releases/*`

Because `dist/` is git-ignored and the marketplace installs only git-tracked files with no build step, it would never ship from `main`. Two workflows close that gap, and both delegate the build to `build.yml` so the artifact they publish came from one run of one set of checks.

| Channel    | Workflow      | Trigger                                    | Version                     | Refs written                                                                                                                                               |
|------------|---------------|--------------------------------------------|-----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **edge**   | `publish.yml` | every push to `main`                       | `0.1.0-edge-<short-sha>`    | `releases/<plugin>/edge` + `<plugin>@edge`, force-replaced after rejecting stale reruns.                                                                   |
| **stable** | `release.yml` | manual dispatch, then the release PR merge | whatever Changesets decided | `<plugin>@<version>` source tag; versioned `releases/<plugin>/v<version>` + `<plugin>/v<version>`; rolling `releases/<plugin>/latest` + `<plugin>@latest`. |

Every published ref is namespaced by plugin name — `releases/<plugin>/<channel>` for branches, `<plugin>@<channel>` for tags — matching the `<plugin>@<version>` tag Changesets already creates. Both workflows fan out over `scripts/plugins.mjs --json`, so a new plugin directory joins the matrix without editing a workflow, and each plugin's refs, GitHub release and dispatch are independent of every other plugin's.

The stable channel follows [Changesets v3](https://changesets.dev/guide/versioning-and-publishing), but it does not run `changeset git-tag`: that command scans every eligible package and is unsafe inside an independent plugin matrix. A maintainer dispatches `release.yml`; `scripts/release-version.mjs` scopes `changeset version`, and the v3-compatible Changesets Action v2 opens the PR through the repository automation GitHub App. A second scope cannot overwrite an open release PR. On merge, `scripts/release-plan.mjs` admits only package versions and changelog headings newly added by that merge. Each publish leg then reproduces Changesets' `<package>@<version>` tag name for that plugin only.

Edge runs are automatic and push-only. `publish.yml` passes the triggering `main` SHA and all discovered plugins to one `build.yml` call. Each build leg adds an ephemeral patch changeset for its plugin and runs the same scoped version wrapper with `--snapshot edge`, so another plugin's pending changesets cannot affect it. `snapshot.prereleaseTemplate` suffixes the calculated version with the seven-character source SHA. Neither synthetic changesets nor snapshot rewrites are committed.

Neither workflow pushes to `main`: its ruleset grants GitHub Actions no bypass. The version bump reaches `main` the same way every other change does — as a reviewed pull request.

```mermaid
graph TD
    Main["main branch<br/>(source, no dist)"]

    subgraph PrepWF["release.yml — prepare (manual dispatch)"]
        VersionPR["changeset version<br/>changelog + versions<br/>open the release pull request"]
    end

    subgraph DetectWF["release.yml — detect (release PR merged)"]
        Decide{"same-repo Bot PR?<br/>expected branch?"}
        Source["resolve exact merge SHA"]
    end

    Main --> VersionPR
    VersionPR -->|a maintainer merges it| Decide
    Decide -->|no| Nothing["do nothing"]
    Decide -->|yes| Source

    subgraph BuildWF["build.yml (reusable)"]
        Checks["shared checks once<br/>upload build-gate"]
        Resolve["plugin matrix<br/>scoped stable or edge version"]
        Artifact["resolve full source SHA<br/>bundle .github/extension<br/>validate dist/ + native pnpm SBOM<br/>upload plugin-dist-plugin + plugin-sbom-plugin"]
    end

    Main -->|edge push SHA| Checks
    Source -->|stable source SHA| Checks
    Checks --> Resolve --> Artifact

    subgraph EdgeWF["publish.yml"]
        EdgePush["attest provenance + SBOM<br/>reject stale source<br/>signed orphan commit<br/>move edge refs"]
    end

    subgraph RelWF["release.yml — artifact"]
        RelPush["deterministic package<br/>attest provenance + SBOM<br/>selected plugin@version tag<br/>push zero-history tree<br/>draft release + assets, then publish<br/>download and compare bytes<br/>move latest; completion tag last"]
    end

    Artifact --> EdgePush
    Artifact --> RelPush

    EdgePush --> Edge["releases/plugin/edge + plugin@edge<br/>(rolling prerelease)"]
    RelPush --> Stable["releases/plugin/latest + plugin@latest<br/>(rolling stable)"]
    RelPush --> Pinned["releases/plugin/v&lt;version&gt;<br/>+ plugin/v&lt;version&gt; artifact tag<br/>(versioned orphan)"]
    RelPush --> SourceTag["plugin@&lt;version&gt;<br/>(source tag)"]

    Edge -->|source pins path + ref| MP[".github/plugin/marketplace.json"]
    MP -->|install from the app| Install["GitHub Copilot app<br/>installs complete plugin"]
```

Each published branch is an **orphan**: it shares no history with `main` and contains only `plugins/<plugin>/dist/`, `.github/extension/`, and the marketplace catalog. The root extension tree preserves the canonical repository layout on the self-contained artifact branch; `dist/workflows/` is its byte-identical plugin copy. Generated cross-repository `uses:` paths resolve that canonical path from the immutable source commit recorded by the plugin, not from the orphan commit. [`scripts/verified-git.mjs`](../../scripts/verified-git.mjs) uploads exactly those paths and asks the Commits API for a commit with no parents, so unrelated repository source cannot reach the published tree and there is no history to inherit. Reuse verification requires the two extension trees to have the same file paths and Git blob SHAs, requires `package.json#radiusSourceRef` to equal the source recorded by the commit message, and rejects a parented or unsigned commit. Read-only inspection accepts the fully legacy layout only so the first upgraded stable release can compare and replace an older `latest` branch; a partially migrated layout fails closed.

Nothing is committed or tagged on the runner. A runner holds no signing key, so every commit and ref this pipeline publishes goes through the GitHub API as the repository automation App. GitHub signs the commits, while the Git tag-object API leaves an App-created annotated tag unsigned. The pipeline therefore writes lightweight tag refs only after GitHub verifies their target commit, and verifies that target again before reusing a tag. Existing signed annotated tags are accepted only when both the tag object and its target commit are verified. Reusing an install branch also re-checks its commit, so a branch left by older automation cannot keep publishing an unsigned commit. The cost is that a branch and its channel tag no longer move in one atomic push: the branch every install reads lands first, and a rerun reconciles a failure in between.

The trade-off is deliberate: a clone of a published branch contains the plugin artifact, its workflow/action assets, and its catalog, but no monorepo source, node_modules, or history. The exact source SHA lives in both the commit message and built package metadata. Because rolling refs are replaced wholesale each run, superseded bundles become unreferenced objects rather than permanent repository growth.

A release publishes the pinned branch and `releases/<plugin>/latest` from the same `dist/` and `.github/extension/`; they differ only in the catalog's selected `source.ref`. The deterministic tarball contains the complete bundled copy under the plugin's `workflows/` directory. Checks, deterministic tar/zip packaging, native pnpm SBOM generation, validation, and attestation finish before the first push. A retry reconstructs the expected orphan tree and reuses an existing versioned branch only when its tree ID, source pin, extension copies, and zero-parent invariant match. It reconciles the source tag and GitHub release, verifies downloaded asset bytes, then moves rolling refs. The `<plugin>/v<version>` artifact tag is pushed last as the completion marker.

GitHub immutable releases are optional. By default, the release remains mutable and a retry reconciles assets with `gh release upload --clobber`. Setting repository variable `REQUIRE_IMMUTABLE_RELEASES=true` activates two fail-closed checks (before PR creation and before publication), requires Administration read on the GitHub App, and requires the published release response to report `immutable: true`. Both modes use draft-first publication; an immutable retry reuses the published native SBOM rather than regenerating pnpm's run-specific document.

The SBOM is native [`pnpm sbom`](https://pnpm.io/cli/sbom) output filtered to the selected plugin. The plugin declares its build adapter as a workspace `devDependency`, so inlined browser packages are present while pnpm retains ownership of document identity, package IDs, timestamps, licenses, and checksums.

`build.yml` generates it beside the bundle and uploads it as its own artifact, so both channels inventory the same build. Placement is load-bearing rather than incidental: pnpm records the workspace's current version as the SBOM's root package, and for edge that version exists only in the build workspace, stamped there by the snapshot step. Generating the document in a publishing job would inventory the unstamped version and describe something other than the artifact it accompanies. It stays out of the dist artifact because that tree is published verbatim as the install branch, and the SBOM describes the release rather than forming part of what gets installed. Stable uploads it as a release asset; edge has no release to attach it to, so it is recorded as an SBOM attestation over the published files and retrieved with `gh attestation verify`.

### 3a. The awesome-copilot listing asset

[`github/awesome-copilot`](https://github.com/github/awesome-copilot) lists plugins hosted elsewhere in `plugins/external.json` and in the marketplace catalog it serves, both carrying the same entry object. `scripts/awesome-copilot.mjs` derives that entry from this repository's catalog and the selected released manifest, and ships `<plugin>-awesome-copilot.zip` holding exactly four files:

| Path in the zip                   | Content                                  |
|-----------------------------------|------------------------------------------|
| `.github/plugin/marketplace.json` | `{ "plugins": [ <entry> ] }`             |
| `plugins/external.json`           | `[ <entry> ]`                            |
| `plugins/<plugin>/plugin.json`    | The released manifest, for the reviewer. |
| `plugins/<plugin>/README.md`      | The released README, for the reviewer.   |

The entry's `source.ref` **and** `source.sha` are both the full 40-character SHA of the `releases/<plugin>/v<version>` artifact commit. A tag or branch could be repointed after review; their validator accepts a full SHA and rejects an abbreviated one. The release process assumes the repository is public when the listing is submitted.

### 4. The install: resolving the complete artifact

`.github/plugin/marketplace.json` pins the plugin `source` to the object form:

```json
"source": {
  "source": "github",
  "repo": "radius-project/ai-extensions",
  "path": "plugins/radius/dist",
    "ref": "radius@edge"
}
```

The catalog exposes one plugin identity, `radius`. Its `source.ref` on `main` selects the default channel: it pins the rolling `radius@edge` tag during the preview period and changes to `radius@latest` when stable becomes the default. The edge publisher rewrites its generated catalog copy back to `radius@edge`, while the stable publisher points each generated catalog at its own release branch, so changing the default does not remove either explicit install target. In every case `path` points at the assembled `dist/` rather than the source directory. Because the Radius canvas can only be hosted by the GitHub Copilot app, the plugin is installed from the app: open app settings, click **Plugins**, add the `radius-project/ai-extensions` marketplace, and install `radius`.

To pin a specific release instead of tracking edge, add the marketplace at that release's branch — `marketplace add radius-project/ai-extensions#releases/radius/v<version>` for one exact version, or `#releases/radius/latest` to track stable — whose catalog points `source.ref` at itself.

The installer copies the git-tracked files at `plugins/radius/dist` from the published ref into the app's installed-plugins directory (for example, `~/.copilot/installed-plugins/radius-plugins/radius/`). Because the bundle is committed there, the installed plugin contains everything: `plugin.json`, `package.json`, `extension.mjs`, and `skills/`.

## Notable details

- **Skills and canvas stay in lockstep.** Both come from the same `main` commit tree that the build job checked out, so a PR that updates a skill and a PR that updates canvas code both land on the published branch together. There is no way for the shipped skills to lag the shipped bundle.
- **Published branches are generated — never hand-edit them.** Rolling `releases/<plugin>/{edge,latest}` branches are force-recreated; `releases/<plugin>/v<version>` is created once. `main` remains the single source of truth.
- **Plugin versions are derived everywhere.** Changesets writes each plugin package version; `scripts/version.mjs` derives its manifest and catalog entry. The shared marketplace `metadata.version` is independently managed and is never rewritten by one plugin's release.
- **Release branches are orphaned and retryable.** Every edge/latest/versioned branch points to a GitHub-signed zero-parent commit. Versioned branches and completion tags are never force-pushed; mutable releases reconcile assets, while enforced immutable releases compare protected assets.
- **Every published bundle is attested and inventoried.** [`actions/attest`](https://github.com/actions/attest) records provenance for every edge-tree file. Stable provenance names the deterministic tarball as its subject, and a standard SBOM attestation binds that subject to native pnpm SPDX output. Attestation runs before the first push.
- **The publish gates on the same checks as CI.** `version:check`, `typecheck`, `lint`, `format:check` and `test` all run in `build.yml` before the bundle is assembled, so a broken build never publishes; on failure, the published refs keep pointing at the last good artifact.
- **Ordering is explicit.** Edge queues whole runs with `queue: max` and builds each triggering push SHA, then rejects a manually rerun stale SHA before moving the branch and tag. Stable queues manual dispatches and release-PR merge events, builds the exact merge SHA, completes the canonical release and asset before moving the rolling stable refs, and pushes the artifact completion tag last. Edge ordering therefore comes from queue order and git ancestry, never from version precedence: two edge builds sharing a base version differ only by a commit SHA, which sorts lexically rather than chronologically. Nothing consumes that precedence — installs resolve the moving `edge` ref, and the sole `--compare` caller skips prereleases — so it is deliberately not part of the edge contract.
- **Changeset feedback is non-blocking and privilege-separated.** The status job reads pull request files without executing repository code or receiving write access. The comment job has no checkout and receives only the generated comment body plus `pull-requests: write`; release pull requests are exempt because their changesets have already been consumed. The `pr/no-changeset` label skips the status job and rewrites the comment as a waiver, and `labeled`/`unlabeled` are workflow triggers so applying it takes effect without another push.
- **Release pull requests run CI.** The Changesets version action uses a short-lived token from the repository automation GitHub App rather than `GITHUB_TOKEN`, so its pull request triggers the normal `pull_request` build.
- **`build.yml` also uploads the bundle as a read-only CI artifact** for per-PR inspection; only `publish.yml` and `release.yml` write to the published refs.
- **Canvas activation is a separate concern.** This pipeline guarantees a complete, installable plugin. Whether the installed plugin's `extensions` are auto-discovered and the canvas registered is a GitHub App behavior, tracked outside this packaging/publishing flow. See [`docs/design/2026-07-canvas-bundle-publishing.md`](../design/2026-07-canvas-bundle-publishing.md) for the design and scope.
