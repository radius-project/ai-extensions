import type { RouteDeclaration } from "../../../src/server/route-table.js";

// T001: reviewed pre-lifecycle contracts, not aliases of live declarations.
// Update deliberately when an approved migration changes a retained contract.
export const CANVAS_BASELINE = {
  id: "radius",
  displayName: "Radius",
  description:
    "Application modeling and deployment: configure cloud credentials, generate app.bicep, visualize application graphs, view PR diffs, and create deployment environments.",
  inputSchema: {
    type: "object",
    properties: {
      page: {
        type: "string",
        enum: [
          "credentials",
          "graph",
          "planned",
          "graph-diff",
          "deployed",
          "environment",
          "deploying"
        ],
        description: "Which page to display",
        default: "graph"
      },
      repo: {
        type: "string",
        description:
          "Repository in owner/repo format to pre-select in dropdowns"
      },
      branch: {
        type: "string",
        description:
          "Branch to read .radius/app.bicep from. For the workspace repository, omit this to use the checked-out branch; an explicit different branch is fetched from GitHub. Defaults to 'main' for another repository."
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
  }
} as const;

export const ACTION_BASELINE = [
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
] as const;

export const TOOL_BASELINE = [
  {
    name: "radius_generate_app",
    description:
      "Starts Radius app.bicep authoring after checking whether the repository is modelable. For supported repositories, returns one JSON object with the radius-app-bicep skill name, repository path, packaged skill path, instruction, optional generator version, and optional ambiguity brief. For repositories without a Dockerfile, returns a Markdown refusal instead of invoking the skill handoff.",
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
    name: "radius_report_modeling_failure",
    description:
      "Reports a permanent radius-app-bicep authoring failure to the Radius Canvas attempt that requested it. Use only when the Canvas handoff supplies the exact instance, repository, branch, and attempt token; never report transient failures, cancellations, or a run that wrote app.bicep.",
    parameters: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          description: "Radius Canvas instance that requested modeling"
        },
        repo: {
          type: "string",
          description: "Repository supplied by the Canvas handoff"
        },
        branch: {
          type: "string",
          description: "Branch supplied by the Canvas handoff"
        },
        attemptToken: {
          type: "string",
          description: "Opaque attempt token supplied by the Canvas handoff"
        },
        error: {
          type: "string",
          description:
            "Actionable permanent-failure summary without credentials or secrets",
          maxLength: 4000
        }
      },
      required: ["instanceId", "repo", "branch", "attemptToken", "error"]
    }
  },
  {
    name: "radius_generate_pr_diff_markdown",
    description:
      "Generates a Mermaid application graph diff diagram and summary markdown for embedding in a PR description. Call this BEFORE creating the PR. Include the exact returned markdown at the top of the PR body only when the result contains a diff. If the result says the diff is unavailable or the tool fails, create the PR without a graph diff section, report the reason in chat, and do not open the graph-diff Canvas.",
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
            "Path to the resource-type manifest, relative to the workspace .radius/ directory. Defaults to .radius/custom-types.yaml, or to the staging directory when stagingDir is given."
        },
        targetPath: {
          type: "string",
          description:
            "Path for the compiled extension package (.tgz), relative to the workspace .radius/ directory. Defaults to .radius/custom-types.tgz, or to the staging directory when stagingDir is given."
        },
        stagingDir: {
          type: "string",
          description:
            "Staging directory of the modeling run, relative to the workspace .radius/ directory (for example .staging-<runId>). Pass the directory promote-app-model.mjs --begin printed so the published package lands with the rest of the run instead of in .radius/."
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
] as const;

