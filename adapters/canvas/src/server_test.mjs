import { describe, it, expect } from "vitest";
import {
    addGraphProgress,
    azureCredentialIdValidationError,
    azureLoginRequiredResponse,
    buildRoleAssignmentArgs,
    buildAzureCliAssistPrompt,
    canReuseModeledGraph,
    findFederatedCredentialNameCollision,
    graphDefinitionHash,
    isCrossSiteMutation,
    isCliCommandMissing,
    isCurrentSourceRefToken,
    isReplicationLagError,
    invokeSessionPrompt,
    pickAksResourceGroup,
    resolveDeployStatus,
} from "./server.mjs";
import { buildFederatedCredentialName, buildEnvironmentSuffix } from "@radius-project/core";

describe("resolveDeployStatus", () => {
    it("returns success when the run concluded with success", () => {
        expect(resolveDeployStatus({ runConclusion: "success", runStatus: "completed", state: "pending" })).toBe("success");
    });

    describe("modeled graph refresh cache", () => {
        it("hashes the application definition deterministically", () => {
            expect(graphDefinitionHash("resource app 'Radius.Core/applications@2023-10-01-preview' = {}"))
                .toBe(graphDefinitionHash("resource app 'Radius.Core/applications@2023-10-01-preview' = {}"));
            expect(graphDefinitionHash("one")).not.toBe(graphDefinitionHash("two"));
            expect(graphDefinitionHash("app", "config-one")).not.toBe(graphDefinitionHash("app", "config-two"));
        });

        describe("graph diff request identity", () => {
            it("accepts results only for the current diff context", () => {
                const state = {
                    sourceRefContexts: {
                        diff: { token: "diff|octo/app|main...new" },
                    },
                };
                expect(isCurrentSourceRefToken(state, "diff", "diff|octo/app|main...new")).toBe(true);
                expect(isCurrentSourceRefToken(state, "diff", "diff|octo/app|main...old")).toBe(false);
                expect(isCurrentSourceRefToken(state, "diff", null)).toBe(false);
            });
        });

        it("reuses resources only for the same repo, branch, and definition", () => {
            const hash = graphDefinitionHash("app");
            const state = {
                graphLoaded: true,
                graphTargetRepo: "octo/app",
                graphBranch: "main",
                graphDefinitionHash: hash,
                graphResources: [],
            };
            expect(canReuseModeledGraph(state, "octo/app", "main", hash)).toBe(true);
            expect(canReuseModeledGraph(state, "octo/app", "feature", hash)).toBe(false);
            expect(canReuseModeledGraph(state, "octo/app", "main", graphDefinitionHash("changed"))).toBe(false);
        });
    });

    it("returns pending when the run is still in progress (no conclusion yet)", () => {
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "in_progress", state: "pending" })).toBe("pending");
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "queued", state: "pending" })).toBe("pending");
    });

    it("returns failed for any non-success conclusion", () => {
        for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "skipped"]) {
            expect(resolveDeployStatus({ runConclusion: conclusion, runStatus: "completed", state: "pending" }), conclusion).toBe("failed");
        }
    });

    it("falls back to the deployment-status state when no linked run is available", () => {
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "", state: "success" })).toBe("success");
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "", state: "failure" })).toBe("failed");
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "", state: "error" })).toBe("failed");
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "", state: "pending" })).toBe("pending");
        expect(resolveDeployStatus({ runConclusion: "", runStatus: "", state: "in_progress" })).toBe("pending");
    });
});

describe("addGraphProgress", () => {
    it("accepts progress only from the current graph generation", () => {
        const state = { graphBuildGeneration: 2, progressMessages: ["current"] };

        expect(addGraphProgress(state, 1, "stale")).toBe(false);
        expect(addGraphProgress(state, 2, "latest")).toBe(true);
        expect(state.progressMessages).toEqual(["current", "latest"]);
    });
});

