// Unit tests for the persisted-deployed-graph reader + status extractor.
// Mocks ./gh.mjs at the module boundary so the tests exercise the URL shape
// and JSON-parse branches without touching the gh CLI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gh = vi.hoisted(() => ({
    ghApiGetContent: vi.fn(),
    cliExec: vi.fn(),
}));

// Everything deploy.mjs imports from ./gh.mjs. The real module also exports
// runCommand and a handful of utilities that deploy.mjs never touches; only
// what it imports needs to be stubbed here.
vi.mock("./gh.mjs", () => gh);

// deploy.mjs also imports generatePortalUrl from ./infra.mjs at load time
// but never calls it from the code paths under test.
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

describe("fetchDeployedGraph — persisted snapshot on radius-graph", () => {
    const key = { sourceBranch: "main", scope: "default", environment: "aks-dev" };

    it("addresses <sourceBranch>/.radius/deployments/<scope>-<env>/app-graph.json on radius-graph", async () => {
        gh.ghApiGetContent.mockResolvedValue('{"resources":[]}');

        await deploy.fetchDeployedGraph("acme/app", key);

        expect(gh.ghApiGetContent).toHaveBeenCalledWith(
            "/repos/acme/app/contents/main/.radius/deployments/default-aks-dev/app-graph.json?ref=radius-graph",
            12000,
        );
    });

    it("parses a successful response", async () => {
        gh.ghApiGetContent.mockResolvedValue(
            '{"resources":[{"name":"web","provisioningState":"Succeeded"}]}',
        );

        const graph = await deploy.fetchDeployedGraph("acme/app", key);

        expect(graph).toEqual({
            resources: [{ name: "web", provisioningState: "Succeeded" }],
        });
    });

    it("returns null when no persisted snapshot has been published yet (404 → empty content)", async () => {
        gh.ghApiGetContent.mockResolvedValue(null);
        expect(await deploy.fetchDeployedGraph("acme/app", key)).toBeNull();
    });

    it("returns null on malformed JSON so callers just show the scaffold", async () => {
        gh.ghApiGetContent.mockResolvedValue("partial{");
        expect(await deploy.fetchDeployedGraph("acme/app", key)).toBeNull();
    });
});

describe("mapProvisioningStateToDeployStatus", () => {
    it.each([
        ["Succeeded", "success"],
        ["succeeded", "success"],
        ["Success", "success"],
        ["Ok", "success"],
        ["Failed", "failed"],
        ["Canceled", "failed"],
        ["Cancelled", "failed"],
        ["Provisioning", "in_progress"],
        ["Accepted", "in_progress"],
        ["Creating", "in_progress"],
        ["Updating", "in_progress"],
        ["Deleting", "in_progress"],
        ["Running", "in_progress"],
    ])("%s → %s", (input, expected) => {
        expect(deploy.mapProvisioningStateToDeployStatus(input)).toBe(expected);
    });

    it("falls back to 'pending' for empty / unknown values so untouched nodes stay grey", () => {
        expect(deploy.mapProvisioningStateToDeployStatus("")).toBe("pending");
        expect(deploy.mapProvisioningStateToDeployStatus(null)).toBe("pending");
        expect(deploy.mapProvisioningStateToDeployStatus(undefined)).toBe("pending");
        expect(deploy.mapProvisioningStateToDeployStatus("NotSpecified")).toBe("pending");
        expect(deploy.mapProvisioningStateToDeployStatus("Weird")).toBe("pending");
    });
});

describe("extractStatusesFromGraph — persisted graph → per-name status map", () => {
    it("builds a name → deployStatus map from a top-level resources array", () => {
        expect(
            deploy.extractStatusesFromGraph({
                resources: [
                    { name: "todo-list-app-1", provisioningState: "Succeeded" },
                    { name: "mysql", provisioningState: "Provisioning" },
                    { name: "cache", provisioningState: "Failed" },
                ],
            }),
        ).toEqual({
            "todo-list-app-1": "success",
            "mysql": "in_progress",
            "cache": "failed",
        });
    });

    it("accepts a flat-array shape (some legacy tools omit the wrapper)", () => {
        expect(
            deploy.extractStatusesFromGraph([
                { name: "web", provisioningState: "Succeeded" },
            ]),
        ).toEqual({ web: "success" });
    });

    it("also reads provisioningStatus (different provider spelling) as an alias", () => {
        expect(
            deploy.extractStatusesFromGraph({
                resources: [{ name: "web", provisioningStatus: "Succeeded" }],
            }),
        ).toEqual({ web: "success" });
    });

    it("skips a resource with no name and no provisioningState (either alias)", () => {
        expect(
            deploy.extractStatusesFromGraph({
                resources: [
                    { name: "no-state" },
                    { provisioningState: "Succeeded" }, // no name
                    { name: "", provisioningState: "Succeeded" }, // empty name
                    { name: "web", provisioningState: "Succeeded" },
                ],
            }),
        ).toEqual({ web: "success" });
    });

    it("returns {} for empty / null / non-object input so callers can always ...spread", () => {
        expect(deploy.extractStatusesFromGraph(null)).toEqual({});
        expect(deploy.extractStatusesFromGraph(undefined)).toEqual({});
        expect(deploy.extractStatusesFromGraph({})).toEqual({});
        expect(deploy.extractStatusesFromGraph({ resources: null })).toEqual({});
    });
});
