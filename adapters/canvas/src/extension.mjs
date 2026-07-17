// Extension: radius — SDK entry (joinSession wiring).
//
// The thin Copilot-canvas adapter entry point: it registers the canvas + tools
// with the SDK and delegates every meaningful operation to a radius-core
// use-case or a sibling adapter module (server/pages/deploy/infra/gh). It owns
// no product logic — only the SDK surface and process-lifecycle hardening.

import { execFile } from "node:child_process";
import { existsSync, statSync, watch as fsWatch } from "node:fs";
import { dirname, join } from "node:path";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import {
  computeGraphDiff,
  fetchBicepFromRepo,
} from "@radius-project/core";
import { buildGraphViaRad } from "@radius-project/shared";
import { github } from "./gh.mjs";
import {
    defaultBranchForState,
    detectWorkspaceContext,
    fetchWorkspaceBicep,
    isWorkspaceSelection,
    parseRepoFromRemote,
} from "./workspace.mjs";
import { generateAzureOIDC, generateAWSOIDC } from "./infra.mjs";
import {
    servers,
    getOrCreateServer,
    getLastWebviewActivityAt,
    setAppBicepHandoff,
} from "./server.mjs";
import {
    getSourceRefResources,
    prepareSourceRefResources,
    setSourceRefResources,
    updateSourceRefs,
} from "./source-refs.mjs";
import { evaluateAppBicepHook, GRAPH_PAGES, appBicepHandoffPrompt } from "./hooks.mjs";
import { radiusAppBicepSkill } from "./skill.mjs";

async function workspaceState() {
    const workspace = await detectWorkspaceContext(session);
    return {
        workspacePath: workspace.workspacePath,
        workspaceRepo: workspace.repo,
        workspaceBranch: workspace.branch,
        contextRepo: workspace.repo,
        contextBranch: workspace.branch,
    };
}

