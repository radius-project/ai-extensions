---
name: radius-design-doc
description: 'Author a NEW design doc (design note / proposal) for a planned, non-trivial change to the ai-extensions repo — capturing why and how before implementation. Use when the user asks to write/create/draft a design doc, design note, design proposal, RFC, or spec for a feature or architectural change (e.g. control plane state storage, a new canvas action, plugin packaging). Not for documenting existing architecture after the fact, and not for how-to/contributing docs.'
argument-hint: 'The design topic and a starting code reference (file, package, component, or issue)'
user-invocable: true
---

# Author a design doc

Draft a design doc for a **planned** change to `radius-project/ai-extensions`, grounded in the real codebase and following the repository's design-note format. The goal is to reach agreement on **why** and **how** before code is written.

This skill is a convenience wrapper around the process and template in [`docs/design/README.md`](../../../docs/design/README.md) and [`docs/design/template.md`](../../../docs/design/template.md). It adds no convention that is not already recorded there. The format is adapted from the Radius [design-notes](https://github.com/radius-project/design-notes) process.

## When to use

Use this skill when the user wants to propose a non-trivial change, such as:

- A new capability or a significant change to an existing one (a new canvas page/action or tool, a new compute platform in `packages/core`, a change to how the plugin is built, packaged, or shipped).
- A change to a public contract: a canvas action/tool surface, `plugin.json`, the marketplace entry, or a `packages/core` API.
- A change with meaningful security, compatibility, or cross-component impact.

Do **not** use this skill for:

- Documenting how an existing subsystem already works after the fact — write an architecture overview instead.
- How-to or contributing guides (setup, build, release steps).
- Minor changes (docs, small bug fixes, behavior-preserving refactors) — those are handled with a normal issue and pull request.

## Inputs

- A **topic** — the planned change to design.
- A **starting code reference** — a file, package, component, or issue the design will build on. If the user did not provide one, ask for it or locate the most relevant code before drafting.

## Steps

1. **Confirm it is a design doc.** This skill authors forward-looking design proposals placed in `docs/design/`. If the request is really about documenting existing architecture or writing a how-to, stop and use the appropriate approach instead.
2. **Gather context from code.** Read the relevant source before writing. Trace the components the design touches across `packages/core/` (product logic), `packages/adapter-canvas/` and `packages/adapter-shared/` (Copilot wiring), and `plugins/radius/` (skills + canvas extension packaging). Identify entry points, key types, ports, and existing patterns. Never design from assumptions — verify against the code.
3. **Create the file.** Copy [`docs/design/template.md`](../../../docs/design/template.md) to `docs/design/YYYY-MM-short-name.md`, using the current year and month plus a short descriptive name (for example, `2026-07-control-plane-state-ghcr.md`). Put supporting assets in a directory of the same name without `.md`.
4. **Fill out every section.** Do not omit sections. If a section does not apply, write `N/A` and briefly explain why. Pay particular attention to:
   - **Objectives** — explicit goals and non-goals.
   - **Detailed design** — give each option its own section with advantages, disadvantages, and a clearly chosen **Proposed option** with reasoning.
   - **Implementation details** — map the work onto the affected components (`packages/core`, `packages/adapter-canvas`, `packages/adapter-shared`, `plugins/radius`, build/packaging); delete the subsections that do not apply.
   - **Security**, **Test plan**, and **Open questions** — do not skip these.
5. **Ground every reference in code.** Link to real files, symbols, commands, and flags. Never invent a path, type, or behavior. Put alternatives you are unsure about in **Open questions** or **Alternatives considered**.
6. **Add diagrams where they help.** Use a fenced ```mermaid``` block for the architecture diagram so it renders on GitHub. Keep diagrams true to the code — a correct simple diagram beats an elaborate wrong one.
7. **Hand off for review.** A design doc is reviewed on a pull request before any implementation begins. Leave the **Design review notes** section for the review outcome. Do not treat the design as final until it is approved.

## Verification

- The doc lives at `docs/design/YYYY-MM-short-name.md` and follows the template.
- Every template section is present; non-applicable sections say `N/A` with a reason — none are silently dropped.
- The **Detailed design** presents options with advantages/disadvantages and a reasoned **Proposed option**.
- Every path, symbol, command, and link resolves to something real in the repo — no hallucinated references.
- Any Mermaid diagram renders (valid fenced ```mermaid``` block) and reflects the actual components.
- Markdown follows the repo's lint rules: dash (`-`) bullets, fenced code blocks, and ordered lists starting at `1.`.