// Column order: method, path, matcher, body, mutation policy, owner.
// All 52 declarations are ordered: the diagnostics template precedes the GET prefix.
const ROUTE_ROWS = [
  ["ANY", "/api/ping", "exact", "none", "none", "liveness-source"],
  ["GET", "/api/operations", "exact", "none", "none", "operations-status"],
  [
    "GET",
    "/api/operations/:operationId/diagnostics",
    "template",
    "none",
    "none",
    "operations-status"
  ],
  ["GET", "/api/operations/", "prefix", "none", "none", "operations-status"],
  [
    "POST",
    "/api/open-source",
    "exact",
    "json",
    "legacy-exempt",
    "liveness-source"
  ],
  [
    "POST",
    "/api/verify-azure-login",
    "exact",
    "json",
    "legacy-exempt",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/azure-cli-assist",
    "exact",
    "json",
    "legacy-exempt",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/verify-aws-login",
    "exact",
    "json",
    "legacy-exempt",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/run-remediation",
    "exact",
    "json",
    "nonce-required",
    "remediations"
  ],
  [
    "GET",
    "/api/credential-profiles",
    "exact",
    "none",
    "none",
    "identity-credentials"
  ],
  [
    "GET",
    "/api/github-identity",
    "exact",
    "none",
    "none",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/github-account",
    "exact",
    "json",
    "nonce-required",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/save-credential-profile",
    "exact",
    "json",
    "legacy-exempt",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/delete-credential-profile",
    "exact",
    "json",
    "legacy-exempt",
    "identity-credentials"
  ],
  [
    "POST",
    "/api/delete-environment",
    "exact",
    "json",
    "legacy-exempt",
    "environments"
  ],
  [
    "POST",
    "/api/bypass-verification",
    "exact",
    "json",
    "nonce-required",
    "environments"
  ],
  [
    "POST",
    "/api/operations",
    "exact",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/azure-auto-setup",
    "exact",
    "json",
    "legacy-exempt",
    "azure-discovery"
  ],
  [
    "GET",
    "/api/list-azure-app-registrations",
    "exact",
    "none",
    "none",
    "azure-discovery"
  ],
  [
    "GET",
    "/api/azure-app-serves-repos",
    "exact",
    "none",
    "none",
    "azure-discovery"
  ],
  ["POST", "/api/app-params", "exact", "json", "legacy-exempt", "environments"],
  [
    "POST",
    "/api/create-environment",
    "exact",
    "json",
    "legacy-exempt",
    "environments"
  ],
  ["GET", "/api/load-graph-stream", "exact", "none", "none", "graphs-planning"],
  ["GET", "/api/progress", "exact", "none", "none", "graphs-planning"],
  ["GET", "/api/deployed-graph", "exact", "none", "none", "graphs-planning"],
  ["GET", "/api/deploy-status", "exact", "none", "none", "deployments"],
  ["GET", "/api/deploy-notification", "exact", "none", "none", "deployments"],
  [
    "POST",
    "/api/load-graph",
    "exact",
    "json",
    "legacy-exempt",
    "graphs-planning"
  ],
  ["GET", "/api/list-environments", "exact", "none", "none", "environments"],
  ["GET", "/api/list-applications", "exact", "none", "none", "deployments"],
  ["GET", "/api/list-deployments", "exact", "none", "none", "deployments"],
  ["GET", "/api/delete-conflict", "exact", "none", "none", "deployments"],
  [
    "POST",
    "/api/delete-deployment",
    "exact",
    "json",
    "legacy-exempt",
    "deployments"
  ],
  [
    "POST",
    "/api/abandon-deployment",
    "exact",
    "json",
    "nonce-required",
    "deployments"
  ],
  ["GET", "/api/verify-status", "exact", "none", "none", "environments"],
  ["GET", "/api/user-repos", "exact", "none", "none", "repositories"],
  [
    "POST",
    "/api/repo-branches",
    "exact",
    "json",
    "legacy-exempt",
    "repositories"
  ],
  [
    "POST",
    "/api/plan-graph",
    "exact",
    "json",
    "legacy-exempt",
    "graphs-planning"
  ],
  [
    "POST",
    "/api/discover-branches",
    "exact",
    "json",
    "legacy-exempt",
    "repositories"
  ],
  [
    "POST",
    "/api/diff-branches",
    "exact",
    "json",
    "legacy-exempt",
    "graphs-planning"
  ],
  ["POST", "/api/deploy", "exact", "json", "legacy-exempt", "deployments"],
  [
    "POST",
    "/api/deploy-reset",
    "exact",
    "none",
    "legacy-exempt",
    "deployments"
  ],
  [
    "POST",
    "/api/discover",
    "exact",
    "json",
    "legacy-exempt",
    "azure-discovery"
  ],
  [
    "POST",
    "/api/operations/:operationId/resume/:code",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/abandon",
    "template",
    "none",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/dismiss",
    "template",
    "none",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/stop",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/continue",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/cancel-workflow",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/rollback",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/exit",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ],
  [
    "POST",
    "/api/operations/:operationId/retry/:retryKind",
    "template",
    "json",
    "nonce-required",
    "operations-status"
  ]
] as const satisfies readonly (readonly [
  RouteDeclaration["method"],
  string,
  RouteDeclaration["match"],
  RouteDeclaration["bodyPolicy"],
  RouteDeclaration["mutationPolicy"],
  RouteDeclaration["owner"]
])[];

export const ROUTE_BASELINE = Object.freeze(
  ROUTE_ROWS.map(([method, path, match, bodyPolicy, mutationPolicy, owner]) =>
    Object.freeze({ method, path, match, bodyPolicy, mutationPolicy, owner })
  )
);

// The legacy workflow has no lifecycle/execution version input. Artifact
// versions are independent: command results use a string, progress a number.
export const WORKFLOW_BASELINE = {
  dispatcher: "run-rad-commands.yml",
  providers: ["run-rad-commands-azure.yml", "run-rad-commands-aws.yml"],
  dispatchInputs: {
    environment: {
      description: "GitHub Environment name",
      required: true,
      default: "{{ENV}}"
    },
    image: {
      description:
        "Container image passed only when the application template declares the image parameter",
      required: false,
      default: ""
    },
    rad_commands: {
      description:
        "rad CLI command string, or JSON array of command strings (rad prefix omitted; split on whitespace, so arguments with spaces are not supported). Overrides the default deploy.",
      required: false,
      default: ""
    }
  },
  concurrency: {
    group: "radius-routes-gateway-${{ github.repository }}",
    "cancel-in-progress": false
  }
} as const;

export const LEGACY_RESULT_BASELINE = {
  command: {
    artifact: "rad-commands-result",
    file: "rad-commands-result.json",
    schemaVersion: "1.0",
    fields: [
      "schemaVersion",
      "outcome",
      "exitCode",
      "environment",
      "commandsRequested",
      "commandsRan",
      "commands"
    ]
  },
  progress: {
    artifactPrefix: "radius-deploy-status-",
    file: "deploy-progress.json",
    schemaVersion: 1
  }
} as const;

export const LEGACY_PROGRESS_BASELINE = {
  schemaVersion: 1,
  application: "shop",
  environment: "dev",
  runId: 123,
  sequence: 1,
  updatedAt: "2026-09-15T20:00:00Z",
  state: "succeeded",
  resources: []
} as const;
