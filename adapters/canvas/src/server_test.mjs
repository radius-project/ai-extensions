import { describe, it, expect } from "vitest";
import { resolveDeployStatus } from "./server.mjs";
import { parseRadDeployProgress } from "./deploy.mjs";

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

// Merge rules for the deploy monitor loop, expressed as pure inputs → outputs.
// The loop itself is glue over parseRadDeployProgress + setStatus; these tests
// pin the parser output the merge rules consume, which is the observable input
// to the state machine. Full loop tests would need a Node HTTP fixture and a
// stubbed gh CLI, deferred until a real e2e harness lands.
describe("deploy monitor merge inputs (parseRadDeployProgress)", () => {
    const modeled = [
        { name: "todolist", type: "Applications.Core/applications" },
        { name: "postgresql", type: "Radius.Data/postgreSqlDatabases" },
        { name: "frontend", type: "Applications.Core/containers" },
    ];

    it("mid-run tick: Completed <name> lines drive success by name; failed line drives failed", () => {
        const log = [
            "Deployment In Progress...",
            "Completed            frontend        Applications.Core/containers",
            "Failed               postgresql      Radius.Data/postgreSqlDatabases",
        ].join("\n");
        const prog = parseRadDeployProgress(log, modeled);
        expect(prog.global).toBe("in_progress");
        expect(prog.byName.frontend).toBe("success");
        expect(prog.byName.postgresql).toBe("failed");
        // todolist has no terminal line yet → not present in byName (caller must
        // treat it as pending / in_progress based on global).
        expect(prog.byName.todolist).toBeUndefined();
    });

    it("terminal tick: Deployment Complete + full success set produces global 'complete' and every byName success", () => {
        const log = [
            "Deployment In Progress...",
            "Completed            todolist        Applications.Core/applications",
            "Completed            postgresql      Radius.Data/postgreSqlDatabases",
            "Completed            frontend        Applications.Core/containers",
            "Deployment Complete",
        ].join("\n");
        const prog = parseRadDeployProgress(log, modeled);
        expect(prog.global).toBe("complete");
        expect(prog.byName).toEqual({
            todolist: "success",
            postgresql: "success",
            frontend: "success",
        });
    });

    it("does not report a terminal per-resource status for a node that never appeared in a Completed/Failed line — caller must decide (pending → failed when the run conclusion is non-success)", () => {
        const log = [
            "Deployment In Progress...",
            "Completed            frontend        Applications.Core/containers",
        ].join("\n");
        const prog = parseRadDeployProgress(log, modeled);
        expect(prog.byName.postgresql).toBeUndefined();
        expect(prog.byName.todolist).toBeUndefined();
    });
});