describe("isReplicationLagError", () => {
    it("treats Graph-replication 'principal not yet visible' errors as retryable", () => {
        for (const stderr of [
            "Principal <id> does not exist in the directory <tenant>.",
            "No matching principal found.",
            "PrincipalNotFound: Principal does not exist.",
            "Cannot find user or service principal in graph database for the given assignee.",
            "Cannot find principal in the directory.",
            "The assignee was not found in the directory.",
        ]) {
            expect(isReplicationLagError(stderr), stderr).toBe(true);
        }
    });

    it("does NOT retry genuine authorization failures or empty errors", () => {
        expect(isReplicationLagError("AuthorizationFailed: The client does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write'.")).toBe(false);
        expect(isReplicationLagError("RoleAssignmentUpdateNotPermitted")).toBe(false);
        expect(isReplicationLagError("")).toBe(false);
        expect(isReplicationLagError(undefined)).toBe(false);
    });
});

describe("buildRoleAssignmentArgs", () => {
    it("assigns by SP object id with an explicit ServicePrincipal principal type (never by appId)", () => {
        const args = buildRoleAssignmentArgs({
            objectId: "00000000-obj-id",
            role: "Contributor",
            scope: "/subscriptions/sub/resourceGroups/rg",
            subscriptionId: "sub",
        });
        expect(args).toContain("--assignee-object-id");
        expect(args[args.indexOf("--assignee-object-id") + 1]).toBe("00000000-obj-id");
        expect(args).toContain("--assignee-principal-type");
        expect(args[args.indexOf("--assignee-principal-type") + 1]).toBe("ServicePrincipal");
        // The appId-based form is what caused the replication race — never emit it.
        expect(args).not.toContain("--assignee");
        expect(args.slice(args.indexOf("--role"), args.indexOf("--role") + 2)).toEqual(["--role", "Contributor"]);
        expect(args.slice(args.indexOf("--scope"), args.indexOf("--scope") + 2)).toEqual(["--scope", "/subscriptions/sub/resourceGroups/rg"]);
    });
});

describe("findFederatedCredentialNameCollision", () => {
    // Prove the real name-collapse: two env names differing only by a char that
    // clean() normalizes ("prod:west" vs "prod-west") build the SAME FIC name but
    // DIFFERENT subjects (the subject keeps "%3A"). Emulates a reused app where
    // the colon env was set up first and the hyphen env is being added.
    const repoFullName = "octo/app";
    const colonName = buildFederatedCredentialName({ repoFullName, envName: "prod:west" });
    const hyphenName = buildFederatedCredentialName({ repoFullName, envName: "prod-west" });
    const colonSubject = `repo:${repoFullName}:${buildEnvironmentSuffix("prod:west")}`;
    const hyphenSubject = `repo:${repoFullName}:${buildEnvironmentSuffix("prod-west")}`;

    it("names collapse but subjects differ (guards the premise of the fix)", () => {
        expect(hyphenName).toBe(colonName);
        expect(hyphenSubject).not.toBe(colonSubject);
    });

    it("flags a name that already exists with a different subject", () => {
        const desired = [{ name: hyphenName, subject: hyphenSubject }];
        const existing = new Map([[colonName, colonSubject]]);
        const hit = findFederatedCredentialNameCollision(desired, existing);
        expect(hit).not.toBeNull();
        expect(hit.name).toBe(hyphenName);
        expect(hit.existingSubject).toBe(colonSubject);
        expect(hit.desiredSubject).toBe(hyphenSubject);
    });

    it("returns null when the same name maps to the same subject (true idempotent rerun)", () => {
        const desired = [{ name: colonName, subject: colonSubject }];
        const existing = new Map([[colonName, colonSubject]]);
        expect(findFederatedCredentialNameCollision(desired, existing)).toBeNull();
    });

    it("returns null when the name is not present at all", () => {
        const desired = [{ name: hyphenName, subject: hyphenSubject }];
        expect(findFederatedCredentialNameCollision(desired, new Map())).toBeNull();
    });

    it("accepts a plain object map as well as a Map", () => {
        const desired = [{ name: hyphenName, subject: hyphenSubject }];
        const hit = findFederatedCredentialNameCollision(desired, { [colonName]: colonSubject });
        expect(hit && hit.name).toBe(hyphenName);
    });

    it("is null-safe on empty or missing inputs", () => {
        expect(findFederatedCredentialNameCollision(null, new Map())).toBeNull();
        expect(findFederatedCredentialNameCollision([], null)).toBeNull();
        expect(findFederatedCredentialNameCollision([{ subject: "s" }], new Map([["n", "x"]]))).toBeNull();
    });
});

