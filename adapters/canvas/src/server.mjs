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
  discoverSourceCodeRefs,
  fetchBicepFromRepo,
  fetchRecipesFromGitHub,
  resolveRecipeOutputs,
} from "@radius-project/core";
import { buildGraphViaRad, RADIUS_BICEP_CONFIG_JSON } from "@radius-project/shared";
import { ensureVendorScripts } from "./vendor.mjs";
import { escapeHtml, sharedCredentials, saveCredentials } from "./shared.mjs";
import { fetchFileFromRepo, fetchRepoTree, github, cliExec, runCommand } from "./gh.mjs";
import { appParams, resolveDeployParams, partitionParams, buildDeployRadCommand } from "./bicep.mjs";
import {
  createWorkspaceGitHub,
  defaultBranchForState,
  fetchWorkspaceBicep,
  fetchWorkspaceFile,
  fetchWorkspaceTree,
  isWorkspaceSelection,
} from "./workspace.mjs";
import {
  generateAzureOIDC, validateAzureCredentials, generateAWSOIDC,
  generateVerifyWorkflow, generateDeployWorkflow, generatePortalUrl,
  DEPLOY_DISPATCHER_FILE,
} from "./infra.mjs";
import {
  findWorkflowRun, getRunDetail, fetchRunLog, fetchLiveDeployLog,
  fetchLiveActivityLog, fetchLiveControlPlaneLog, fetchDeployState, fetchDeployGraph,
  normalizeDeployedGraph, rewireDeployedGraphChain, reduceActivityLog,
  applyActivityToResources, extractErrorLines, extractRadDeployError,
  parseResourceProgress, parseRadDeployLog,
} from "./deploy.mjs";
import {
  appGeneratePage, graphPage, plannedGraphPage, graphDiffPage,
  deployedGraphPage, environmentPage, deployingPage,
} from "./pages.mjs";

// Per-instance canvas servers: instanceId -> { server, url, page, state }.
// Shared with the SDK entry (extension.ts) for open/close + shutdown.
export const servers = new Map();

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

