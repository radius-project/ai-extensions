// Extension: radius — SDK entry (joinSession wiring).
//
// The thin Copilot-canvas adapter entry point: it registers the canvas + tools
// with the SDK and delegates every meaningful operation to @radius-project/core
// use-case or a sibling adapter module (server/pages/deploy/infra/gh). It owns
// no product logic — only the SDK surface and process-lifecycle hardening.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync, watch as fsWatch } from "node:fs";
import { dirname } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import {
  computeGraphDiff,
  fetchBicepFromRepo,
  filterGraphVisualizationResources
} from "@radius-project/core";
import {
  buildGraphViaRad,
  ensureRadBinary,
  runRadBicepPublishExtension,
  runRadBicepPublish
} from "@radius-project/adapter-shared";
import { github } from "./gh.js";
import {
  defaultBranchForState,
  detectWorkspaceContext,
  fetchWorkspaceBicep,
  isWorkspaceSelection,
  parseRepoFromRemote,
  toSafeRepoRelPath,
  workspaceFileExists
} from "./workspace.js";
import { radArtifactsDirForSelection } from "./remote-rad-artifacts.js";
import {
  selectDeployEntry,
  buildDeployPayload,
  validateDeployPayload,
  validateDeployAttempt,
  summarizeDeployStatus
} from "./deploy-tools.js";
import { generateAzureOIDC, generateAWSOIDC } from "./infra.js";
import {
  servers,
  getOrCreateServer,
  getLastWebviewActivityAt,
  isCurrentSourceRefToken,
  setAppBicepHandoff,
  setDeployRepairHandoff,
  setSessionPromptHandler,
  setOpenSourceHandler
} from "./server.js";
import type { CanvasServerEntry } from "./server.js";
import type { CanvasGraphResource, CanvasState } from "./shared.js";
import {
  getSourceRefResources,
  prepareSourceRefResources,
  setSourceRefResources,
  updateSourceRefs
} from "./source-refs.js";
import {
  evaluateAppBicepHook,
  GRAPH_PAGES,
  DEFAULT_CANVAS_PAGE,
  appBicepHandoffPrompt,
  deployRepairHandoffPrompt
} from "./hooks.js";
import { radiusAppBicepSkill } from "./skill.js";
import { reloadCanvasInstance } from "./canvas-lifecycle.js";
import {
  announcementOptions,
  onOperationTerminal,
  setupInFlight,
  summarize
} from "./operations.js";
import { renderPrDiffMarkdown } from "./pr-diff-markdown.js";
import { withGhcrDockerConfig } from "./ghcr.js";
import {
  resolveExistingRadiusArtifact,
  resolveRadiusArtifactTarget,
  validateGhcrTargetForRepo
} from "./publish-targets.js";

const execFileAsync = promisify(execFile);

