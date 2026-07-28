// Unit tests for the deployed-graph readers on top of ghApiGetContent.
// Mocks ./gh.mjs at the module boundary so the tests exercise the URL shape
// and JSON-parse branches without touching the gh CLI. Sibling readers
// (fetchLiveDeployLog etc.) are covered indirectly by the addressing-contract
// tests — they use the same RADIUS_DEPLOY_STATUS_BRANCH constant.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gh = vi.hoisted(() => ({
    ghApiGetContent: vi.fn(),
    cliExec: vi.fn(),
}));

// Everything deploy.mjs imports from ./gh.mjs. The real module also exports
// runCommand, ghApiGetContentResult, and a handful of utilities that
// deploy.mjs never touches; only what it imports needs to be stubbed here.
vi.mock("./gh.mjs", () => gh);

// deploy.mjs also imports generatePortalUrl from ./infra.mjs at load time,
// but never calls it from the code paths under test. Stubbing keeps the load
// side-effect-free without pulling in the real infra.mjs graph.
vi.mock("./infra.mjs", () => ({ generatePortalUrl: vi.fn() }));

let deploy;

beforeEach(async () => {
    gh.ghApiGetContent.mockReset();
    gh.cliExec.mockReset();
    deploy = await import("./deploy.mjs");
});

afterEach(() => {
    vi.resetModules();
});

describe("fetchDeployedGraph — durable graph on radius-graph", () => {
    it("addresses the file at <sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json on radius-graph", async () => {
        gh.ghApiGetContent.mockResolvedValue('{"resources":[]}');

        await deploy.fetchDeployedGraph("acme/app", {
            sourceBranch: "main",
            scope: "default",
            environment: "aks-dev",
        });

        expect(gh.ghApiGetContent).toHaveBeenCalledWith(
            "/repos/acme/app/contents/main/.radius/deployments/default-aks-dev/app-graph.json?ref=radius-graph",
            12000,
        );
    });

    it("preserves a '/'-separated source branch as a nested path", async () => {
        gh.ghApiGetContent.mockResolvedValue(null);

        await deploy.fetchDeployedGraph("acme/app", {
            sourceBranch: "feature/x",
            scope: "default",
            environment: "dev",
        });

        expect(gh.ghApiGetContent).toHaveBeenCalledWith(
            "/repos/acme/app/contents/feature/x/.radius/deployments/default-dev/app-graph.json?ref=radius-graph",
            12000,
        );
    });

    it("parses a successful response into an object", async () => {
        gh.ghApiGetContent.mockResolvedValue(
            '{"resources":[{"name":"web","type":"Applications.Core/containers"}]}',
        );

        const graph = await deploy.fetchDeployedGraph("acme/app", {
            sourceBranch: "main",
            scope: "default",
            environment: "dev",
        });

        expect(graph).toEqual({
            resources: [{ name: "web", type: "Applications.Core/containers" }],
        });
    });

    it("returns null when the file isn't published yet", async () => {
        gh.ghApiGetContent.mockResolvedValue(null);

        const graph = await deploy.fetchDeployedGraph("acme/app", {
            sourceBranch: "main",
            scope: "default",
            environment: "dev",
        });

        expect(graph).toBeNull();
    });

    it("returns null when the file body isn't valid JSON", async () => {
        // A partially-written file (workflow race) or a malformed payload
        // should never crash the poller; the /api/deployed-graph handler
        // treats a null return as "no durable graph, try the next tier".
        gh.ghApiGetContent.mockResolvedValue("not-json-yet");

        const graph = await deploy.fetchDeployedGraph("acme/app", {
            sourceBranch: "main",
            scope: "default",
            environment: "dev",
        });

        expect(graph).toBeNull();
    });
});

describe("fetchLiveDeployedGraph — live snapshot on radius-deploy-status", () => {
    it("addresses deploy-graph-live.json at the repo root on radius-deploy-status", async () => {
        gh.ghApiGetContent.mockResolvedValue('{"resources":[]}');

        await deploy.fetchLiveDeployedGraph("acme/app");

        expect(gh.ghApiGetContent).toHaveBeenCalledWith(
            "/repos/acme/app/contents/deploy-graph-live.json?ref=radius-deploy-status",
            12000,
        );
    });

    it("parses a successful response", async () => {
        gh.ghApiGetContent.mockResolvedValue(
            '{"resources":[{"name":"web","provisioningState":"Provisioning"}]}',
        );

        const graph = await deploy.fetchLiveDeployedGraph("acme/app");

        expect(graph).toEqual({
            resources: [{ name: "web", provisioningState: "Provisioning" }],
        });
    });

    it("returns null when no live snapshot has been published yet", async () => {
        gh.ghApiGetContent.mockResolvedValue(null);

        expect(await deploy.fetchLiveDeployedGraph("acme/app")).toBeNull();
    });

    it("returns null on malformed JSON", async () => {
        gh.ghApiGetContent.mockResolvedValue("partial{");

        expect(await deploy.fetchLiveDeployedGraph("acme/app")).toBeNull();
    });
});

describe("fetchDeployGraph — legacy fallback on radius-deploy-status", () => {
    it("still addresses the legacy deploy-graph.json path (backward compat)", async () => {
        gh.ghApiGetContent.mockResolvedValue('{"resources":[]}');

        await deploy.fetchDeployGraph("acme/app");

        expect(gh.ghApiGetContent).toHaveBeenCalledWith(
            "/repos/acme/app/contents/deploy-graph.json?ref=radius-deploy-status",
            12000,
        );
    });
});