describe("isCrossSiteMutation", () => {
    // Read-only methods always pass, regardless of the header.
    it("allows GET/HEAD from any site", () => {
        for (const site of ["cross-site", "same-site", "same-origin", "none", "", undefined]) {
            expect(isCrossSiteMutation("GET", site), "GET " + site).toBe(false);
            expect(isCrossSiteMutation("HEAD", site), "HEAD " + site).toBe(false);
        }
    });

    // The extension's own page (same-origin) and user navigations (none) pass.
    it("allows same-origin and none state-changing requests", () => {
        expect(isCrossSiteMutation("POST", "same-origin")).toBe(false);
        expect(isCrossSiteMutation("POST", "none")).toBe(false);
        expect(isCrossSiteMutation("DELETE", "same-origin")).toBe(false);
    });

    // The attack: a browser page on another site issuing a simple POST.
    it("rejects cross-site and same-site state-changing requests", () => {
        expect(isCrossSiteMutation("POST", "cross-site")).toBe(true);
        expect(isCrossSiteMutation("POST", "same-site")).toBe(true);
        expect(isCrossSiteMutation("PUT", "cross-site")).toBe(true);
        expect(isCrossSiteMutation("PATCH", "same-site")).toBe(true);
        expect(isCrossSiteMutation("DELETE", "cross-site")).toBe(true);
    });

    // Non-browser callers (extension host, curl) never send the header — allow.
    it("allows state-changing requests with no Sec-Fetch-Site header", () => {
        expect(isCrossSiteMutation("POST", undefined)).toBe(false);
        expect(isCrossSiteMutation("POST", null)).toBe(false);
        expect(isCrossSiteMutation("POST", "")).toBe(false);
    });

    // Header parsing is case-insensitive, trimmed, and array-tolerant.
    it("normalizes header value casing, whitespace, and array form", () => {
        expect(isCrossSiteMutation("post", "  Cross-Site  ")).toBe(true);
        expect(isCrossSiteMutation("POST", ["cross-site"])).toBe(true);
        expect(isCrossSiteMutation("POST", ["same-origin"])).toBe(false);
        expect(isCrossSiteMutation("POST", "SAME-ORIGIN")).toBe(false);
    });
});

describe("pickAksResourceGroup", () => {
    // The AKS Cluster Admin grant must be scoped to the resource group that
    // actually holds the cluster, which can differ from the deployment RG the
    // user selected. pickAksResourceGroup prefers the cluster's discovered RG.
    it("prefers the cluster's own resource group over the deployment RG", () => {
        expect(pickAksResourceGroup("rg-cluster", "rg-deploy")).toBe("rg-cluster");
    });

    it("falls back to the deployment RG when the cluster RG is absent", () => {
        expect(pickAksResourceGroup("", "rg-deploy")).toBe("rg-deploy");
        expect(pickAksResourceGroup(undefined, "rg-deploy")).toBe("rg-deploy");
        expect(pickAksResourceGroup(null, "rg-deploy")).toBe("rg-deploy");
    });

    it("trims whitespace and falls back on a blank cluster RG", () => {
        expect(pickAksResourceGroup("  rg-cluster  ", "rg-deploy")).toBe("rg-cluster");
        expect(pickAksResourceGroup("   ", "rg-deploy")).toBe("rg-deploy");
    });

    it("ignores non-string cluster RG values", () => {
        expect(pickAksResourceGroup(123, "rg-deploy")).toBe("rg-deploy");
    });
});

