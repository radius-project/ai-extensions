import { describe, it, expect } from "vitest";
import {
    selectDeployEntry,
    buildDeployPayload,
    validateDeployPayload,
    summarizeDeployStatus,
    DEPLOY_LOG_TAIL_DEFAULT,
    DEPLOY_LOG_TAIL_MAX,
} from "./deploy-tools.mjs";

describe("selectDeployEntry", () => {
    const older = { baseUrl: "http://127.0.0.1:1", state: { deployStatus: "failed", deployStartedAt: 10 } };
    const newer = { baseUrl: "http://127.0.0.1:2", state: { deployStatus: "failed", deployStartedAt: 20 } };

    it("prefers the deployment named by the handoff over the most recent one", () => {
        const servers = new Map([["a", older], ["b", newer]]);
        expect(selectDeployEntry(servers, "a")).toBe(older);
    });

    it("falls back to the most recently started deploy when no id is given", () => {
        const servers = new Map([["a", older], ["b", newer]]);
        expect(selectDeployEntry(servers)).toBe(newer);
    });

    it("fails closed when the named deployment is gone, rather than deploying another one", () => {
        // During an automatic loop, falling back here could redeploy a different
        // repository or environment after the original canvas was closed.
        expect(selectDeployEntry(new Map([["b", newer]]), "missing")).toBeNull();
        expect(selectDeployEntry(new Map(), "missing")).toBeNull();
    });

    it("fails closed when the named instance has no server", () => {
        expect(selectDeployEntry(new Map([["a", { state: {} }]]), "a")).toBeNull();
    });

    it("uses any open instance when none has deploy state", () => {
        const idle = { baseUrl: "http://127.0.0.1:3", state: {} };
        expect(selectDeployEntry(new Map([["a", idle]]))).toBe(idle);
    });

    it("returns null when no canvas instance is usable", () => {
        expect(selectDeployEntry(new Map())).toBeNull();
        expect(selectDeployEntry(new Map([["a", { state: {} }]]))).toBeNull();
    });
});

describe("buildDeployPayload", () => {
    const state = {
        deployParams: { environment: "dev", provider: "aws", targetRepo: "octo/app", branch: "feat", appFile: ".radius/app.bicep" },
    };

    it("repeats the last deploy so a post-repair redeploy matches the original", () => {
        expect(buildDeployPayload({}, state)).toEqual({
            environment: "dev",
            provider: "aws",
            targetRepo: "octo/app",
            branch: "feat",
            appFile: ".radius/app.bicep",
            agentInitiated: true,
        });
    });

    it("always marks the deploy as agent-initiated so loop ownership is kept", () => {
        expect(buildDeployPayload({}, {}).agentInitiated).toBe(true);
    });

    it("lets explicit arguments override the last deploy", () => {
        const payload = buildDeployPayload({ environment: "prod", repo: "octo/other", branch: "main", provider: "azure" }, state);
        expect(payload).toMatchObject({ environment: "prod", targetRepo: "octo/other", branch: "main", provider: "azure" });
    });

    it("falls back to the canvas context repo and defaults", () => {
        const payload = buildDeployPayload({ environment: "dev" }, { contextRepo: "octo/ctx" });
        expect(payload).toMatchObject({ targetRepo: "octo/ctx", provider: "azure", appFile: ".radius/app.bicep", branch: "" });
    });
});

describe("validateDeployPayload", () => {
    it("accepts a payload that names a repository and environment", () => {
        expect(validateDeployPayload({ targetRepo: "octo/app", environment: "dev" })).toBeNull();
    });

    it("refuses to guess a missing repository or environment", () => {
        expect(validateDeployPayload({ targetRepo: "", environment: "dev" })).toMatch(/repository/i);
        expect(validateDeployPayload({ targetRepo: "octo/app", environment: "" })).toMatch(/environment/i);
    });
});

describe("summarizeDeployStatus", () => {
    const status = {
        status: "failed",
        error: "BCP037",
        errorKind: null,
        deployRunUrl: "https://github.com/octo/app/actions/runs/42",
        startedAt: 1,
        finishedAt: 2,
        logs: Array.from({ length: 500 }, (_, i) => `line ${i}`),
        resources: [{ id: "huge" }],
    };

    it("keeps the failure details the repair loop needs", () => {
        expect(summarizeDeployStatus(status)).toMatchObject({
            status: "failed",
            error: "BCP037",
            deployRunUrl: "https://github.com/octo/app/actions/runs/42",
        });
    });

    it("drops the resource graph and trims the log to the default tail", () => {
        const out = summarizeDeployStatus(status);
        expect(out.resources).toBeUndefined();
        expect(out.logTail).toHaveLength(DEPLOY_LOG_TAIL_DEFAULT);
        expect(out.logTail.at(-1)).toBe("line 499");
    });

    it("caps an oversized log request and rejects a nonsensical one", () => {
        expect(summarizeDeployStatus(status, 10_000).logTail).toHaveLength(DEPLOY_LOG_TAIL_MAX);
        expect(summarizeDeployStatus(status, 0).logTail).toHaveLength(DEPLOY_LOG_TAIL_DEFAULT);
        expect(summarizeDeployStatus(status, -5).logTail).toHaveLength(1);
    });

    it("tolerates an empty or malformed status response", () => {
        expect(summarizeDeployStatus({})).toMatchObject({ status: "pending", error: null, logTail: [] });
        expect(summarizeDeployStatus({ logs: "not-an-array" }).logTail).toEqual([]);
    });
});
