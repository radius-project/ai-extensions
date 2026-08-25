# Architecture documentation

This folder holds **living architecture documentation**: explanations of how the Radius Canvas extension actually works today. These docs are descriptive reference material derived from the current codebase, not proposals for future work.

## Architecture docs vs. design docs

|               | Architecture doc (this folder) | Design doc ([`docs/design/`](../design/README.md)) |
|---------------|--------------------------------|----------------------------------------------------|
| Answers       | "How does it work?"            | "What should we build, and why?"                   |
| Orientation   | Descriptive                    | Decision-making                                    |
| Lifecycle     | Updated when behavior changes  | Proposed, reviewed, approved, then implemented     |
| Approval gate | None                           | Yes, reviewed before implementation                |
| Naming        | `short-name.md`                | `YYYY-MM-short-name.md`                            |

If you are proposing a change and weighing options, write a design doc instead. If you are explaining a mechanism that already exists, write an architecture doc here.

## When to write one

- Explain a subsystem or end-to-end flow (for example, how control-plane state is stored in GHCR, or how the canvas extension is discovered and registered).
- Onboard contributors to a part of the system.
- Capture a component diagram, sequence diagram, or entity relationships that are true to the code.

## How to create one

Use the [`radius-architecture-documenter`](../../.github/skills/radius-architecture-documenter/SKILL.md) skill, which grounds every diagram and explanation in the actual source code.

1. Scope what you are documenting.
2. Read the relevant code before writing (do not document from memory).
3. Produce Mermaid diagrams plus prose, using the actual package, type, and function names from the codebase.
4. Save the file here as `short-name.md` (for example, `control-plane-state-ghcr.md`). Put supporting assets in a folder with the same name.

## Keeping docs accurate

Because these describe current behavior, update them when the code they describe changes. A diagram that no longer matches the code is worse than no diagram, so prefer a small, correct scope over an exhaustive one that drifts.
