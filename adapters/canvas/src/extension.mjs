// Extension: radius — SDK entry (joinSession wiring).
//
// The thin Copilot-canvas adapter entry point: it registers the canvas + tools
// with the SDK and delegates every meaningful operation to a radius-core
// use-case or a sibling adapter module (server/pages/deploy/infra/gh). It owns
// no product logic — only the SDK surface and process-lifecycle hardening.

import { execFile } from "node:child_process";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import {
  getPlatform,
  computeGraphDiff,
  fetchBicepFromRepo,
  generateBicepFromRepo,
} from "@radius-project/core";
import { buildGraphViaRad } from "@radius-project/shared";
import { runCommand, github } from "./gh.mjs";
import {
    createWorkspaceGitHub,
    defaultBranchForState,
    detectWorkspaceContext,
    fetchWorkspaceBicep,
    isWorkspaceSelection,
} from "./workspace.mjs";
import { generateAzureOIDC, generateAWSOIDC } from "./infra.mjs";
import { servers, getOrCreateServer, getLastWebviewActivityAt } from "./server.mjs";

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

async function generateBicepForBranch(repo, branch, state) {
    const source = isWorkspaceSelection(state, repo, branch)
        ? createWorkspaceGitHub(state, repo, branch)
        : github;
    return await generateBicepFromRepo(source, repo, branch);
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
                        enum: ["credentials", "generate", "graph", "planned", "graph-diff", "deployed", "environment", "deploying"],
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
                    name: "generate_app",
                    description: "Display generated app.bicep content in the canvas",
                    inputSchema: {
                        type: "object",
                        properties: {
                            content: { type: "string", description: "The generated app.bicep content to display" },
                        },
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "generate");
                        Object.assign(entry.state, await workspaceState());
                        if (ctx.input?.content) {
                            entry.state.generatedContent = ctx.input.content;
                        } else {
                            const repo = entry.state.generateTargetRepo || entry.state.contextRepo || '';
                            const branch = defaultBranchForState(entry.state);
                            entry.state.generatedContent = repo
                                ? (await generateBicepForBranch(repo, branch, entry.state) || '')
                                : '';
                        }
                        entry.url = `${entry.baseUrl}/?page=generate`;
                        return { message: "app.bicep content ready", url: entry.url };
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
                        // app.bicep — matching generate_app and the open() handler.
                        Object.assign(entry.state, await workspaceState());
                        if (ctx.input?.resources) {
                            entry.state.graphResources = ctx.input.resources;
                            entry.state.plannedResources = ctx.input.resources;
                        }
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
                        },
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "graph-diff");
                        // Compute diff from base/head if provided
                        if (ctx.input?.baseResources && ctx.input?.headResources) {
                            // Compute diff using the shared algorithm (see computeGraphDiff).
                            const diffResources = computeGraphDiff(ctx.input.baseResources, ctx.input.headResources);
                            entry.state.diffResources = diffResources;
                        }
                        entry.url = `${entry.baseUrl}/?page=graph-diff`;
                        return { message: "Diff graph rendered", url: entry.url };
                    },
                },
                {
                    name: "create_environment",
                    description: "Create a GitHub environment and configure cloud provider secrets",
                    inputSchema: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Environment name (e.g. production)" },
                            provider: { type: "string", enum: ["azure", "aws"], description: "Cloud provider" },
                            repo: { type: "string", description: "Repository in owner/repo format" },
                            subscriptionId: { type: "string", description: "Azure Subscription ID" },
                            resourceGroup: { type: "string", description: "Azure Resource Group" },
                            location: { type: "string", description: "Azure Location" },
                            accountId: { type: "string", description: "AWS Account ID" },
                            region: { type: "string", description: "AWS Region" },
                        },
                        required: ["name", "provider", "repo"],
                    },
                    handler: async (ctx) => {
                        const entry = await getOrCreateServer(ctx.instanceId, "environment");
                        const data = ctx.input;
                        let output = "";
                        let error = null;
                        try {
                            const repo = data.repo;
                            output += await runCommand("gh", ["api", "--method", "PUT", `/repos/${repo}/environments/${data.name}`]);
                            output += "\nEnvironment created successfully.\n";
                            const envPlatform = getPlatform(data.provider) || getPlatform("aws");
                            for (const spec of envPlatform.environmentSecrets(data)) {
                                if (!spec.value) continue;
                                const verb = spec.kind === "variable" ? "variable" : "secret";
                                // Variables can be passed on argv; secret values are fed over
                                // stdin so they never appear in the process argument list.
                                if (verb === "variable") {
                                    await runCommand("gh", ["variable", "set", spec.name, "--body", spec.value, "--repo", repo, "--env", data.name]);
                                } else {
                                    await runCommand("gh", ["secret", "set", spec.name, "--repo", repo, "--env", data.name], { stdin: spec.value });
                                }
                                output += `Secret ${spec.name} set.\n`;
                            }
                        } catch (e) { error = e.message; }
                        entry.state.envResult = error
                            ? { error, output }
                            : { message: `Environment '${data.name}' created and configured for ${data.repo}`, output };
                        entry.url = `${entry.baseUrl}/?page=environment`;
                        return entry.state.envResult;
                    },
                },
            ],
            open: async (ctx) => {
                const page = ctx.input?.page || "environment";
                const entry = await getOrCreateServer(ctx.instanceId, page);
                const workspace = await workspaceState();
                Object.assign(entry.state, workspace);
                // If a repo is passed in input, set it as context for all pages
                if (ctx.input?.repo) {
                    entry.state.contextRepo = ctx.input.repo;
                    if (ctx.input.repo === workspace.workspaceRepo) {
                        entry.state.contextBranch = workspace.workspaceBranch;
                    } else {
                        entry.state.contextBranch = ctx.input?.branch || "";
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
                        const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/]+)(?:\.git)?$/i);
                        if (match) {
                            entry.state.contextRepo = match[1].replace(/\.git$/i, '');
                        }
                    } catch (e) { /* ignore */ }
                }

                // Auto-compare when baseBranch and headBranch are provided (PR diff mode)
                if (page === "graph-diff" && ctx.input?.baseBranch && ctx.input?.headBranch) {
                    const repo = entry.state.contextRepo || ctx.input?.repo || '';
                    entry.state.diffBase = ctx.input.baseBranch;
                    entry.state.diffHead = ctx.input.headBranch;
                    entry.state.diffTargetRepo = repo;
                    try {
                        // Fetch existing app.bicep, or generate from repo analysis if not found
                        let [baseContent, headContent] = await Promise.all([
                            fetchBicepForBranch(repo, ctx.input.baseBranch, entry.state),
                            fetchBicepForBranch(repo, ctx.input.headBranch, entry.state)
                        ]);
                        if (!baseContent) baseContent = await generateBicepForBranch(repo, ctx.input.baseBranch, entry.state);
                        if (!headContent) headContent = await generateBicepForBranch(repo, ctx.input.headBranch, entry.state);

                        const baseResources = await buildGraphViaRad(baseContent || '', ".radius/app.bicep", { log: (m) => { try { session.log(m); } catch {} } });
                        const headResources = await buildGraphViaRad(headContent || '', ".radius/app.bicep", { log: (m) => { try { session.log(m); } catch {} } });
                        // Compute diff using the shared algorithm (see computeGraphDiff).
                        const diffResources = computeGraphDiff(baseResources, headResources);
                        entry.state.diffResources = diffResources;
                        // Flag if no changes detected
                        const hasChanges = diffResources.some(r => r.diffStatus !== 'unchanged');
                        entry.state.diffNoChanges = !hasChanges;
                    } catch (e) {
                        // If fetching fails, leave empty for manual comparison
                    }
                }

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
            description: "Generates a Radius app.bicep file by analyzing the repository structure using the extensibility app-modeling skill. Returns instructions for the agent to produce the bicep file with correct Radius.* namespace types.",
            parameters: {
                type: "object",
                properties: {
                    repoPath: { type: "string", description: "Path to the repository to analyze" },
                },
            },
            handler: async (args) => {
                return `To generate app.bicep, follow the Radius Extensibility App Modeling skill (https://github.com/nicolejms/radius/blob/nicolejms/extensibility-app-modeling-skill/.github/skills/radius-extensibility-app-modeling/SKILL.md):

1. Analyze the repository at ${args.repoPath || "the current workspace"}:
   - Find Dockerfiles, docker-compose files, config files, source code
   - Identify containers, databases, caches, message queues, secrets, routes
   - Check package.json/requirements.txt/go.mod for infrastructure client dependencies

2. Resolve resource types from radius-project/resource-types-contrib:
   - Check known types table below
   - If not found, generate a custom resource type YAML schema and recipe at runtime

3. Generate .radius/app.bicep with the correct structure

CRITICAL — Use ONLY Radius.* namespaces (NEVER Applications.*):

| Resource | Full Type |
|---|---|
| Containers | Radius.Compute/containers@2025-08-01-preview |
| Container Images | Radius.Compute/containerImages@2025-08-01-preview |
| Routes/Ingress | Radius.Compute/routes@2025-05-01-preview |
| Persistent Volumes | Radius.Compute/persistentVolumes@2025-05-01-preview |
| MySQL | Radius.Data/mySqlDatabases@2025-08-01-preview |
| PostgreSQL | Radius.Data/postgreSqlDatabases@2025-08-01-preview |
| Neo4j | Radius.Data/neo4jDatabases@2025-08-01-preview |
| Redis | Radius.Data/redisCaches@2025-08-01-preview |
| MongoDB | Radius.Data/mongoDatabases@2025-08-01-preview |
| Secrets | Radius.Security/secrets@2025-05-01-preview |
| RabbitMQ | Radius.Messaging/rabbitMQQueues@2025-08-01-preview |
| Dapr State | Radius.Dapr/stateStores@2025-08-01-preview |

Extensions:
- extension radius

The single published 'radius' Bicep extension provides ALL Radius.* namespaces
(Compute, Data, Security, Messaging, Dapr, ...). Declare only 'extension radius'.
Do NOT use split aliases like radiusCompute/radiusSecurity/radiusData — they are
not published extensions and cause BCP204 "Extension not recognized" at build time.

Structure: extension radius > params (environment, application, @secure password, image) > resources

Key rules:
- Always parameterize environment and application (injected by rad CLI)
- Use connections to express dependencies between resources (source: <resource>.id)
- Symbolic names: camelCase (e.g., webApp, redisCache)
- Resource names: kebab-case (e.g., 'web-app', 'redis-cache')
- Platform-agnostic: recipes handle deployment specifics
- NEVER use Applications.Core/*, Applications.Datastores/*, or Applications.Dapr/*

Radius.Compute/containerImages build.source (CRITICAL):
- Images are built in-cluster by a BuildKit sidecar, so build.source MUST be a
  'git::https://...' URL that BuildKit can clone. NEVER use a local filesystem
  path (e.g. '/app', '/app/demo', '.') — the runner's filesystem is not visible
  to the BuildKit pod and the build fails with "invalid local: ... no such file".
- Use the application's own repository: source: 'git::https://github.com/<owner>/<repo>.git'
- If the Dockerfile is in a subdirectory, append it as a go-getter subdir and
  (optionally) pin a ref: 'git::https://github.com/<owner>/<repo>.git//<subdir>?ref=<branch-or-sha>'
- Set build.dockerfile only when the Dockerfile is not named 'Dockerfile' at the
  build context root (it defaults to 'Dockerfile').

Recipe resolution for planned graph:
1. Check radius-project/resource-types-contrib for recipes under <Category>/<typeName>/recipes/
2. If not found for target platform, check other platforms
3. If no recipe exists anywhere, generate one at runtime based on the resource type schema`;
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
                },
                required: ["baseResources", "headResources"],
            },
            handler: async (args) => {
                // Compute diff using the shared algorithm (see computeGraphDiff).
                const diffResources = computeGraphDiff(args.baseResources, args.headResources);
                return JSON.stringify({
                    message: `Diff computed: ${diffResources.filter(r=>r.diffStatus==='added').length} added, ${diffResources.filter(r=>r.diffStatus==='removed').length} removed, ${diffResources.filter(r=>r.diffStatus==='modified').length} modified`,
                    resources: diffResources,
                    instruction: "Use invoke_canvas_action with actionName 'render_graph_diff' and these resources to display the diff graph.",
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
                    if (!baseContent) baseContent = await generateBicepForBranch(repo, baseBranch, state);
                    if (!headContent) headContent = await generateBicepForBranch(repo, headBranch, state);

                    if (!baseContent && !headContent) {
                        return "No app.bicep found on either branch and could not generate from repo structure. Ensure the repository has a Dockerfile or docker-compose file.";
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
1. First, check if .radius/app.bicep (or app.bicep) exists in the repository.
2. If app.bicep does NOT exist, generate it using the radius_generate_app tool. IMPORTANT: Use ONLY Radius.* namespaces (e.g., Radius.Compute/containers, Radius.Data/mySqlDatabases, Radius.Security/secrets). NEVER use Applications.* namespaces.
3. Only AFTER app.bicep exists in the session worktree, open: open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph", repo: "<current-repo>" } }).

When the user asks to "show me the planned graph", "plan my app": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "planned", repo: "<current-repo>" } }).

When the user asks to "deploy my app", "create environment": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "environment", repo: "<current-repo>" } }).

When the user asks to "configure OIDC", "set up cloud credentials", "add credentials": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "credentials", repo: "<current-repo>" } }).

When the user asks to "show the diff", "compare branches", "app graph diff": open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "graph-diff", repo: "<current-repo>" } }).

CRITICAL: Always use instanceId "radius-panel" for ALL Radius Canvas operations. Never use different instanceIds — this prevents multiple panels from opening.

When a recipe is not found for a resource type during planned graph resolution, use the radius-extensibility-app-modeling skill (https://github.com/nicolejms/radius/blob/nicolejms/extensibility-app-modeling-skill/.github/skills/radius-extensibility-app-modeling/SKILL.md) to generate a custom resource type and recipe on-demand.`
            };
        },
    },
});

// ─── Process Lifecycle Hardening ──────────────────────────────────────────────
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