interface CanvasContext {
  extensionId: string;
  canvasId: string;
  instanceId: string;
  input?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphResources(value: unknown): CanvasGraphResource[] {
  if (!Array.isArray(value)) return [];
  return value.map((resource) => {
    const fields = record(resource);
    return {
      ...fields,
      id: optionalString(fields.id),
      name: optionalString(fields.name),
      type: optionalString(fields.type)
    };
  });
}

async function workspaceState(): Promise<CanvasState> {
  const workspace = await detectWorkspaceContext(session);
  return {
    workspacePath: workspace.workspacePath,
    workspaceRepo: workspace.repo,
    workspaceBranch: workspace.branch,
    contextRepo: workspace.repo,
    contextBranch: workspace.branch
  };
}

async function fetchBicepForBranch(
  repo: string,
  branch: string,
  state: CanvasState
): Promise<string | null> {
  if (isWorkspaceSelection(state, repo, branch)) {
    const local = await fetchWorkspaceBicep(state, repo, branch);
    if (local) return local;
  }
  return await fetchBicepFromRepo(github, repo, branch);
}

// When a graph canvas is opened but no .radius/app.bicep exists, hand the work
// off to the agent/skill. The built-in open_canvas tool is NOT gated by
// onPreToolUse, so this is the only place the extension can trigger generation
// instead of surfacing a dead-end in the canvas. Fire-and-forget
// (session.send resolves only when the agent finishes, and we are mid-open), and
// guard so we send at most once per repo+branch combination.
async function maybeHandoffAppBicep(
  entry: CanvasServerEntry,
  page: string,
  ctx: CanvasContext
): Promise<void> {
  try {
    if (!GRAPH_PAGES.has(page)) return;
    const state = entry.state;
    const input = record(ctx.input);
    const repo = state.contextRepo || optionalString(input.repo);
    if (!repo) return;

    let branches;
    if (page === "graph-diff") {
      branches = [
        optionalString(input.baseBranch),
        optionalString(input.headBranch)
      ].filter(Boolean);
      // Match the onPreToolUse hook's graphTriggerTargets: when no branches
      // are supplied, use [undefined] so both paths resolve to the default
      // branch below and compute the same dedupe key.
      if (!branches.length) branches = [undefined];
    } else {
      // Honor an explicit branch from open_canvas input; fall back to the
      // resolved context branch (the session worktree branch for the
      // workspace repo) so we never default the session repo to main.
      branches = [optionalString(input.branch) || state.contextBranch];
    }
    branches = branches.map((b) => b || defaultBranchForState(state));

    const key = `${repo}::${branches.join(",")}`;
    if (state.appBicepHandoffKey === key) return; // already handed off for this target
    // Claim the key before the async fetch so a concurrent canvas-open and
    // server-route trigger for the same target cannot both pass the guard
    // and double-handoff (TOCTOU). If bicep turns out to exist we simply
    // skip the send below; the claimed key is harmless.
    state.appBicepHandoffKey = key;

    const found = await Promise.all(
      branches.map(async (branch) => {
        try {
          return !!(await fetchBicepForBranch(repo, branch, state));
        } catch {
          return false;
        }
      })
    );
    if (found.some(Boolean)) return; // at least one branch has it → nothing to do

    try {
      Promise.resolve(
        session.send(appBicepHandoffPrompt(repo, page, branches))
      ).catch(() => {});
    } catch {
      /* session.send unavailable → ignore */
    }
  } catch {
    /* never block canvas open on handoff failure */
  }
}

// ─── Canvas + Tools ───────────────────────────────────────────────────────────
const session = await joinSession({
  canvases: [
    createCanvas({
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
            default: DEFAULT_CANVAS_PAGE
          },
          repo: {
            type: "string",
            description:
              "Repository in owner/repo format to pre-select in dropdowns"
          },
          branch: {
            type: "string",
            description:
              "Branch to read app.bicep and the graph from (e.g. 'main'). Defaults to the workspace branch, or 'main' for a repository that is not checked out locally."
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
      },
      actions: [
        {
          name: "configure_oidc",
          description:
            "Configure OIDC identity federation for Azure or AWS and display the setup commands",
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                enum: ["azure", "aws"],
                description: "Cloud provider to configure"
              },
              tenantId: { type: "string", description: "Azure Tenant ID" },
              tenantName: {
                type: "string",
                description: "Azure Tenant display name"
              },
              subscriptionId: {
                type: "string",
                description: "Azure Subscription ID"
              },
              subscriptionName: {
                type: "string",
                description: "Azure Subscription display name"
              },
              clientId: {
                type: "string",
                description: "Azure Client ID (App Registration)"
              },
              clientName: {
                type: "string",
                description: "Azure App Registration display name"
              },
              accountId: { type: "string", description: "AWS Account ID" },
              accountName: {
                type: "string",
                description: "AWS Account alias or display name"
              },
              region: { type: "string", description: "AWS Region" }
            },
            required: ["provider"]
          },
          handler: async (ctx) => {
            const entry = await getOrCreateServer(
              ctx.instanceId,
              "credentials"
            );
            const data = ctx.input || {};
            const result =
              data.provider === "azure" ?
                generateAzureOIDC(data)
              : generateAWSOIDC(data);
            if (data.provider === "azure") {
              entry.state.oidcAzure = {
                ...result,
                tenantId: data.tenantId || "",
                tenantName: data.tenantName || "",
                subscriptionId: data.subscriptionId || "",
                subscriptionName: data.subscriptionName || "",
                clientId: data.clientId || "",
                clientName: data.clientName || ""
              };
            } else {
              entry.state.oidcAws = {
                ...result,
                accountId: data.accountId || "",
                accountName: data.accountName || "",
                region: data.region || ""
              };
            }
            entry.url = `${entry.baseUrl}/?page=environment`;
            return { message: result.message, url: entry.url };
          }
        },
        {
          name: "render_graph",
          description:
            "Render the application graph from ApplicationGraphResource data",
          inputSchema: {
            type: "object",
            properties: {
              resources: {
                type: "array",
                description:
                  "Array of ApplicationGraphResource objects with id, name, type, and connections",
                items: { type: "object" }
              }
            }
          },
          handler: async (ctx) => {
            const entry = await getOrCreateServer(ctx.instanceId, "graph");
            const input = record(ctx.input);
            // Populate the active worktree context (repo/branch/path) so the
            // graph page defaults to the session branch and reads the worktree
            // app.bicep — matching the open() handler.
            Object.assign(entry.state, await workspaceState());
            if (Array.isArray(input.resources)) {
              const context = {
                repo:
                  entry.state.contextRepo || entry.state.workspaceRepo || "",
                branch:
                  entry.state.contextBranch || entry.state.workspaceBranch || ""
              };
              // Filter out implementation-detail resources (containerImages
              // and their ghcr-registry-creds secret) so they are never
              // rendered — matching the buildGraphViaRad data path.
              const resources = filterGraphVisualizationResources(
                graphResources(input.resources)
              );
              setSourceRefResources(entry, "graph", resources, context);
              setSourceRefResources(entry, "planned", resources, context);
              entry.state.graphLoaded = true;
              // No authoritative app.bicep fetch on this path — clear any
              // provenance flag left over from a prior HTTP load so the page
              // falls back to (fail-closed) repo+branch matching against the
              // worktree context rather than trusting a stale value.
              delete entry.state.graphFromWorkspace;
              delete entry.state.plannedFromWorkspace;
            }
            entry.state.activeGraphView = "graph";
            entry.url = `${entry.baseUrl}/?page=graph`;
            return { message: "Graph rendered", url: entry.url };
          }
        },
        {
          name: "render_graph_diff",
          description:
            "Render a diff graph showing changes between base and head application models in a PR",
          inputSchema: {
            type: "object",
            properties: {
              baseResources: {
                type: "array",
                description: "Base branch resources",
                items: { type: "object" }
              },
              headResources: {
                type: "array",
                description: "Head branch resources",
                items: { type: "object" }
              },
              repo: {
                type: "string",
                description: "Repository in owner/repo format"
              },
              baseBranch: {
                type: "string",
                description: "Base branch represented by baseResources"
              },
              headBranch: {
                type: "string",
                description: "Head branch represented by headResources"
              }
            },
            required: [
              "baseResources",
              "headResources",
              "repo",
              "baseBranch",
              "headBranch"
            ]
          },
          handler: async (ctx) => {
            const entry = await getOrCreateServer(ctx.instanceId, "graph-diff");
            const input = record(ctx.input);
            // Compute diff from base/head if provided
            if (
              Array.isArray(input.baseResources) &&
              Array.isArray(input.headResources)
            ) {
              // Filter both sides before diffing so containerImages and
              // their ghcr-registry-creds secret never appear in the diff.
              const baseResources = filterGraphVisualizationResources(
                graphResources(input.baseResources)
              );
              const headResources = filterGraphVisualizationResources(
                graphResources(input.headResources)
              );
              // Compute diff using the shared algorithm (see computeGraphDiff).
              const diffResources = computeGraphDiff(
                baseResources,
                headResources
              );
              setSourceRefResources(entry, "diff", diffResources, {
                repo: optionalString(input.repo),
                baseBranch: optionalString(input.baseBranch),
                headBranch: optionalString(input.headBranch)
              });
              entry.state.diffTargetRepo = optionalString(input.repo);
              entry.state.diffBase = optionalString(input.baseBranch);
              entry.state.diffHead = optionalString(input.headBranch);
            }
            entry.state.activeGraphView = "diff";
            entry.url = `${entry.baseUrl}/?page=graph-diff`;
            return { message: "Diff graph rendered", url: entry.url };
          }
        },
        {
          name: "create_environment",
          description:
            "Create a GitHub environment, private GHCR state package, cloud settings, and verification/deploy workflows",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Environment name (e.g. production)"
              },
              provider: {
                type: "string",
                enum: ["azure", "aws"],
                description: "Cloud provider"
              },
              repo: {
                type: "string",
                description: "Repository in owner/repo format"
              },
              clientId: {
                type: "string",
                description: "Azure application (client) ID"
              },
              tenantId: { type: "string", description: "Azure tenant ID" },
              subscriptionId: {
                type: "string",
                description: "Azure Subscription ID"
              },
              resourceGroup: {
                type: "string",
                description: "Azure Resource Group"
              },
              location: { type: "string", description: "Azure Location" },
              roleArn: {
                type: "string",
                description: "AWS IAM role ARN used by GitHub OIDC"
              },
              accountId: { type: "string", description: "AWS Account ID" },
              region: { type: "string", description: "AWS Region" },
              cluster: {
                type: "string",
                description: "AKS or EKS cluster name"
              },
              vpcId: { type: "string", description: "Optional AWS VPC ID" },
              subnetIds: {
                type: "string",
                description: "Optional comma-separated AWS subnet IDs"
              }
            },
            required: ["name", "provider", "repo"]
          },
          handler: async (ctx) => {
            const entry = await getOrCreateServer(
              ctx.instanceId,
              "environment"
            );
            const data = record(ctx.input);
            try {
              const provider = optionalString(data.provider);
              const required =
                provider === "azure" ?
                  [
                    "clientId",
                    "tenantId",
                    "subscriptionId",
                    "resourceGroup",
                    "cluster"
                  ]
                : ["roleArn", "accountId", "region", "cluster"];
              const missing = required.filter((name) => !data[name]);
              if (missing.length > 0) {
                throw new Error(
                  `Missing required ${provider} environment inputs: ${missing.join(", ")}.`
                );
              }
              const response = await fetch(
                `${entry.baseUrl}/api/create-environment`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ...data,
                    environment: optionalString(data.name)
                  })
                }
              );
              const result = record(await response.json());
              if (!response.ok && !result.error) {
                result.error = `Environment setup failed with HTTP ${response.status}.`;
              }
              entry.state.envResult = result;
            } catch (e) {
              entry.state.envResult = { error: errorMessage(e) };
            }
            entry.url = `${entry.baseUrl}/?page=environment`;
            return entry.state.envResult;
          }
        },
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
          },
          handler: async (ctx) => {
            const entry = await getOrCreateServer(ctx.instanceId);
            const input = record(ctx.input);
            const result = getSourceRefResources(
              entry,
              optionalString(input.view) || undefined
            );
            if (!result.ready) {
              return {
                ready: false,
                resources: [],
                message:
                  "Graph has not been built yet. Open the graph page and wait for it to load, then try again."
              };
            }
            const missingOnly = input.missingOnly !== false;
            if (!result.context) {
              return {
                ready: false,
                resources: [],
                message: "Graph context is unavailable."
              };
            }
            const resources =
              missingOnly ?
                result.resources.filter(
                  (r) =>
                    !r.codeReference &&
                    !r.type?.toLowerCase().includes("applications")
                )
              : result.resources;
            return {
              ready: true,
              view: result.view,
              contextToken: result.context.token,
              repo: result.context.repo,
              branch: result.context.branch || null,
              baseBranch: result.context.baseBranch || null,
              headBranch: result.context.headBranch || null,
              resources: resources.map((r) => ({
                name: r.name,
                type: r.type,
                id: r.id,
                codeReference: r.codeReference || null
              }))
            };
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
                description:
                  "Graph context token returned by get_graph_resources"
              }
            },
            required: ["contextToken", "refs"]
          },
          handler: async (ctx) => {
            const entry = await getOrCreateServer(ctx.instanceId);
            const input = record(ctx.input);
            const contextToken = input.contextToken;
            if (!contextToken || typeof contextToken !== "string") {
              return {
                error: "contextToken is required",
                updated: 0,
                queued: 0,
                skipped: 0
              };
            }
            const refs = input.refs;
            if (!Array.isArray(refs) || refs.length === 0) {
              return {
                error: "refs array is required",
                updated: 0,
                queued: 0,
                skipped: 0
              };
            }
            const parsedRefs = refs.flatMap((value) => {
              const fields = record(value);
              const id = optionalString(fields.id);
              const codeReference = optionalString(fields.codeReference);
              return id && codeReference ? [{ id, codeReference }] : [];
            });
            const result = updateSourceRefs(entry, contextToken, parsedRefs);
            if (result.error) return result;
            const page = result.view === "diff" ? "graph-diff" : result.view;
            entry.url = `${
              entry.baseUrl
            }/?page=${page}&sourceRefs=${Date.now()}`;
            await reloadCanvasInstance(session, ctx, { page });
            return {
              ...result,
              message: `Updated ${result.updated} resource(s); queued ${result.queued}; skipped ${result.skipped}.`,
              url: entry.url
            };
          }
        }
      ],
      open: async (ctx) => {
        const input = record(ctx.input);
        const page = optionalString(input.page) || DEFAULT_CANVAS_PAGE;
        const entry = await getOrCreateServer(ctx.instanceId, page);
        entry.state.activeGraphView =
          page === "graph-diff" ? "diff"
          : page === "planned" ? "planned"
          : page === "graph" ? "graph"
          : entry.state.activeGraphView;
        const workspace = await workspaceState();
        Object.assign(entry.state, workspace);
        // If a repo is passed in input, set it as context for all pages
        const inputRepo = optionalString(input.repo);
        if (inputRepo) {
          entry.state.contextRepo = inputRepo;
          if (inputRepo === workspace.workspaceRepo) {
            entry.state.contextBranch = workspace.workspaceBranch;
          } else {
            entry.state.contextBranch = optionalString(input.branch) || "main";
          }
        } else if (!entry.state.contextRepo && session.workspacePath) {
          // Try to detect repo from workspace git remote
          try {
            const { stdout } = await execFileAsync(
              "git",
              ["-C", session.workspacePath, "remote", "get-url", "origin"],
              { timeout: 5000, encoding: "utf8" }
            );
            const remoteUrl = stdout.trim();
            const repo = parseRepoFromRemote(remoteUrl);
            if (repo) {
              entry.state.contextRepo = repo;
            }
          } catch (e) {
            /* ignore */
          }
        }

        if (page === "graph" || page === "planned") {
          prepareSourceRefResources(entry, page, {
            repo: entry.state.contextRepo || "",
            branch: entry.state.contextBranch || ""
          });
        }

        // Auto-compare when baseBranch and headBranch are provided (PR diff mode)
        if (
          page === "graph-diff" &&
          optionalString(input.baseBranch) &&
          optionalString(input.headBranch)
        ) {
          const baseBranch = optionalString(input.baseBranch);
          const headBranch = optionalString(input.headBranch);
          const repo = entry.state.contextRepo || inputRepo;
          const sourceRefContext = prepareSourceRefResources(entry, "diff", {
            repo,
            baseBranch,
            headBranch
          });
          entry.state.diffBase = baseBranch;
          entry.state.diffHead = headBranch;
          entry.state.diffTargetRepo = repo;
          delete entry.state.diffError;
          try {
            // Fetch the committed/persisted app.bicep on each branch.
            // Generation is owned by the radius-app-bicep skill.
            let [baseContent, headContent] = await Promise.all([
              fetchBicepForBranch(repo, baseBranch, entry.state),
              fetchBicepForBranch(repo, headBranch, entry.state)
            ]);

            const { dir: baseRadArtifactsDir, remote: baseRadArtifactsRemote } =
              await radArtifactsDirForSelection({
                isLocal: isWorkspaceSelection(entry.state, repo, baseBranch),
                state: entry.state,
                github,
                repo,
                branch: baseBranch,
                bicepRepoPath: ".radius/app.bicep",
                log: (m) => {
                  try {
                    session.log(m);
                  } catch {}
                }
              });
            const { dir: headRadArtifactsDir, remote: headRadArtifactsRemote } =
              await radArtifactsDirForSelection({
                isLocal: isWorkspaceSelection(entry.state, repo, headBranch),
                state: entry.state,
                github,
                repo,
                branch: headBranch,
                bicepRepoPath: ".radius/app.bicep",
                log: (m) => {
                  try {
                    session.log(m);
                  } catch {}
                }
              });
            const baseResources = await buildGraphViaRad(
              baseContent || "",
              ".radius/app.bicep",
              {
                log: (m) => {
                  try {
                    session.log(m);
                  } catch {}
                },
                radArtifactsDir: baseRadArtifactsDir,
                cleanupRadArtifactsDir: baseRadArtifactsRemote
              }
            );
            const headResources = await buildGraphViaRad(
              headContent || "",
              ".radius/app.bicep",
              {
                log: (m) => {
                  try {
                    session.log(m);
                  } catch {}
                },
                radArtifactsDir: headRadArtifactsDir,
                cleanupRadArtifactsDir: headRadArtifactsRemote
              }
            );
            // Compute diff using the shared algorithm (see computeGraphDiff).
            const diffResources = computeGraphDiff(
              baseResources,
              headResources
            );
            setSourceRefResources(
              entry,
              "diff",
              diffResources,
              {
                repo,
                baseBranch,
                headBranch
              },
              sourceRefContext.token
            );
            // Flag if no changes detected
            const hasChanges = diffResources.some(
              (r) => r.diffStatus !== "unchanged"
            );
            entry.state.diffNoChanges = !hasChanges;
          } catch (e) {
            if (
              isCurrentSourceRefToken(
                entry.state,
                "diff",
                sourceRefContext.token
              )
            ) {
              entry.state.diffError = errorMessage(e);
            }
          }
        }

        await maybeHandoffAppBicep(entry, page, {
          extensionId: ctx.extensionId,
          canvasId: ctx.canvasId,
          instanceId: ctx.instanceId,
          input
        });

        return { title: "Radius", url: entry.url };
      },
      onClose: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (entry) {
          servers.delete(ctx.instanceId);
          await new Promise<void>((resolve) =>
            entry.server.close(() => resolve())
          );
        }
      }
    })
  ],
  tools: [
    {
      name: "radius_configure_oidc",
      description:
        "Opens the Radius OIDC configuration canvas to set up Azure or AWS identity federation for GitHub Actions",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: ["azure", "aws"],
            description: "Cloud provider to configure"
          }
        }
      },
      handler: async (_args) => {
        return "Open the radius canvas with page 'environment' to configure OIDC and deploy. Use open_canvas with canvasId 'radius' and input { page: 'environment' }.";
      }
    },
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
      },
      handler: async (args) => {
        return radiusAppBicepSkill(args.repoPath);
      }
    },
    {
      name: "radius_render_graph",
      description:
        "Renders an interactive application graph visualization from resource data",
      parameters: {
        type: "object",
        properties: {
          resources: {
            type: "array",
            description: "Array of ApplicationGraphResource objects",
            items: { type: "object" }
          }
        },
        required: ["resources"]
      },
      handler: async (args) => {
        // Filter for an accurate count; the render_graph action re-applies
        // the same visualization filter before display.
        const resources = filterGraphVisualizationResources(
          args.resources || []
        );
        return `Graph data received with ${resources.length} resources. Use invoke_canvas_action with actionName 'render_graph' and the resources data to display the graph.`;
      }
    },
    {
      name: "radius_render_graph_diff",
      description:
        "Renders a diff visualization comparing base and head application graphs for a pull request",
      parameters: {
        type: "object",
        properties: {
          baseResources: {
            type: "array",
            description: "Base branch resources",
            items: { type: "object" }
          },
          headResources: {
            type: "array",
            description: "Head branch resources",
            items: { type: "object" }
          },
          repo: {
            type: "string",
            description: "Repository in owner/repo format"
          },
          baseBranch: {
            type: "string",
            description: "Base branch represented by baseResources"
          },
          headBranch: {
            type: "string",
            description: "Head branch represented by headResources"
          }
        },
        required: [
          "baseResources",
          "headResources",
          "repo",
          "baseBranch",
          "headBranch"
        ]
      },
      handler: async (args) => {
        // Filter both sides before diffing so containerImages and their
        // ghcr-registry-creds secret never appear in the diff or its counts.
        const baseResources = filterGraphVisualizationResources(
          args.baseResources
        );
        const headResources = filterGraphVisualizationResources(
          args.headResources
        );
        // Compute diff using the shared algorithm (see computeGraphDiff).
        const diffResources = computeGraphDiff(baseResources, headResources);
        return JSON.stringify({
          message: `Diff computed: ${
            diffResources.filter((r) => r.diffStatus === "added").length
          } added, ${
            diffResources.filter((r) => r.diffStatus === "removed").length
          } removed, ${
            diffResources.filter((r) => r.diffStatus === "modified").length
          } modified`,
          resources: diffResources,
          instruction: `Use invoke_canvas_action with actionName 'render_graph_diff' and pass these resources with repo '${args.repo}', baseBranch '${args.baseBranch}', and headBranch '${args.headBranch}'.`
        });
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
      },
      handler: async (args) => {
        const { repo, baseBranch, headBranch } = args;
        try {
          const state = await workspaceState();
          let [baseContent, headContent] = await Promise.all([
            fetchBicepForBranch(repo, baseBranch, state),
            fetchBicepForBranch(repo, headBranch, state)
          ]);

          if (!baseContent && !headContent) {
            return `.radius/app.bicep does not exist on ${baseBranch} or ${headBranch} yet. A PR diff compares the committed model on each branch, so author it with the Radius app-bicep skill (run the radius_generate_app tool) and make sure each branch you are comparing contains the committed file, then re-run this tool.`;
          }

          const { dir: baseRadArtifactsDir, remote: baseRadArtifactsRemote } =
            await radArtifactsDirForSelection({
              isLocal: isWorkspaceSelection(state, repo, baseBranch),
              state,
              github,
              repo,
              branch: baseBranch,
              bicepRepoPath: ".radius/app.bicep",
              log: (m) => {
                try {
                  session.log(m);
                } catch {}
              }
            });
          const { dir: headRadArtifactsDir, remote: headRadArtifactsRemote } =
            await radArtifactsDirForSelection({
              isLocal: isWorkspaceSelection(state, repo, headBranch),
              state,
              github,
              repo,
              branch: headBranch,
              bicepRepoPath: ".radius/app.bicep",
              log: (m) => {
                try {
                  session.log(m);
                } catch {}
              }
            });
          const baseResources = await buildGraphViaRad(
            baseContent || "",
            ".radius/app.bicep",
            {
              log: (m) => {
                try {
                  session.log(m);
                } catch {}
              },
              radArtifactsDir: baseRadArtifactsDir,
              cleanupRadArtifactsDir: baseRadArtifactsRemote
            }
          );
          const headResources = await buildGraphViaRad(
            headContent || "",
            ".radius/app.bicep",
            {
              log: (m) => {
                try {
                  session.log(m);
                } catch {}
              },
              radArtifactsDir: headRadArtifactsDir,
              cleanupRadArtifactsDir: headRadArtifactsRemote
            }
          );

          // Compute diff using the shared algorithm (see computeGraphDiff)
          // and render it as PR-embeddable Markdown (see renderPrDiffMarkdown).
          const diffResources = computeGraphDiff(baseResources, headResources);
          return renderPrDiffMarkdown(diffResources, baseBranch, headBranch);
        } catch (err) {
          return `⚠️ Could not generate app graph diff: ${errorMessage(err)}`;
        }
      }
    },
    {
      name: "radius_create_environment",
      description:
        "Opens the GitHub environment creation canvas to set up a deployment environment with cloud provider secrets",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            enum: ["azure", "aws"],
            description: "Cloud provider"
          },
          repo: {
            type: "string",
            description: "Repository in owner/repo format"
          }
        }
      },
      handler: async (_args) => {
        return "Open the radius canvas with page 'environment' to create a GitHub environment. Use open_canvas with canvasId 'radius' and input { page: 'environment' }.";
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
      },
      handler: async (args) => {
        try {
          const { workspacePath } = await workspaceState();
          const fromFile = resolveExistingRadiusArtifact(
            workspacePath,
            args.manifestPath,
            ".radius/custom-types.yaml"
          );
          const target = resolveRadiusArtifactTarget(
            workspacePath,
            args.targetPath,
            ".radius/custom-types.tgz"
          );
          if (!existsSync(fromFile)) {
            return `Resource-type manifest not found at ${fromFile}. Author it first (see the radius-app-bicep custom-resource-types reference), then re-run this tool.`;
          }
          await runRadBicepPublishExtension({
            fromFile,
            target,
            log: (m) => {
              try {
                session.log(m);
              } catch {}
            }
          });
          return `Published custom-type extension to ${target}. Reference it from .radius/bicepconfig.json and recompile the app graph through the Radius canvas.`;
        } catch (err) {
          return `⚠️ Could not publish the custom-type extension: ${errorMessage(err)}`;
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
      },
      handler: async (args) => {
        try {
          const { workspacePath, workspaceRepo } = await workspaceState();
          const targetError = validateGhcrTargetForRepo(
            args.target,
            workspaceRepo
          );
          if (targetError) return targetError;
          const file = resolveExistingRadiusArtifact(
            workspacePath,
            args.file,
            null
          );
          if (!existsSync(file)) {
            return `Recipe file not found at ${file}. Author it first (see the radius-app-bicep custom-resource-types reference), then re-run this tool.`;
          }
          const target = String(args.target).trim();
          const published = await withGhcrDockerConfig((env) =>
            runRadBicepPublish({
              file,
              target,
              env,
              log: (m) => {
                try {
                  session.log(m);
                } catch {}
              }
            })
          );
          return `Published recipe to ${String(published)}. Reference it from the recipe pack (Radius.Core/recipePacks) for the custom type.`;
        } catch (err) {
          return `⚠️ Could not publish the recipe: ${errorMessage(err)}`;
        }
      }
    },
    {
      name: "radius_deploy",
      description:
        "Deploys the Radius application by dispatching the same GitHub Actions deploy workflow the canvas Deploy button uses. The workflow checks out the target branch from GitHub, so commit and push any repair before calling this. Returns as soon as the deploy is started; poll the radius_deploy_status tool for the outcome. With no arguments it repeats the last deploy from this session, which is what a redeploy after repairing .radius/app.bicep needs.",
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
            description:
              "Branch to deploy. Defaults to the last deploy's branch."
          },
          provider: {
            type: "string",
            enum: ["azure", "aws"],
            description:
              "Cloud provider. Defaults to the last deploy's provider."
          },
          appFile: {
            type: "string",
            description:
              "Path to the application Bicep file. Defaults to .radius/app.bicep."
          }
        }
      },
      handler: async (args = {}) => {
        try {
          const entry = selectDeployEntry(servers, args.attemptId);
          if (!entry) {
            return args.attemptId ?
                `Deploy attempt "${args.attemptId}" is no longer active, so this redeploy was not started. A newer deploy may have replaced it; ask the user which deploy to repair rather than retrying against a different one.`
              : "No Radius canvas session is open, so there is no deploy to repeat. Open the Radius canvas and start a deploy first.";
          }
          const retarget = validateDeployAttempt(args, entry.state || {});
          if (retarget) return retarget;
          const payload = buildDeployPayload(args, entry.state || {});
          const invalid = validateDeployPayload(payload);
          if (invalid) return invalid;
          const response = await fetch(`${entry.baseUrl}/api/deploy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
          const result = record(await response.json().catch(() => ({})));
          if (!response.ok || result.error) {
            return `⚠️ Could not start the deploy: ${
              result.error || `HTTP ${response.status}`
            }`;
          }
          return `Deploy of ${payload.targetRepo}${
            payload.branch ? ` (branch ${payload.branch})` : ""
          } to environment "${payload.environment}" started. It deploys ${
            payload.branch || "that branch"
          } as it exists on GitHub, so confirm any repair was pushed. Poll the radius_deploy_status tool until it reports success or failed.`;
        } catch (err) {
          return `⚠️ Could not start the deploy: ${errorMessage(err)}`;
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
      },
      handler: async (args = {}) => {
        try {
          const entry = selectDeployEntry(servers, args.attemptId);
          if (!entry) {
            return args.attemptId ?
                `Deploy attempt "${args.attemptId}" is no longer active, so its status is unavailable.`
              : "No Radius canvas session is open, so there is no deploy status to report.";
          }
          const response = await fetch(`${entry.baseUrl}/api/deploy-status`);
          if (!response.ok)
            return `⚠️ Could not read the deploy status: HTTP ${response.status}`;
          const d = record(await response.json().catch(() => ({})));
          return JSON.stringify(
            summarizeDeployStatus(
              {
                status: optionalString(d.status),
                errorKind: optionalString(d.errorKind) || null,
                deployRunUrl: optionalString(d.deployRunUrl) || null,
                startedAt:
                  (
                    typeof d.startedAt === "string" ||
                    typeof d.startedAt === "number"
                  ) ?
                    d.startedAt
                  : null,
                finishedAt:
                  (
                    typeof d.finishedAt === "string" ||
                    typeof d.finishedAt === "number"
                  ) ?
                    d.finishedAt
                  : null,
                error: d.error,
                logs: d.logs
              },
              args.logLines
            )
          );
        } catch (err) {
          return `⚠️ Could not read the deploy status: ${errorMessage(err)}`;
        }
      }
    }
  ],
  hooks: {
    // Guard the graph-generating tool calls: if a graph page is opened (or a
    // PR graph diff is generated) while no .radius/app.bicep exists, deny the
    // call and instruct the agent to author + SAVE it via the radius-app-bicep
    // skill first. The extension never writes bicep itself; it only triggers
    // the skill. Fail open — a hook error must never break tool execution.
    onPreToolUse: async (input) => {
      try {
        return await evaluateAppBicepHook(
          { toolName: input.toolName, toolArgs: input.toolArgs },
          {
            workspaceState,
            fetchBicep: fetchBicepForBranch,
            defaultBranchForState
          }
        );
      } catch {
        return undefined;
      }
    },
    onSessionStart: async () => {
      return {
        additionalContext: `When opening the Radius Canvas (canvasId: "radius"), ALWAYS:
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

When planned graph resolution cannot resolve a resource type, distinguish two cases. (1) The type exists but no recipe or recipe pack is registered for it in the target Environment: report the unresolved type and explain that a recipe pack providing it must be registered to the environment; do NOT generate a custom type or an inline singleton recipe for this case. (2) No built-in type fits the needed backing service at all: the radius-app-bicep skill generates a custom resource type (namespace Radius.Resources) together with its own recipe pack, following the skill's custom-resource-types guidance (Azure scope for now). In both cases recipes are supplied via recipe packs, not inline per-type singleton recipes, so do NOT fabricate a singleton recipe in app.bicep or in the graph. If a needed service is not provisionable on Azure, report it to the user instead of inventing a type.`
      };
    }
  }
});

