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

describe("resolveDeployedGraph — /api/deployed-graph priority chain", () => {
    const key = { sourceBranch: "main", scope: "default", environment: "aks-dev" };

    // Reusable stub factory: every fetcher rejects by default so tests only
    // have to override the tiers they care about.
    const nullFetchers = () => ({
        fetchDurable: vi.fn().mockResolvedValue(null),
        fetchLive: vi.fn().mockResolvedValue(null),
        fetchLegacy: vi.fn().mockResolvedValue(null),
    });

    it("returns durable first — stops the chain and reports source='durable'", async () => {
        const fetchers = nullFetchers();
        fetchers.fetchDurable.mockResolvedValue({
            resources: [{ name: "web", provisioningState: "Succeeded" }],
        });
        // Later tiers are populated too — they must NOT be consulted once
        // durable answers, otherwise a stale live/legacy could overwrite the
        // authoritative post-deploy graph.
        fetchers.fetchLive.mockResolvedValue({ resources: [{ name: "stale-live" }] });
        fetchers.fetchLegacy.mockResolvedValue({ resources: [{ name: "stale-legacy" }] });

        const result = await deploy.resolveDeployedGraph({
            key,
            fetchers,
            sessionDeployedGraph: { resources: [{ name: "stale-session" }] },
            scaffoldResources: [{ name: "modeled-scaffold" }],
        });

        expect(result.source).toBe("durable");
        expect(result.resources).toEqual([{ name: "web", provisioningState: "Succeeded" }]);
        expect(fetchers.fetchDurable).toHaveBeenCalledWith(key);
        expect(fetchers.fetchLive).not.toHaveBeenCalled();
        expect(fetchers.fetchLegacy).not.toHaveBeenCalled();
    });

    it("falls through to the live snapshot when durable isn't published yet", async () => {
        const fetchers = nullFetchers();
        fetchers.fetchLive.mockResolvedValue({
            resources: [{ name: "web", provisioningState: "Provisioning" }],
        });

        const result = await deploy.resolveDeployedGraph({ key, fetchers });

        expect(result.source).toBe("live");
        expect(result.resources).toEqual([{ name: "web", provisioningState: "Provisioning" }]);
        expect(fetchers.fetchLegacy).not.toHaveBeenCalled();
    });

    it("falls through to legacy when durable + live are both empty", async () => {
        const fetchers = nullFetchers();
        fetchers.fetchLegacy.mockResolvedValue([{ name: "web" }]);

        const result = await deploy.resolveDeployedGraph({ key, fetchers });

        expect(result.source).toBe("legacy");
        expect(result.resources).toEqual([{ name: "web" }]);
    });

    it("accepts a flat-array legacy shape (backward compat with old workflow)", async () => {
        const fetchers = nullFetchers();
        // The old workflow wrote a bare array to deploy-graph.json rather than
        // wrapping it in { resources: [...] }; both shapes normalize the same.
        fetchers.fetchLegacy.mockResolvedValue([{ name: "flat" }]);

        const result = await deploy.resolveDeployedGraph({ key, fetchers });

        expect(result.source).toBe("legacy");
        expect(result.resources).toEqual([{ name: "flat" }]);
    });

    it("uses the session-cached graph when every network fetch is empty", async () => {
        // The session cache is populated by /api/deploy when a deploy completes
        // successfully. It's the legacy tier's fast-path — a fresh legacy
        // network read beats it above, but if the file was deleted or the
        // network fails, the last-good in-memory snapshot still wins over
        // dropping back to a grey scaffold.
        const result = await deploy.resolveDeployedGraph({
            key,
            fetchers: nullFetchers(),
            sessionDeployedGraph: { resources: [{ name: "cached" }] },
        });

        expect(result.source).toBe("legacy");
        expect(result.resources).toEqual([{ name: "cached" }]);
    });

    it("falls through to a greyed scaffold when only the modeled graph is available", async () => {
        // The modeled/planned array feeds the scaffold. Every node gets its
        // deployStatus stamped 'pending' and outputResources reset too, so the
        // Deployed tab always shows *some* topology (all grey) before a deploy
        // has ever completed.
        const modeled = [
            {
                name: "web",
                deployStatus: "success",
                outputResources: [{ id: "azResource", deployStatus: "success" }],
            },
            { name: "db" },
        ];

        const result = await deploy.resolveDeployedGraph({
            key,
            fetchers: nullFetchers(),
            scaffoldResources: modeled,
        });

        expect(result.source).toBe("scaffold");
        expect(result.resources).toEqual([
            {
                name: "web",
                deployStatus: "pending",
                outputResources: [{ id: "azResource", deployStatus: "pending" }],
            },
            { name: "db", deployStatus: "pending" },
        ]);
        // Deep-cloned — the caller's modeled state (which also feeds the
        // Modeled/Planned tabs) must not be mutated by the scaffold path.
        expect(modeled[0].deployStatus).toBe("success");
    });

    it("returns source='none' with an empty resources array as the terminal fallback", async () => {
        const result = await deploy.resolveDeployedGraph({
            key,
            fetchers: nullFetchers(),
        });

        expect(result).toEqual({ resources: [], source: "none" });
    });

    it("skips durable when the environment is unknown but still tries live/legacy", async () => {
        // The handler wires fetchDurable to null when it can't resolve the
        // environment; the resolver must then move on to the branch-agnostic
        // tiers (live and legacy) rather than short-circuiting to 'none'.
        const fetchers = {
            fetchDurable: null,
            fetchLive: vi.fn().mockResolvedValue({ resources: [{ name: "live-web" }] }),
            fetchLegacy: vi.fn().mockResolvedValue(null),
        };

        const result = await deploy.resolveDeployedGraph({
            key: { sourceBranch: "main", scope: "default", environment: "" },
            fetchers,
        });

        expect(result.source).toBe("live");
        expect(result.resources).toEqual([{ name: "live-web" }]);
        expect(fetchers.fetchLive).toHaveBeenCalled();
    });
});
