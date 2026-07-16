// Canvas adapter — HTTP server host for the webview.
//
// Owns the local loopback server that backs each canvas instance: the ~21-route
// request handler (parse request -> call a radius-core use-case or adapter
// helper -> serialize), the page router, and the idempotent server lifecycle
// (stable per-instance port, reuse on re-open). The only product logic here is
// glue; everything substantive is delegated to radius-core or the sibling
// adapter modules (pages/deploy/infra/gh). No SDK surface — that stays in
// extension.ts.

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  computeGraphDiff,
  fetchBicepFromRepo,
  fetchRecipesFromGitHub,
  resolveRecipeOutputs,
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  stateRegistryForEnvironment,
} from "@radius-project/core";
import { buildGraphViaRad } from "@radius-project/shared";
import { ensureVendorScripts } from "./vendor.mjs";
import { escapeHtml, sharedCredentials, saveCredentials } from "./shared.mjs";
import { fetchFileFromRepo, github, cliExec, runCommand } from "./gh.mjs";
import { bootstrapGHCRStatePackage } from "./ghcr.mjs";
import { appParams, resolveDeployParams, partitionParams, buildDeployRadCommand } from "./bicep.mjs";
import {
  createWorkspaceGitHub,
  defaultBranchForState,
  fetchWorkspaceBicep,
  fetchWorkspaceFile,
  isWorkspaceSelection,
} from "./workspace.mjs";
import {
  generateAzureOIDC, validateAzureCredentials, generateAWSOIDC,
  generateVerifyWorkflow, generateDeployWorkflow, generateDeleteWorkflow, generatePortalUrl,
  DEPLOY_DISPATCHER_FILE, DEPLOY_AWS_FILE,
  DELETE_APP_DISPATCHER_FILE, DELETE_AWS_FILE,
} from "./infra.mjs";
import {
  findWorkflowRun, getRunDetail, fetchRunLog, fetchLiveDeployLog,
  fetchLiveActivityLog, fetchLiveControlPlaneLog, fetchDeployState, fetchDeployGraph,
  normalizeDeployedGraph, rewireDeployedGraphChain, reduceActivityLog,
  applyActivityToResources, extractErrorLines, extractRadDeployError,
  parseResourceProgress, parseRadDeployLog,
} from "./deploy.mjs";
import {
  graphPage, plannedGraphPage, graphDiffPage,
  deployedGraphPage, environmentPage, deployingPage,
} from "./pages.mjs";

// Per-instance canvas servers: instanceId -> { server, url, page, state }.
// Shared with the SDK entry (extension.ts) for open/close + shutdown.
export const servers = new Map();

// Short-lived cache for the /api/list-environments listing to keep the planned
// and deploy pages snappy. Invalidated on environment creation.
const ENV_LIST_TTL_MS = 15000;
const envListCache = new Map(); // repo -> { at, payload }

// Handoff callback registered by the SDK entry (extension.mjs). The server has
// no access to the SDK `session`, so when a graph/generate route finds no
// app.bicep it delegates through this hook, which injects a user turn asking the
// agent to run the radius-app-bicep skill. This is what makes branch/repo
// selection (not just canvas open) trigger generation automatically.
let appBicepHandoff = null;
export function setAppBicepHandoff(fn) { appBicepHandoff = fn; }

// Fire the app.bicep handoff at most once per repo+branch(es) for a given
// instance. Fire-and-forget so it never blocks the HTTP response.
function triggerAppBicepHandoff(entry, repo, branches, page) {
    try {
        if (typeof appBicepHandoff !== "function") return;
        if (!repo) return;
        const list = (Array.isArray(branches) ? branches : [branches]).filter(Boolean);
        const state = entry?.state;
        const key = `${repo}::${list.join(",")}`;
        if (state) {
            if (state.appBicepHandoffKey === key) return; // already handed off
            state.appBicepHandoffKey = key;
        }
        Promise.resolve(appBicepHandoff({ repo, branches: list, page })).catch(() => {});
    } catch { /* never let a handoff failure break the response */ }
}

// Bare filename of the legacy monolithic deploy workflow that the composite-
// action model (run-rad-commands*.yml) replaces. Removed from target repos on
// commit so it does not double-trigger alongside the new dispatcher.
const LEGACY_DEPLOY_WORKFLOW_FILE = 'radius-deploy.yml';

/**
 * Best-effort delete of the legacy `.github/workflows/radius-deploy.yml` from a
 * target repo. No-op when the file is absent. Self-contained (uses cliExec) so
 * it can be called from any request handler regardless of its local gh runner.
 */
function deleteLegacyDeployWorkflow(targetRepo) {
    const path = '.github/workflows/' + LEGACY_DEPLOY_WORKFLOW_FILE;
    return new Promise((resolve) => {
        cliExec('gh', ['api', '/repos/' + targetRepo + '/contents/' + path, '--jq', '.sha'], { timeout: 30000 }, (err, stdout) => {
            const sha = err ? '' : (stdout || '').trim();
            if (!sha) { resolve(false); return; }
            cliExec('gh', ['api', '--method', 'DELETE', '/repos/' + targetRepo + '/contents/' + path,
                '-f', 'message=Remove legacy Radius deploy workflow (replaced by run-rad-commands.yml)',
                '-f', 'sha=' + sha], { timeout: 30000 }, () => resolve(true));
        });
    });
}

// Timestamp of the last request served to any canvas webview. Updated by the
// request handler and read by the host-channel keepalive via the getter below
// to tell whether a panel is actively open (so the process isn't idle-reaped).
let lastWebviewActivityAt = 0;
export function getLastWebviewActivityAt() { return lastWebviewActivityAt; }

function accessForSelection(entry, repo, branch) {
    const state = entry?.state || {};
    const selectedBranch = branch || defaultBranchForState(state);
    const useWorkspace = isWorkspaceSelection(state, repo, selectedBranch);
    return {
        branch: selectedBranch,
        github: useWorkspace ? createWorkspaceGitHub(state, repo, selectedBranch) : github,
        useWorkspace,
    };
}

// Unlike repoMatches() in workspace.mjs, this helper always receives a
// non-empty repo string and performs strict equality only (no falsy-arg
// shortcut), so the workspace.mjs version is not reused here.
function repoMatchesWorkspace(state, repo) {
    const workspaceRepo = state?.workspaceRepo || "";
    return !!workspaceRepo && repo === workspaceRepo;
}

async function fetchBicepForSelection(entry, repo, branch) {
    const access = accessForSelection(entry, repo, branch);
    if (access.useWorkspace) {
        const local = await fetchWorkspaceBicep(entry.state, repo, access.branch);
        if (local !== null) return local;
    }
    return await fetchBicepFromRepo(github, repo, access.branch);
}

async function fetchFileForSelection(entry, repo, branch, repoPath) {
    const access = accessForSelection(entry, repo, branch);
    if (access.useWorkspace) {
        const local = await fetchWorkspaceFile(entry.state, repo, access.branch, repoPath);
        if (local !== null) return local;
    }
    return await fetchFileFromRepo(repo, repoPath, access.branch);
}

