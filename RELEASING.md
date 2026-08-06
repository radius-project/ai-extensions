# Releasing

This is a [pnpm](https://pnpm.io/) workspace monorepo whose packages are
versioned and changelogged with [Changesets](https://github.com/changesets/changesets).

## Packages & naming convention

| Package directory          | npm name                 | Notes                                   |
|----------------------------|--------------------------|-----------------------------------------|
| `packages/core/`           | `@radius-project/core`   | UI-agnostic product core.               |
| `packages/adapter-canvas/` | `@radius-project/canvas` | Copilot canvas adapter (builds bundle). |

- All packages live under the **`@radius-project`** org scope to match the
  GitHub organization.
- Internal dependencies use the pnpm **`workspace:*`** protocol; Changesets
  rewrites these to real version ranges at publish time.
- Packages are currently `private`, so Changesets versions and changelogs them
  but does not publish to a registry.

## Version & tag convention

Versions are [semver](https://semver.org/). Each package is versioned
independently (no `fixed`/`linked` groups).

Git tags follow the Changesets monorepo convention, one tag per released
package:

```
@radius-project/<package>@<version>
# e.g. @radius-project/core@0.2.0
#      @radius-project/canvas@0.2.0
```

## Local release flow

1. **Add a changeset with your change** (also done as part of normal PRs):

   ```bash
   pnpm changeset
   ```

   Select the affected packages, the bump level (`patch` / `minor` / `major`),
   and write a user-facing summary. Commit the generated `.changeset/*.md` file.

2. **Apply pending changesets** to bump versions and write changelogs:

   ```bash
   pnpm version          # runs `changeset version`
   ```

   This updates each package's `version`, rewrites internal `workspace:*`
   dependents, and writes/updates a `CHANGELOG.md` per package. Review and
   commit the result.

3. **Build the release artifact** and tag:

   ```bash
   pnpm release          # runs the workspace build
git tag "@radius-project/core@$(node -p 'require("./packages/core/package.json").version')"
git tag "@radius-project/canvas@$(node -p 'require("./packages/adapter-canvas/package.json").version')"
   git push --follow-tags
   ```

   (When CI is added later, `changeset version` + tagging + `changeset publish`
   can be automated with the [Changesets GitHub Action](https://github.com/changesets/action).)

## Why Changesets (vs. changie / git-cliff)

| Tool           | Model                                                                                                                                                           | Fit for this repo                                                                                                                                                                        |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Changesets** | Developer-authored change fragments; JS/pnpm-native. Bumps per-package versions, rewrites `workspace:*` ranges, writes per-package changelogs, and can publish. | **Chosen.** Purpose-built for pnpm/TS monorepos with independently versioned packages.                                                                                                   |
| changie        | Developer-authored fragments (YAML/TOML), language-agnostic.                                                                                                    | Similar dev-managed model, but not workspace-aware — it won't bump versions or rewrite internal dependency ranges, so we'd hand-roll that.                                               |
| git-cliff      | Automated changelog from [Conventional Commits](https://www.conventionalcommits.org/); no per-change files.                                                     | Great for single packages, but it generates changelog text only — it does not decide per-package version bumps or update workspace deps, and quality depends entirely on commit hygiene. |

Changesets gives us the same **developer-curated** changelog quality as changie
while also handling the **monorepo versioning mechanics** (per-package bumps +
`workspace:*` propagation) that changie and git-cliff leave to us. If we later
prefer commit-driven automation, git-cliff can be layered on without removing
Changesets' version management.