describe("isCliCommandMissing", () => {
    it("recognizes common missing-command errors", () => {
        expect(isCliCommandMissing("spawn az ENOENT")).toBe(true);
        expect(isCliCommandMissing("spawn az.exe ENOENT")).toBe(true);
        expect(isCliCommandMissing("/bin/sh: az: command not found")).toBe(true);
        expect(isCliCommandMissing("'az' is not recognized as an internal or external command")).toBe(true);
    });

    it("does not treat ordinary auth or runtime failures as a missing CLI", () => {
        expect(isCliCommandMissing("Please run 'az login' to setup account.")).toBe(false);
        expect(isCliCommandMissing("ERROR: The subscription was not found.")).toBe(false);
        expect(isCliCommandMissing("Failed to read token cache: No such file or directory")).toBe(false);
        expect(isCliCommandMissing("Token cache failed with ENOENT")).toBe(false);
        expect(isCliCommandMissing("helper: command not found")).toBe(false);
        expect(isCliCommandMissing("")).toBe(false);
    });
});

describe("azureCredentialIdValidationError", () => {
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const subscriptionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    it("accepts valid or omitted credential identifiers", () => {
        expect(azureCredentialIdValidationError({ tenantId, subscriptionId })).toBe("");
        expect(azureCredentialIdValidationError()).toBe("");
    });

    it("rejects an invalid tenant before generating login guidance", () => {
        expect(azureCredentialIdValidationError({ tenantId: "not-a-guid", subscriptionId }))
            .toBe('Invalid tenantId "not-a-guid" (expected a GUID).');
    });

    it("rejects an invalid subscription before invoking Azure CLI", () => {
        expect(azureCredentialIdValidationError({ tenantId, subscriptionId: "not-a-guid" }))
            .toBe('Invalid subscriptionId "not-a-guid" (expected a GUID).');
    });
});

describe("azureLoginRequiredResponse", () => {
    const tenantId = "11111111-2222-3333-4444-555555555555";

    it("returns structured login guidance for an unauthenticated session", () => {
        expect(azureLoginRequiredResponse({ tenantId })).toEqual({
            error: 'No active Azure session. Run "az login --use-device-code" in your terminal, then click Verify Credentials again.',
            code: "az-login-required",
            tenantId,
        });
    });

    it("returns structured tenant-specific guidance for the wrong active tenant", () => {
        const response = azureLoginRequiredResponse({
            tenantId,
            activeTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        });
        expect(response.code).toBe("az-login-required");
        expect(response.tenantId).toBe(tenantId);
        expect(response.error).toContain(`--tenant ${tenantId}`);
    });
});

describe("invokeSessionPrompt", () => {
    it("waits for the session prompt handler to finish", async () => {
        let completed = false;
        const result = await invokeSessionPrompt(async () => {
            await Promise.resolve();
            completed = true;
        }, "prompt");
        expect(completed).toBe(true);
        expect(result).toEqual({ status: 200 });
    });

    it("surfaces unavailable and rejected handlers as server errors", async () => {
        await expect(invokeSessionPrompt(null, "prompt")).resolves.toEqual({
            status: 503,
            error: "Could not reach the Copilot session to start Azure CLI help.",
        });
        await expect(invokeSessionPrompt(async () => {
            throw new Error("send failed");
        }, "prompt")).resolves.toEqual({
            status: 502,
            error: "The Copilot session could not start Azure CLI help.",
        });
    });
});

describe("buildAzureCliAssistPrompt", () => {
    it("builds a login prompt with the requested tenant when it is a valid guid", () => {
        const prompt = buildAzureCliAssistPrompt({
            action: "login",
            tenantId: "11111111-2222-3333-4444-555555555555",
        });
        expect(prompt).toContain("Run `az login --use-device-code --tenant 11111111-2222-3333-4444-555555555555`");
        expect(prompt).toContain("remove COPILOT_AGENT_SESSION_ID from the az process environment");
        expect(prompt).toContain("show me the device code and sign-in URL");
        expect(prompt).toContain("click Verify Credentials again");
    });

    it("falls back to tenant-agnostic device-code login for invalid tenant ids", () => {
        const prompt = buildAzureCliAssistPrompt({ action: "login", tenantId: "not-a-guid" });
        expect(prompt).toContain("Run `az login --use-device-code`");
        expect(prompt).not.toContain("--tenant not-a-guid");
    });

    it("builds install guidance when Azure CLI is missing", () => {
        const prompt = buildAzureCliAssistPrompt({ action: "install" });
        expect(prompt).toContain("Azure CLI is not installed");
        expect(prompt).toContain("install Azure CLI");
    });
});
