---
name: radius-architecture-documenter
description: 'Document the Radius AI Extension architecture with Mermaid diagrams. Use for: generating architecture overviews, component diagrams, sequence diagrams from code, explaining how the canvas adapter and shared core work, answering architecture questions, producing entity-relationship diagrams, and distilling TypeScript/ESM code into human-readable descriptions. Writes living architecture docs to docs/architecture/. For proposing new changes with options and trade-offs, use radius-design-doc instead.'
argument-hint: 'Describe what part of the architecture to document or ask an architecture question'
user-invocable: true
---

# Architecture Documenter

Expert skill for analyzing this repository, documenting how the Radius AI Extension works today, and generating accurate Mermaid diagrams grounded in actual source code. Output goes in [`docs/architecture/`](../../../docs/architecture/README.md).

## Architecture doc or design doc?

| You want to…                                             | Use                                                |
|----------------------------------------------------------|----------------------------------------------------|
| **Explain** how something works today (diagram + prose)  | **this skill**                                     |
| **Propose** a change, weigh options, get review sign-off | [radius-design-doc](../radius-design-doc/SKILL.md) |

Architecture docs are descriptive and have no approval gate. Design docs are decision-making proposals that are reviewed before implementation. See [`docs/architecture/README.md`](../../../docs/architecture/README.md) for the distinction.

## When to Use

- Generate a high-level architecture overview of the system or a subsystem.
- Produce component diagrams showing how `packages/core`, the adapters, and the plugin relate.
- Create sequence diagrams that are true-to-code (reflect actual call chains).
- Explain how a subsystem works in plain language (for example, how canvas pages call into the core through ports).
- Answer questions about the existing architecture.
- Onboard new contributors by explaining system structure.

## Core Principles

1. **Code-grounded**: Every diagram and explanation must be derived from actual source code, not assumptions. Read the code before documenting it.
2. **Progressive depth**: Start with high-level overviews, then drill into details only when asked.
3. **Accuracy over aesthetics**: A correct simple diagram beats an elaborate wrong one.
4. **Human-readable output**: Distill complex code concepts into clear, jargon-minimal prose. Use diagrams to complement text, not replace it.

## Procedure

### Step 1: Scope the Request

Determine what the user wants documented:

| Request Type                                  | Output                                        |
|-----------------------------------------------|-----------------------------------------------|
| "How does X work?"                            | Prose explanation + optional diagram          |
| "Show me the architecture of X"               | Component diagram + brief description         |
| "Show me the flow when X happens"             | Sequence diagram + step-by-step narrative     |
| "What are the relationships between X, Y, Z?" | Entity-relationship / component diagram       |
| "Give me an overview"                         | High-level system diagram + component summary |

### Step 2: Gather Context from Code

This is the most critical step. **Do not generate diagrams from memory or assumptions.**

1. **Identify entry points**: Find the canvas entry (`packages/adapter-canvas/src/extension.ts`), the plugin manifest (`plugins/radius/plugin.json`), the core's public API (`packages/core/src/index.ts`), and any relevant skill under `plugins/radius/skills/`.
2. **Trace the call chain**: Follow calls from a canvas page or action into the shared core through its ports, and out to the outside world through adapters.
3. **Map the workspace**: Understand how the pnpm workspace packages relate (`pnpm-workspace.yaml`, each `package.json`, `workspace:*` dependencies).
4. **Identify key types**: Find the core ports, models, and functions that define the boundary between UI-agnostic logic and adapter code.
5. **Note patterns**: Identify the ports-and-adapters (hexagonal) boundary, the canvas action/tool registration, and the build/bundle step.

#### Repo-Specific Investigation Techniques

- **Respect the core boundary**: `packages/core` must not depend on an adapter, the Copilot SDK, HTTP, or the DOM. Anything touching the outside world goes through a **port**. When documenting a flow, show where it crosses that boundary.
- **Find port implementations**: A port is defined in `packages/core` and implemented in an adapter (`packages/adapter-canvas`, `packages/adapter-shared`). Search for the port name across `packages/adapter-*` to find its concrete implementation.
- **Follow canvas registration**: Start at `packages/adapter-canvas/src/extension.ts` (which calls `createCanvas({ id: "radius" })`), then trace how pages (`pages/`), the server (`server.ts`), and actions are wired.
- **Understand packaging**: `packages/adapter-canvas/build.mjs` (esbuild) bundles the adapter and the `workspace:*` core into `plugins/radius/dist/extension.mjs`, then assembles the rest of the plugin around it. Note what is source vs. generated when documenting the build.
- **Read test files**: `*.test.ts` files (for example, `appgraph.test.ts`, `rad.test.ts`) reveal expected behavior and interaction patterns.

### Step 3: Generate the Diagram

