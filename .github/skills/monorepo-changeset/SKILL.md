---
name: monorepo-changeset
description: 'Decide whether a change to any released plugin or package in this monorepo needs a Changeset, then draft, create, or review its release note and semantic version bump. Use when assessing pull requests, diffs, commits, user-facing changes, changelog entries, release notes, shared-code impact, future plugins, or whether to propose the `pr:no-changeset` label.'
argument-hint: 'The pull request, diff, commit, or change to assess'
user-invocable: true
---

# Monorepo changeset

Assess a change from the perspective of users of every affected release unit. A release unit is a plugin or other workspace package versioned by Changesets. Produce exactly one outcome:

1. Create or propose one or more Changesets for notable user-facing changes.
2. Create no Changeset and propose the `pr:no-changeset` pull request label when no release unit has a change directly relevant to end users.

Do not create an empty or vague Changeset merely to satisfy automation.

## Sources of truth

- Follow the [Changesets workflow](https://changesets.dev/guide/getting-started): a Changeset declares the release unit, semantic version bump, and changelog summary. Changes that do not require a release do not require a Changeset.
- Follow [Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/): write for humans, include only notable changes, and classify them as Added, Changed, Deprecated, Removed, Fixed, or Security.
- Use `scripts/plugins.mjs` as the source of truth for shippable plugins. It discovers plugin directories and verifies that each directory, `package.json`, and `plugin.json` use the same name.
- Use `pnpm-workspace.yaml` and `.changeset/config.json` as the sources of truth for workspace membership and Changesets behavior, including ignored, fixed, linked, and private packages.
- Use `scripts/release-version.mjs` as the source of truth for release scoping. It versions plugins independently by temporarily ignoring every unselected plugin.
- Follow the contributor guidance in `.changeset/README.md` and label behavior in `.github/workflows/changesets.yml`.
- Never maintain a plugin or package-name list in this skill. Discover the current repository state whenever the skill runs.

## Workflow

### 1. Discover the release units

From the repository root, discover the current plugins:

```bash
node scripts/plugins.mjs --json
```

For each returned plugin, read `plugins/<plugin>/package.json` and use its exact `name` as the Changeset frontmatter key. Do not infer the package name from an example, an old Changeset, or the number of plugins currently present.

Read `pnpm-workspace.yaml` and `.changeset/config.json` to identify any independently versioned workspace packages outside `plugins/`. Exclude packages matched by the active `ignore` configuration. If the same change modifies that configuration, evaluate the resulting configuration rather than the previous one.

An ignored internal package may still implement behavior shipped by one or more plugins. In that case, name the affected plugins in separate Changesets, not the ignored implementation package. Trace dependency, build, and packaging paths to determine which plugins consume the behavior.

### 2. Inspect the actual change

Read the pull request, diff, or changed implementation and tests. Trace the changed behavior far enough to determine every release unit whose shipped output or behavior changes. Do not decide from file paths, commit titles, labels, or test names alone.

Identify:

- What users of each release unit could newly do, observe, depend on, or need to change.
- Whether the change affects behavior, compatibility, security, configuration, generated workflows, commands, output, or user experience.
- Whether shared code or assets propagate the outcome to multiple plugins.
- Whether an existing pending Changeset already describes the same outcome for each affected release unit.

If the available evidence cannot establish whether the behavior ships to users, ask one targeted question instead of inventing an impact.

Build an impact set before drafting. For each affected release unit, record its exact package name, user-visible outcome, Keep a Changelog category, and semantic version bump. Direct changes under a plugin directory make that plugin a candidate, but do not prove that the change is user-facing. Changes to shared workspaces or common assets affect only the release units that actually consume them, which may be one, several, or all discovered plugins.

### 3. Decide whether the change is notable

Create or propose a Changeset when the release changes something users can observe or must act on, including:

- New capabilities or supported scenarios.
- Changes to existing behavior, configuration, commands, generated artifacts, workflows, or UI.
- User-visible bug fixes or reliability improvements.
- Deprecations, removals, breaking changes, or changed requirements.
- Security changes that affect user risk or required action.

Do not create a Changeset when no released behavior changes, including:

- Tests, fixtures, formatting, comments, or type-only maintenance.
- Internal refactors that preserve observable behavior.
- CI, repository automation, contributor tooling, or release-process maintenance.
- Internal architecture, design, or planning documentation.
- Generated-file refreshes that contain no independent behavior change.
- Dependency updates with no user-visible security, compatibility, or behavior effect.

Documentation-only work normally needs no release. Make an exception only when the documentation is shipped to users and materially changes how they use or migrate a release unit.

For a mixed pull request, create a Changeset if any part is notable to users and describe only that part. Do not propose `pr:no-changeset` when any release unit needs a Changeset or an existing Changeset already covers the complete impact set.

### 4. Choose a Keep a Changelog category

Choose the category independently from the semantic version bump:

- **Added:** New user-facing functionality.
- **Changed:** A change to existing functionality or supported behavior.
- **Deprecated:** Functionality users should stop relying on before removal.
- **Removed:** Functionality that is no longer available.
- **Fixed:** A correction to faulty user-visible behavior.
- **Security:** A vulnerability fix or security posture change users should know about.

Use one primary category for one coherent outcome. Split unrelated outcomes, release-unit-specific wording, or different categories into separate Changesets.

### 5. Choose the semantic version bump

Choose the bump independently for each release unit and use the highest impact that unit receives from the Changeset:

- `patch` for backward-compatible fixes and small backward-compatible behavior corrections.
- `minor` for backward-compatible features, meaningful enhancements, and deprecations.
- `major` for removals, incompatible behavior, or changes that require users to migrate.

Keep a Changelog categories do not mechanically determine the bump. For example, a Security entry may be `patch`, `minor`, or `major` depending on compatibility. Follow a more specific repository release policy if one applies, and explain any non-obvious bump choice.

Let the fixed and linked groups in `.changeset/config.json` influence the release plan through Changesets rather than copying package names into a file speculatively.

### 6. Preserve independent releases

Create a separate Changeset for each independently releasable plugin, even when one shared change affects several plugins. Tailor each summary and bump to that plugin's user-visible impact.

Do not combine independently releasable plugins in one Changeset. A scoped release temporarily ignores unselected plugins, and Changesets rejects a Changeset that contains both ignored and non-ignored packages. Separate files allow each plugin's pending note to remain queued until that plugin is released.

Use multi-package frontmatter only when the current Changesets configuration and release tooling explicitly require those packages to version together and a scoped release cannot split them. Do not assume that shared implementation implies shared versioning.

### 7. Draft or create the Changeset

Use a unique, short, lowercase kebab-case filename under `.changeset/`. Use this exact shape:

```markdown
---
"<package-name-from-manifest>": patch
---

**Fixed:** Prevent a completed operation from being retried.
```

Replace every placeholder with discovered repository data; never write the angle-bracket placeholder literally. Replace `patch` and `Fixed` with the selected bump and category. Keep the category as a bold prefix rather than adding release-level headings; Changesets owns final changelog assembly.

Write the summary in active, user-facing language:

- Lead with the capability, behavior, fix, or required action.
- Explain what changed and why it matters. Include migration steps for breaking changes.
- Use product terminology that users of the affected release unit see.
- Keep one simple change to one concise sentence. Add a short paragraph only when users need constraints or migration guidance.
- Do not narrate implementation details, filenames, tests, commits, or pull request mechanics.
- Do not manually edit package versions or generated `CHANGELOG.md` files.

When asked only to propose Changesets, return each proposed filename, affected release unit, bump rationale, and complete file content without writing it. When asked to add, create, or fix them, edit the files in the workspace.

### 8. Handle the no-Changeset outcome

When the change is not directly relevant to users of any release unit:

- Do not create a file under `.changeset/`.
- State the concrete reason observable behavior is unchanged.
- Propose the exact pull request label `pr:no-changeset`.
- Do not apply the label unless the user explicitly asks and a pull request is available.

Use this response shape:

```text
Changeset: not required
Reason: <one concrete sentence>
Proposed PR label: pr:no-changeset
```

### 9. Validate the result

Before finishing a Changeset outcome, verify:

- Every frontmatter key exactly matches an affected, non-ignored package name discovered from the current workspace, and no affected release unit is missing.
- Every frontmatter value is `patch`, `minor`, or `major`, selected independently for that release unit.
- Each independently releasable plugin has its own Changeset.
- No package name came from a hardcoded list or an example in this skill.
- The summary uses one Keep a Changelog category and describes a notable user outcome.
- Breaking changes state what users must do.
- The note does not duplicate a pending Changeset, and any existing note covers the correct release unit rather than only the first discovered plugin.
- `node scripts/plugins.mjs --json` succeeds and identifies the plugin package names used in the frontmatter.
- `pnpm exec changeset status` parses the complete pending release plan.
- The new Markdown files pass the repository Markdown lint command.

Before finishing a no-Changeset outcome, recheck the complete diff for indirect effects through shared packages, builds, and generated assets across all discovered release units. Then ensure no new Changeset was created and propose `pr:no-changeset` with the rationale.