// Prepare the `rad` binary once per extension load. This is the preferred place
// to download/reconcile rad and run the `rad version --cli` check; doing it here
// (fire-and-forget) keeps that work off the hot path of most graph builds.
// If the warm-up has not finished yet (or no binary exists), the first graph
// build may still await ensureRadBinary() as a fallback.
// @radius-project/adapter-shared, shared because the canvas server runs in-process).
ensureRadBinary({
  log: (m) => {
    try {
      console.error(`[radius] ${m}`);
    } catch {
      /* ignore */
    }
  }
}).catch((e) => {
  try {
    console.error(
      `[radius] rad binary preparation failed (will retry on first use): ${
        e?.message || e
      }`
    );
  } catch {
    /* ignore */
  }
});

// Wire the server-side app.bicep handoff to the SDK session. Graph/generate
// routes fire when a repo/branch is selected (not just on canvas open), so this
// is how selection changes trigger the radius-app-bicep skill automatically.
setAppBicepHandoff(({ repo, branches, page }) =>
  session.send(appBicepHandoffPrompt(repo, page, branches))
);
setDeployRepairHandoff(({ repo, branch, error, deployRunUrl, attemptId }) =>
  session.send(
    deployRepairHandoffPrompt(repo, branch, { error, deployRunUrl, attemptId })
  )
);

