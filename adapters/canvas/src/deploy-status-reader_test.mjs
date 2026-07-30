import { describe, expect, it } from "vitest";
import {
    deriveGraphRegistry,
    deriveGraphTag,
    appNameForGraphTag,
    createDeployStatusReader,
} from "./deploy.mjs";

// The producer (radius-project/radius PR #12591) derives the graph registry/tag
// in bash; these tests lock the reader's derivation to byte-for-byte parity so
// it pulls the exact artifact the deploy pushed.
describe("deriveGraphRegistry", () => {
    it("prefers an explicit graph registry override", () => {
        expect(deriveGraphRegistry("ghcr.io/acme/app-radius-state-dev-abc", "ghcr.io/acme/custom"))
            .toBe("ghcr.io/acme/custom");
    });

    it("swaps radius-state for radius-graph", () => {
        expect(deriveGraphRegistry("ghcr.io/acme/app-radius-state-dev-abc123", ""))
            .toBe("ghcr.io/acme/app-radius-graph-dev-abc123");
    });

    it("only swaps the first radius-state occurrence", () => {
        expect(deriveGraphRegistry("ghcr.io/acme/radius-state-radius-state", ""))
            .toBe("ghcr.io/acme/radius-graph-radius-state");
    });

    it("appends -graph when the registry has no radius-state token", () => {
        expect(deriveGraphRegistry("ghcr.io/acme/statepkg", "")).toBe("ghcr.io/acme/statepkg-graph");
    });

    it("returns empty when neither input is provided", () => {
        expect(deriveGraphRegistry("", "")).toBe("");
    });
});

describe("deriveGraphTag", () => {
    it("prefers an explicit tag override", () => {
        expect(deriveGraphTag("dev", "my-app", "pinned")).toBe("pinned");
    });

    it("builds <environment>-<app>-latest, lowercased and sanitized", () => {
        expect(deriveGraphTag("Dev", "My App!", "")).toBe("dev-my-app-latest");
    });

    it("collapses runs of invalid characters and strips leading/trailing dashes", () => {
        // '/' and '@' are replaced with '-'; existing dashes are preserved (the
        // producer's sed keeps '-' in its allowed set), matching bash parity.
        expect(deriveGraphTag("Prod/EU", "web@svc", "")).toBe("prod-eu-web-svc-latest");
        expect(deriveGraphTag("--lead", "trail--", "")).toBe("lead-trail-latest");
    });

    it("caps the base at 80 characters before appending -latest", () => {
        const env = "e".repeat(50);
        const app = "a".repeat(50);
        const tag = deriveGraphTag(env, app, "");
        // base = 50 e's + '-' + 50 a's => sliced to 80 chars, then '-latest'.
        expect(tag).toBe(`${`${env}-${app}`.slice(0, 80)}-latest`);
    });

    it("falls back to deploy-status when the base sanitizes to empty", () => {
        expect(deriveGraphTag("", "", "")).toBe("deploy-status-latest");
    });
});

describe("appNameForGraphTag", () => {
    it("extracts the first single-quoted name literal", () => {
        const src = `resource app 'Radius.Core/applications@2025-08-01-preview' = {\n  name: 'checkout'\n}`;
        expect(appNameForGraphTag(src)).toBe("checkout");
    });

    it("returns empty when no name literal is present", () => {
        expect(appNameForGraphTag("param image string")).toBe("");
    });
});

const READER_BASE = {
    repo: "acme/app",
    environment: "dev",
    app: "my-app",
    stateRegistry: "ghcr.io/acme/app-radius-state-dev-123456789abc",
    // Skip the gh keyring lookup in tests.
    credentials: { username: "octocat", token: "t" },
};

describe("createDeployStatusReader", () => {
    it("derives the GHCR registry and tag the producer published to", () => {
        const reader = createDeployStatusReader(READER_BASE);
        expect(reader.registry).toBe("ghcr.io/acme/app-radius-graph-dev-123456789abc");
        expect(reader.tag).toBe("dev-my-app-latest");
    });

    it("returns the deployed graph from the GHCR artifact when present", async () => {
        let branchCalls = 0;
        const reader = createDeployStatusReader({
            ...READER_BASE,
            pullArtifact: async () => ({ files: { "deploy-graph.json": '{"resources":[{"name":"web"}]}' } }),
            getBranchContent: async () => { branchCalls++; return null; },
        });
        const { graph, source, status } = await reader.graph();
        expect(status).toBe("ok");
        expect(source).toBe("ghcr");
        expect(graph).toEqual({ resources: [{ name: "web" }] });
        expect(branchCalls).toBe(0);
    });

    it("falls back to the branch when the GHCR artifact is missing", async () => {
        const reader = createDeployStatusReader({
            ...READER_BASE,
            pullArtifact: async () => null,
            getBranchContent: async () => Buffer.from('{"resources":[]}'),
        });
        const { graph, source, status } = await reader.graph();
        expect(status).toBe("missing");
        expect(source).toBe("branch");
        expect(graph).toEqual({ resources: [] });
    });

    it("surfaces an auth status and still tries the branch fallback", async () => {
        const authError = Object.assign(new Error("denied"), { code: "GHCR_AUTH" });
        let branchCalls = 0;
        const reader = createDeployStatusReader({
            ...READER_BASE,
            pullArtifact: async () => { throw authError; },
            getBranchContent: async () => { branchCalls++; return null; },
        });
        const { graph, source, status } = await reader.graph();
        expect(status).toBe("auth");
        expect(source).toBe("none");
        expect(graph).toBe(null);
        expect(branchCalls).toBe(1);
    });

    it("reports malformed when the artifact lacks a usable deploy-graph.json", async () => {
        const reader = createDeployStatusReader({
            ...READER_BASE,
            pullArtifact: async () => ({ files: { "deploy-state.txt": "state=succeeded" } }),
            getBranchContent: async () => null,
        });
        const { status, source } = await reader.graph();
        expect(status).toBe("malformed");
        expect(source).toBe("none");
    });

    it("skips GHCR and reads the branch when no registry can be derived", async () => {
        let pullCalls = 0;
        const reader = createDeployStatusReader({
            repo: "acme/app",
            environment: "",
            app: "",
            stateRegistry: "",
            pullArtifact: async () => { pullCalls++; return null; },
            getBranchContent: async () => Buffer.from('{"resources":[]}'),
        });
        const { status, source } = await reader.graph();
        expect(status).toBe("unconfigured");
        expect(source).toBe("branch");
        expect(pullCalls).toBe(0);
    });

    it("caches the pull within the TTL window (single flight)", async () => {
        let pulls = 0;
        const reader = createDeployStatusReader({
            ...READER_BASE,
            ttlMs: 10000,
            now: () => 1000,
            pullArtifact: async () => { pulls++; return { files: { "deploy-graph.json": "[]" } }; },
            getBranchContent: async () => null,
        });
        await Promise.all([reader.pull(), reader.pull(), reader.graph()]);
        await reader.pull();
        expect(pulls).toBe(1);
    });
});