async function fetchTreeForSelection(entry, repo, branch) {
    const access = accessForSelection(entry, repo, branch);
    if (access.useWorkspace) {
        const localTree = await fetchWorkspaceTree(entry.state, repo, access.branch);
        if (localTree !== null) return localTree;
    }
    return await fetchRepoTree(repo, access.branch);
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

                function runGh(args, stdin) {
                    return new Promise((resolve) => {
                        const child = cliExec("gh", args, { timeout: 30000 }, (err, stdout, stderr) => {
                            resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
                        });
                        if (stdin !== undefined) child.stdin?.end(stdin);
                    });
                }

                const steps = [];

                // Step 1: Create the GitHub environment
                steps.push('Creating GitHub environment "' + envName + '"...');
                await runGh(['api', '--method', 'PUT', '/repos/' + targetRepo + '/environments/' + envName]);

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

                    if (clientId) await runGh(['variable', 'set', 'AZURE_CLIENT_ID', '--body', clientId, '--env', envName, '--repo', targetRepo]);
                    if (tenantId) await runGh(['variable', 'set', 'AZURE_TENANT_ID', '--body', tenantId, '--env', envName, '--repo', targetRepo]);
                    if (subscriptionId) await runGh(['variable', 'set', 'AZURE_SUBSCRIPTION_ID', '--body', subscriptionId, '--env', envName, '--repo', targetRepo]);
                    if (rg) await runGh(['variable', 'set', 'AZURE_RESOURCE_GROUP', '--body', rg, '--env', envName, '--repo', targetRepo]);
                    if (k8s) await runGh(['variable', 'set', 'AZURE_AKS_CLUSTER_NAME', '--body', k8s, '--env', envName, '--repo', targetRepo]);
                    if (data.location) await runGh(['variable', 'set', 'AZURE_LOCATION', '--body', data.location, '--env', envName, '--repo', targetRepo]);

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

                    if (roleArn) await runGh(['variable', 'set', 'AWS_ROLE_ARN', '--body', roleArn, '--env', envName, '--repo', targetRepo]);
                    if (region) await runGh(['variable', 'set', 'AWS_REGION', '--body', region, '--env', envName, '--repo', targetRepo]);
                    if (accountId) await runGh(['variable', 'set', 'AWS_ACCOUNT_ID', '--body', accountId, '--env', envName, '--repo', targetRepo]);
                    if (k8s) await runGh(['variable', 'set', 'AWS_EKS_CLUSTER_NAME', '--body', k8s, '--env', envName, '--repo', targetRepo]);
                    if (data.vpcId) await runGh(['variable', 'set', 'RADIUS_VPC_ID', '--body', data.vpcId, '--env', envName, '--repo', targetRepo]);
                    if (data.subnetIds) await runGh(['variable', 'set', 'RADIUS_SUBNET_IDS', '--body', data.subnetIds, '--env', envName, '--repo', targetRepo]);
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
                        await runGh(['secret', 'set', 'RADIUS_DEPLOY_PARAMS', '--env', envName, '--repo', targetRepo], Object.keys(secretParams).length ? JSON.stringify(secretParams) : '{}');

                        // Build the rad deploy command with non-secret params inline and
                        // store it as an environment variable. The deploy workflow reads
                        // it via `inputs.rad_commands || vars.RADIUS_RAD_COMMANDS`, so it
                        // applies on both explicit dispatch and the verify→deploy auto
                        // trigger (where inputs are empty). Secret params are appended by
                        // the workflow from RADIUS_DEPLOY_PARAMS.
                        const radCommand = buildDeployRadCommand(bicepPath, envName, publicParams);
                        await runGh(['variable', 'set', 'RADIUS_RAD_COMMANDS', '--env', envName, '--repo', targetRepo, '--body', radCommand]);

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

                const commitResult = await runGh(['api', '--method', 'PUT', '/repos/' + targetRepo + '/contents/' + verifyPath, '--input', tmpFile]);
                try { unlinkSync(tmpFile); } catch {}

                if (commitResult.code !== 0) {
                    steps.push('❌ Failed to commit verify-credentials workflow.');
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: 'Failed to commit the verify-credentials workflow (' + verifyPath + ') to ' + targetRepo + '. ' + ((commitResult.stderr || '').trim() || 'The GitHub API request failed.') + ' Check that you have write access to the repository and that GitHub Actions is enabled.',
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

                    const deployCommitResult = await runGh(['api', '--method', 'PUT', '/repos/' + targetRepo + '/contents/' + deployPath, '--input', tmpFile2]);
                    try { unlinkSync(tmpFile2); } catch {}

                    if (deployCommitResult.code !== 0) {
                        steps.push('❌ Failed to commit deploy workflow ' + fileName + '.');
                        res.setHeader("Content-Type", "application/json");
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            error: 'Failed to commit the deploy workflow (' + deployPath + ') to ' + targetRepo + '. ' + ((deployCommitResult.stderr || '').trim() || 'The GitHub API request failed.') + ' Check that you have write access to the repository and that GitHub Actions is enabled.',
                            steps
                        }));
                        return;
                    }
                }
                // Best-effort: remove the legacy monolithic deploy workflow so it
                // does not double-trigger alongside the new dispatcher.
                await deleteLegacyDeployWorkflow(targetRepo);
                steps.push('✅ Deploy workflows committed.');

                // Step 5: Dispatch the verify workflow
                steps.push('Dispatching verify-credentials workflow...');
                // Wait briefly for GitHub to index the workflow
                await new Promise(r => setTimeout(r, 3000));
                const dispatchedAt = Date.now();
                const dispatchResult = await runGh(['workflow', 'run', 'radius-verify-credentials.yml', '-f', 'environment=' + envName, '--repo', targetRepo]);

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
                    steps.push('Deploy workflow will auto-trigger after verify-credentials succeeds.');
                } else {
                    steps.push('⚠️ Could not dispatch verify workflow (may need to retry): ' + dispatchResult.stderr);
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
                let content = await fetchBicepForSelection(entry, repo, branch);
                if (!content) {
                    content = await fetchFileForSelection(entry, repo, branch, '.radius/app.bicep');
                }

                if (content) {
                    sendProgress('Found existing app.bicep — parsing resources...');
                } else {
                    sendDone({
                        error: `No app.bicep found for ${repo} on branch ${branch}. app.bicep is generated by the Radius app-bicep skill — ask Copilot to generate it, then re-open the graph.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    });
                    return;
                }

                const resources = await buildGraphViaRad(content, ".radius/app.bicep", { log: sendProgress });
                // Discover source code references for resources missing codeReference
                const needsSourceDiscovery = resources.some(r => !r.codeReference && !r.type.includes('applications'));
                if (needsSourceDiscovery) {
                    sendProgress('Scanning repository for source code references...');
                    let repoTree = null;
                    try { repoTree = await fetchTreeForSelection(entry, repo, branch); } catch {}
                    if (repoTree && repoTree.length > 0) {
                        await discoverSourceCodeRefs(accessForSelection(entry, repo, branch).github, resources, repoTree, repo, branch);
                    }
                }
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
                res.end(JSON.stringify({ resources, logsNew, logBase, logTotal, status, error, startedAt, finishedAt, deployedGraph }));
            } else {
                res.end(JSON.stringify({ resources, logs, logBase, logTotal, status, error, startedAt, finishedAt, deployedGraph }));
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
                let content = await fetchBicepForSelection(entry, repo, branch);
                if (!content) {
                    content = await fetchFileForSelection(entry, repo, branch, '.radius/app.bicep');
                }
                if (content) {
                    addProgress('Found existing app.bicep — parsing resources...');
                } else {
                    addProgress('No app.bicep found — generation is owned by the Radius app-bicep skill.');
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `No app.bicep found for ${repo} on branch ${branch}. app.bicep is generated by the Radius app-bicep skill — ask Copilot to generate it, then re-open the graph.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    }));
                    return;
                }

                const resources = await buildGraphViaRad(content, ".radius/app.bicep", { log: addProgress });
                // Discover source code references
                const needsSourceDiscovery2 = resources.some(r => !r.codeReference && !r.type.includes('applications'));
                if (needsSourceDiscovery2) {
                    addProgress('Scanning repository for source code references...');
                    let repoTree2 = null;
                    try { repoTree2 = await fetchTreeForSelection(entry, repo, branch); } catch {}
                    if (repoTree2 && repoTree2.length > 0) {
                        await discoverSourceCodeRefs(accessForSelection(entry, repo, branch).github, resources, repoTree2, repo, branch);
                    }
                }
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
                let content = await fetchBicepForSelection(entry, repo, branch);
                if (!content) {
                    content = await fetchFileForSelection(entry, repo, branch, '.radius/app.bicep');
                }
                if (!content) {
                    addProgress('No app.bicep found — generation is owned by the Radius app-bicep skill.');
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `No app.bicep found for ${repo} on branch ${branch}. app.bicep is generated by the Radius app-bicep skill — ask Copilot to generate it, then re-open the graph.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    }));
                    return;
                }
                addProgress('Found app.bicep — parsing resources...');

                const resources = await buildGraphViaRad(content, ".radius/app.bicep", { log: addProgress });
                // Discover source code references for planned graph
                const needsSrcDisc = resources.some(r => !r.codeReference && !r.type.includes('applications'));
                if (needsSrcDisc) {
                    addProgress('Scanning repository for source code references...');
                    let srcTree = null;
                    try { srcTree = await fetchTreeForSelection(entry, repo, branch); } catch {}
                    if (srcTree && srcTree.length > 0) {
                        await discoverSourceCodeRefs(accessForSelection(entry, repo, branch).github, resources, srcTree, repo, branch);
                    }
                }
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

        if (pathname === "/api/generate-bicep" && req.method === "POST") {
            let body = "";
            for await (const chunk of req) body += chunk;
            try {
                const data = JSON.parse(body);
                const repo = data.repo || '';
                const entry = servers.get(instanceId);
                const branch = data.branch || defaultBranchForState(entry?.state);
                // app.bicep generation is owned by the Radius app-bicep skill, not
                // this server. This endpoint only surfaces a committed/persisted
                // app.bicep for preview; if none exists, direct the user to have
                // Copilot run the skill.
                let content = await fetchBicepForSelection(entry, repo, branch);
                if (!content) {
                    content = await fetchFileForSelection(entry, repo, branch, '.radius/app.bicep');
                }
                if (!content) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `No app.bicep found for ${repo} on branch ${branch}. app.bicep is generated by the Radius app-bicep skill — ask Copilot to generate it.`,
                        needsAppBicep: true,
                        repo,
                        branch,
                    }));
                    return;
                }
                if (entry) {
                    entry.state.generatedContent = content;
                    entry.state.generateTargetRepo = repo;
                    entry.state.generateBranch = branch;
                }

                // Preview mode: return the fetched app.bicep content for review
                // without triggering a page reload.
                if (data.preview) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({ repo, branch, content, committed: true }));
                    return;
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
                let [baseContent, headContent] = await Promise.all([
                    fetchBicepForSelection(entry, repo, data.base),
                    fetchBicepForSelection(entry, repo, data.head)
                ]);
                if (!baseContent) {
                    baseContent = await fetchFileForSelection(entry, repo, data.base, '.radius/app.bicep');
                }
                if (!headContent) {
                    headContent = await fetchFileForSelection(entry, repo, data.head, '.radius/app.bicep');
                }

                if (!baseContent && !headContent) {
                    res.setHeader("Content-Type", "application/json");
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        error: `No app.bicep found on either ${data.base} or ${data.head}. app.bicep is generated by the Radius app-bicep skill — ask Copilot to generate it, then re-open the diff.`,
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

                    const repo = data.targetRepo || entry.state.plannedRepo || entry.state.contextRepo || '';
                    const branch = data.branch || entry.state.deployingBranch || 'main';
                    const provider = data.provider || 'azure';
                    const verifyRunId = entry.state.verifyRunId || null;
                    const dispatchedAt = entry.state.deployDispatchedAt || Date.now();
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
                                let content = await fetchBicepForSelection(entry, repo, branch);
                                if (!content) content = await fetchFileForSelection(entry, repo, branch, '.radius/app.bicep');
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
                                    addLog('⚠ No app.bicep found — generate it with the Radius app-bicep skill to see the planned graph.');
                                }
                            } catch (e) { addLog('⚠ Could not resolve planned graph: ' + e.message); }
                        }

                        // ── Phase 1: Verify credentials ─────────────────────────
                        addLog('━━ Verifying credentials ━━');
                        addLog('📡 Monitoring credential verification for ' + repo + '...');
                        let vRunId = verifyRunId;
                        for (let attempt = 0; attempt < 10 && !vRunId; attempt++) {
                            vRunId = await findWorkflowRun(repo, 'radius-verify-credentials.yml', dispatchedAt, null);
                            if (!vRunId) await delay(3000);
                        }
                        if (!vRunId) {
                            addLog('⚠ No verify-credentials run found. Proceeding to deploy monitoring...');
                        } else {
                            addLog('Tracking verify run: https://github.com/' + repo + '/actions/runs/' + vRunId);
                            const seenV = new Set();
                            const startedV = new Set();
                            let verifyOk = false;
                            for (let p = 0; p < 60; p++) {
                                const detail = await getRunDetail(repo, vRunId);
                                if (detail) {
                                    for (const s of detail.steps) {
                                        if (s.status === 'in_progress' && !startedV.has(s.name)) {
                                            startedV.add(s.name);
                                            addLog('  ▶ ' + s.name + '…');
                                        }
                                        if (s.status === 'completed' && !seenV.has(s.name)) {
                                            seenV.add(s.name);
                                            addLog('  ' + (s.conclusion === 'success' ? '✓' : '✗') + ' ' + s.name);
                                        }
                                    }
                                    if (detail.status === 'completed') {
                                        verifyOk = detail.conclusion === 'success';
                                        addLog(verifyOk ? '✅ Credentials verified.' : '❌ Credential verification failed: ' + detail.conclusion);
                                        break;
                                    }
                                }
                                await delay(5000);
                            }
                            if (!verifyOk) {
                                addLog('Deployment aborted — credential verification did not succeed.');
                                // Surface the actual failure detail from the verify run log.
                                const vDetail = await getRunDetail(repo, vRunId);
                                const failedV = (vDetail?.steps || []).filter(s => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped');
                                let vErr = 'Credential verification failed' + (vDetail?.conclusion ? ' (' + vDetail.conclusion + ')' : '') + '.';
                                if (failedV.length) vErr += ' Failed step: ' + failedV.map(s => s.name).join(', ') + '.';
                                const vLog = await fetchRunLog(repo, vRunId);
                                const vLines = extractErrorLines(vLog, 10);
                                if (vLines.length) vErr += '\n' + vLines.join('\n');
                                vErr += '\nView the full run: https://github.com/' + repo + '/actions/runs/' + vRunId;
                                vLines.forEach(l => addLog('  ! ' + l));
                                entry.state.deployError = vErr;
                                entry.state.deployStatus = 'failed';
                                return;
                            }
                        }

                        // ── Phase 2: Deploy Radius application ──────────────────
                        addLog('');
                        addLog('━━ Deploying Radius application ━━');
                        addLog('Waiting for the deploy workflow to start...');
                        let dRunId = null;
                        for (let attempt = 0; attempt < 24 && !dRunId; attempt++) {
                            dRunId = await findWorkflowRun(repo, DEPLOY_DISPATCHER_FILE, dispatchedAt, null);
                            if (!dRunId) await delay(5000);
                        }
                        if (!dRunId) {
                            addLog('⚠ No deploy run found for ' + DEPLOY_DISPATCHER_FILE + '.');
                            entry.state.deployError = 'The deploy workflow (' + DEPLOY_DISPATCHER_FILE + ') did not start. Check that the workflow exists on branch ' + branch + ' and that Actions are enabled for ' + repo + '.';
                            entry.state.deployStatus = 'failed';
                            return;
                        }
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
    "generate": appGeneratePage,
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