Choose the appropriate Mermaid diagram type. See [Mermaid Diagram Reference](./references/mermaid-patterns.md) for templates.

| Situation                   | Diagram Type                      |
|-----------------------------|-----------------------------------|
| System / subsystem overview | `graph TD` (top-down flowchart)   |
| Request/response flow       | `sequenceDiagram`                 |
| Entity relationships        | `classDiagram` or `erDiagram`     |
| State transitions           | `stateDiagram-v2`                 |
| Component dependencies      | `graph LR` (left-right flowchart) |
| Packaging / install flow    | `graph TD` with subgraphs         |

#### Diagram Quality Checklist

- [ ] Every node corresponds to a real package, module, type, or function in the code.
- [ ] Relationships reflect actual code dependencies (imports, function calls, port implementations).
- [ ] Labels use the actual names from the codebase (package names, module file names, function names).
- [ ] The diagram is not overcrowded — split into multiple diagrams if >15 nodes.
- [ ] Subgraphs group related components (for example, `packages/core` vs. `packages/adapter-canvas` vs. `plugins/radius`).
- [ ] Arrow labels describe the nature of the relationship (for example, "implements port", "calls", "bundles").

### Step 4: Write the Explanation

Pair every diagram with a prose explanation that:

1. **Summarizes** what the diagram shows in 1-2 sentences.
2. **Walks through** the key components and their responsibilities.
3. **Highlights** important architectural decisions or patterns (especially the core/adapter boundary).
4. **Notes** any non-obvious aspects (error handling paths, async behavior, the build/bundle step).

#### Writing Style

- Use short paragraphs (3-4 sentences max).
- Lead with the "what" and "why" before the "how".
- Use bullet lists for component responsibilities.
- Bold key terms on first use.
- Reference specific file paths so readers can find the code.

### Step 5: Save the Document

Place the finished doc in `docs/architecture/` as `short-name.md` (living reference, no date prefix). Put supporting assets in a folder with the same name. Update the doc when the code it describes changes.

## Repository Context

This is a [pnpm](https://pnpm.io/) workspace monorepo written in TypeScript and ESM. UI-agnostic product logic lives in a shared core, and adapters wire it into concrete surfaces. The core never depends on an adapter, the Copilot SDK, HTTP, or the DOM.

### High-Level Components

| Component         | Location                            | Purpose                                                                                                           |
|-------------------|-------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Core              | `packages/core/`                    | UI-agnostic product logic: modeling, application graph, platform, and workflow generation, exposed through ports. |
| Canvas adapter    | `packages/adapter-canvas/`          | Wires the core into the GitHub Copilot app as the `radius` canvas extension (pages, server, actions).             |
| Shared adapter    | `packages/adapter-shared/`          | Shared adapter utilities (for example, `rad` CLI invocation) used across surfaces.                                |
| Plugin            | `plugins/radius/`                   | The Copilot plugin source: `plugin.json` manifest and `skills/`; assembled with the built canvas into `dist/`.    |
| Build / packaging | `packages/adapter-canvas/build.mjs` | esbuild step that bundles the adapter + core and assembles `plugins/radius/dist/`.                                |

### Key Modules in the Canvas Adapter

| Module                                             | Purpose                                                         |
|----------------------------------------------------|-----------------------------------------------------------------|
| `src/extension.mjs`                                | Canvas entry point; registers `createCanvas({ id: "radius" })`. |
| `src/pages.mjs`                                    | Canvas page definitions (graph, environments, deployments).     |
| `src/server.mjs`                                   | Server-side canvas logic and action handlers.                   |
| `src/client.mjs`, `src/ui.mjs`                     | Client/UI rendering for the canvas surface.                     |
| `src/gh.mjs`, `src/ghcr.mjs`                       | GitHub and GHCR integration.                                    |
| `src/bicep.mjs`, `src/deploy.mjs`, `src/infra.mjs` | Bicep generation, deployment, and infrastructure logic.         |

### Common Patterns

- **Ports and adapters (hexagonal)**: The core defines ports; adapters implement them. Documenting a flow means showing where it crosses that boundary.
- **Canvas actions/tools**: The canvas registers agent-callable actions alongside UI controls; skills under `plugins/radius/skills/` tell the agent when to drive them.
- **Single bundled artifact**: The plugin ships a single generated `extension.mjs` produced by the build; it is not hand-edited.
- **Changesets**: Versioning and changelogs use Changesets (see `RELEASING.md`).

## Output Format

Always structure output as:

````markdown
# [Title — what is being documented]

[1-2 sentence summary]

```mermaid
[diagram]
```

## Key Components

[Bulleted list of components and responsibilities]

## How It Works

[Prose walkthrough of the flow/architecture]

## Notable Details

[Any non-obvious aspects worth calling out]
````
