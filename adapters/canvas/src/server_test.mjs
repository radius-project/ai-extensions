import { describe, it, expect } from "vitest";
import { resolveDeployStatus, isReplicationLagError, buildRoleAssignmentArgs } from "./server.mjs";

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
