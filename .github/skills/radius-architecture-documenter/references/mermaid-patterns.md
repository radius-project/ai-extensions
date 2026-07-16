# Mermaid Diagram Patterns

Reusable Mermaid templates for architecture documentation in this repository. Copy and adapt these patterns, replacing the placeholder nodes with the actual packages, modules, and functions from the code you are documenting.

## High-Level System Overview (Top-Down Flowchart)

```mermaid
graph TD
    subgraph Copilot["GitHub Copilot app / CLI"]
        Agent["Agent + skills"]
        Panel["Canvas side panel"]
    end

    subgraph Plugin["plugins/radius"]
        Manifest["plugin.json"]
        Skills["skills/"]
        Ext["plugins/radius/extension.mjs<br/>(built bundle)"]
    end

    subgraph Adapters["adapters/"]
        Canvas["canvas<br/>(canvas adapter)"]
        Shared["shared<br/>(rad CLI, utils)"]
    end

    Core["radius-core<br/>(UI-agnostic logic + ports)"]

    Agent -->|invokes| Skills
    Panel -->|renders| Ext
    Canvas -->|implements ports| Core
    Shared -->|implements ports| Core
    Canvas -.->|bundled into| Ext
    Core -.->|bundled into| Ext
```

## Ports-and-Adapters Boundary (Component Diagram)

```mermaid
graph LR
    subgraph core["radius-core"]
        API["src/index.ts<br/>(public API)"]
        Port["Port<br/>(interface)"]
    end

    subgraph canvas["adapters/canvas"]
        Impl["Adapter<br/>(port implementation)"]
    end

    Impl -->|implements| Port
    Impl -->|calls| API
```

## Sequence Diagram (Canvas Action Flow)

```mermaid
sequenceDiagram
    participant User
    participant Panel as Canvas Panel<br/>(ui.mjs)
    participant Server as Canvas Server<br/>(server.mjs)
    participant Core as radius-core<br/>(port)
    participant Ext as External<br/>(gh / ghcr / rad)

    User->>Panel: Interact (open graph, deploy)
    Panel->>Server: invoke action
    Server->>Core: call core logic via port
    Core->>Ext: perform side effect (adapter impl)
    Ext-->>Core: result
    Core-->>Server: model / graph
    Server-->>Panel: update canvas
    Panel-->>User: render result
```

## Build / Packaging Flow

```mermaid
graph TD
    subgraph Source["Source (tracked)"]
        CoreTS["radius-core/src/*.ts"]
        CanvasSrc["adapters/canvas/src/*.mjs"]
        Build["adapters/canvas/build.mjs<br/>(esbuild)"]
    end

    subgraph Output["Generated"]
        Bundle["plugins/radius/extension.mjs"]
    end

    CoreTS -->|transpiled + inlined| Build
    CanvasSrc -->|bundled| Build
    Build -->|emits single file| Bundle
    Bundle -->|loaded by| App["Copilot app / CLI"]
```

## State Diagram (Application Graph Views)

```mermaid
stateDiagram-v2
    [*] --> Modeled: model source code
    Modeled --> Planned: choose target
    Planned --> Deployed: deploy to environment
    Modeled --> Diff: compare branches
    Planned --> Diff: compare branches
    Deployed --> Diff: compare branches
    Diff --> [*]
```

## Tips for Effective Diagrams

### Keep It Readable

- **Max ~15 nodes** per diagram. Split complex systems into multiple diagrams.
- Use **subgraphs** to group related components (for example, `radius-core` vs. `adapters/canvas` vs. `plugins/radius`).
- Use **short labels** on arrows — one or two words.
- Prefer **top-down** (`TD`) for hierarchical relationships and **left-right** (`LR`) for data flows.

### Make It Accurate

- Use **actual names** from the code (package names, module file names, function names).
- Show **real relationships** — do not invent connections that do not exist in the code.
- Distinguish **source** from **generated** artifacts (for example, mark the built `extension.mjs` as bundled output).
- Show where a flow **crosses the core/adapter boundary** — that boundary is the most important architectural fact in this repo.

### Sequence Diagram Tips

- Name participants after their **actual role** in the code (for example, "server.mjs" not "Server").
- Use `Note over` to explain non-obvious steps.
- Use `activate`/`deactivate` to show which participant is processing.
- Show **error paths** with `alt`/`else` blocks when they are architecturally significant.

### Class Diagram Tips

- Use `<<interface>>` stereotypes for core ports.
- Show only **architecturally significant** fields and methods, not every field.
- Use composition (`*--`) vs. aggregation (`o--`) vs. dependency (`-->`) appropriately.
