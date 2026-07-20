// Tests for the server-side HTML page renderers. Focus: the recipe-pack
// refactor removed all singleton-recipe / on-demand-bicep UI, and app.bicep is
// now authored solely by the Radius app-bicep skill. These tests assert the
// changed pages surface the skill/needsAppBicep messaging and no longer emit
// the removed generated-bicep state, while smoke-rendering every page so the
// module's branches stay exercised.

import { describe, it, expect } from "vitest";
import {
    pageShell,
    oidcPage,
    graphHeader,
    graphHeaderClose,
    graphPage,
    plannedGraphPage,
    graphDiffPage,
    deployedGraphPage,
    environmentPage,
    deployingPage,
} from "./pages.mjs";

const REMOVED_TOKENS = ["bicepGenerated", "generatedWarning", "defGenerated", "/generated-bicep"];
const sampleResources = [
    { id: "app/web", name: "web", type: "Applications.Core/containers", connections: [] },
];

describe("pageShell", () => {
    it("wraps body content in an HTML document with the title", () => {
        const html = pageShell("My Title", "<p>hello</p>");
        expect(html).toContain("<!doctype html>");
        expect(html).toContain("My Title — Radius");
        expect(html).toContain("<p>hello</p>");
    });
});

describe("graphHeader / graphHeaderClose", () => {
    it("renders the nav header and matching close markup", () => {
        expect(graphHeader("graph")).toContain("<");
        expect(graphHeaderClose()).toContain("<");
    });
});

describe("graphPage — empty resources (initial) branch", () => {
    const html = graphPage({ contextRepo: "octo/app", contextBranch: "dev" });

    it("posts to /api/load-graph and reacts to reload/error only", () => {
        expect(html).toContain("/api/load-graph");
        expect(html).toContain("d.reload");
        expect(html).toContain("d.error");
    });

    it("emits none of the removed generated-bicep tokens", () => {
        for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
    });
});

describe("graphPage — with resources branch", () => {
    const html = graphPage({
        graphResources: sampleResources,
        graphTargetRepo: "octo/app",
        graphBranch: "main",
    });

    it("handles needsAppBicep and error from /api/load-graph", () => {
        expect(html).toContain("d.needsAppBicep");
        expect(html).toContain("Error: ");
        expect(html).toContain("Radius app-bicep skill");
    });

    it("renders the graph via radiusRenderGraph with the serialized resources", () => {
        expect(html).toContain("radiusRenderGraph");
        expect(html).toContain("Applications.Core/containers");
    });

    it("emits none of the removed generated-bicep tokens", () => {
        for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
    });
});

describe("graphPage — localSource provenance flag", () => {
    it("passes localSource:true when the graph is the local workspace selection", () => {
        const html = graphPage({
            graphResources: sampleResources,
            graphTargetRepo: "octo/app",
            graphBranch: "feature-x",
            workspacePath: "/work/tree",
            workspaceRepo: "octo/app",
            workspaceBranch: "feature-x",
        });
        expect(html).toContain("localSource: true");
    });

    it("passes localSource:false for a remote/non-workspace selection", () => {
        const html = graphPage({
            graphResources: sampleResources,
            graphTargetRepo: "octo/app",
            graphBranch: "main",
        });
        expect(html).toContain("localSource: false");
    });
});

describe("plannedGraphPage", () => {
    it("passes localSource:true for the local workspace planned graph", () => {
        const html = plannedGraphPage({
            plannedResources: sampleResources,
            plannedRepo: "octo/app",
            plannedBranch: "feature-x",
            workspacePath: "/work/tree",
            workspaceRepo: "octo/app",
            workspaceBranch: "feature-x",
        });
        expect(html).toContain("localSource: true");
    });

    it("renders the empty (plan) branch with no removed tokens", () => {
        const html = plannedGraphPage({ contextRepo: "octo/app", contextBranch: "main" });
        expect(html).toContain("Plan Deployment");
        for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
    });

    it("renders the with-resources branch with no removed tokens", () => {
        const html = plannedGraphPage({ plannedResources: sampleResources, plannedRepo: "octo/app" });
        expect(typeof html).toBe("string");
        for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
    });
});

describe("environmentPage — Credentials/Profiles restructure", () => {
    it("renders Environments and Credentials subtabs", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain('data-subtab="environments"');
        expect(html).toContain('data-subtab="credentials"');
    });

    it("activates the Credentials subtab when state.activeSubtab is 'credentials'", () => {
        const html = environmentPage({ contextRepo: "octo/app", activeSubtab: "credentials" });
        // The active pane is the one NOT display:none'd.
        expect(html).toContain('id="pane-credentials"');
        expect(html).toContain("Create Credential Profile");
    });

    it("drives environment creation from a saved credential profile, not inline tenant/sub", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain('id="env-profile-select"');
        expect(html).toContain("/api/credential-profiles");
        expect(html).toContain("/api/save-credential-profile");
        // The old inline provider picker was removed from the env-create form.
        expect(html).not.toContain('id="env-provider-select"');
    });
});

describe("remaining pages smoke-render without removed tokens", () => {
    const cases = [
        ["oidcPage", () => oidcPage({ provider: "azure" }), () => oidcPage({})],
        ["graphDiffPage", () => graphDiffPage({ branches: ["main", "dev"], branchShas: { main: "abcdef1234567" }, diffBase: "main", diffHead: "dev" }), () => graphDiffPage({ diffResources: sampleResources })],
        ["deployedGraphPage", () => deployedGraphPage({ deployedResources: sampleResources }), () => deployedGraphPage({})],
        ["environmentPage empty", () => environmentPage({}), () => environmentPage(undefined)],
        ["environmentPage result", () => environmentPage({ deployResult: { message: "ok", workflowUrl: "https://x" } }), null],
        ["environmentPage error", () => environmentPage({ deployResult: { error: "boom" } }), null],
        ["deployingPage", () => deployingPage({ deployRepo: "octo/app" }), () => deployingPage({})],
    ];

    for (const [name, primary, secondary] of cases) {
        it(`${name} renders a string with no removed tokens`, () => {
            const html = primary();
            expect(typeof html).toBe("string");
            expect(html.length).toBeGreaterThan(0);
            for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
            if (secondary) expect(typeof secondary()).toBe("string");
        });
    }
});