// Let server routes ask the Copilot session to perform follow-up actions the
// canvas itself cannot run interactively, such as Azure CLI login/install help.
setSessionPromptHandler((prompt) => session.send(String(prompt || "")));

// Wire the "View source code" / "View app definition" click for local-workspace
// graphs to the Copilot editor canvas (side pane). The graph + line numbers are
// generated from the on-disk worktree checkout, so opening the repo-relative file
// there matches what was graphed (including uncommitted edits) — unlike a GitHub
// blob URL, which 404s for an unpushed worktree branch. A stable instanceId means
// every click reuses one editor panel instead of stacking new ones.
//
// canvas.open({createIfMissing:false}) SILENTLY resolves for a file that isn't on
// the worktree (a dead click with no error), so we first verify the file exists on
// this session's checkout and throw NOT_ON_WORKTREE when it doesn't. Any throw is
// Tier 2 of the notification model: say once, in the session timeline, that an
// environment setup finished.
//
// This is deliberately `session.log` and not `session.send`. A sent message is a
// directive that resolves only when the agent finishes acting on it, so a
// completion notice would submit a turn -- interrupting whatever the user is
// doing to announce something they may already know from the panel. A log entry
// is level-tagged, lands on the timeline, and asks nothing of anyone.
//
// It is best-effort by design. Tier 1 -- the status chip and the panel -- is
// what carries the guarantee, because it depends on nothing outside our own
// pages. If this line never renders, nothing is lost that the user could not
// already see.
//
// The host RPC documents this as a "user-visible session log event" and accepts
// a `url` and a `tip` alongside the level, so the announcement carries the
// pull request link on the one state where the user has to go and act on it.
// See announcementOptions for why the tip is limited to a plain success.
onOperationTerminal((op: any) => {
  try {
    const message = summarize(op);
    if (!message) return false;
    session.log(`Radius: ${message}`, announcementOptions(op));
    return true;
  } catch {
    // The host may be gone, or between sessions. Never let it matter.
    return false;
  }
});