function createRequestHandler(instanceId) {
    return async (req, res) => {
        lastWebviewActivityAt = Date.now();
        const url = new URL(req.url, `http://localhost`);
        const pathname = url.pathname;

        // Lightweight liveness probe used by the client-side heartbeat so pages
        // can detect when the server has come back after an idle respawn.
        if (pathname === "/api/ping") {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, instanceId }));
            return;
        }

        // JSON API: OIDC validation
        if (pathname === "/api/oidc" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                if (data.provider === "azure") {
                    // Real Azure validation via az CLI
                    const validation = await validateAzureCredentials(data);
                    const entry = servers.get(instanceId);
                    if (validation.success) {
                        const result = {
                            message: `✅ Azure authentication confirmed — logged in as ${validation.userName || 'user'}`,
                            validated: true,
                            tenantId: validation.tenantId,
                            subscriptionId: validation.subscriptionId,
                            subscriptionName: validation.subscriptionName,
                            userName: validation.userName,
                            output: generateAzureOIDC(data).output
                        };
                        if (entry) {
                            entry.state.oidcAzure = { ...result, clientId: data.clientId || "", tenantName: "", clientName: "" };
                        }
                        // Persist credentials
                        sharedCredentials.azure = {
                            tenantId: validation.tenantId,
                            subscriptionId: validation.subscriptionId,
                            subscriptionName: validation.subscriptionName,
                            userName: validation.userName,
                            clientId: data.clientId || ""
                        };
                        saveCredentials();
                        res.setHeader("Content-Type", "application/json");
                        res.writeHead(200);
                        res.end(JSON.stringify(result));
                    } else {
                        res.setHeader("Content-Type", "application/json");
                        res.writeHead(200);
                        res.end(JSON.stringify({ message: `❌ ${validation.error}`, validated: false, output: '' }));
                    }
                } else {
                    const result = generateAWSOIDC(data);
                    const entry = servers.get(instanceId);
                    if (entry) {
                        entry.state.oidcAws = { ...result, accountId: data.accountId || "", accountName: data.accountName || "", region: data.region || "" };
                    }
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                }
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // Verify Azure CLI login with specified tenant/subscription
        if (pathname === "/api/verify-azure-login" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const tenantId = (data.tenantId || '').trim();
                const subscriptionId = (data.subscriptionId || '').trim();

                // NOTE: we intentionally do NOT run `az login` here. Interactive
                // login opens a browser/device-code flow that blocks indefinitely
                // and would hang this server. Instead we verify the user's existing
                // Azure CLI session (and optionally switch subscription). If there
                // is no session, we tell them to run `az login` in their terminal.
                if (subscriptionId) {
                    try { await runCommand("az", ["account", "set", "--subscription", subscriptionId], { timeout: 10000 }); } catch (e) {}
                }

                let acct;
                try {
                    const acctJson = await runCommand("az", ["account", "show", "-o", "json"], { timeout: 10000 });
                    acct = JSON.parse(acctJson);
                } catch (e) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({ error: 'No active Azure CLI session. Run "az login" in your terminal, then click Verify again.' }));
                    return;
                }

                // If a tenant was specified and the active session is for a
                // different tenant, surface a clear, actionable message.
                if (tenantId && acct.tenantId && acct.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({ error: `Active Azure session is tenant ${acct.tenantId}, not ${tenantId}. Run "az login --tenant ${tenantId}" in your terminal, then click Verify again.` }));
                    return;
                }

                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    user: acct.user?.name || '',
                    tenantId: acct.tenantId,
                    subscriptionId: acct.id,
                    subscriptionName: acct.name
                }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ error: 'Azure CLI verification failed: ' + e.message }));
            }
            return;
        }

        // Auto-setup Azure credentials: create App Registration, federated cred (OIDC), role assignment
        if (pathname === "/api/azure-auto-setup" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const targetRepo = data.repo || '';
                const envName = data.environment || 'dev';
                const resourceGroup = data.resourceGroup || '';
                const clusterName = data.cluster || '';

                if (!targetRepo || !resourceGroup || !clusterName) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'repo, resourceGroup, and cluster are required.' }));
                    return;
                }

                function runCmd(cmd, args) {
                    return new Promise((resolve) => {
                        cliExec(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
                            resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
                        });
                    });
                }

                const steps = [];

                // Step 1: Get account info — use provided values or fall back to az CLI
                let tenantId = data.tenantId || '';
                let subscriptionId = data.subscriptionId || '';

                if (!tenantId || !subscriptionId) {
                    steps.push('Checking Azure CLI login...');
                    const acctResult = await runCmd('az', ['account', 'show', '--output', 'json']);
                    if (acctResult.code !== 0) {
                        res.setHeader("Content-Type", "application/json");
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Azure CLI not logged in. Run "az login" first.', steps }));
                        return;
                    }
                    const account = JSON.parse(acctResult.stdout);
                    tenantId = tenantId || account.tenantId;
                    subscriptionId = subscriptionId || account.id;
                }
                steps.push(`✅ Using subscription=${subscriptionId}, tenant=${tenantId}`);

                // Step 2: Create a fresh App Registration. We always auto-create
                // new credentials rather than reusing an existing Client ID.
                const appName = `radius-deploy-${targetRepo.replace('/', '-')}`;
                steps.push(`Creating App Registration: ${appName}...`);
                const appResult = await runCmd('az', ['ad', 'app', 'create', '--display-name', appName, '--query', 'appId', '-o', 'tsv']);
                if (appResult.code !== 0) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Failed to create App Registration: ' + appResult.stderr, steps }));
                    return;
                }
                const clientId = appResult.stdout.trim();
                steps.push(`✅ App Registration created: ${clientId}`);

                // Step 3: Create Service Principal
                steps.push('Creating Service Principal...');
                const spResult = await runCmd('az', ['ad', 'sp', 'create', '--id', clientId]);
                if (spResult.code !== 0 && !spResult.stderr.includes('already exists')) {
                    // SP might already exist, try to get it
                    const spShow = await runCmd('az', ['ad', 'sp', 'show', '--id', clientId, '--query', 'id', '-o', 'tsv']);
                    if (spShow.code !== 0) {
                        steps.push('⚠️ Could not create/find Service Principal: ' + spResult.stderr);
                    }
                }
                steps.push('✅ Service Principal ready');

                // Step 4: Create Federated Credential for GitHub Actions OIDC
                steps.push('Creating federated credential for GitHub OIDC...');
                const fedParams = JSON.stringify({
                    name: `github-actions-${envName}`,
                    issuer: 'https://token.actions.githubusercontent.com',
                    subject: `repo:${targetRepo}:environment:${envName}`,
                    audiences: ['api://AzureADTokenExchange']
                });
                const { writeFileSync, unlinkSync } = await import("node:fs");
                const { tmpdir } = await import("node:os");
                const { join } = await import("node:path");
                const fedTmpFile = join(tmpdir(), 'fed-cred-' + Date.now() + '.json');
                writeFileSync(fedTmpFile, fedParams);
                const fedResult = await runCmd('az', ['ad', 'app', 'federated-credential', 'create', '--id', clientId, '--parameters', '@' + fedTmpFile]);
                try { unlinkSync(fedTmpFile); } catch {}
                if (fedResult.code !== 0 && !fedResult.stderr.includes('already exists')) {
                    steps.push('⚠️ Federated credential warning: ' + fedResult.stderr);
                } else {
                    steps.push('✅ Federated credential created');
                }

                // Step 5: Assign Contributor role on the resource group
                steps.push(`Assigning Contributor role on ${resourceGroup}...`);
                const roleResult = await runCmd('az', ['role', 'assignment', 'create', '--assignee', clientId, '--role', 'Contributor', '--scope', `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`, '--output', 'none']);
                if (roleResult.code !== 0 && !roleResult.stderr.includes('already exists')) {
                    steps.push('⚠️ Role assignment warning: ' + roleResult.stderr);
                } else {
                    steps.push('✅ Contributor role assigned');
                }

                // Return all credentials for the environment setup
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    clientId,
                    tenantId,
                    subscriptionId,
                    resourceGroup,
                    cluster: clusterName,
                    appName,
                    steps
                }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // Create GitHub Environment with secrets/variables and commit verify workflow
        if (pathname === "/api/app-params" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo || "";
                if (!repo) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "No repository specified.", params: [] }));
                    return;
                }
                // Resolve the branch the deploy will run against (the caller's
                // selection, else the repo default) and locate the app.bicep the
                // same way the deploy route does (.radius/app.bicep, then app.bicep).
                let branch = data.branch || "";
                if (!branch) {
                    const def = await runCommand("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]).catch(() => "");
                    branch = (def || "").trim() || "main";
                }
                let source = await fetchFileFromRepo(repo, ".radius/app.bicep", branch);
                if (!source) source = await fetchFileFromRepo(repo, "app.bicep", branch);
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ branch, found: !!source, params: source ? appParams(source) : [] }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ error: e.message, params: [] }));
            }
            return;
        }

        if (pathname === "/api/create-environment" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const targetRepo = data.repo || '';
                const envName = data.environment || 'dev';
                const provider = data.provider || 'azure';

                if (!targetRepo) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No target repository specified.' }));
                    return;
                }

                function runGh(args, stdin, extraOpts) {
                    return new Promise((resolve) => {
                        const child = cliExec("gh", args, { timeout: 30000, ...(extraOpts || {}) }, (err, stdout, stderr) => {
                            resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
                        });
                        if (stdin !== undefined) child.stdin?.end(stdin);
                    });
                }

                async function runGhOrThrow(args, message, stdin) {
                    const result = await runGh(args, stdin);
                    if (result.code !== 0) {
                        const detail = (result.stderr || result.stdout || '').trim();
                        throw new Error(detail ? `${message}: ${detail}` : message);
                    }
                    return result;
                }

                async function setEnvironmentVariable(name, value) {
                    if (!value) return false;
                    await runGhOrThrow(
                        ['variable', 'set', name, '--body', value, '--env', envName, '--repo', targetRepo],
                        `Failed to set ${name} on GitHub environment "${envName}"`
                    );
                    return true;
                }

                // The host often injects GH_TOKEN (an OAuth app token) that lacks the
                // `workflow` scope, which is required to create/update files under
                // .github/workflows/ or to dispatch workflows. The user's stored gh
                // credential (keyring) usually has that scope. For workflow-scoped
                // commands, run normally first; if it fails while an injected token is
                // present, retry with GH_TOKEN/GITHUB_TOKEN stripped so gh falls back
                // to the keyring credential. (A missing `workflow` scope surfaces as
                // either a 403 "without workflow scope" on updates or a bare 404 on
                // creates, so we retry on any failure rather than pattern-matching.)
                function needsWorkflowScope(stderr) {
                    return /workflow.{0,20}scope/i.test(stderr || '') || /without .?workflow.? scope/i.test(stderr || '');
                }
                async function runGhWorkflow(args, stdin) {
                    const first = await runGh(args, stdin);
                    if (first.code === 0) return first;
                    const hasInjectedToken = !!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
                    if (!hasInjectedToken) return first;
                    const fallbackEnv = { ...process.env };
                    delete fallbackEnv.GH_TOKEN;
                    delete fallbackEnv.GITHUB_TOKEN;
                    const retry = await runGh(args, stdin, { env: fallbackEnv });
                    // Prefer the retry only if it actually succeeded; otherwise keep the
                    // original error, which is usually the more meaningful one.
                    return retry.code === 0 ? retry : first;
                }

                const steps = [];
                const stateRegistry = stateRegistryForEnvironment(targetRepo, envName);

                steps.push('Creating private GHCR state package "' + stateRegistry + '"...');
                const statePackage = await bootstrapGHCRStatePackage({
                    targetRepository: targetRepo,
                    registry: stateRegistry,
                });
                steps.push(`✅ GHCR state package is ${statePackage.visibility} and linked to ${targetRepo}.`);

                // Step 1: Create the GitHub environment
                steps.push('Creating GitHub environment "' + envName + '"...');
                await runGhOrThrow(
                    ['api', '--method', 'PUT', '/repos/' + targetRepo + '/environments/' + envName],
                    'Failed to create GitHub environment "' + envName + '"'
                );
                // A new environment invalidates the cached listing for this repo.
                envListCache.delete(targetRepo);

                steps.push('Configuring Radius state package "' + stateRegistry + '"...');
                await setEnvironmentVariable('RADIUS_STATE_BACKEND', OCI_STATE_BACKEND);
                await setEnvironmentVariable('RADIUS_STATE_REGISTRY', stateRegistry);
                await setEnvironmentVariable('RADIUS_STATE_ARCHIVE', DEFAULT_STATE_ARCHIVE);
                steps.push(`✅ Radius state package configured with archive tag "${DEFAULT_STATE_ARCHIVE}".`);

                // Step 2: Set environment variables and secrets based on provider
                steps.push('Setting environment variables and secrets...');
                // Fall back to shared credentials for values not provided in the request
                const azureCreds = sharedCredentials.azure || {};
                const awsCreds = sharedCredentials.aws || {};

                if (provider === 'azure') {
                    const clientId = data.clientId || azureCreds.clientId || '';
                    const tenantId = data.tenantId || azureCreds.tenantId || '';
                    const subscriptionId = data.subscriptionId || azureCreds.subscriptionId || '';
                    const rg = data.resourceGroup || '';
                    const k8s = data.cluster || '';

                    await setEnvironmentVariable('AZURE_CLIENT_ID', clientId);
                    await setEnvironmentVariable('AZURE_TENANT_ID', tenantId);
                    await setEnvironmentVariable('AZURE_SUBSCRIPTION_ID', subscriptionId);
                    await setEnvironmentVariable('AZURE_RESOURCE_GROUP', rg);
                    await setEnvironmentVariable('AZURE_AKS_CLUSTER_NAME', k8s);
                    await setEnvironmentVariable('AZURE_LOCATION', data.location);

                    const setCount = [clientId, tenantId, subscriptionId, rg, k8s, data.location].filter(Boolean).length;
                    steps.push(`Set ${setCount} environment value(s) for Azure.`);
                    if (!clientId || !tenantId || !subscriptionId) {
                        steps.push('⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually.');
                    }
                } else {
                    const roleArn = data.roleArn || '';
                    const region = data.region || awsCreds.region || 'us-east-1';
                    const accountId = data.accountId || awsCreds.accountId || '';
                    const k8s = data.cluster || '';

                    await setEnvironmentVariable('AWS_ROLE_ARN', roleArn);
                    await setEnvironmentVariable('AWS_REGION', region);
                    await setEnvironmentVariable('AWS_ACCOUNT_ID', accountId);
                    await setEnvironmentVariable('AWS_EKS_CLUSTER_NAME', k8s);
                    await setEnvironmentVariable('RADIUS_VPC_ID', data.vpcId);
                    await setEnvironmentVariable('RADIUS_SUBNET_IDS', data.subnetIds);
                }

                // Step 2b: Provision application parameters. Parse the app.bicep the
                // deploy will run against and auto-generate a value for every required
                // parameter that has no Bicep default (e.g. an @secure() password),
                // skipping params that do have a default (Bicep applies it). Values are
                // no longer collected from the UI. The result is stored as a single
                // JSON secret the deploy workflow reads and expands into
                // `--parameters name=value` pairs.
                try {
                    let paramBranch = data.branch || '';
                    if (!paramBranch) {
                        const def = await runCommand('gh', ['repo', 'view', targetRepo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']).catch(() => '');
                        paramBranch = (def || '').trim() || 'main';
                    }
                    let bicepSource = await fetchFileFromRepo(targetRepo, '.radius/app.bicep', paramBranch);
                    let bicepPath = '.radius/app.bicep';
                    if (!bicepSource) {
                        bicepSource = await fetchFileFromRepo(targetRepo, 'app.bicep', paramBranch);
                        bicepPath = 'app.bicep';
                    }
                    if (bicepSource) {
                        const parsed = appParams(bicepSource);
                        const resolved = resolveDeployParams(parsed);
                        // Split into secret (provisioned as a secret, appended by the
                        // workflow) and non-secret (inlined into the rad deploy command).
                        const { secret: secretParams, public: publicParams } = partitionParams(parsed, resolved);
                        await runGhOrThrow(
                            ['secret', 'set', 'RADIUS_DEPLOY_PARAMS', '--env', envName, '--repo', targetRepo],
                            `Failed to set RADIUS_DEPLOY_PARAMS on GitHub environment "${envName}"`,
                            Object.keys(secretParams).length ? JSON.stringify(secretParams) : '{}'
                        );

                        // Build the rad deploy command with non-secret params inline and
                        // store it as an environment variable. The deploy workflow reads
                        // it via `inputs.rad_commands || vars.RADIUS_RAD_COMMANDS`, so it
                        // applies on both explicit dispatch and the verify→deploy auto
                        // trigger (where inputs are empty). Secret params are appended by
                        // the workflow from RADIUS_DEPLOY_PARAMS.
                        const radCommand = buildDeployRadCommand(bicepPath, envName, publicParams);
                        await setEnvironmentVariable('RADIUS_RAD_COMMANDS', radCommand);

                        const names = Object.keys(resolved);
                        if (names.length > 0) {
                            steps.push(`Provisioned ${names.length} application parameter(s) (auto-generated: ${names.join(', ')}).`);
                        }
                    }
                } catch (paramErr) {
                    steps.push('⚠️ Could not resolve application parameters: ' + paramErr.message);
                }

                // Step 3: Commit the verify-credentials workflow
                steps.push('Committing verify-credentials workflow...');
                const verifyWorkflow = await generateVerifyWorkflow(envName, provider);
                const verifyContent = Buffer.from(verifyWorkflow).toString('base64');
                const verifyPath = '.github/workflows/radius-verify-credentials.yml';

                // Check if file exists (get sha for update)
                const checkResult = await runGh(['api', '/repos/' + targetRepo + '/contents/' + verifyPath, '--jq', '.sha']);
                const existingSha = checkResult.code === 0 ? checkResult.stdout.trim() : '';

                const commitBody = JSON.stringify({
                    message: 'Add Radius verify-credentials workflow for environment ' + envName,
                    content: verifyContent,
                    ...(existingSha ? { sha: existingSha } : {})
                });

                // Write to temp file for stdin
                const { writeFileSync, unlinkSync } = await import("node:fs");
                const { tmpdir } = await import("node:os");
                const { join } = await import("node:path");
                const tmpFile = join(tmpdir(), 'radius-verify-commit-' + Date.now() + '.json');
                writeFileSync(tmpFile, commitBody);

                const commitResult = await runGhWorkflow(['api', '--method', 'PUT', '/repos/' + targetRepo + '/contents/' + verifyPath, '--input', tmpFile]);
                try { unlinkSync(tmpFile); } catch {}

                if (commitResult.code !== 0) {
                    steps.push('❌ Failed to commit verify-credentials workflow.');
                    const scopeHint = needsWorkflowScope(commitResult.stderr)
                        ? ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
                        : ' Check that you have write access to the repository and that GitHub Actions is enabled.';
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: 'Failed to commit the verify-credentials workflow (' + verifyPath + ') to ' + targetRepo + '. ' + ((commitResult.stderr || '').trim() || 'The GitHub API request failed.') + scopeHint,
                        steps
                    }));
                    return;
                }
                steps.push('✅ Verify workflow committed.');

                // Step 4: Also commit the deploy workflows (dispatcher + both
                // provider workflows). The dispatcher references both provider
                // files by path, so all three must exist in the target repo.
                steps.push('Committing deploy workflows...');
                const deployWorkflows = await generateDeployWorkflow(envName, '.radius/app.bicep');

                for (const [fileName, content] of Object.entries(deployWorkflows)) {
                    // Only Azure workflows are pushed to the target repo for now.
                    // The AWS deploy workflow is still generated (code retained)
                    // but intentionally skipped so it never lands on the branch.
                    if (fileName === DEPLOY_AWS_FILE) {
                        steps.push('Skipping AWS deploy workflow (' + fileName + ').');
                        continue;
                    }
                    const deployContent = Buffer.from(content).toString('base64');
                    const deployPath = '.github/workflows/' + fileName;

                    const deployCheckResult = await runGh(['api', '/repos/' + targetRepo + '/contents/' + deployPath, '--jq', '.sha']);
                    const deploySha = deployCheckResult.code === 0 ? deployCheckResult.stdout.trim() : '';

                    const deployCommitBody = JSON.stringify({
                        message: 'Add Radius deploy workflow (' + fileName + ') for environment ' + envName,
                        content: deployContent,
                        ...(deploySha ? { sha: deploySha } : {})
                    });

                    const tmpFile2 = join(tmpdir(), 'radius-deploy-commit-' + Date.now() + '.json');
                    writeFileSync(tmpFile2, deployCommitBody);

                    const deployCommitResult = await runGhWorkflow(['api', '--method', 'PUT', '/repos/' + targetRepo + '/contents/' + deployPath, '--input', tmpFile2]);
                    try { unlinkSync(tmpFile2); } catch {}

                    if (deployCommitResult.code !== 0) {
                        steps.push('❌ Failed to commit deploy workflow ' + fileName + '.');
                        const scopeHint2 = needsWorkflowScope(deployCommitResult.stderr)
                            ? ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
                            : ' Check that you have write access to the repository and that GitHub Actions is enabled.';
                        res.setHeader("Content-Type", "application/json");
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            error: 'Failed to commit the deploy workflow (' + deployPath + ') to ' + targetRepo + '. ' + ((deployCommitResult.stderr || '').trim() || 'The GitHub API request failed.') + scopeHint2,
                            steps
                        }));
                        return;
                    }
                }
                // Best-effort: remove the legacy monolithic deploy workflow so it
                // does not double-trigger alongside the new dispatcher.
                await deleteLegacyDeployWorkflow(targetRepo);
                steps.push('✅ Deploy workflows committed.');

                // Step 4b: Commit the application-delete workflows (dispatcher +
                // provider workflows) so the Delete Deployment button can dispatch
                // `rad app delete`. As with deploy, only the Azure workflows are
                // pushed for now; the AWS provider file is skipped.
                steps.push('Committing delete workflows...');
                try {
                    const deleteWorkflows = await generateDeleteWorkflow(envName);
                    for (const [fileName, content] of Object.entries(deleteWorkflows)) {
                        if (fileName === DELETE_AWS_FILE) {
                            steps.push('Skipping AWS delete workflow (' + fileName + ').');
                            continue;
                        }
                        const delContent = Buffer.from(content).toString('base64');
                        const delPath = '.github/workflows/' + fileName;

                        const delCheckResult = await runGh(['api', '/repos/' + targetRepo + '/contents/' + delPath, '--jq', '.sha']);
                        const delFileSha = delCheckResult.code === 0 ? delCheckResult.stdout.trim() : '';

                        const delCommitBody = JSON.stringify({
                            message: 'Add Radius delete workflow (' + fileName + ') for environment ' + envName,
                            content: delContent,
                            ...(delFileSha ? { sha: delFileSha } : {})
                        });

                        const tmpFile3 = join(tmpdir(), 'radius-delete-commit-' + Date.now() + '.json');
                        writeFileSync(tmpFile3, delCommitBody);
                        const delCommitResult = await runGhWorkflow(['api', '--method', 'PUT', '/repos/' + targetRepo + '/contents/' + delPath, '--input', tmpFile3]);
                        try { unlinkSync(tmpFile3); } catch {}

                        if (delCommitResult.code !== 0) {
                            steps.push('⚠️ Could not commit delete workflow ' + fileName + ': ' + ((delCommitResult.stderr || '').trim() || 'GitHub API request failed.'));
                        }
                    }
                    steps.push('✅ Delete workflows committed.');
                } catch (delErr) {
                    // Delete workflows are non-critical to environment creation, so
                    // surface the failure but don't abort the whole flow.
                    steps.push('⚠️ Could not generate/commit delete workflows: ' + delErr.message);
                }

                // Step 5: Dispatch the verify workflow
                steps.push('Dispatching verify-credentials workflow...');
                // Wait briefly for GitHub to index the workflow
                await new Promise(r => setTimeout(r, 3000));
                const dispatchedAt = Date.now();
                const dispatchDelays = [0, 2000, 5000];
                let dispatchResult = { code: 1, stdout: '', stderr: '' };
                for (const delay of dispatchDelays) {
                    if (delay > 0) await new Promise(r => setTimeout(r, delay));
                    dispatchResult = await runGhWorkflow(['workflow', 'run', 'radius-verify-credentials.yml', '-f', 'environment=' + envName, '--repo', targetRepo]);
                    if (dispatchResult.code === 0) break;
                }

                let verifyRunUrl = '';
                let verifyRunId = null;
                if (dispatchResult.code === 0) {
                    steps.push('✅ Verify workflow dispatched.');
                    await new Promise(r => setTimeout(r, 5000));
                    const runsResult = await runGh(['run', 'list', '--workflow=radius-verify-credentials.yml', '--limit', '1', '--json', 'databaseId,status,url', '--repo', targetRepo]);
                    try {
                        const runs = JSON.parse(runsResult.stdout);
                        if (runs.length > 0) {
                            verifyRunId = runs[0].databaseId;
                            verifyRunUrl = 'https://github.com/' + targetRepo + '/actions/runs/' + verifyRunId;
                            steps.push('Verify run: ' + verifyRunUrl);
                        }
                    } catch {}
                    steps.push('Credentials verification dispatched. Deploy your application from the Environments list when ready.');
                } else {
                    const detail = (dispatchResult.stderr || dispatchResult.stdout || '').trim() || 'The GitHub CLI request failed.';
                    steps.push('❌ Could not dispatch verify workflow: ' + detail);
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: 'Environment and state package were configured, but the verify workflow could not be dispatched after multiple attempts. ' + detail,
                        environment: envName,
                        provider,
                        repo: targetRepo,
                        stateBackend: OCI_STATE_BACKEND,
                        stateRegistry,
                        stateArchive: DEFAULT_STATE_ARCHIVE,
                        steps
                    }));
                    return;
                }

                // Record dispatch markers so the deploy monitor can track the
                // correct (newly-triggered) runs rather than any stale runs.
                {
                    const entry = servers.get(instanceId);
                    if (entry) {
                        entry.state.deployDispatchedAt = dispatchedAt;
                        entry.state.verifyRunId = verifyRunId;
                        entry.state.verifyRunUrl = verifyRunUrl;
                    }
                }

                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({
                    success: true,
                    environment: envName,
                    provider,
                    repo: targetRepo,
                    stateBackend: OCI_STATE_BACKEND,
                    stateRegistry,
                    stateArchive: DEFAULT_STATE_ARCHIVE,
                    verifyRunUrl,
                    steps
                }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === "/api/load-graph-stream" && req.method === "GET") {
            const url = new URL(req.url, `http://127.0.0.1`);
            const repo = url.searchParams.get('repo') || '';
            const entry = servers.get(instanceId);
            const branch = url.searchParams.get('branch') || defaultBranchForState(entry?.state);

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.writeHead(200);

            function sendProgress(message) {
                res.write(`event: progress\ndata: ${JSON.stringify({ message })}\n\n`);
            }
            function sendDone(data) {
                res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
                res.end();
            }

            if (!repo) {
                sendDone({ error: 'Please select a repository.' });
                return;
            }

            try {
                sendProgress(`Checking ${repo} for existing app.bicep...`);
                const content = await fetchBicepForSelection(entry, repo, branch);

                if (content) {
                    sendProgress('Found existing app.bicep — parsing resources...');
                } else {
                    triggerAppBicepHandoff(entry, repo, branch, 'graph');
                    sendDone({
                        error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    });
                    return;
                }

                const resources = await buildGraphViaRad(content, ".radius/app.bicep", { log: sendProgress });
                sendProgress(`Mapped ${resources.length} resource(s) — rendering graph...`);

                if (entry) {
                    entry.state.graphResources = resources;
                    entry.state.graphTargetRepo = repo;
                    entry.state.graphBranch = branch;
                }

                sendDone({ reload: true });
            } catch (e) {
                sendDone({ error: e.message });
            }
            return;
        }

        if (pathname === "/api/progress" && req.method === "GET") {
            const entry = servers.get(instanceId);
            const messages = entry?.state?.progressMessages || [];
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify({ messages }));
            return;
        }

        if (pathname === "/api/deployed-graph" && req.method === "GET") {
            const entry = servers.get(instanceId);
            const reqUrl = new URL(req.url, `http://127.0.0.1`);
            const repo = (reqUrl.searchParams.get('repo') || '').trim()
                || entry?.state?.contextRepo || entry?.state?.deployingRepo
                || entry?.state?.plannedRepo || entry?.state?.graphTargetRepo || '';
            res.setHeader("Content-Type", "application/json");
            if (!repo) { res.writeHead(200); res.end(JSON.stringify({ resources: [], repo: '' })); return; }
            // Prefer the live deploy-graph.json on the orphan status branch (source
            // of truth). Fall back to any graph captured in state this session.
            let graph = await fetchDeployGraph(repo);
            if (!graph && entry?.state?.deployedGraph) graph = entry.state.deployedGraph;
            let resources = Array.isArray(graph) ? graph : (graph?.resources || []);
            // DEMO: present the deployed topology as container → cache → database.
            resources = rewireDeployedGraphChain(resources);
            // Re-derive connections (e.g. database→secret) that rad app graph
            // omits, so the deployed graph renders connected like the planned one.
            resources = normalizeDeployedGraph(resources);
            res.writeHead(200);
            res.end(JSON.stringify({ resources, repo, branch: (entry?.state?.workspaceBranch && repoMatchesWorkspace(entry.state, repo)) ? entry.state.workspaceBranch : "main" }));
            return;
        }

        if (pathname === "/api/deploy-status" && req.method === "GET") {
            const entry = servers.get(instanceId);
            const resources = entry?.state?.deployingResources || entry?.state?.plannedResources || [];
            const logs = entry?.state?.deployLogs || [];
            const logBase = entry?.state?.deployLogBase || 0;
            const logTotal = logBase + logs.length;
            const status = entry?.state?.deployStatus || 'pending';
            const error = entry?.state?.deployError || null;
            const startedAt = entry?.state?.deployStartedAt || null;
            const finishedAt = entry?.state?.deployFinishedAt || null;
            const deployedGraph = entry?.state?.deployedGraph || null;
            const deployRunUrl = entry?.state?.deployRunUrl || null;
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            // Incremental log delivery: when the client passes ?since=<absolute
            // line index>, send only the new lines instead of re-serializing the
            // entire (bounded) buffer on every 1.5s poll. Callers that omit it
            // (e.g. the deployed-graph poller, which only reads resources) get the
            // bounded buffer for backward compatibility.
            const sinceRaw = url.searchParams.get('since');
            const since = sinceRaw === null ? NaN : parseInt(sinceRaw, 10);
            if (Number.isFinite(since)) {
                const startIdx = Math.max(0, since - logBase);
                const logsNew = logs.slice(startIdx);
                res.end(JSON.stringify({ resources, logsNew, logBase, logTotal, status, error, startedAt, finishedAt, deployedGraph, deployRunUrl }));
            } else {
                res.end(JSON.stringify({ resources, logs, logBase, logTotal, status, error, startedAt, finishedAt, deployedGraph, deployRunUrl }));
            }
            return;
        }


        if (pathname === "/api/load-graph" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo || '';
                const entry = servers.get(instanceId);
                const branch = data.branch || defaultBranchForState(entry?.state);
                if (!repo) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({ error: 'Please select a repository.' }));
                    return;
                }

                function addProgress(msg) {
                    if (entry) {
                        if (!entry.state.progressMessages) entry.state.progressMessages = [];
                        entry.state.progressMessages.push(msg);
                    }
                }
                // Reset progress
                if (entry) entry.state.progressMessages = [];

                addProgress(`Checking ${repo} for existing app.bicep...`);
                const content = await fetchBicepForSelection(entry, repo, branch);
                if (content) {
                    addProgress('Found existing app.bicep — parsing resources...');
                } else {
                    addProgress('.radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill.');
                    triggerAppBicepHandoff(entry, repo, branch, 'graph');
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    }));
                    return;
                }

                const resources = await buildGraphViaRad(content, ".radius/app.bicep", { log: addProgress });
                addProgress(`Mapped ${resources.length} resource(s) — rendering graph...`);

                if (entry) {
                    entry.state.graphResources = resources;
                    entry.state.graphTargetRepo = repo;
                    entry.state.graphBranch = branch;
                }
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ reload: true }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === "/api/list-environments" && req.method === "GET") {
            const repo = url.searchParams.get("repo") || "";
            const respond = (payload) => {
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.writeHead(200);
                res.end(JSON.stringify(payload));
            };
            if (!repo) { respond({ environments: [] }); return; }

            const cached = envListCache.get(repo);
            if (cached && Date.now() - cached.at < ENV_LIST_TTL_MS) { respond(cached.payload); return; }

            const gh = (args, timeout = 12000) => new Promise((resolve) => {
                cliExec("gh", args, { timeout }, (err, stdout) => {
                    if (err) { resolve(""); return; }
                    resolve((stdout || "").trim());
                });
            });

            try {
                // 1) List environment names + ids for the repo. Kick off the
                //    verify-credentials workflow-runs fetch in parallel — it's
                //    independent of the names, so there's no reason to wait.
                const verifyRunsPromise = gh([
                    "api",
                    `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
                    "--jq", ".workflow_runs[] | (.id|tostring) + \"\\t\" + (.status // \"\") + \"\\t\" + (.conclusion // \"\")",
                ]);
                const namesRes = await new Promise((resolve) => {
                    cliExec("gh", ["api", "--paginate", `/repos/${repo}/environments?per_page=100`, "--jq", ".environments[] | (.id|tostring) + \"\\t\" + .name"], { timeout: 12000 }, (err, stdout, stderr) => {
                        if (err) { resolve({ error: ((stderr || err.message || "").trim()) || "Failed to list environments." }); return; }
                        resolve({ stdout: (stdout || "").trim() });
                    });
                });
                // Surface a genuine API/auth/permission failure instead of
                // silently reporting "no environments" (which hides real
                // problems). Failures are not cached so a retry can recover.
                if (namesRes.error) {
                    respond({ environments: [], error: namesRes.error });
                    return;
                }
                const namesRaw = namesRes.stdout;
                const rows = namesRaw ? namesRaw.split("\n").filter(Boolean).map((l) => {
                    const tab = l.indexOf("\t");
                    return tab === -1 ? { id: "", name: l } : { id: l.slice(0, tab), name: l.slice(tab + 1) };
                }) : [];
                if (rows.length === 0) {
                    const payload = { environments: [] };
                    respond(payload);
                    envListCache.set(repo, { at: Date.now(), payload });
                    return;
                }

                // Index the pre-fetched verify runs by run id. The environment
                // status is derived from these (not from app deployments): an
                // environment is "Success" only once it exists AND its
                // verify-credentials workflow has passed.
                const verifyRunsRaw = await verifyRunsPromise;
                const verifyRuns = new Map();
                if (verifyRunsRaw) {
                    for (const line of verifyRunsRaw.split("\n").filter(Boolean)) {
                        const [rid, rstatus, rconclusion] = line.split("\t");
                        verifyRuns.set(rid, { status: rstatus, conclusion: rconclusion });
                    }
                }
                // Map a verify run's outcome to an environment status.
                const verifyStatusOf = (run) => {
                    if (!run) return null;
                    if (run.status !== "completed") return "pending"; // queued / in_progress
                    if (run.conclusion === "success") return "success";
                    return "failed"; // failure / cancelled / timed_out / etc.
                };

                // 2) For each environment, derive provider (from stored variables)
                //    and a status from the verify-credentials workflow. Both the
                //    verify and deploy workflows create deployments to the same
                //    environment, so we walk this env's deployments newest-first
                //    until we find one created by a verify-credentials run.
                const environments = await Promise.all(rows.map(async ({ id, name }) => {
                    // The variables (provider) and deployments (status) lookups are
                    // independent, so fire them together.
                    const [varsRaw, depIdsRaw] = await Promise.all([
                        gh(["api", `/repos/${repo}/environments/${encodeURIComponent(name)}/variables?per_page=100`, "--jq", ".variables[].name"]),
                        verifyRuns.size > 0
                            ? gh(["api", `/repos/${repo}/deployments?environment=${encodeURIComponent(name)}&per_page=10`, "--jq", ".[].id"])
                            : Promise.resolve(""),
                    ]);
                    let provider = "";
                    if (/AZURE_/.test(varsRaw)) provider = "azure";
                    else if (/AWS_/.test(varsRaw)) provider = "aws";

                    // Status reflects the verify-credentials workflow only:
                    // pending while it runs, success when it passes, failed if it
                    // fails. Default to "pending" until we find a matching run.
                    let status = "pending";
                    if (verifyRuns.size > 0) {
                        const depIds = depIdsRaw ? depIdsRaw.split("\n").filter(Boolean) : [];
                        // Resolve every deployment's originating-run URL in parallel
                        // (deployments come back newest-first), then pick the newest
                        // one created by a verify-credentials run. Doing this serially
                        // was the main source of latency for this endpoint.
                        const logUrls = await Promise.all(depIds.map((depId) =>
                            gh(["api", `/repos/${repo}/deployments/${depId}/statuses?per_page=1`, "--jq", ".[0].log_url // .[0].target_url // \"\""])
                        ));
                        for (const logUrl of logUrls) {
                            const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
                            if (!m) continue;
                            const run = verifyRuns.get(m[1]);
                            if (run) { status = verifyStatusOf(run) || status; break; }
                        }
                    }

                    const webUrl = id
                        ? `https://github.com/${repo}/settings/environments/${id}/edit`
                        : `https://github.com/${repo}/settings/environments`;
                    return { name, provider, status, webUrl };
                }));

                respond({ environments });
                envListCache.set(repo, { at: Date.now(), payload: { environments } });
            } catch (e) {
                respond({ environments: [], error: e.message });
            }
            return;
        }

        if (pathname === "/api/list-applications" && req.method === "GET") {
            const repo = url.searchParams.get("repo") || "";
            const respond = (payload) => {
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.writeHead(200);
                res.end(JSON.stringify(payload));
            };
            if (!repo) { respond({ applications: [] }); return; }
            const gh = (args, timeout = 12000) => new Promise((resolve) => {
                cliExec("gh", args, { timeout }, (err, stdout) => resolve(err ? "" : (stdout || "").trim()));
            });
            try {
                // The application name is defined in the repo's app.bicep. Try to
                // read it; otherwise fall back to the repo's short name. A repo
                // hosts a single Radius application in this model.
                let appName = repo.split("/").pop() || repo;
                const entry = servers.get(instanceId);
                const branch = entry?.state?.contextBranch || entry?.state?.plannedBranch || entry?.state?.graphBranch || "main";
                for (const p of [".radius/app.bicep", "app.bicep"]) {
                    const raw = await gh(["api", `/repos/${repo}/contents/${p}?ref=${branch}`, "--jq", ".content"]);
                    if (!raw) continue;
                    let decoded = "";
                    try { decoded = Buffer.from(raw, "base64").toString("utf8"); } catch { decoded = ""; }
                    const m = decoded.match(/application\s+['"]([^'"]+)['"]/) || decoded.match(/name:\s*string\s*=\s*['"]([^'"]+)['"]/);
                    if (m) { appName = m[1]; break; }
                }
                respond({ applications: [{ name: appName }] });
            } catch (e) {
                respond({ applications: [{ name: repo.split("/").pop() || repo }], error: e.message });
            }
            return;
        }

        if (pathname === "/api/list-deployments" && req.method === "GET") {
            const repo = url.searchParams.get("repo") || "";
            const respond = (payload) => {
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.writeHead(200);
                res.end(JSON.stringify(payload));
            };
            if (!repo) { respond({ deployments: [] }); return; }
            const gh = (args, timeout = 12000) => new Promise((resolve) => {
                cliExec("gh", args, { timeout }, (err, stdout) => resolve(err ? "" : (stdout || "").trim()));
            });
            const appName = repo.split("/").pop() || repo;
            try {
                // A "deployment" is the application deployed into a GitHub
                // Environment. List every deployment record for the repo and
                // collapse to the latest per environment, mapping its GitHub
                // deployment-status state to our success/pending/failed model.
                const raw = await gh(["api", "--paginate", `/repos/${repo}/deployments?per_page=100`, "--jq", ".[] | (.id|tostring) + \"\\t\" + (.environment // \"\")"]);
                const rows = raw ? raw.split("\n").filter(Boolean).map((l) => {
                    const t = l.indexOf("\t");
                    return t === -1 ? { id: l, environment: "" } : { id: l.slice(0, t), environment: l.slice(t + 1) };
                }) : [];
                // Latest deployment id per environment (list is newest-first).
                const latestByEnv = new Map();
                for (const r of rows) {
                    if (!r.environment) continue;
                    if (!latestByEnv.has(r.environment)) latestByEnv.set(r.environment, r.id);
                }
                const deployments = await Promise.all(Array.from(latestByEnv.entries()).map(async ([environment, id]) => {
                    const [stateRaw, varsRaw] = await Promise.all([
                        gh(["api", `/repos/${repo}/deployments/${id}/statuses?per_page=1`, "--jq", "(.[0].state // \"\") + \"\\t\" + (.[0].log_url // .[0].target_url // \"\")"]),
                        gh(["api", `/repos/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`, "--jq", ".variables[].name"]),
                    ]);
                    const tab = stateRaw.indexOf("\t");
                    const state = tab === -1 ? stateRaw : stateRaw.slice(0, tab);
                    const logUrl = tab === -1 ? "" : stateRaw.slice(tab + 1);
                    // Link the status to the GitHub Actions run that produced it.
                    let runUrl = "";
                    const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
                    if (m) runUrl = `https://github.com/${repo}/actions/runs/${m[1]}`;
                    else if (/^https?:\/\//.test(logUrl || "")) runUrl = logUrl;

                    // Deleting an application dispatches delete-application.yml,
                    // which (via its environment-bound job) creates a fresh
                    // deployment record for this environment. So the latest record
                    // may belong to a delete run, not a deploy. Inspect the run: if
                    // the app's most recent run is a SUCCESSFUL delete, the app no
                    // longer exists in that environment, so drop it from the list.
                    let isDelete = false;
                    let deleteConclusion = "";
                    if (m) {
                        const runInfo = await gh(["api", `/repos/${repo}/actions/runs/${m[1]}`, "--jq", "(.path // \"\") + \"\\t\" + (.conclusion // \"\")"]);
                        const rt = runInfo.indexOf("\t");
                        const runPath = rt === -1 ? runInfo : runInfo.slice(0, rt);
                        deleteConclusion = rt === -1 ? "" : runInfo.slice(rt + 1);
                        isDelete = /(^|\/)delete-application\.yml$/.test(runPath);
                    }
                    if (isDelete && deleteConclusion === "success") return null;

                    let status = "pending";
                    if (isDelete) {
                        // A delete run that hasn't succeeded (in progress or failed):
                        // surface it as "deleting" so the row reflects the pending
                        // teardown rather than a misleading deploy status.
                        status = "deleting";
                    } else if (state === "success") status = "success";
                    else if (state === "failure" || state === "error") status = "failed";
                    let provider = "";
                    if (/AZURE_/.test(varsRaw)) provider = "azure";
                    else if (/AWS_/.test(varsRaw)) provider = "aws";
                    return { app: appName, environment, provider, status, deploymentId: id, runUrl };
                }));
                respond({ deployments: deployments.filter(Boolean) });
            } catch (e) {
                respond({ deployments: [], error: e.message });
            }
            return;
        }

        if (pathname === "/api/delete-deployment" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const respond = (code, payload) => {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(code);
                res.end(JSON.stringify(payload));
            };
            try {
                const data = JSON.parse(body || "{}");
                const repo = data.repo || "";
                const environment = data.environment || "";
                const application = data.application || "";
                if (!repo || !environment || !application) { respond(400, { error: "repo, environment, and application are required." }); return; }

                const gh = (args, timeout = 20000, extraEnv) => new Promise((resolve) => {
                    const opts = { timeout };
                    if (extraEnv) opts.env = extraEnv;
                    cliExec("gh", args, opts, (err, stdout, stderr) => {
                        resolve({ code: err ? err.code || 1 : 0, stdout: (stdout || "").trim(), stderr: stderr || "" });
                    });
                });
                // Dispatching a workflow requires the `workflow` scope, which an
                // injected GH_TOKEN often lacks. Retry with it stripped so gh falls
                // back to the keyring credential.
                const ghWorkflow = async (args) => {
                    const first = await gh(args);
                    if (first.code === 0) return first;
                    if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) return first;
                    const fallbackEnv = { ...process.env };
                    delete fallbackEnv.GH_TOKEN;
                    delete fallbackEnv.GITHUB_TOKEN;
                    const retry = await gh(args, 20000, fallbackEnv);
                    return retry.code === 0 ? retry : first;
                };

                // Deleting a deployment now runs `rad app delete` via the committed
                // delete-application.yml workflow. This tears down the Radius
                // application on the ephemeral control plane while leaving the
                // GitHub Environment (and its credentials) intact.
                const dispatchedAt = Date.now();
                const dispatch = await ghWorkflow([
                    'workflow', 'run', DELETE_APP_DISPATCHER_FILE,
                    '-f', 'environment=' + environment,
                    '-f', 'application=' + application,
                    '--repo', repo,
                ]);
                if (dispatch.code !== 0) {
                    const de = (dispatch.stderr || '').trim();
                    const hint = /workflow.{0,20}scope/i.test(de)
                        ? ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
                        : ' Ensure ' + DELETE_APP_DISPATCHER_FILE + ' exists on the default branch (recreate the environment to commit it) and that Actions are enabled for ' + repo + '.';
                    respond(400, { error: 'Failed to start the delete workflow (' + DELETE_APP_DISPATCHER_FILE + ') on ' + repo + '. ' + (de || 'The dispatch request failed.') + hint });
                    return;
                }

                // Best-effort: resolve the dispatched run's URL so the client can
                // link to it in GitHub.
                let runUrl = "";
                const runId = await findWorkflowRun(repo, DELETE_APP_DISPATCHER_FILE, dispatchedAt, null);
                if (runId) runUrl = 'https://github.com/' + repo + '/actions/runs/' + runId;
                respond(200, { success: true, runUrl });
            } catch (e) {
                respond(400, { error: e.message });
            }
            return;
        }

        if (pathname === "/api/verify-status" && req.method === "GET") {
            const repo = url.searchParams.get("repo") || "";
            const envName = url.searchParams.get("environment") || "";
            const respond = (payload) => {
                res.setHeader("Content-Type", "application/json");
                res.setHeader("Cache-Control", "no-store");
                res.writeHead(200);
                res.end(JSON.stringify(payload));
            };
            if (!repo) { respond({ state: "unknown", error: "No repository specified." }); return; }

            try {
                const entry = servers.get(instanceId);
                const dispatchedAt = entry?.state?.deployDispatchedAt || 0;
                let runId = entry?.state?.verifyRunId || null;
                if (!runId) {
                    runId = await findWorkflowRun(repo, 'radius-verify-credentials.yml', dispatchedAt, null);
                    if (runId && entry) entry.state.verifyRunId = runId;
                }
                if (!runId) { respond({ state: "pending", runId: null }); return; }

                const detail = await getRunDetail(repo, runId);
                const runUrl = 'https://github.com/' + repo + '/actions/runs/' + runId;
                if (!detail) { respond({ state: "pending", runId, runUrl }); return; }

                if (detail.status !== "completed") {
                    respond({ state: "in_progress", runId, runUrl });
                    return;
                }
                if (detail.conclusion === "success") {
                    respond({ state: "success", runId, runUrl });
                    return;
                }
                // Failed — surface the failing step + a few error lines.
                const failed = (detail.steps || []).filter(s => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped');
                let errMsg = 'Credential verification failed' + (detail.conclusion ? ' (' + detail.conclusion + ')' : '') + '.';
                if (failed.length) errMsg += ' Failed step: ' + failed.map(s => s.name).join(', ') + '.';
                const log = await fetchRunLog(repo, runId);
                const lines = extractErrorLines(log, 8);
                if (lines.length) errMsg += '\n' + lines.join('\n');
                respond({ state: "failed", runId, runUrl, error: errMsg });
            } catch (e) {
                respond({ state: "unknown", error: e.message });
            }
            return;
        }

        if (pathname === "/api/user-repos" && req.method === "GET") {
            try {
                // Fetch personal repos and org repos in parallel
                const [personalRepos, orgRepos] = await Promise.all([
                    new Promise((resolve) => {
                        cliExec("gh", ["repo", "list", "--limit", "30", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"], { timeout: 15000 }, (err, stdout) => {
                            if (err) { resolve([]); return; }
                            resolve(stdout.trim().split('\n').filter(Boolean));
                        });
                    }),
                    new Promise((resolve) => {
                        // Get orgs the user belongs to, then fetch repos from each
                        cliExec("gh", ["org", "list"], { timeout: 15000 }, (err, stdout) => {
                            if (err || !stdout.trim()) { resolve([]); return; }
                            const orgs = stdout.trim().split('\n').filter(Boolean);
                            const orgPromises = orgs.map(org => new Promise((res2) => {
                                cliExec("gh", ["repo", "list", org, "--limit", "20", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"], { timeout: 15000 }, (err2, stdout2) => {
                                    if (err2) { res2([]); return; }
                                    res2(stdout2.trim().split('\n').filter(Boolean));
                                });
                            }));
                            Promise.all(orgPromises).then(results => resolve(results.flat()));
                        });
                    }),
                ]);
                const allRepos = [...new Set([...personalRepos, ...orgRepos])];
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ repos: allRepos }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ repos: [] }));
            }
            return;
        }

        if (pathname === "/api/repo-branches" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo;
                if (!repo) { res.writeHead(200); res.end(JSON.stringify({ branches: [] })); return; }
                const result = await new Promise((resolve) => {
                    cliExec("gh", ["api", "--paginate", `/repos/${repo}/branches?per_page=100`, "--jq", ".[].name"], { timeout: 15000 }, (err, stdout) => {
                        if (err) { resolve([]); return; }
                        resolve(stdout.trim().split('\n').filter(Boolean));
                    });
                });
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ branches: result }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ branches: [] }));
            }
            return;
        }

        if (pathname === "/api/plan-graph" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo || '';
                const entry = servers.get(instanceId);
                const branch = data.branch || defaultBranchForState(entry?.state);
                const provider = data.provider || 'azure';

                function addProgress(msg) {
                    if (entry) {
                        if (!entry.state.progressMessages) entry.state.progressMessages = [];
                        entry.state.progressMessages.push(msg);
                    }
                }
                if (entry) entry.state.progressMessages = [];

                addProgress(`Checking ${repo} for app.bicep...`);
                const content = await fetchBicepForSelection(entry, repo, branch);
                if (!content) {
                    addProgress('.radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill.');
                    triggerAppBicepHandoff(entry, repo, branch, 'graph');
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    }));
                    return;
                }
                addProgress('Found app.bicep — parsing resources...');

                const resources = await buildGraphViaRad(content, ".radius/app.bicep", { log: addProgress });
                addProgress(`Parsed ${resources.length} resource(s) — resolving ${provider} recipes...`);

                // Fetch recipes from GitHub (radius-project/resource-types-contrib)
                let recipes = [];
                addProgress('Fetching recipes from GitHub...');
                recipes = await fetchRecipesFromGitHub(github, provider);
                addProgress(`Loaded ${Array.isArray(recipes) ? recipes.length : 0} recipe(s) from GitHub.`);

                // For each abstract resource, resolve its recipe and concrete output resources
                addProgress('Resolving recipe outputs for planned resources...');
                const plannedResources = await resolveRecipeOutputs(github, resources, recipes, provider);
                addProgress(`Planned ${plannedResources.length} resource(s) — rendering graph...`);

                if (entry) {
                    entry.state.plannedResources = plannedResources;
                    entry.state.plannedRepo = repo;
                    entry.state.plannedBranch = branch;
                    entry.state.plannedProvider = provider;
                    entry.state.resolvedRecipes = recipes;
                }
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ reload: true }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === "/api/discover-branches" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo || '';
                const result = await new Promise((resolve) => {
                    cliExec("gh", ["api", "--paginate", `/repos/${repo}/branches?per_page=100`], { timeout: 15000 }, (err, stdout, stderr) => {
                        if (err) { resolve({ error: stderr || err.message }); return; }
                        try {
                            const raw = JSON.parse(stdout.trim());
                            const branches = raw.map(b => ({ name: b.name, sha: b.commit?.sha || '' }));
                            resolve({ branches });
                        } catch (e) {
                            resolve({ error: 'Failed to parse branch data' });
                        }
                    });
                });
                const entry = servers.get(instanceId);
                if (entry?.state?.workspaceBranch && repoMatchesWorkspace(entry.state, repo)) {
                    const branches = result.branches || [];
                    if (!branches.some(b => b.name === entry.state.workspaceBranch)) {
                        branches.unshift({ name: entry.state.workspaceBranch, sha: "worktree" });
                    }
                    result.branches = branches;
                    result.workspaceBranch = entry.state.workspaceBranch;
                }
                if (entry && result.branches) {
                    entry.state.branches = result.branches.map(b => b.name);
                    entry.state.branchShas = {};
                    for (const b of result.branches) entry.state.branchShas[b.name] = b.sha;
                    entry.state.diffTargetRepo = repo;
                }
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === "/api/diff-branches" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo || '';
                const entry = servers.get(instanceId);
                if (entry) {
                    entry.state.diffBase = data.base;
                    entry.state.diffHead = data.head;
                    entry.state.diffTargetRepo = repo;
                }

                // Fetch the committed/persisted app.bicep on each branch. app.bicep
                // generation is owned by the Radius app-bicep skill, so branches
                // without one simply contribute nothing to the diff (added/removed).
                const [baseContent, headContent] = await Promise.all([
                    fetchBicepForSelection(entry, repo, data.base),
                    fetchBicepForSelection(entry, repo, data.head)
                ]);

                if (!baseContent && !headContent) {
                    triggerAppBicepHandoff(entry, repo, [data.base, data.head], 'graph-diff');
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
                        needsAppBicep: true,
                        repo,
                    }));
                    return;
                }

                const baseResources = await buildGraphViaRad(baseContent || '');
                const headResources = await buildGraphViaRad(headContent || '');

                // Compute diff using the shared algorithm (see computeGraphDiff).
                const diffResources = computeGraphDiff(baseResources, headResources);

                if (entry) {
                    entry.state.diffResources = diffResources;
                    entry.state.diffBaseGenerated = false;
                    entry.state.diffHeadGenerated = false;
                    entry.state.page = 'graphDiff';
                }

                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ message: `Comparing ${data.base} → ${data.head}`, reload: true }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === "/api/deploy" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const entry = servers.get(instanceId);
                // Store deploy params
                if (entry) {
                    entry.state.deployParams = data;
                    entry.state.envName = data.environment;
                    entry.state.deployProvider = data.provider;
                    entry.state.deployingRepo = data.targetRepo;
                    entry.state.deployingBranch = data.branch || 'main';
                    entry.state.appFile = data.appFile;

                    // Snapshot the planned graph (nodes start as pending). If the
                    // planned graph hasn't been resolved yet, it is built on the fly
                    // inside the monitor so the deploying page always shows it.
                    let resources = JSON.parse(JSON.stringify(entry.state.plannedResources || []));
                    resources.forEach(r => { r.deployStatus = 'pending'; if (r.outputResources) r.outputResources.forEach(o => { o.deployStatus = 'pending'; }); });
                    entry.state.deployingResources = resources;
                    entry.state.deployLogs = [];
                    entry.state.deployLogBase = 0;
                    entry.state.deployStatus = 'in_progress';
                    entry.state.deployError = null;
                    entry.state.deployRunUrl = null;
                    entry.state.deployRunId = null;

                    const repo = data.targetRepo || entry.state.plannedRepo || entry.state.contextRepo || '';
                    const branch = data.branch || entry.state.deployingBranch || 'main';
                    const provider = data.provider || 'azure';
                    // Bounded ring buffer: a verbose deploy can stream tens of
                    // thousands of recipe/terraform log lines. Keeping them all in
                    // memory (and re-serializing the whole array to every 1.5s
                    // status poll) grew unbounded and got the extension process
                    // OOM-killed mid-deploy. Cap the buffer and track how many
                    // lines were dropped so the client can still page through new
                    // lines by absolute offset.
                    const DEPLOY_LOG_CAP = 4000;
                    const addLog = (msg) => {
                        const dl = entry.state.deployLogs;
                        dl.push(msg);
                        if (dl.length > DEPLOY_LOG_CAP) {
                            const drop = dl.length - DEPLOY_LOG_CAP;
                            dl.splice(0, drop);
                            entry.state.deployLogBase = (entry.state.deployLogBase || 0) + drop;
                        }
                    };
                    const setStatus = (r, s) => {
                        r.deployStatus = s;
                        if (r.outputResources) r.outputResources.forEach(o => {
                            o.deployStatus = s;
                            if (s === 'success') {
                                const portalUrlKey = provider === 'azure' ? (o.id || o.type || o.displayType || '') : (o.type || o.displayType || o.id || '');
                                o.portalUrl = generatePortalUrl(portalUrlKey, provider, entry.state);
                            }
                        });
                    };

                    // Monitor BOTH workflows in sequence: first verify-credentials,
                    // then the deploy workflow. Do NOT dispatch — they were already
                    // triggered from the environment page.
                    (async () => {
                        const delay = ms => new Promise(r => setTimeout(r, ms));

                        if (!repo) {
                            addLog('❌ No target repository specified.');
                            entry.state.deployError = 'No target repository was specified for the deployment.';
                            entry.state.deployStatus = 'failed';
                            return;
                        }

                        // Build the planned graph if it wasn't resolved beforehand.
                        if (resources.length === 0) {
                            addLog('Resolving planned application graph for ' + repo + '...');
                            try {
                                const content = await fetchBicepForSelection(entry, repo, branch);
                                if (content) {
                                    const parsed = await buildGraphViaRad(content, ".radius/app.bicep", { log: addLog });
                                    const recipes = await fetchRecipesFromGitHub(github, provider);
                                    const planned = await resolveRecipeOutputs(github, parsed, recipes, provider);
                                    planned.forEach(r => { r.deployStatus = 'pending'; if (r.outputResources) r.outputResources.forEach(o => { o.deployStatus = 'pending'; }); });
                                    entry.state.plannedResources = planned;
                                    entry.state.plannedRepo = repo;
                                    resources = planned;
                                    entry.state.deployingResources = resources;
                                    addLog('Planned ' + planned.length + ' resource(s).');
                                } else {
                                    addLog('⚠ .radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill to show the planned graph.');
                                }
                            } catch (e) { addLog('⚠ Could not resolve planned graph: ' + e.message); }
                        }

                        // ── Phase 1: Dispatch the run-rad-commands workflow ─────
                        // Credentials are verified separately when the environment
                        // is created, so deploying is now an explicit action: we
                        // dispatch the unified run-rad-commands workflow here (the
                        // "Repo Radius" entry point that runs `rad deploy` by
                        // default) rather than relying on a verify → deploy chain.
                        addLog('━━ Deploying Radius application ━━');
                        const envForDeploy = entry.state.envName || data.environment || 'dev';
                        const deployWorkflowFile = 'run-rad-commands.yml';
                        const runGhDeploy = (args, envOverride) => new Promise((resolve) => {
                            cliExec('gh', args, { timeout: 30000, ...(envOverride ? { env: envOverride } : {}) }, (err, stdout, stderr) => {
                                resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
                            });
                        });
                        const dispatchArgs = ['workflow', 'run', deployWorkflowFile, '-f', 'environment=' + envForDeploy, '--repo', repo];

                        // Recompute the rad commands from the CURRENT app.bicep at
                        // dispatch time (rather than relying on the RADIUS_RAD_COMMANDS
                        // variable captured when the environment was created) so the
                        // deploy always reflects the latest bicep. Also append
                        // `rad app graph` so the deployed application graph is rendered
                        // as part of the run. Secret params are still appended by the
                        // workflow from the RADIUS_DEPLOY_PARAMS secret.
                        try {
                            let bicepPath = '.radius/app.bicep';
                            let bicepSource = await fetchFileForSelection(entry, repo, branch, '.radius/app.bicep');
                            if (!bicepSource) {
                                bicepSource = await fetchFileForSelection(entry, repo, branch, 'app.bicep');
                                if (bicepSource) bicepPath = 'app.bicep';
                            }
                            if (bicepSource) {
                                const parsed = appParams(bicepSource);
                                const resolved = resolveDeployParams(parsed);
                                const { public: publicParams } = partitionParams(parsed, resolved);
                                const deployCmd = buildDeployRadCommand(bicepPath, envForDeploy, publicParams);
                                const appMatch = bicepSource.match(/application\s+['"]([^'"]+)['"]/) || bicepSource.match(/name:\s*string\s*=\s*['"]([^'"]+)['"]/);
                                const appName = appMatch ? appMatch[1] : '';
                                const commands = [deployCmd];
                                if (appName) commands.push('app graph --application ' + appName);
                                const radCommandsInput = JSON.stringify(commands);
                                dispatchArgs.push('-f', 'rad_commands=' + radCommandsInput);
                                addLog('Deploying with rad commands: ' + commands.join('  |  '));
                            } else {
                                addLog('⚠ Could not read app.bicep at dispatch; falling back to the environment\'s RADIUS_RAD_COMMANDS / default deploy.');
                            }
                        } catch (e) {
                            addLog('⚠ Could not compute rad commands from bicep (' + e.message + '); falling back to the environment default.');
                        }
                        const deployDispatchedAt = Date.now();
                        addLog('🚀 Dispatching run rad commands workflow (' + deployWorkflowFile + ') for environment "' + envForDeploy + '"...');
                        let dispatchDeployRes = await runGhDeploy(dispatchArgs);
                        if (dispatchDeployRes.code !== 0 && (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) {
                            // The injected OAuth token may lack the `workflow` scope; retry
                            // with it stripped so gh falls back to the keyring credential.
                            const fallbackEnv = { ...process.env };
                            delete fallbackEnv.GH_TOKEN;
                            delete fallbackEnv.GITHUB_TOKEN;
                            const retry = await runGhDeploy(dispatchArgs, fallbackEnv);
                            if (retry.code === 0) dispatchDeployRes = retry;
                        }
                        if (dispatchDeployRes.code !== 0) {
                            const de = (dispatchDeployRes.stderr || '').trim();
                            addLog('❌ Failed to dispatch the run rad commands workflow: ' + de);
                            const scopeHint = /workflow.{0,20}scope/i.test(de)
                                ? ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
                                : ' Ensure ' + deployWorkflowFile + ' exists on the default branch and that GitHub Actions are enabled for ' + repo + '.';
                            entry.state.deployError = 'Failed to start the run rad commands workflow (' + deployWorkflowFile + ') on ' + repo + '. ' + (de || 'The dispatch request failed.') + scopeHint;
                            entry.state.deployStatus = 'failed';
                            return;
                        }
                        addLog('✅ Run rad commands workflow dispatched.');

                        // ── Phase 2: Monitor the deploy run ─────────────────────
                        addLog('Waiting for the deploy workflow to start...');
                        let dRunId = null;
                        for (let attempt = 0; attempt < 24 && !dRunId; attempt++) {
                            dRunId = await findWorkflowRun(repo, deployWorkflowFile, deployDispatchedAt, null);
                            if (!dRunId) await delay(5000);
                        }
                        if (!dRunId) {
                            addLog('⚠ No deploy run found for ' + deployWorkflowFile + '.');
                            entry.state.deployError = 'The run rad commands workflow (' + deployWorkflowFile + ') did not start. Check that the workflow exists on the default branch and that Actions are enabled for ' + repo + '.';
                            entry.state.deployStatus = 'failed';
                            return;
                        }
                        entry.state.deployRunId = dRunId;
                        entry.state.deployRunUrl = 'https://github.com/' + repo + '/actions/runs/' + dRunId;
                        addLog('Tracking deploy run: https://github.com/' + repo + '/actions/runs/' + dRunId);
                        if (resources.length > 0 && resources[0].deployStatus === 'pending') setStatus(resources[0], 'in_progress');

                        const seenD = new Set();
                        const startedD = new Set();
                        let deployStepStartedAt = 0;
                        let beatStep = '';
                        let beatStepStartedAt = 0;
                        let lastBeatAt = 0;
                        // Live `rad deploy` progress (published by the workflow to the
                        // radius-deploy-status branch). We track how many raw lines we've
                        // already surfaced so we only append new ones.
                        let liveLogShown = 0;
                        let deployStarted = false;
                        // Track which activity-log status changes we've already
                        // streamed so we only announce new transitions.
                        const activitySeen = new Set();
                        // Track how many control-plane / recipe log lines we've surfaced.
                        let cpLogShown = 0;
                        let cpLogTail = '';
                        const DEPLOY_STEP = 'Deploy Application';

                        // Poll the Azure activity log the workflow publishes and
                        // drive FINE-GRAINED per-resource (output) status, coloring
                        // each planned graph node individually as Azure creates it.
                        const pollActivity = async () => {
                            if (provider !== 'azure' || resources.length === 0) return;
                            const actText = await fetchLiveActivityLog(repo);
                            if (!actText) return;
                            const entries = reduceActivityLog(actText);
                            if (entries.length === 0) return;
                            const changes = applyActivityToResources(entries, resources, provider, entry.state);
                            for (const c of changes) {
                                if (!activitySeen.has(c)) {
                                    activitySeen.add(c);
                                    addLog('    ☁ ' + c);
                                }
                            }
                        };

                        // Stream the Radius control-plane / recipe log (terraform/bicep
                        // execution from the radius-system pods). Real-time and carries
                        // the precise recipe failure cause. We append only new lines.
                        const pollControlPlane = async () => {
                            const cpText = await fetchLiveControlPlaneLog(repo);
                            if (!cpText) return;
                            cpLogTail = cpText;
                            const lines = cpText.split(/\r?\n/);
                            for (let i = cpLogShown; i < lines.length; i++) {
                                const t = lines[i].replace(/\s+$/, '');
                                if (t) addLog('    ⚙ ' + t);
                            }
                            cpLogShown = lines.length;
                        };

                        // Advance per-resource status from any live log text so the
                        // graph shows gray→yellow→green/red per node. rad deploy in CI
                        // (non-TTY) prints no intermediate per-resource lines, so the
                        // control-plane/recipe log + activity log are the real signals.
                        const applyProgress = (text) => {
                            if (!text) return;
                            const prog = parseResourceProgress(text, resources);
                            for (const r of resources) {
                                const s = prog[r.name];
                                if (!s) continue;
                                const cur = r.deployStatus;
                                // Mid-deployment a node is NEVER painted red: a transient
                                // "error"/"failed"/"postponed" line in the live log does not
                                // mean the deployment failed. Such resources stay yellow
                                // (in_progress). Only the TERMINAL run conclusion (below)
                                // decides red vs green, so nodes go red solely on an actual
                                // failed deployment.
                                if (s === 'success' && cur !== 'success' && cur !== 'failed') {
                                    setStatus(r, 'success');
                                    addLog('  ✓ ' + r.name + ' deployed');
                                } else if ((s === 'in_progress' || s === 'failed') && (cur === 'pending' || !cur)) {
                                    setStatus(r, 'in_progress');
                                    addLog('  ◐ ' + r.name + ' provisioning…');
                                }
                            }
                        };

                        for (let p = 0; p < 240; p++) {
                            const detail = await getRunDetail(repo, dRunId);
                            if (!detail) { await delay(5000); continue; }

                            // Stream step lifecycle: announce when a step STARTS
                            // (in_progress) and again when it COMPLETES so the feed
                            // never goes silent during long-running steps.
                            for (const s of detail.steps) {
                                if (s.status === 'in_progress' && !startedD.has(s.name)) {
                                    startedD.add(s.name);
                                    addLog('  ▶ ' + s.name + '…');
                                }
                                if (s.status === 'completed' && !seenD.has(s.name)) {
                                    seenD.add(s.name);
                                    addLog('  ' + (s.conclusion === 'success' ? '✓' : (s.conclusion ? '✗' : '•')) + ' ' + s.name);
                                }
                            }

                            // Heartbeat: emit a "still running" line every ~30s for the
                            // currently-executing step so the user sees continuous activity
                            // even when GitHub provides no intra-step log lines (gh cannot
                            // stream a running job's stdout).
                            const running = detail.steps.find(s => s.status === 'in_progress');
                            if (running) {
                                if (beatStep !== running.name) {
                                    beatStep = running.name;
                                    beatStepStartedAt = Date.now();
                                    lastBeatAt = Date.now();
                                } else if (Date.now() - lastBeatAt > 30000) {
                                    lastBeatAt = Date.now();
                                    addLog('    … ' + running.name + ' still running (' + Math.round((Date.now() - beatStepStartedAt) / 1000) + 's)');
                                }
                            }

                            // While `rad deploy` runs, consume the live progress log
                            // the workflow publishes and drive REAL per-resource state.
                            const deployStep = detail.steps.find(s => s.name === DEPLOY_STEP);
                            if (deployStep && deployStep.status === 'in_progress' && resources.length > 0) {
                                if (!deployStarted) {
                                    deployStarted = true;
                                    deployStepStartedAt = Date.now();
                                    entry.state.deployStartedAt = deployStepStartedAt;
                                    addLog('🚀 rad deploy running — provisioning resources...');
                                    addLog('  ⏱ Deployment started at ' + new Date(deployStepStartedAt).toISOString());
                                    // Leave nodes gray; each flips to yellow when its own
                                    // recipe/operation actually starts (see applyProgress).
                                }
                                const live = await fetchLiveDeployLog(repo);
                                if (live) {
                                    // Append any new raw rad-deploy output lines to the feed.
                                    const lines = live.split(/\r?\n/);
                                    for (let i = liveLogShown; i < lines.length; i++) {
                                        const t = lines[i].replace(/\s+$/, '');
                                        if (t) addLog('    │ ' + t);
                                    }
                                    liveLogShown = lines.length;
                                    // Flip resources to their real status as the log reports them.
                                    applyProgress(live);
                                }
                                // Fine-grained Azure activity-log status per resource.
                                await pollActivity();
                                // Real-time control-plane / recipe (terraform) output.
                                await pollControlPlane();
                                // Drive per-node coloring from the control-plane/recipe log.
                                applyProgress(cpLogTail);
                                // Fallback: if nothing has advanced past pending ~25s into
                                // the deploy (no parseable per-resource signal), mark all
                                // pending nodes in_progress so the graph isn't stuck gray.
                                if (Date.now() - deployStepStartedAt > 25000 &&
                                    !resources.some(r => r.deployStatus && r.deployStatus !== 'pending')) {
                                    resources.forEach(r => { if (!r.deployStatus || r.deployStatus === 'pending') setStatus(r, 'in_progress'); });
                                }
                            }

                            if (detail.status === 'completed') {
                                const conclusion = detail.conclusion;
                                // Final fine-grained activity sweep before settling.
                                await pollActivity();
                                await pollControlPlane();

                                // ── Finalize logs without cutting off ───────────
                                // The workflow writes the terminal deploy-state marker
                                // (succeeded/failed) LAST — only after the complete log
                                // and the deployed graph have been pushed to the status
                                // branch. Keep fetching the live log until the state is
                                // terminal AND its length stops growing, so we never drop
                                // the final rad-deploy output (e.g. the summary table).
                                let parsed;
                                let live = null;
                                let prevLen = -1;
                                let stableHits = 0;
                                for (let f = 0; f < 12; f++) {
                                    const ds = await fetchDeployState(repo);
                                    const cur = await fetchLiveDeployLog(repo);
                                    if (cur) live = cur;
                                    const len = cur ? cur.length : 0;
                                    const terminal = (ds === 'succeeded' || ds === 'failed');
                                    if (len === prevLen) stableHits++; else stableHits = 0;
                                    prevLen = len;
                                    // Stream any control-plane lines that arrive late too.
                                    await pollControlPlane();
                                    if (terminal && (stableHits >= 1 || len === 0)) break;
                                    if (!terminal || stableHits < 1) await delay(2500);
                                }
                                if (live) {
                                    const lines = live.split(/\r?\n/);
                                    for (let i = liveLogShown; i < lines.length; i++) {
                                        const t = lines[i].replace(/\s+$/, '');
                                        if (t) addLog('    │ ' + t);
                                    }
                                    liveLogShown = lines.length;
                                    parsed = parseRadDeployLog(live, resources, { stripPrefix: false });
                                } else {
                                    const logText = await fetchRunLog(repo, dRunId);
                                    parsed = parseRadDeployLog(logText, resources);
                                }

                                // Record stop time + duration.
                                const finishedAt = Date.now();
                                entry.state.deployFinishedAt = finishedAt;
                                if (deployStepStartedAt) {
                                    const secs = Math.round((finishedAt - deployStepStartedAt) / 1000);
                                    addLog('  ⏱ Deployment finished at ' + new Date(finishedAt).toISOString() + ' (' + secs + 's)');
                                }

                                if (conclusion === 'success') {
                                    // Overall success ⇒ every resource provisioned. Force all
                                    // nodes green; a transient "failed" token in the live log
                                    // must never leave a node red on a successful deployment.
                                    resources.forEach(r => setStatus(r, 'success'));
                                    // Fetch + store the REAL deployed application graph the
                                    // workflow published to the orphan status branch.
                                    addLog('🗺  Retrieving deployed application graph…');
                                    let deployed = null;
                                    for (let g = 0; g < 6 && !deployed; g++) {
                                        deployed = await fetchDeployGraph(repo);
                                        if (!deployed) await delay(2500);
                                    }
                                    if (deployed) {
                                        entry.state.deployedGraph = deployed;
                                        entry.state.deployedGraphRepo = repo;
                                        addLog('  ✓ Deployed graph saved.');
                                    } else {
                                        addLog('  ⚠ Deployed graph not available yet (continuing).');
                                    }
                                    entry.state.deployStatus = 'complete';
                                    addLog('');
                                    addLog('🎉 Deployment complete! Application deployed to ' + (provider === 'aws' ? 'AWS' : 'Azure') + '.');
                                    addLog('Click on deployed resources to view them in the ' + (provider === 'aws' ? 'AWS Console' : 'Azure Portal') + '.');
                                } else {
                                    resources.forEach(r => {
                                        if (parsed[r.name] === 'success') setStatus(r, 'success');
                                        else if (parsed[r.name] === 'failed' || r.deployStatus === 'pending' || r.deployStatus === 'in_progress') setStatus(r, 'failed');
                                    });
                                    entry.state.deployStatus = 'failed';
                                    addLog('');
                                    addLog('❌ Deployment failed. Conclusion: ' + conclusion);
                                    // Build a user-facing error from the failed step(s) + log.
                                    const failedSteps = detail.steps.filter(s => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped');
                                    let dErr = 'Deployment failed' + (conclusion ? ' (' + conclusion + ')' : '') + '.';
                                    if (failedSteps.length) dErr += ' Failed step: ' + failedSteps.map(s => s.name).join(', ') + '.';
                                    // Surface the FULL detailed rad deploy failure block (root cause:
                                    // recipe/terraform/ARM operation errors). Prefer the live raw rad
                                    // output; fall back to the full run log.
                                    let failLog = live;
                                    if (!failLog) failLog = await fetchRunLog(repo, dRunId);
                                    const detailBlock = extractRadDeployError(failLog);
                                    if (detailBlock) {
                                        dErr += '\n\n' + detailBlock;
                                        addLog('');
                                        addLog('──────── failure details ────────');
                                        detailBlock.split('\n').forEach(l => addLog('  ' + l));
                                        addLog('─────────────────────────────────');
                                    }
                                    // The exact recipe (terraform/bicep) error is emitted by the
                                    // Radius control plane. Surface its tail if we captured it.
                                    if (cpLogTail) {
                                        const cpLines = cpLogTail.split(/\r?\n/).filter(l => l.trim());
                                        const cpErr = cpLines.filter(l => /error|failed|terraform|tofu|recipe/i.test(l)).slice(-25);
                                        const cpShow = (cpErr.length ? cpErr : cpLines.slice(-25));
                                        if (cpShow.length) {
                                            dErr += '\n\n──── control-plane / recipe log ────\n' + cpShow.join('\n');
                                            addLog('');
                                            addLog('──────── control-plane / recipe log ────────');
                                            cpShow.forEach(l => addLog('  ' + l));
                                            addLog('─────────────────────────────────────────');
                                        }
                                    }
                                    dErr += '\n\nView the full run: https://github.com/' + repo + '/actions/runs/' + dRunId;
                                    entry.state.deployError = dErr;
                                }
                                return;
                            }
                            await delay(5000);
                        }
                        addLog('⚠ Timed out waiting for the deploy workflow to complete.');
                        entry.state.deployError = 'Timed out waiting for the deploy workflow to complete. It may still be running — view it at https://github.com/' + repo + '/actions/runs/' + dRunId;
                        entry.state.deployStatus = 'failed';
                    })().catch((monErr) => {
                        // Never let the background monitor die silently (which would
                        // leave the page stuck polling an 'in_progress' that never
                        // resolves). Surface the error and settle the status.
                        try {
                            addLog('❌ Deploy monitor stopped unexpectedly: ' + (monErr && monErr.message ? monErr.message : monErr));
                            if (!entry.state.deployError) entry.state.deployError = 'Deploy monitoring stopped unexpectedly: ' + (monErr && monErr.message ? monErr.message : monErr);
                            entry.state.deployStatus = 'failed';
                        } catch { /* ignore */ }
                    });
                }
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (pathname === "/api/deploy-reset" && req.method === "POST") {
            const entry = servers.get(instanceId);
            if (entry) { delete entry.state.deployResult; }
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (pathname === "/api/discover" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const result = { clusters: [], resourceGroups: [], namespaces: [], vpcs: [], subnets: [] };

                if (data.provider === "azure") {
                    // Set tenant/subscription context before querying
                    if (data.subscriptionId) {
                        try { await runCommand("az", ["account", "set", "--subscription", data.subscriptionId], { timeout: 10000 }); } catch (e) {}
                    }
                    const subArgs = data.subscriptionId ? ["--subscription", data.subscriptionId] : [];
                    try {
                        const aksJson = await runCommand("az", ["aks", "list", "--query", "[].{id:name, name:name, resourceGroup:resourceGroup}", "-o", "json", ...subArgs], { timeout: 30000 });
                        result.clusters = JSON.parse(aksJson);
                    } catch (e) { result.clusters = []; }
                    try {
                        const rgJson = await runCommand("az", ["group", "list", "--query", "[].{id:name, name:name}", "-o", "json", ...subArgs], { timeout: 30000 });
                        result.resourceGroups = JSON.parse(rgJson);
                    } catch (e) { result.resourceGroups = []; }
                    // If we got a cluster, try to get namespaces from it
                    if (result.clusters.length > 0) {
                        try {
                            const rg = result.resourceGroups.length > 0 ? result.resourceGroups[0].id : '';
                            const clusterName = result.clusters[0].id;
                            if (rg && clusterName) {
                                await runCommand("az", ["aks", "get-credentials", "--name", clusterName, "--resource-group", rg, "--overwrite-existing"], { timeout: 20000 });
                                const nsJson = await runCommand("kubectl", ["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"], { timeout: 10000 });
                                result.namespaces = nsJson.replace(/"/g, '').split(' ').filter(Boolean);
                            } else {
                                result.namespaces = ['default', 'kube-system', 'radius-system'];
                            }
                        } catch (e) {
                            result.namespaces = ['default', 'kube-system', 'radius-system'];
                        }
                    } else {
                        result.namespaces = ['default', 'kube-system', 'radius-system'];
                    }
                } else {
                    try {
                        const eksJson = await runCommand("aws", ["eks", "list-clusters", "--query", "clusters", "--output", "json"], { timeout: 15000 });
                        const clusterNames = JSON.parse(eksJson);
                        result.clusters = clusterNames.map(n => ({ id: n, name: n }));
                    } catch (e) { result.clusters = []; }
                    try {
                        const vpcJson = await runCommand("aws", ["ec2", "describe-vpcs", "--query", "Vpcs[].{id:VpcId, name:VpcId}", "--output", "json"], { timeout: 15000 });
                        result.vpcs = JSON.parse(vpcJson);
                    } catch (e) { result.vpcs = []; }
                    try {
                        const subnetJson = await runCommand("aws", ["ec2", "describe-subnets", "--query", "Subnets[].{id:SubnetId, name:SubnetId}", "--output", "json"], { timeout: 15000 });
                        result.subnets = JSON.parse(subnetJson);
                    } catch (e) { result.subnets = []; }
                    result.namespaces = ['default', 'kube-system', 'radius-system'];
                }

                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (e) {
                res.setHeader("Content-Type", "application/json");
                res.writeHead(200);
                res.end(JSON.stringify({ error: e.message, clusters: [], resourceGroups: [], namespaces: ['default'], vpcs: [], subnets: [] }));
            }
            return;
        }

        // Default: serve the page HTML based on state
        await ensureVendorScripts();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        const entry = servers.get(instanceId);
        let page = url.searchParams.get("page") || entry?.page || "environment";
        const state = entry?.state || {};
        // If a deployment is actively in progress, redirect the environment /
        // credentials pages to the live deploying page so the user always lands
        // on the in-flight deployment instead of re-triggering one.
        if ((page === "environment" || page === "credentials") && state.deployStatus === "in_progress") {
            page = "deploying";
        }
        const renderer = PAGE_RENDERERS[page];
        if (renderer) {
            res.writeHead(200);
            res.end(renderer(state));
        } else {
            res.writeHead(200);
            res.end(environmentPage(state));
        }
    };
}

const PAGE_RENDERERS = {
    "credentials": environmentPage,
    "graph": graphPage,
    "planned": plannedGraphPage,
    "graph-diff": graphDiffPage,
    "deployed": deployedGraphPage,
    "environment": environmentPage,
    "deploying": deployingPage,
};

function preferredPortForInstance(instanceId) {
    const hash = createHash("sha256").update(String(instanceId)).digest();
    // Map into a high, mostly-unprivileged range (20000–60000) to reduce the
    // chance of clashing with other listeners.
    return 20000 + (hash.readUInt32BE(0) % 40000);
}

function listenOn(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.removeListener("listening", onListening);
            reject(err);
        };
        const onListening = () => {
            server.removeListener("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
    });
}

async function startServer(instanceId, page = "environment") {
    const handler = createRequestHandler(instanceId);
    const server = createServer(handler);
    let port = 0;
    // Try the stable, instanceId-derived port first; fall back to an ephemeral
    // port (listen(0)) only if it's already taken/unavailable.
    const preferred = preferredPortForInstance(instanceId);
    try {
        await listenOn(server, preferred);
        port = preferred;
    } catch {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        port = typeof address === "object" && address ? address.port : 0;
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const entry = { server, baseUrl, url: `${baseUrl}/?page=${page}`, page, state: {} };
    servers.set(instanceId, entry);
    return entry;
}

export async function getOrCreateServer(instanceId, page) {
    let entry = servers.get(instanceId);
    if (entry) {
        if (page && entry.page !== page) {
            entry.page = page;
            entry.url = `${entry.baseUrl}/?page=${page}`;
        }
        return entry;
    }
    return await startServer(instanceId, page);
}
