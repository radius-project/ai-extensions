# Design docs

This folder holds **design docs** (design notes / proposals) for the `radius-project/ai-extensions` repository. A design doc records **why** and **how** we intend to make a non-trivial change *before* the implementation is built, so maintainers and the community can agree on the approach.

## When to write a design doc

Write one for larger changes, such as:

- A new capability or a significant change to an existing one (for example, a new canvas page/action, a new compute platform in `packages/core`, or a change to how the plugin is packaged and shipped).
- A change that affects a public contract: a canvas action/tool surface, the plugin manifest, the marketplace entry, or an API in `packages/core`.
- A change with meaningful security, compatibility, or cross-component impact.

You do **not** need a design doc for minor changes such as documentation updates, small bug fixes, or refactors with no behavioral change — use a GitHub issue and pull request instead.

## How to create one

1. Copy [`template.md`](./template.md) to a new file named `YYYY-MM-short-name.md`, using the current year and month plus a short descriptive name — for example, `2026-07-control-plane-state-ghcr.md`.
2. Fill out **every** section of the template. Do not delete sections; if a section does not apply, write `N/A` and briefly say why.
3. Ground every claim in the codebase. Link to real files, symbols, commands, and flags — do not invent paths or behavior.
4. Put supporting assets (images, large diagrams) in a directory with the same name as the doc, without the `.md` extension (for example, `2026-07-control-plane-state-ghcr/`).
5. Open a pull request with the doc so maintainers and the community can review it.

The [`radius-design-doc`](../../.github/skills/radius-design-doc/SKILL.md) skill automates these steps and keeps the doc grounded in the code.

## Review and lifecycle

- Design is discussed on the pull request; reviewers leave questions and feedback as comments so the history is preserved.
- Record the outcome in the **Design review notes** section before merge.
- Implementation begins only after the design is approved and merged.
- If the design changes materially during implementation, open a follow-up pull request that updates the doc.

## Naming convention

| Item          | Convention                                     |
|---------------|------------------------------------------------|
| Design doc    | `YYYY-MM-short-name.md`                        |
| Doc assets    | `YYYY-MM-short-name/` (same name, no `.md`)    |
| Status values | `Draft`, `In review`, `Approved`, `Superseded` |
