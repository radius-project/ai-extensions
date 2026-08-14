// Immutable declaration/schema builders for the Radius canvas + tools.
//
// This module holds ONLY the static, declarative shape the SDK sees: the
// canvas's id/displayName/description/inputSchema, and every action's/tool's
// name/description/inputSchema (or parameters). No handler logic, no
// dependencies, no I/O — so it can be imported and asserted against in a test
// without constructing a single fake. createRadiusCanvas/createRadiusTools
// (in canvas.ts/tools.ts) attach the actual handlers on top of these
// declarations.
//
// Every exported declaration is deep-frozen so a consumer (or a careless test)
// cannot mutate the canonical shape out from under other importers.

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export const RADIUS_CANVAS_ID = "radius";
export const RADIUS_CANVAS_DISPLAY_NAME = "Radius";
export const RADIUS_CANVAS_DESCRIPTION =
  "Application modeling and deployment: configure cloud credentials, generate app.bicep, visualize application graphs, view PR diffs, and create deployment environments.";

// The 7 pages the canvas can render. Kept here (not just in hooks.ts's
// GRAPH_PAGES) because the canvas's own inputSchema enum is the contract the
// SDK/agent sees; hooks.ts separately owns which of these are graph-generating.
export const RADIUS_CANVAS_PAGES = deepFreeze([
  "credentials",
  "graph",
  "planned",
  "graph-diff",
  "deployed",
  "environment",
  "deploying"
] as const);

export type RadiusCanvasPage = (typeof RADIUS_CANVAS_PAGES)[number];

// SDK/host-reserved tool and action names this extension must never declare,
// so a future action/tool addition cannot silently shadow a built-in (which
// would either fail registration or hijack the built-in's invocations).
export const RESERVED_DECLARATION_NAMES = [
  "open_canvas",
  "close_canvas",
  "invoke_canvas_action",
  "list_canvases"
] as const;

export function buildRadiusCanvasInputSchema(defaultPage: string) {
  return deepFreeze({
    type: "object",
    properties: {
      page: {
        type: "string",
        enum: [...RADIUS_CANVAS_PAGES],
        description: "Which page to display",
        default: defaultPage
      },
      repo: {
        type: "string",
        description:
          "Repository in owner/repo format to pre-select in dropdowns"
      },
      branch: {
        type: "string",
        description:
          "Branch to read .radius/app.bicep from when repo is not the current workspace repository. Ignored for the workspace repository, which always uses the checked-out branch. Defaults to 'main'."
      },
      baseBranch: {
        type: "string",
        description:
          "Base branch for graph-diff comparison (e.g. 'main'). When provided with headBranch, auto-compares on open."
      },
      headBranch: {
        type: "string",
        description:
          "Head branch for graph-diff comparison (e.g. PR branch). When provided with baseBranch, auto-compares on open."
      }
    }
  });
}

export interface ActionDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The 2 canvas actions, in their current order. Declarative shape only — see
// canvas.ts for the handlers.
export const RADIUS_ACTION_DECLARATIONS: readonly ActionDeclaration[] =
  deepFreeze([
    {
      name: "get_graph_resources",
      description:
        "Return the current graph resources, optionally filtered to only those missing a codeReference. Use this to discover which resources need source-code references after the graph has been built.",
      inputSchema: {
        type: "object",
        properties: {
          missingOnly: {
            type: "boolean",
            description:
              "If true (default), return only resources missing codeReference. If false, return all resources."
          },
          view: {
            type: "string",
            enum: ["graph", "planned", "diff"],
            description:
              "Graph view to inspect. Defaults to the active canvas page."
          }
        }
      }
    },
    {
      name: "update_source_refs",
      description:
        "Attach source-code references to the exact graph context returned by get_graph_resources so nodes deep-link to their definition/initialization site.",
      inputSchema: {
        type: "object",
        properties: {
          refs: {
            type: "array",
            description:
              "Array of {id, codeReference} objects. codeReference is a repo-relative path, optionally with #L<line> (e.g. 'src/db.js#L14').",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Stable resource ID returned by get_graph_resources"
                },
                codeReference: {
                  type: "string",
                  description: "Repo-relative path with optional #L<line>"
                }
              },
              required: ["id", "codeReference"]
            }
          },
          contextToken: {
            type: "string",
            description: "Graph context token returned by get_graph_resources"
          }
        },
        required: ["contextToken", "refs"]
      }
    }
  ]);