// logged and re-thrown so /api/open-source returns a non-2xx and the webview falls
// back to the file's GitHub URL instead of dead-clicking.
setOpenSourceHandler(async ({ path: relPath, state }) => {
  // Re-validate independently of the server route: reject absolute / drive /
  // UNC / traversal paths so this stays safe even if reused by another caller.
  // toSafeRepoRelPath is OS-independent, so the same rules hold on Win/macOS/Linux.
  let safe = "";
  try {
    safe = toSafeRepoRelPath(relPath);
    const worktree = state && state.workspacePath;
    if (!worktree || !(await workspaceFileExists(worktree, safe))) {
      const err = new Error("file is not on this worktree", {
        cause: { code: "NOT_ON_WORKTREE" }
      });
      throw err;
    }
    await session.rpc.canvas.open({
      canvasId: "editor",
      instanceId: "radius-source",
      input: {
        scope: "repo",
        path: safe,
        title: safe.split("/").pop() || safe,
        placement: { focus: true, surface: "side" },
        createIfMissing: false
      }
    });
  } catch (e) {
    try {
      session.log(
        `Radius: could not open ${safe || relPath} in the editor canvas: ${errorMessage(e)}`,
        { level: "warning" }
      );
    } catch {}
    throw e;
  }
});

// The extension runs as a long-lived Node process that registers canvases/tools
// with the host. Two failure modes were observed:
//   1. A stray throw / unhandled rejection in an async request handler (e.g. the
//      deploy stream) would crash the whole process. The host then respawns it,
//      but the previous registration can still be lingering, producing
//      "External tool name clash: radius_* already registered by another
//      connection" on the new process.
//   2. On SIGTERM (host cleaning up stale processes during a restart/session
//      switch) the process exited without closing its canvas HTTP servers or
//      leaving the session, so tool registrations were not released cleanly.
//
// To make the extension resilient we (a) swallow otherwise-fatal errors so the
// process stays up and its single registration remains valid, and (b) shut down
// gracefully — closing every canvas server and leaving the session so the host
// can release the tool names before any replacement process registers them.

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    console.error(
      `[radius] received ${signal}; shutting down ${servers.size} canvas server(s)...`
    );
  } catch {}

  // Close all canvas HTTP servers so their ports are released promptly.
  const closes: Array<Promise<void>> = [];
  for (const [id, entry] of servers) {
    try {
      entry.server.closeAllConnections?.();
      closes.push(
        new Promise<void>((resolve) => {
          try {
            entry.server.close(() => resolve());
          } catch {
            resolve();
          }
        })
      );
    } catch {
      /* ignore */
    }
    servers.delete(id);
  }
  // Don't hang forever waiting on lingering keep-alive sockets.
  await Promise.race([
    Promise.all(closes),
    new Promise<void>((resolve) => setTimeout(resolve, 2000))
  ]);

  // Leave/dispose the session so the host deregisters our tools and canvases
  // before any replacement process tries to register the same names. The SDK
  // surface isn't introspectable here, so try the common teardown methods.
  try {
    for (const name of ["close", "dispose", "leave", "stop", "disconnect"]) {
      const candidate = Reflect.get(session, name);
      if (typeof candidate === "function") {
        await Reflect.apply(candidate, session, []);
        break;
      }
    }
    if (session && typeof session[Symbol.asyncDispose] === "function") {
      await session[Symbol.asyncDispose]();
    }
  } catch (e) {
    try {
      console.error(`[radius] session teardown error: ${errorMessage(e)}`);
    } catch {}
  }

  // Give async close callbacks a tick, then exit cleanly.
  setTimeout(() => process.exit(0), 50);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  try {
    process.on(sig, () => {
      gracefulShutdown(sig);
    });
  } catch {
    /* signal may be unsupported on platform */
  }
}

