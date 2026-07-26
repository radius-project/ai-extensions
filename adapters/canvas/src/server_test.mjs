import { describe, it, expect } from "vitest";
import { resolveDeployStatus } from "./server.mjs";

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
