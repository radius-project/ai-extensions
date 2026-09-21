# Design docs and functional specs

This folder holds two kinds of document for the `radius-project/ai-extensions` repository, both written *before* the implementation is built so maintainers and the community can agree first.

## Which one to write

| You want to…                                                       | Write a…            | Template                                                       | Skill                                                                            |
|--------------------------------------------------------------------|---------------------|----------------------------------------------------------------|----------------------------------------------------------------------------------|
| Decide what to build and what the developer gets, screen by screen | **functional spec** | [`functional-spec-template.md`](./functional-spec-template.md) | [`radius-functional-spec`](../../.github/skills/radius-functional-spec/SKILL.md) |
| Decide how to build it — options, trade-offs, a chosen approach    | **design doc**      | [`template.md`](./template.md)                                 | [`radius-design-doc`](../../.github/skills/radius-design-doc/SKILL.md)           |

A functional spec sets product direction as well as experience: what the team is building and who for, what is deliberately out of scope, and what the developer meets on each screen. Where a capability needs both documents, write the functional spec first — agreeing on what the developer gets is what makes the build options comparable. Do not merge them into one document: a design doc contains `Design`, `API design`, `Implementation details`, `Test plan`, `Security`, `Compatibility`, `Monitoring and logging`, and `Development plan`, and a functional spec contains none of them.

## When to write one

Write a **design doc** for a new capability or a significant change to an existing one (a new canvas page/action, a new compute platform in `packages/core`, a change to how the plugin is packaged and shipped), for a change to a public contract (a canvas action/tool surface, the plugin manifest, the marketplace entry, an API in `packages/core`), or for a change with meaningful security, compatibility, or cross-component impact.

Write a **functional spec** when the risk is ambiguity about what to build rather than uncertainty about how to build it — a new cloud provider, a new onboarding flow, a change that alters the screens, controls, or messages a developer meets, or a product-direction decision the team needs on record: which scenarios a capability serves, how far it goes in its first release, what it leaves out. The AWS support spec in [pull request #839](https://github.com/radius-project/ai-extensions/pull/839) is a worked example.

You need **neither** for minor changes such as documentation updates, small bug fixes, or refactors with no behavioral change — use a GitHub issue and pull request instead.

## How to create one

1. Copy the template for your genre to `YYYY-MM-short-name.md`, using the current year and month plus a short descriptive name — for example, `2026-07-control-plane-state-ghcr.md`.
2. Fill out every section the template defines. In a design doc, keep all of them; where one does not apply, write `N/A` and briefly say why. A functional spec has a fixed, shorter set and adds no engineering sections to it.
3. Ground every claim in the codebase. Link to real files, symbols, commands, and flags — do not invent paths or behavior.
4. Put supporting assets (images, large diagrams) in a directory with the same name as the doc, without the `.md` extension.
5. Open a pull request with the doc so maintainers and the community can review it.

The skills in the table above automate these steps and keep the document grounded in the code.

## Review and lifecycle

- The document is discussed on its pull request; reviewers leave questions and feedback as comments so the history is preserved.
- Record a design doc's outcome in its **Design review notes** section before merge. A functional spec has no such section — its review lives on the pull request.
- Implementation begins only after the document is approved and merged.
- If the design changes materially during implementation, open a follow-up pull request that updates the document.

## Naming convention

| Item          | Convention                                     |
|---------------|------------------------------------------------|
| Doc or spec   | `YYYY-MM-short-name.md`                        |
| Assets        | `YYYY-MM-short-name/` (same name, no `.md`)    |
| Status values | `Draft`, `In review`, `Approved`, `Superseded` |