// Keep the process alive on otherwise-fatal async errors. Crashing here is what
// triggers the respawn → "tool name clash" cascade, so we log and continue; the
// single live registration stays valid and the user can retry the failed action.
process.on("uncaughtException", (err) => {
  try {
    console.error(
      `[radius] uncaughtException (ignored to stay alive): ${err?.stack || err}`
    );
  } catch {}
});
process.on("unhandledRejection", (reason) => {
  try {
    console.error(
      `[radius] unhandledRejection (ignored to stay alive): ${
        reason instanceof Error ?
          reason.stack || reason.message
        : String(reason)
      }`
    );
  } catch {}
});

// ─── Host-channel keepalive ───────────────────────────────────────────────────
// The Copilot host reaps idle extension processes with a clean SIGTERM after
// ~10 minutes (observed: consistent dur=600s SIGTERMs in the extension logs).
// "Idle" is measured on the host<->extension JSON-RPC connection, NOT on the
// in-process HTTP server that serves the canvas webview. So a user sitting on an
// open canvas panel — whose browser polls /api/ping every 5s and, during a
// deploy, /api/deploy-status every 1.5s — still looks completely idle to the
// host and gets reaped. That kills the HTTP server mid-use, the webview's pings
// start failing, and the panel shows the "disconnecting" overlay (and any
// in-flight deploy monitor dies with the process).
//
// Fix: while a canvas panel is actively open (we've served a webview request
// recently) OR a deployment is being monitored in the background OR an
// environment/credential setup operation is running, send a benign, read-only
// request over the host channel to keep the connection warm so the idle timer
// never elapses. session.metadata.snapshot() is a pure read with no side
// effects (unlike session.log, which would spam the host log). The whole thing
// is defensive: it never throws, and when the panel is closed and nothing is
// running it stops pinging, letting the host reap the process normally.
//
// Setup deserves its own predicate rather than riding on `panelRecentlyActive`.
// Today setup runs inside a single awaited POST while the modal polls
// /api/ping every 5s, so the connection stays warm by accident. Once the
// operation runs in the background the user is free to close the panel — at
// which point webview activity stops, and the only thing standing between a
// half-created App Registration and a SIGTERM is this predicate. Roughly:
// 3 min activity window + 2 min tick + ~10 min reap.
const KEEPALIVE_INTERVAL_MS = 120000; // 2 min — comfortably under the ~10 min reaper
const KEEPALIVE_ACTIVE_WINDOW_MS = 180000; // consider the panel "open" if seen within 3 min
let keepaliveBusy = false;
function deployInFlight() {
  for (const [, entry] of servers) {
    if (entry && entry.state && entry.state.deployStatus === "in_progress")
      return true;
  }
  return false;
}
const keepaliveTimer = setInterval(async () => {
  if (keepaliveBusy || shuttingDown) return;
  const panelRecentlyActive =
    Date.now() - getLastWebviewActivityAt() < KEEPALIVE_ACTIVE_WINDOW_MS;
  let settingUp = false;
  try {
    settingUp = setupInFlight();
  } catch {
    /* never let the predicate break the keepalive */
  }
  if (!panelRecentlyActive && !deployInFlight() && !settingUp) return;
  keepaliveBusy = true;
  try {
    const metadata = Reflect.get(session, "metadata");
    const snapshot =
      metadata && typeof metadata === "object" ?
        Reflect.get(metadata, "snapshot")
      : undefined;
    if (typeof snapshot === "function") {
      await Reflect.apply(snapshot, metadata, []);
    }
  } catch {
    /* keepalive must never crash or surface errors */
  } finally {
    keepaliveBusy = false;
  }
}, KEEPALIVE_INTERVAL_MS);
// Don't let the keepalive timer itself hold the process open if everything else
// has settled and the host wants to shut us down.
try {
  keepaliveTimer.unref?.();
} catch {}

