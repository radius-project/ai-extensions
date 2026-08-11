# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).

Every change that affects a published package should ship with a changeset that
describes the change and the version bump it requires. Add one from the repo
root:

```bash
pnpm changeset
```

Pick the affected packages, choose `patch` / `minor` / `major` per
[semver](https://semver.org/), and write a short, user-facing summary. The
command writes a markdown file in this folder — commit it alongside your code.

At release time `pnpm version` (which runs `changeset version`) consumes all
pending changesets: it bumps each package's version, updates internal
`workspace:*` dependents, and writes a `CHANGELOG.md` per package. See
[`RELEASING.md`](../docs/eng/RELEASING.md) for the full flow and tag convention.
