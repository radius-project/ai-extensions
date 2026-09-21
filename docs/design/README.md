# Design docs and functional specs

This folder holds two kinds of document for the `radius-project/ai-extensions` repository, both written *before* the implementation is built so maintainers and the community can agree first.

- A **design doc** (design note / proposal) records **why** and **how** we intend to make a non-trivial change.
- A **functional spec** records **what the developer experiences** — every screen of a user-facing capability, in the order they meet them.

## Which one to write

| You want to…                                                  | Write a…            | Template                                                       | Skill                                                                            |
|---------------------------------------------------------------|---------------------|----------------------------------------------------------------|----------------------------------------------------------------------------------|
| Settle the user experience of a new capability                | **functional spec** | [`functional-spec-template.md`](./functional-spec-template.md) | [`radius-functional-spec`](../../.github/skills/radius-functional-spec/SKILL.md) |
| Settle the mechanism — options, trade-offs, a chosen approach | **design doc**      | [`template.md`](./template.md)                                 | [`radius-design-doc`](../../.github/skills/radius-design-doc/SKILL.md)           |

The two are complements, not competitors. Where a capability needs both, the functional spec comes first and is the input to the design doc. Do not merge them into one document: a design doc requires `Design`, `API design`, `Implementation details`, `Test plan`, `Security`, and `Development plan` sections, and a functional spec contains none of them.

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

## When to write a functional spec

Write one when the risk is ambiguity about **behavior** rather than uncertainty about implementation — a new cloud provider, a new onboarding flow, a new canvas page or wizard, or a change that alters the screens, controls, or messages a developer meets.

A functional spec has a fixed, shorter section set: `Overview`, `Terms and definitions`, `Objectives`, `User experience`, `Error handling`, `Open questions`. Unlike a design doc, it does **not** carry engineering sections — no `Design`, `API design`, `Implementation details`, `Test plan`, `Security`, `Compatibility`, `Monitoring and logging`, or `Development plan`.

Copy [`functional-spec-template.md`](./functional-spec-template.md) and follow the same naming, asset, and pull-request conventions as a design doc. The [`radius-functional-spec`](../../.github/skills/radius-functional-spec/SKILL.md) skill carries the full procedure and the writing rules, and the AWS support spec in [pull request #839](https://github.com/radius-project/ai-extensions/pull/839) is a worked example.

## Review and lifecycle

- Design is discussed on the pull request; reviewers leave questions and feedback as comments so the history is preserved.
- Record the outcome in the **Design review notes** section before merge. A functional spec has no such section — its review lives on the pull request.
- Implementation begins only after the design is approved and merged.
- If the design changes materially during implementation, open a follow-up pull request that updates the doc.

## Naming convention

| Item            | Convention                                     |
|-----------------|------------------------------------------------|
| Design doc      | `YYYY-MM-short-name.md`                        |
| Functional spec | `YYYY-MM-short-name.md`                        |
| Doc assets      | `YYYY-MM-short-name/` (same name, no `.md`)    |
| Status values   | `Draft`, `In review`, `Approved`, `Superseded` |