// ─── Dev self-reload (opt-in, off by default) ───────────────────────────────────
// In development a fresh build can hot-reload without a manual restart: we watch
// the installed extension.mjs and, when it changes, gracefully shut down so the
// host respawns a fresh process with the new code. This uses the SAME safe
// graceful-shutdown path as a host SIGTERM (close servers, leave the session) so
// the host deregisters our tools/canvas cleanly.
//
// IMPORTANT: the installed extension.mjs is user-scoped and SHARED by every
// session on this machine, so restarting the process reloads the extension in
// ALL sessions — not just the one being edited. That makes auto-reload actively
// harmful as a default: any `build --install` (from any session) would tear down
// every other active session, which shows up as sessions "constantly stopping".
//
// So this is now OFF unless a developer explicitly opts in for the current
// process with `RADIUS_CANVAS_DEV=1`. It is deliberately NOT armed by an
// on-disk sentinel: a sentinel persists across installs and silently re-enables
// the destructive behavior for everyone forever. With it off, new code is picked
// up the normal, non-disruptive way — when a session next starts a fresh
// process — rather than by killing running sessions. When explicitly enabled,
// the quiesce logic below still defers the restart until the extension is idle.
(function setupDevSelfReload() {
  try {
    const enabled = process.env.RADIUS_CANVAS_DEV === "1";
    if (!enabled) return;
    const extPath = process.env.EXTENSION_PATH || "";
    if (!extPath || !existsSync(extPath)) return;
    const extDir = dirname(extPath);
    let lastSize = -1;
    try {
      lastSize = statSync(extPath).size;
    } catch {}
    let debounce: NodeJS.Timeout | null = null;
    let triggered = false; // set once we commit to the actual restart
    let reloadPending = false; // a deferral loop is already running
    let reloadRequestedAt = 0; // when the pending reload was first requested

    // Quiesce-before-reload tuning. A rebuild that overwrites the installed
    // extension.mjs must NOT restart this process mid-flight — doing so
    // deregisters our tools/canvas and leaves the host waiting on a
    // vanished extension, which surfaces as "system unresponsive". So we
    // defer the restart until the extension is idle:
    //   • Never restart while a deploy is being monitored — the restart
    //     would kill the in-process deploy monitor (no cap; a deploy is
    //     worth waiting for).
    //   • Defer while a canvas panel is ACTIVELY serving requests, up to a
    //     cap. An idle-but-open panel only pings /api/ping every 5s, so a
    //     window just under that cadence lets a merely-open panel reload
    //     (brief reconnect) while genuine interaction bursts keep deferring.
    const RELOAD_IDLE_WINDOW_MS = 4000; // "active" if a request was served within this
    const RELOAD_DEFER_POLL_MS = 2000; // re-check cadence while deferring
    const RELOAD_MAX_DEFER_MS = 60000; // cap deferral for panel activity (not deploys)

    const reloadNow = () => {
      if (triggered || shuttingDown) return;
      triggered = true;
      try {
        console.error(
          "[radius][dev] extension.mjs changed — restarting for hot reload…"
        );
      } catch {}
      setTimeout(() => {
        gracefulShutdown("DEV_RELOAD");
      }, 250);
    };
    const maybeReload = () => {
      if (triggered || shuttingDown) return;
      let deploying = false;
      try {
        deploying = deployInFlight();
      } catch {}
      const panelActive =
        Date.now() - getLastWebviewActivityAt() < RELOAD_IDLE_WINDOW_MS;
      const waited = Date.now() - reloadRequestedAt;
      if (deploying || (panelActive && waited < RELOAD_MAX_DEFER_MS)) {
        try {
          console.error(
            `[radius][dev] reload deferred (${
              deploying ? "deploy in flight" : "canvas panel active"
            }); retrying in ${RELOAD_DEFER_POLL_MS}ms…`
          );
        } catch {}
        setTimeout(maybeReload, RELOAD_DEFER_POLL_MS);
        return;
      }
      reloadNow();
    };
    const trigger = () => {
      if (triggered || shuttingDown) return;
      let size = lastSize;
      try {
        size = statSync(extPath).size;
      } catch {}
      if (size === lastSize) return;
      lastSize = size;
      // Coalesce a burst of rebuild writes into a single deferral loop; if
      // one is already running it picks up the new state on its next poll.
      if (reloadPending) return;
      reloadPending = true;
      reloadRequestedAt = Date.now();
      maybeReload();
    };
    const watcher = fsWatch(extDir, { persistent: false }, (_evt, filename) => {
      if (filename && filename !== "extension.mjs") return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(trigger, 300);
    });
    try {
      watcher.unref?.();
    } catch {}
    try {
      console.error(`[radius][dev] self-reload armed (watching ${extPath})`);
    } catch {}
  } catch (e) {
    try {
      console.error(
        `[radius][dev] self-reload setup failed (ignored): ${errorMessage(e)}`
      );
    } catch {}
  }
})();
