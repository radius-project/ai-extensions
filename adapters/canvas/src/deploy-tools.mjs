// Pure helpers behind the radius_deploy / radius_deploy_status tools, kept out of
// extension.mjs so they can be tested without the SDK or a live canvas server.

// Pick the canvas instance a deploy tool should act on. `deploymentId` comes from
// the repair handoff and makes ownership deterministic; without it, fall back to
// the most recently started deploy, then to any open instance.
export function selectDeployEntry(servers, deploymentId) {
    if (deploymentId && servers?.get) {
        const exact = servers.get(deploymentId);
        if (exact?.baseUrl) return exact;
    }
    let found = null;
    for (const entry of servers.values()) {
        if (!entry?.baseUrl) continue;
        const state = entry.state || {};
        if (!state.deployParams && !state.deployStatus) continue;
        if (!found || (state.deployStartedAt || 0) > (found.state?.deployStartedAt || 0)) found = entry;
    }
    if (found) return found;
    for (const entry of servers.values()) if (entry?.baseUrl) return entry;
    return null;
}

// Build the /api/deploy body, defaulting to the entry's last deploy so a redeploy
// after a repair repeats what the user originally deployed.
export function buildDeployPayload(args = {}, state = {}) {
    const last = state.deployParams || {};
    return {
        environment: args.environment || last.environment || "",
        provider: args.provider || last.provider || "azure",
        targetRepo: args.repo || last.targetRepo || state.contextRepo || "",
        branch: args.branch || last.branch || "",
        appFile: args.appFile || last.appFile || ".radius/app.bicep",
        agentInitiated: true,
    };
}

// Reject a payload that would deploy something unintended rather than guessing.
export function validateDeployPayload(payload) {
    if (!payload.targetRepo) return "No target repository is known for this deploy. Pass `repo` (owner/repo).";
    if (!payload.environment) return "No GitHub environment is known for this deploy. Pass `environment`.";
    return null;
}

export const DEPLOY_LOG_TAIL_DEFAULT = 40;
export const DEPLOY_LOG_TAIL_MAX = 200;

// Compact the status payload: the raw response carries the full resource graph and
// up to 4000 log lines, which would swamp the agent's context.
export function summarizeDeployStatus(d = {}, logLines) {
    const requested = Number(logLines) || DEPLOY_LOG_TAIL_DEFAULT;
    const cap = Math.min(Math.max(requested, 1), DEPLOY_LOG_TAIL_MAX);
    const logs = Array.isArray(d.logs) ? d.logs : [];
    return {
        status: d.status || "pending",
        error: d.error || null,
        errorKind: d.errorKind || null,
        deployRunUrl: d.deployRunUrl || null,
        startedAt: d.startedAt || null,
        finishedAt: d.finishedAt || null,
        logTail: logs.slice(-cap),
    };
}