async function fetchBicepForBranch(repo, branch, state) {
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
async function maybeHandoffAppBicep(entry, page, ctx) {
    try {
        if (!GRAPH_PAGES.has(page)) return;
        const state = entry.state;
        const repo = state.contextRepo || ctx.input?.repo || "";
        if (!repo) return;

        let branches;
        if (page === "graph-diff") {
            branches = [ctx.input?.baseBranch, ctx.input?.headBranch].filter(Boolean);
            // Match the onPreToolUse hook's graphTriggerTargets: when no branches
            // are supplied, use [undefined] so both paths resolve to the default
            // branch below and compute the same dedupe key.
            if (!branches.length) branches = [undefined];
        } else {
            // Honor an explicit branch from open_canvas input; fall back to the
            // resolved context branch (the session worktree branch for the
            // workspace repo) so we never default the session repo to main.
            branches = [ctx.input?.branch || state.contextBranch];
        }
        branches = branches.map((b) => b || defaultBranchForState(state));

        const key = `${repo}::${branches.join(",")}`;
        if (state.appBicepHandoffKey === key) return; // already handed off for this target
        // Claim the key before the async fetch so a concurrent canvas-open and
        // server-route trigger for the same target cannot both pass the guard
        // and double-handoff (TOCTOU). If bicep turns out to exist we simply
        // skip the send below; the claimed key is harmless.
        state.appBicepHandoffKey = key;

        const found = await Promise.all(branches.map(async (branch) => {
            try {
                return !!(await fetchBicepForBranch(repo, branch, state));
            } catch {
                return false;
            }
        }));
        if (found.some(Boolean)) return; // at least one branch has it → nothing to do

        try {
            Promise.resolve(session.send(appBicepHandoffPrompt(repo, page))).catch(() => {});
        } catch { /* session.send unavailable → ignore */ }
    } catch { /* never block canvas open on handoff failure */ }
}

// ─── Canvas + Tools ───────────────────────────────────────────────────────────
const session = await joinSession({
    canvases: [
        createCanvas({
            id: "radius",
            displayName: "Radius",
            description: "Application modeling and deployment: configure cloud credentials, generate app.bicep, visualize application graphs, view PR diffs, and create deployment environments.",
            inputSchema: {
                type: "object",
                properties: {
                    page: {
                        type: "string",
                        enum: ["credentials", "graph", "planned", "graph-diff", "deployed", "environment", "deploying"],
                        description: "Which page to display",
                    },
                    repo: {
                        type: "string",
                        description: "Repository in owner/repo format to pre-select in dropdowns",
                    },
                    baseBranch: {
                        type: "string",
                        description: "Base branch for graph-diff comparison (e.g. 'main'). When provided with headBranch, auto-compares on open.",
                    },
                    headBranch: {
                        type: "string",
                        description: "Head branch for graph-diff comparison (e.g. PR branch). When provided with baseBranch, auto-compares on open.",
                    },
                },
            },
            actions: [
                {
                    name: "configure_oidc",
                    description: "Configure OIDC identity federation for Azure or AWS and display the setup commands",
                    inputSchema: {
                        type: "object",
                        properties: {
                            provider: { type: "string", enum: ["azure", "aws"], description: "Cloud provider to configure" },
                            tenantId: { type: "string", description: "Azure Tenant ID" },
                            tenantName: { type: "string", description: "Azure Tenant display name" },
                            subscriptionId: { type: "string", description: "Azure Subscription ID" },
                            subscriptionName: { type: "string", description: "Azure Subscription display name" },
                            clientId: { type: "string", description: "Azure Client ID (App Registration)" },
                            clientName: { type: "string", description: "Azure App Registration display name" },
                            accountId: { type: "string", description: "AWS Account ID" },
                            accountName: { type: "string", description: "AWS Account alias or display name" },
                            region: { type: "string", description: "AWS Region" },
                        },
                        required: ["provider"],
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "credentials");
                        const data = ctx.input || {};
                        const result = data.provider === "azure"
                            ? generateAzureOIDC(data)
                            : generateAWSOIDC(data);
                        if (data.provider === "azure") {
                            entry.state.oidcAzure = { ...result, tenantId: data.tenantId || "", tenantName: data.tenantName || "", subscriptionId: data.subscriptionId || "", subscriptionName: data.subscriptionName || "", clientId: data.clientId || "", clientName: data.clientName || "" };
                        } else {
                            entry.state.oidcAws = { ...result, accountId: data.accountId || "", accountName: data.accountName || "", region: data.region || "" };
                        }
                        entry.url = `${entry.baseUrl}/?page=environment`;
                        return { message: result.message, url: entry.url };
                    },
                },
                {
                    name: "render_graph",
                    description: "Render the application graph from ApplicationGraphResource data",
                    inputSchema: {
                        type: "object",
                        properties: {
                            resources: {
                                type: "array",
                                description: "Array of ApplicationGraphResource objects with id, name, type, and connections",
                                items: { type: "object" },
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "graph");
                        // Populate the active worktree context (repo/branch/path) so the
                        // graph page defaults to the session branch and reads the worktree
                        // app.bicep — matching the open() handler.
                        Object.assign(entry.state, await workspaceState());
                        if (ctx.input?.resources) {
                            const context = {
                                repo: entry.state.contextRepo || entry.state.workspaceRepo || "",
                                branch: entry.state.contextBranch || entry.state.workspaceBranch || "",
                            };
                            setSourceRefResources(entry, "graph", ctx.input.resources, context);
                            setSourceRefResources(entry, "planned", ctx.input.resources, context);
                        }
                        entry.state.activeGraphView = "graph";
                        entry.url = `${entry.baseUrl}/?page=graph`;
                        return { message: "Graph rendered", url: entry.url };
                    },
                },
                {
                    name: "render_graph_diff",
                    description: "Render a diff graph showing changes between base and head application models in a PR",
                    inputSchema: {
                        type: "object",
                        properties: {
                            baseResources: { type: "array", description: "Base branch resources", items: { type: "object" } },
                            headResources: { type: "array", description: "Head branch resources", items: { type: "object" } },
                            repo: { type: "string", description: "Repository in owner/repo format" },
                            baseBranch: { type: "string", description: "Base branch represented by baseResources" },
                            headBranch: { type: "string", description: "Head branch represented by headResources" },
                        },
                        required: ["baseResources", "headResources", "repo", "baseBranch", "headBranch"],
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "graph-diff");
                        // Compute diff from base/head if provided
                        if (ctx.input?.baseResources && ctx.input?.headResources) {
                            // Compute diff using the shared algorithm (see computeGraphDiff).
                            const diffResources = computeGraphDiff(ctx.input.baseResources, ctx.input.headResources);
                            setSourceRefResources(entry, "diff", diffResources, {
                                repo: ctx.input.repo,
                                baseBranch: ctx.input.baseBranch,
                                headBranch: ctx.input.headBranch,
                            });
                            entry.state.diffTargetRepo = ctx.input.repo;
                            entry.state.diffBase = ctx.input.baseBranch;
                            entry.state.diffHead = ctx.input.headBranch;
                        }
                        entry.state.activeGraphView = "diff";
                        entry.url = `${entry.baseUrl}/?page=graph-diff`;
                        return { message: "Diff graph rendered", url: entry.url };
                    },
                },
                {
                    name: "create_environment",
                    description: "Create a GitHub environment, private GHCR state package, cloud settings, and verification/deploy workflows",
                    inputSchema: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Environment name (e.g. production)" },
                            provider: { type: "string", enum: ["azure", "aws"], description: "Cloud provider" },
                            repo: { type: "string", description: "Repository in owner/repo format" },
                            clientId: { type: "string", description: "Azure application (client) ID" },
                            tenantId: { type: "string", description: "Azure tenant ID" },
                            subscriptionId: { type: "string", description: "Azure Subscription ID" },
                            resourceGroup: { type: "string", description: "Azure Resource Group" },
                            location: { type: "string", description: "Azure Location" },
                            roleArn: { type: "string", description: "AWS IAM role ARN used by GitHub OIDC" },
                            accountId: { type: "string", description: "AWS Account ID" },
                            region: { type: "string", description: "AWS Region" },
                            cluster: { type: "string", description: "AKS or EKS cluster name" },
                            vpcId: { type: "string", description: "Optional AWS VPC ID" },
                            subnetIds: { type: "string", description: "Optional comma-separated AWS subnet IDs" },
                        },
                        required: ["name", "provider", "repo"],
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "environment");
                        const data = ctx.input;
                        try {
                            const required = data.provider === "azure"
                                ? ["clientId", "tenantId", "subscriptionId", "resourceGroup", "cluster"]
                                : ["roleArn", "accountId", "region", "cluster"];
                            const missing = required.filter((name) => !data[name]);
                            if (missing.length > 0) {
                                throw new Error(`Missing required ${data.provider} environment inputs: ${missing.join(", ")}.`);
                            }
                            const response = await fetch(`${entry.baseUrl}/api/create-environment`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    ...data,
                                    environment: data.name,
                                }),
                            });
                            const result = await response.json();
                            if (!response.ok && !result.error) {
                                result.error = `Environment setup failed with HTTP ${response.status}.`;
                            }
                            entry.state.envResult = result;
                        } catch (e) {
                            entry.state.envResult = { error: e.message };
                        }
                        entry.url = `${entry.baseUrl}/?page=environment`;
                        return entry.state.envResult;
                    },
                },
                {
                    name: "get_graph_resources",
                    description: "Return the current graph resources, optionally filtered to only those missing a codeReference. Use this to discover which resources need source-code references after the graph has been built.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            missingOnly: {
                                type: "boolean",
                                description: "If true (default), return only resources missing codeReference. If false, return all resources.",
                            },
                            view: {
                                type: "string",
                                enum: ["graph", "planned", "diff"],
                                description: "Graph view to inspect. Defaults to the active canvas page.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId);
                        const result = getSourceRefResources(entry, ctx.input?.view);
                        if (!result.ready) {
                            return { ready: false, resources: [], message: "Graph has not been built yet. Open the graph page and wait for it to load, then try again." };
                        }
                        const missingOnly = ctx.input?.missingOnly !== false;
                        const resources = missingOnly
                            ? result.resources.filter(r => !r.codeReference && !r.type?.toLowerCase().includes('applications'))
                            : result.resources;
                        return {
                            ready: true,
                            view: result.view,
                            contextToken: result.context.token,
                            repo: result.context.repo,
                            branch: result.context.branch || null,
                            baseBranch: result.context.baseBranch || null,
                            headBranch: result.context.headBranch || null,
                            resources: resources.map(r => ({ name: r.name, type: r.type, id: r.id, codeReference: r.codeReference || null })),
                        };
                    },
                },
                {
                    name: "update_source_refs",
                    description: "Attach source-code references to the exact graph context returned by get_graph_resources so nodes deep-link to their definition/initialization site.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            refs: {
                                type: "array",
                                description: "Array of {id, codeReference} objects. codeReference is a repo-relative path, optionally with #L<line> (e.g. 'src/db.js#L14').",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "string", description: "Stable resource ID returned by get_graph_resources" },
                                        codeReference: { type: "string", description: "Repo-relative path with optional #L<line>" },
                                    },
                                    required: ["id", "codeReference"],
                                },
                            },
                            contextToken: {
                                type: "string",
                                description: "Graph context token returned by get_graph_resources",
                            },
                        },
                        required: ["contextToken", "refs"],
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId);
                        const contextToken = ctx.input?.contextToken;
                        if (!contextToken || typeof contextToken !== "string") {
                            return { error: "contextToken is required", updated: 0, queued: 0, skipped: 0 };
                        }
                        const refs = ctx.input?.refs;
                        if (!Array.isArray(refs) || refs.length === 0) {
                            return { error: "refs array is required", updated: 0, queued: 0, skipped: 0 };
                        }
                        const result = updateSourceRefs(entry, contextToken, refs);
                        if (result.error) return result;
                        const page = result.view === "diff" ? "graph-diff" : result.view;
                        entry.url = `${entry.baseUrl}/?page=${page}&sourceRefs=${Date.now()}`;
                        return {
                            ...result,
                            message: `Updated ${result.updated} resource(s); queued ${result.queued}; skipped ${result.skipped}.`,
                            url: entry.url,
                        };
                    },
                },
            ],
            open: async (ctx) => {
                const page = ctx.input?.page || "environment";
                const entry = await getOrCreateServer(ctx.instanceId, page);
                entry.state.activeGraphView = page === "graph-diff" ? "diff" : page === "planned" ? "planned" : page === "graph" ? "graph" : entry.state.activeGraphView;
                const workspace = await workspaceState();
                Object.assign(entry.state, workspace);
                // If a repo is passed in input, set it as context for all pages
                if (ctx.input?.repo) {
                    entry.state.contextRepo = ctx.input.repo;
                    if (ctx.input.repo === workspace.workspaceRepo) {
                        entry.state.contextBranch = workspace.workspaceBranch;
                    } else {
                        entry.state.contextBranch = ctx.input?.branch || "main";
                    }
                } else if (!entry.state.contextRepo && session.workspacePath) {
                    // Try to detect repo from workspace git remote
                    try {
                        const remoteUrl = await new Promise((resolve) => {
                            execFile("git", ["-C", session.workspacePath, "remote", "get-url", "origin"], { timeout: 5000 }, (err, stdout) => {
                                if (err) { resolve(''); return; }
                                resolve(stdout.trim());
                            });
                        });
                        const repo = parseRepoFromRemote(remoteUrl);
                        if (repo) {
                            entry.state.contextRepo = repo;
                        }
                    } catch (e) { /* ignore */ }
                }

                if (page === "graph" || page === "planned") {
                    prepareSourceRefResources(entry, page, {
                        repo: entry.state.contextRepo || "",
                        branch: entry.state.contextBranch || "",
                    });
                }

                // Auto-compare when baseBranch and headBranch are provided (PR diff mode)
                if (page === "graph-diff" && ctx.input?.baseBranch && ctx.input?.headBranch) {
                    const repo = entry.state.contextRepo || ctx.input?.repo || '';
                    const sourceRefContext = prepareSourceRefResources(entry, "diff", {
                        repo,
                        baseBranch: ctx.input.baseBranch,
                        headBranch: ctx.input.headBranch,
                    });
                    entry.state.diffBase = ctx.input.baseBranch;
                    entry.state.diffHead = ctx.input.headBranch;
                    entry.state.diffTargetRepo = repo;
                    try {
                        // Fetch the committed/persisted app.bicep on each branch.
                        // Generation is owned by the radius-app-bicep skill.
                        let [baseContent, headContent] = await Promise.all([
                            fetchBicepForBranch(repo, ctx.input.baseBranch, entry.state),
                            fetchBicepForBranch(repo, ctx.input.headBranch, entry.state)
                        ]);

                        const baseResources = await buildGraphViaRad(baseContent || '', ".radius/app.bicep", { log: (m) => { try { session.log(m); } catch {} } });
                        const headResources = await buildGraphViaRad(headContent || '', ".radius/app.bicep", { log: (m) => { try { session.log(m); } catch {} } });
                        // Compute diff using the shared algorithm (see computeGraphDiff).
                        const diffResources = computeGraphDiff(baseResources, headResources);
                        setSourceRefResources(entry, "diff", diffResources, {
                            repo,
                            baseBranch: ctx.input.baseBranch,
                            headBranch: ctx.input.headBranch,
                        }, sourceRefContext.token);
                        // Flag if no changes detected
                        const hasChanges = diffResources.some(r => r.diffStatus !== 'unchanged');
                        entry.state.diffNoChanges = !hasChanges;
                    } catch (e) {
                        // If fetching fails, leave empty for manual comparison
                    }
                }

                await maybeHandoffAppBicep(entry, page, ctx);

                return { title: "Radius", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
    tools: [
        {
            name: "radius_configure_oidc",
            description: "Opens the Radius OIDC configuration canvas to set up Azure or AWS identity federation for GitHub Actions",
            parameters: {
                type: "object",
                properties: {
                    provider: { type: "string", enum: ["azure", "aws"], description: "Cloud provider to configure" },
                },
            },
            handler: async (args) => {
                return "Open the radius canvas with page 'environment' to configure OIDC and deploy. Use open_canvas with canvasId 'radius' and input { page: 'environment' }.";
            },
        },
        {
            name: "radius_generate_app",
            description: "Generates a Radius app.bicep file by analyzing the repository structure using the radius-app-bicep skill. Returns the full radius-app-bicep skill (SKILL.md and all reference files, bundled with the extension) so the agent uses authoritative, schema-accurate Radius.* types and compiles the result before finishing.",
            parameters: {
                type: "object",
                properties: {
                    repoPath: { type: "string", description: "Path to the repository to analyze" },
                },
            },
            handler: async (args) => {
                return radiusAppBicepSkill(args.repoPath);
            },
        },
        {
            name: "radius_render_graph",
            description: "Renders an interactive application graph visualization from resource data",
            parameters: {
                type: "object",
                properties: {
                    resources: {
                        type: "array",
                        description: "Array of ApplicationGraphResource objects",
                        items: { type: "object" },
                    },
                },
                required: ["resources"],
            },
            handler: async (args) => {
                return `Graph data received with ${args.resources?.length || 0} resources. Use invoke_canvas_action with actionName 'render_graph' and the resources data to display the graph.`;
            },
        },
        {
            name: "radius_render_graph_diff",
            description: "Renders a diff visualization comparing base and head application graphs for a pull request",
            parameters: {
                type: "object",
                properties: {
                    baseResources: { type: "array", description: "Base branch resources", items: { type: "object" } },
                    headResources: { type: "array", description: "Head branch resources", items: { type: "object" } },
                    repo: { type: "string", description: "Repository in owner/repo format" },
                    baseBranch: { type: "string", description: "Base branch represented by baseResources" },
                    headBranch: { type: "string", description: "Head branch represented by headResources" },
                },
                required: ["baseResources", "headResources", "repo", "baseBranch", "headBranch"],
            },
            handler: async (args) => {
                // Compute diff using the shared algorithm (see computeGraphDiff).
                const diffResources = computeGraphDiff(args.baseResources, args.headResources);
                return JSON.stringify({
                    message: `Diff computed: ${diffResources.filter(r=>r.diffStatus==='added').length} added, ${diffResources.filter(r=>r.diffStatus==='removed').length} removed, ${diffResources.filter(r=>r.diffStatus==='modified').length} modified`,
                    resources: diffResources,
                    instruction: `Use invoke_canvas_action with actionName 'render_graph_diff' and pass these resources with repo '${args.repo}', baseBranch '${args.baseBranch}', and headBranch '${args.headBranch}'.`,
                });
            },
        },
        {
            name: "radius_generate_pr_diff_markdown",
            description: "Generates a Mermaid application graph diff diagram and summary markdown for embedding in a PR description. Call this BEFORE creating the PR and include the returned markdown in the PR body.",
            parameters: {
                type: "object",
                properties: {
                    repo: { type: "string", description: "Repository in owner/repo format" },
                    baseBranch: { type: "string", description: "Base branch (PR target, e.g. 'main')" },
                    headBranch: { type: "string", description: "Head branch (PR source, e.g. 'feature/add-redis')" },
                },
                required: ["repo", "baseBranch", "headBranch"],
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
                        return `.radius/app.bicep does not exist on ${baseBranch} or ${headBranch} yet. Author it with the Radius app-bicep skill (run the radius_generate_app tool) and follow the skill through committing and pushing it to the branch (PR-diff and GitHub-backed views read the pushed remote branch), then re-run this tool.`;
                    }

                    const baseResources = await buildGraphViaRad(baseContent || '', ".radius/app.bicep", { log: (m) => { try { session.log(m); } catch {} } });
                    const headResources = await buildGraphViaRad(headContent || '', ".radius/app.bicep", { log: (m) => { try { session.log(m); } catch {} } });

                    // Compute diff using the shared algorithm (see computeGraphDiff).
                    const diffResources = computeGraphDiff(baseResources, headResources);

                    const added = diffResources.filter(r => r.diffStatus === "added").length;
                    const removed = diffResources.filter(r => r.diffStatus === "removed").length;
                    const modified = diffResources.filter(r => r.diffStatus === "modified").length;
                    const unchanged = diffResources.filter(r => r.diffStatus === "unchanged").length;

                    // Build Mermaid diagram
                    // Create a map from full resource id to a short safe mermaid node id
                    const idMap = new Map();
                    for (let i = 0; i < diffResources.length; i++) {
                        const r = diffResources[i];
                        const fullId = r.id || r.name || `node${i}`;
                        // Use symName (last segment of id path) for readable Mermaid ids
                        const segments = fullId.split('/');
                        const shortId = segments[segments.length - 1] || `node${i}`;
                        const safeId = shortId.replace(/[^a-zA-Z0-9]/g, "_");
                        idMap.set(fullId, safeId);
                    }

                    const statusStyle = { added: ":::added", removed: ":::removed", modified: ":::modified", unchanged: ":::unchanged" };
                    const statusIcon = { added: "🟢", removed: "🔴", modified: "🟡", unchanged: "" };
                    let mermaid = "graph TD\n";
                    mermaid += "    classDef added fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#1a7f37\n";
                    mermaid += "    classDef removed fill:#ffebe9,stroke:#cf222e,stroke-width:2px,color:#cf222e\n";
                    mermaid += "    classDef modified fill:#fff8c5,stroke:#bf8700,stroke-width:2px,color:#9a6700\n";
                    mermaid += "    classDef unchanged fill:#f6f8fa,stroke:#d1d9e0,stroke-width:1px,color:#656d76\n";

                    for (const r of diffResources) {
                        const fullId = r.id || r.name || "node";
                        const safeId = idMap.get(fullId) || fullId.replace(/[^a-zA-Z0-9]/g, "_");
                        const icon = statusIcon[r.diffStatus] || "";
                        const typeLabel = ((r.type || "").split("/").pop() || "").split("@")[0];
                        const label = `${icon} ${r.name || r.id}\\n${typeLabel}`.trim();
                        mermaid += `    ${safeId}["${label}"]${statusStyle[r.diffStatus] || ""}\n`;
                    }

                    // Add edges from connections (match by conn.id which is the full resource path)
                    for (const r of diffResources) {
                        if (r.connections && r.connections.length > 0) {
                            const srcFullId = r.id || r.name || "";
                            const srcSafeId = idMap.get(srcFullId);
                            if (!srcSafeId) continue;
                            for (const conn of r.connections) {
                                const dir = conn.direction || 'Outbound';
                                if (dir !== 'Outbound') continue;
                                const tgtFullId = conn.id || conn.name || "";
                                const tgtSafeId = idMap.get(tgtFullId);
                                if (tgtSafeId) {
                                    mermaid += `    ${srcSafeId} --> ${tgtSafeId}\n`;
                                }
                            }
                        }
                    }

                    let md = `## 📊 Application Graph Diff\n\n`;
                    md += `Comparing \`${baseBranch}\` → \`${headBranch}\`\n\n`;

                    if (added === 0 && removed === 0 && modified === 0) {
                        md += `✅ No application graph changes detected. The application model is identical between \`${baseBranch}\` and \`${headBranch}\`.\n`;
                    } else {
                        md += `| Status | Count |\n|--------|-------|\n`;
                        if (added > 0) md += `| 🟢 Added | ${added} |\n`;
                        if (removed > 0) md += `| 🔴 Removed | ${removed} |\n`;
                        if (modified > 0) md += `| 🟡 Modified | ${modified} |\n`;
                        if (unchanged > 0) md += `| ⚪ Unchanged | ${unchanged} |\n`;
                        md += `\n`;
                    }

                    md += "```mermaid\n" + mermaid + "```\n";

                    return md;
                } catch (err) {
                    return `⚠️ Could not generate app graph diff: ${err.message}`;
                }
            },
        },
        {
            name: "radius_create_environment",
            description: "Opens the GitHub environment creation canvas to set up a deployment environment with cloud provider secrets",
            parameters: {
                type: "object",
                properties: {
                    provider: { type: "string", enum: ["azure", "aws"], description: "Cloud provider" },
                    repo: { type: "string", description: "Repository in owner/repo format" },
                },
            },
            handler: async (args) => {
                return "Open the radius canvas with page 'environment' to create a GitHub environment. Use open_canvas with canvasId 'radius' and input { page: 'environment' }.";
            },
        },
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
                    { workspaceState, fetchBicep: fetchBicepForBranch, defaultBranchForState },
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
1. First, check whether .radius/app.bicep (or app.bicep) is available on the branch the graph reads. A local workspace can use the on-disk file, but GitHub-backed and PR views read the pushed remote branch.
2. If it is not available, author it using the radius_generate_app tool (the radius-app-bicep skill owns namespaces, types, structure, and committing + pushing the file) and follow that skill to completion.
3. Only AFTER the skill has committed and pushed app.bicep to that branch, open: open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph", repo: "<current-repo>" } }). Push for reliability: GitHub-backed and PR views resolve the graph from the pushed branch, so a local save alone is not visible there.

The same rule applies to the "planned" and "graph-diff" pages: they resolve .radius/app.bicep the same way, so if it is not available on the branch, first author it with the radius_generate_app tool (radius-app-bicep skill) and let the skill commit and push it before opening those pages.

When the user asks to "show me the planned graph", "plan my app": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "planned", repo: "<current-repo>" } }).