// additionalContext returned from onSessionStart. Pure static data — the
// wiring that returns it lives in extension.ts (createRadiusExtension).
export const RADIUS_SESSION_START_CONTEXT = `When opening the Radius Canvas (canvasId: "radius"), ALWAYS:
1. Use instanceId "radius-panel" — this ensures only ONE Radius Canvas panel is ever open (reusing the same panel for all views).
2. Pass the current session's repository as the "repo" input in owner/repo format.
                3. Treat the current Copilot session worktree branch as the graph branch. Do not default graph views to main for the session repo.

IMPORTANT — Automatic PR Graph Diff: When a pull request is created (via create_pull_request tool or any PR creation action):
1. FIRST, call the radius_generate_pr_diff_markdown tool with the repo, base branch, and head branch. This returns a Mermaid application graph diff diagram and summary.
2. Include the returned markdown at the TOP of the PR description/body (before any other content).
3. THEN open the Radius Canvas to the graph-diff page:
   open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph-diff", repo: "<current-repo>", baseBranch: "<pr-base-branch>", headBranch: "<pr-head-branch>" } })
The PR description will show the app graph diff inline on GitHub, and the canvas provides the interactive version.

When the user asks to "show me the app graph", "show me the application graph", "show the app graph", or similar phrases:
1. First, check whether .radius/app.bicep (or app.bicep) exists in the working tree.
2. If it does not, author it using the radius_generate_app tool (the radius-app-bicep skill owns namespaces, types, and structure, and writes the file to the working tree) and follow that skill to completion.
3. Only AFTER the skill has written app.bicep to the working tree, open: open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph", repo: "<current-repo>" } }). For the current workspace repo and branch, the graph and planned pages render from the on-disk working tree, so no push is needed (modeling does not push). For a different repo or branch, the canvas reads .radius/app.bicep from that remote branch, so it must be committed and pushed there.

The planned page resolves .radius/app.bicep from the working tree the same way. The graph-diff page instead compares two branches, so each branch being compared must already contain the committed model.

When the user asks to "show me the planned graph", "plan my app": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "planned", repo: "<current-repo>" } }).

When the user asks to "deploy my app", "create environment": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "environment", repo: "<current-repo>" } }).

When the user asks to "configure OIDC", "set up cloud credentials", "add credentials": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "credentials", repo: "<current-repo>" } }).

When the user asks to "show the diff", "compare branches", "app graph diff": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph-diff", repo: "<current-repo>" } }).

CRITICAL: Always use instanceId "radius-panel" for ALL Radius Canvas operations. Never use different instanceIds — this prevents multiple panels from opening.

When planned graph resolution cannot resolve a resource type, distinguish two cases. (1) The type exists but no recipe or recipe pack is registered for it in the target Environment: report the unresolved type and explain that a recipe pack providing it must be registered to the environment; do NOT generate a custom type or an inline singleton recipe for this case. (2) No built-in type fits the needed backing service at all: the radius-app-bicep skill generates a custom resource type (namespace Radius.Resources) together with its own recipe pack, following the skill's custom-resource-types guidance (Azure scope for now). In both cases recipes are supplied via recipe packs, not inline per-type singleton recipes, so do NOT fabricate a singleton recipe in app.bicep or in the graph. If a needed service is not provisionable on Azure, report it to the user instead of inventing a type.`;

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// The 6 tools, in their current order. Declarative shape only — see tools.ts
// for the handlers.
export const RADIUS_TOOL_DECLARATIONS: readonly ToolDeclaration[] = deepFreeze([
  {
    name: "radius_generate_app",
    description:
      "Generates a Radius app.bicep file by analyzing the repository structure using the radius-app-bicep skill. Returns the full radius-app-bicep skill (SKILL.md and all reference files, bundled with the extension) so the agent uses authoritative, schema-accurate Radius.* types and compiles the result before finishing.",
    parameters: {
      type: "object",
      properties: {
        repoPath: {
          type: "string",
          description: "Path to the repository to analyze"
        }
      }
    }
  },
  {
    name: "radius_generate_pr_diff_markdown",
    description:
      "Generates a Mermaid application graph diff diagram and summary markdown for embedding in a PR description. Call this BEFORE creating the PR and include the returned markdown in the PR body.",
    parameters: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository in owner/repo format"
        },
        baseBranch: {
          type: "string",
          description: "Base branch (PR target, e.g. 'main')"
        },
        headBranch: {
          type: "string",
          description: "Head branch (PR source, e.g. 'feature/add-redis')"
        }
      },
      required: ["repo", "baseBranch", "headBranch"]
    }
  },
  {
    name: "radius_publish_custom_type_extension",
    description:
      "Compiles a Radius resource-type manifest into a local Bicep extension package using the extension's managed rad binary, so a generated app.bicep can reference the Radius.Resources/* custom types it declares. Use this instead of running `rad bicep publish-extension` directly. Produces a local .tgz (no registry, no authentication). Paths are confined to the workspace .radius/ directory.",
    parameters: {
      type: "object",
      properties: {
        manifestPath: {
          type: "string",
          description:
            "Path to the resource-type manifest, relative to the workspace .radius/ directory. Defaults to .radius/custom-types.yaml."
        },
        targetPath: {
          type: "string",
          description:
            "Path for the compiled extension package (.tgz), relative to the workspace .radius/ directory. Defaults to .radius/custom-types.tgz."
        }
      }
    }
  },
  {
    name: "radius_publish_recipe",
    description:
      "Publishes an authored Radius recipe Bicep file to the user's GitHub Container Registry (ghcr.io) using the extension's managed rad binary and the stored GitHub package credentials, so a generated custom type's recipe pack can reference it. Use this instead of running `rad bicep publish` directly. Prefer an Azure Verified Module (which needs no publish) when one matches the resource. The recipe file must live under the workspace .radius/ directory and the target must publish under the repository being modeled.",
    parameters: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "Path to the recipe Bicep file, relative to the workspace .radius/ directory (e.g. .radius/<type>-recipe.bicep)."
        },
        target: {
          type: "string",
          description:
            "OCI target under the repository being modeled, e.g. br:ghcr.io/<owner>/<repo>/<recipe>:<tag>."
        }
      },
      required: ["file", "target"]
    }
  },
  {
    name: "radius_deploy",
    description:
      "Deploys the Radius application by dispatching the same GitHub Actions deploy workflow the canvas Deploy button uses. The workflow checks out the target branch from GitHub, so commit and push any repair before calling this. Returns as soon as the deploy is started; poll the radius_deploy_status tool for the outcome. When repairing a failed deploy, pass the attemptId you were given: calling with no arguments repeats this session's last deploy as a brand new one, which leaves the repair loop and its remaining attempts behind.",
    parameters: {
      type: "object",
      properties: {
        attemptId: {
          type: "string",
          description:
            "Deploy attempt this call belongs to, as given in the repair handoff. Required when redeploying inside a repair loop; it pins the repository, environment, branch, provider, and app file to that attempt."
        },
        environment: {
          type: "string",
          description:
            "GitHub environment to deploy to. Defaults to the last deploy's environment."
        },
        repo: {
          type: "string",
          description:
            "Target repository in owner/repo format. Defaults to the last deploy's repository."
        },
        branch: {
          type: "string",
          description: "Branch to deploy. Defaults to the last deploy's branch."
        },
        provider: {
          type: "string",
          enum: ["azure", "aws"],
          description: "Cloud provider. Defaults to the last deploy's provider."
        },
        appFile: {
          type: "string",
          description:
            "Path to the application Bicep file. Defaults to .radius/app.bicep."
        }
      }
    }
  },
  {
    name: "radius_deploy_status",
    description:
      "Reports the current Radius deploy state (in_progress, success, or failed) with the workflow run URL and a bounded, fenced diagnostic block when it failed. Poll this after calling radius_deploy until it reports a terminal state.",
    parameters: {
      type: "object",
      properties: {
        attemptId: {
          type: "string",
          description:
            "Deploy attempt this call belongs to, as given in the repair handoff. Required while following a repair loop."
        },
        logLines: {
          type: "number",
          description:
            "How many trailing deploy log lines to include (default 40, max 200)."
        }
      }
    }
  }
]);
