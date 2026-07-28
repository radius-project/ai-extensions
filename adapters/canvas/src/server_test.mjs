import { describe, it, expect } from "vitest";
import { resolveDeployStatus, isReplicationLagError, buildRoleAssignmentArgs, findFederatedCredentialNameCollision } from "./server.mjs";
import { buildFederatedCredentialName, buildEnvironmentSuffix } from "@radius-project/core";

describe("resolveDeployStatus", () => {
    it("returns success when the run concluded with success", () => {
        expect(resolveDeployStatus({ runConclusion: "success", runStatus: "completed", state: "pending" })).toBe("success");
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