When the user asks to "deploy my app", "create environment": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "environment", repo: "<current-repo>" } }).

When the user asks to "configure OIDC", "set up cloud credentials", "add credentials": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "credentials", repo: "<current-repo>" } }).

When the user asks to "show the diff", "compare branches", "app graph diff": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph-diff", repo: "<current-repo>" } }).

CRITICAL: Always use instanceId "radius-panel" for ALL Radius Canvas operations. Never use different instanceIds — this prevents multiple panels from opening.

When a recipe is not found for a resource type during planned graph resolution, report the unresolved resource type to the user and explain that a recipe pack providing that type must be registered to the target environment. Do NOT attempt to generate a singleton custom resource type or recipe on-demand — with Radius extensibility, recipes are supplied via recipe packs, not per-type singleton recipes.`
            };
        },
    },
});

// Wire the server-side app.bicep handoff to the SDK session. Graph/generate
// routes fire when a repo/branch is selected (not just on canvas open), so this
// is how selection changes trigger the radius-app-bicep skill automatically.
setAppBicepHandoff(({ repo, page }) => session.send(appBicepHandoffPrompt(repo, page)));

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
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    try { console.error(`[radius] received ${signal}; shutting down ${servers.size} canvas server(s)...`); } catch {}

    // Close all canvas HTTP servers so their ports are released promptly.
    const closes = [];
    for (const [id, entry] of servers) {
        try {
            entry.server.closeAllConnections?.();
            closes.push(new Promise((resolve) => {
                try { entry.server.close(() => resolve()); } catch { resolve(); }
            }));
        } catch { /* ignore */ }
        servers.delete(id);
    }
    // Don't hang forever waiting on lingering keep-alive sockets.
    await Promise.race([
        Promise.all(closes),
        new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    // Leave/dispose the session so the host deregisters our tools and canvases
    // before any replacement process tries to register the same names. The SDK
    // surface isn't introspectable here, so try the common teardown methods.
    try {
        for (const fn of ["close", "dispose", "leave", "stop", "disconnect"]) {
            if (session && typeof session[fn] === "function") { await session[fn](); break; }
        }
        if (session && typeof session[Symbol.asyncDispose] === "function") { await session[Symbol.asyncDispose](); }
    } catch (e) {
        try { console.error(`[radius] session teardown error: ${e?.message || e}`); } catch {}
    }

    // Give async close callbacks a tick, then exit cleanly.
    setTimeout(() => process.exit(0), 50);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    try { process.on(sig, () => { gracefulShutdown(sig); }); } catch { /* signal may be unsupported on platform */ }
}

// Keep the process alive on otherwise-fatal async errors. Crashing here is what
// triggers the respawn → "tool name clash" cascade, so we log and continue; the
// single live registration stays valid and the user can retry the failed action.
process.on("uncaughtException", (err) => {
    try { console.error(`[radius] uncaughtException (ignored to stay alive): ${err?.stack || err}`); } catch {}
});
process.on("unhandledRejection", (reason) => {
    try { console.error(`[radius] unhandledRejection (ignored to stay alive): ${reason?.stack || reason}`); } catch {}
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
// recently) OR a deployment is being monitored in the background, send a benign,
// read-only request over the host channel to keep the connection warm so the
// idle timer never elapses. session.metadata.snapshot() is a pure read with no
// side effects (unlike session.log, which would spam the host log). The whole
// thing is defensive: it never throws, and when the panel is closed and no
// deploy is running it stops pinging, letting the host reap the process normally.
const KEEPALIVE_INTERVAL_MS = 120000;   // 2 min — comfortably under the ~10 min reaper
const KEEPALIVE_ACTIVE_WINDOW_MS = 180000; // consider the panel "open" if seen within 3 min
let keepaliveBusy = false;
function deployInFlight() {
    for (const [, entry] of servers) {
        if (entry && entry.state && entry.state.deployStatus === "in_progress") return true;
    }
    return false;
}
const keepaliveTimer = setInterval(async () => {
    if (keepaliveBusy || shuttingDown) return;
    const panelRecentlyActive = (Date.now() - getLastWebviewActivityAt()) < KEEPALIVE_ACTIVE_WINDOW_MS;
    if (!panelRecentlyActive && !deployInFlight()) return;
    keepaliveBusy = true;
    try {
        if (session && session.metadata && typeof session.metadata.snapshot === "function") {
            await session.metadata.snapshot();
        }
    } catch { /* keepalive must never crash or surface errors */ }
    finally { keepaliveBusy = false; }
}, KEEPALIVE_INTERVAL_MS);
// Don't let the keepalive timer itself hold the process open if everything else
// has settled and the host wants to shut us down.
try { keepaliveTimer.unref?.(); } catch {}

// ─── Dev self-reload ───────────────────────────────────────────────────────────
// In development we want a fresh build to hot-reload without a manual reload. We
// watch the installed extension.mjs and, when it changes, gracefully shut down so
// the host respawns a fresh process with the new code. This uses the SAME safe
// graceful-shutdown path as a host SIGTERM (close servers, leave the session),
// which is important: it lets the host deregister our tools/canvas cleanly so the
// respawn doesn't clash or leave the session looking unresponsive.
//
// Opt-in and inert in production: it only arms when RADIUS_CANVAS_DEV=1 or a
// `.dev-reload` sentinel file sits next to the installed extension.
//
// NOTE: the installed extension.mjs is shared by every session on this machine
// (user-scoped), so a rebuild reloads the extension in ALL sessions, not just the
// one under test. Each reload is a brief (~1s) reconnect. Do your interactive
// canvas testing in a session separate from the one you're editing in.
(function setupDevSelfReload() {
    try {
        const extPath = process.env.EXTENSION_PATH || "";
        if (!extPath || !existsSync(extPath)) return;
        const extDir = dirname(extPath);
        const sentinel = join(extDir, ".dev-reload");
        const enabled = process.env.RADIUS_CANVAS_DEV === "1" || existsSync(sentinel);
        if (!enabled) return;
        let lastSize = -1;
        try { lastSize = statSync(extPath).size; } catch {}
        let debounce = null;
        let triggered = false;
        const trigger = () => {
            if (triggered || shuttingDown) return;
            let size = lastSize;
            try { size = statSync(extPath).size; } catch {}
            if (size === lastSize) return;
            lastSize = size;
            triggered = true;
            try { console.error("[radius][dev] extension.mjs changed — restarting for hot reload…"); } catch {}
            setTimeout(() => { gracefulShutdown("DEV_RELOAD"); }, 250);
        };
        const watcher = fsWatch(extDir, { persistent: false }, (_evt, filename) => {
            if (filename && filename !== "extension.mjs") return;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(trigger, 300);
        });
        try { watcher.unref?.(); } catch {}
        try { console.error(`[radius][dev] self-reload armed (watching ${extPath})`); } catch {}
    } catch (e) {
        try { console.error(`[radius][dev] self-reload setup failed (ignored): ${e?.message || e}`); } catch {}
    }
})();
