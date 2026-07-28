// Tests for the server-side HTML page renderers. Focus: the recipe-pack
// refactor removed all singleton-recipe / on-demand-bicep UI, and app.bicep is
// now authored solely by the Radius app-bicep skill. These tests assert the
// changed pages surface the skill/needsAppBicep messaging and no longer emit
// the removed generated-bicep state, while smoke-rendering every page so the
// module's branches stay exercised.

import { describe, it, expect } from "vitest";
import vm from "node:vm";
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

    it("previews feedback link destinations in native tooltips", () => {
        const html = pageShell("My Title", "<p>hello</p>");
        expect(html).toContain('title="https://github.com/radius-project/ai-extensions/issues/new?template=feedback-or-bug-report.yml"');
        expect(html).toContain('title="https://radapp.io"');
    });

    it("renders larger top-navigation icons without a border or filled background", () => {
        const html = pageShell("My Title", "<p>hello</p>");
        const iconStyles = html.match(/\.rad-topnav__icon\s*\{([^}]*)\}/)?.[1];
        expect(html).toContain("width:28px;height:28px");
        expect(iconStyles).toContain("background: transparent");
        expect(iconStyles).not.toContain("border:");
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

    it("honors the persisted graphFromWorkspace:false even when repo+branch match", () => {
        const html = graphPage({
            graphResources: sampleResources,
            graphTargetRepo: "octo/app",
            graphBranch: "feature-x",
            workspacePath: "/work/tree",
            workspaceRepo: "octo/app",
            workspaceBranch: "feature-x",
            graphFromWorkspace: false,
        });
        expect(html).toContain("localSource: false");
    });

    it("honors the persisted graphFromWorkspace:true", () => {
        const html = graphPage({
            graphResources: sampleResources,
            graphTargetRepo: "octo/app",
            graphBranch: "main",
            graphFromWorkspace: true,
        });
        expect(html).toContain("localSource: true");
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

    it("honors the persisted plannedFromWorkspace:false even when repo+branch match", () => {
        const html = plannedGraphPage({
            plannedResources: sampleResources,
            plannedRepo: "octo/app",
            plannedBranch: "feature-x",
            workspacePath: "/work/tree",
            workspaceRepo: "octo/app",
            workspaceBranch: "feature-x",
            plannedFromWorkspace: false,
        });
        expect(html).toContain("localSource: false");
    });

    it("renders the empty (plan) branch with no removed tokens", () => {
        const html = plannedGraphPage({ contextRepo: "octo/app", contextBranch: "main" });
        expect(html).toContain("Plan Deployment");
        expect(html).toContain("radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH)");
        for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
    });

    it("renders the with-resources branch with no removed tokens", () => {
        const html = plannedGraphPage({ plannedResources: sampleResources, plannedRepo: "octo/app" });
        expect(typeof html).toBe("string");
        expect(html).toContain("plannedMode: true");
        expect(html).not.toContain("Cloud Resource");
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

    it("progressively discloses a Service Management Reference input and retries with it", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // The SMR modal + input are present but hidden by default (no field on
        // first submit).
        expect(html).toContain('id="env-smr-modal"');
        expect(html).toContain('id="env-smr-input"');
        expect(html).toContain("Service Management Reference");
        expect(html).toContain("Service Tree ID GUID");
        // The client reacts to the machine-readable code and forwards the value.
        expect(html).toContain("service-management-reference-required");
        expect(html).toContain("serviceManagementReference");
        expect(html).toContain("runAzureAutoSetupInteractive");
    });

    it("renders the app-registration picker + editable name + use-existing action", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Editable deploy-identity name prefilled from the repo.
        expect(html).toContain('id="az-app-name-input"');
        expect(html).toContain("radius-deploy-octo-app");
        // Opt-in cross-repo "use existing" advanced action + its endpoint.
        expect(html).toContain('id="az-use-existing-link"');
        expect(html).toContain("/api/list-azure-app-registrations");
        // Duplicate/selection picker modal + its machine-readable trigger code.
        expect(html).toContain('id="env-appselect-modal"');
        expect(html).toContain("app-selection-required");
        expect(html).toContain("showAppPicker");
    });

    it("leads the deploy-identity field copy with its purpose (Round 11A / four-step redesign)", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Step 3 header + provider-federated app registration copy.
        expect(html).toContain("3 · Deploy identity");
        expect(html).toContain("Azure app registration");
        expect(html).toContain("The Microsoft Entra app GitHub Actions signs in as");
        expect(html).toContain("no stored secrets");
    });

    it("discloses both role grants (Contributor + AKS Cluster Admin) at consent", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Setup grants two roles; both the deploy-identity field help and the
        // profile-detail line must name the AKS Cluster Admin grant, not just
        // Contributor, so the privilege is disclosed before the user proceeds.
        expect(html).toContain("Azure Kubernetes Service RBAC Cluster Admin");
        expect(html).toContain("the default for AKS Automatic");
        expect(html).toContain("AKS RBAC Cluster Admin on the cluster");
    });

    it("wires the New Environment button to open the env form (regression guard)", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // d97b6d1 accidentally dropped this handler when the use-existing IIFE was
        // inserted, leaving #new-env-btn dead. Assert the exact wiring so a future
        // deletion of the primary entry point fails the suite.
        expect(html).toContain("getElementById('new-env-btn')");
        expect(html).toMatch(/getElementById\('new-env-btn'\)\.addEventListener\('click',\s*function\(\)\s*\{\s*showEnvForm/);
    });

    it("makes the shared-identity pin reversible and reset on context change", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Hidden pin + note + explicit reversal affordance.
        expect(html).toContain('id="az-selected-app-id"');
        expect(html).toContain('id="az-selected-app-note"');
        expect(html).toContain('id="az-clear-pin-link"');
        // Central reset helper is defined and called from both the fresh-form and
        // profile-change paths so a stale pin can't leak into the wrong context.
        expect(html).toContain("function clearSharedAppPin");
        expect(html).toMatch(/clearSharedAppPin\(\)/);
    });

    it("re-syncs the profile combo when returning to an open env form (stale-profile regression)", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Repro: open the env form, use the combo's "+ Create new profile" action
        // to add a profile on the Credentials subtab, then switch back to
        // Environments. switchSubtab() must refresh the combo (preserving the
        // current selection) so the new profile appears without a full canvas
        // reload — but only while the form is visible, so discovery doesn't fire
        // on the hidden landing view.
        expect(html).toMatch(/if\s*\(envForm\s*&&\s*envForm\.style\.display\s*!==\s*'none'\)\s*loadProfilesIntoEnvSelect\(envProfileSelect\.value\)/);
    });

    it("surfaces the write:packages scope in the account picker and identity warning", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Per-account label flags a missing packages scope (sibling of the
        // existing workflow-scope flag).
        expect(html).toContain("missing ");
        expect(html).toContain("hasPackages");
        expect(html).toContain("actingHasPackages");
        // The identity warning builds the concrete refresh command including
        // read:packages + write:packages when the acting account lacks it.
        expect(html).toContain("read:packages");
        expect(html).toContain("write:packages");
        // Default (non-warning) note names both scopes setup needs.
        expect(html).toContain("<code>write:packages</code>");
        // `gh auth refresh` has NO --user flag, so the remediation must first
        // `gh auth switch -u <login>` and then run a bare `gh auth refresh`.
        // Guard against regressing to `gh auth refresh ... -u <login>`, which
        // errors with "unknown shorthand flag: 'u'".
        expect(html).toContain("gh auth switch -h github.com -u ");
        expect(html).toContain("gh auth refresh -h github.com");
        expect(html).not.toMatch(/gh auth refresh[^'"`]*-u /);
        // After running the command out-of-band the UX must be able to detect the
        // change: a manual Re-check button plus an auto re-check on window refocus,
        // both hitting the cache-busting ?fresh=1 identity endpoint.
        expect(html).toContain('id="env-gh-recheck"');
        expect(html).toContain("'/api/github-identity' + (fresh ? '?fresh=1' : '')");
        expect(html).toContain("visibilitychange");
        expect(html).toContain("window.addEventListener('focus', envGhAutoRecheck)");
    });

    it("scopes the AKS grant to the cluster's own resource group and surfaces setup warnings on success", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // The cluster's own RG (from discovery) is sent independently of the
        // editable deployment RG combo, so the server scopes AKS Cluster Admin to
        // the cluster's real path even when the deployment RG differs.
        expect(html).toContain("function findAzureClusterResourceGroup(");
        expect(html).toContain("clusterResourceGroup = findAzureClusterResourceGroup(cluster)");
        expect(html).toContain("clusterResourceGroup: clusterResourceGroup");
        expect(html).toContain("payload.clusterResourceGroup = params.clusterResourceGroup");
        // The auto-setup step log (incl. the best-effort AKS warning) is surfaced
        // on the SUCCESS path, not just swallowed into the error message.
        expect(html).toContain("function showEnvSetupWarnings(");
        expect(html).toContain("preflight.then(function(setupResult)");
        expect(html).toContain("showEnvSetupWarnings(setupSteps)");
        expect(html).toContain('id="env-warning-banner"');
    });

    it("always sends appName on create so explicit-empty is server-detectable", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        // Omitted vs explicit-blank must be distinguishable server-side.
        expect(html).toContain("params.appName !== undefined");
    });

    it("emits only syntactically valid client <script> blocks (init-halt guard)", () => {
        // The client scripts live inside a template literal, so an escaped
        // apostrophe (\\') un-escapes to a raw ' in the emitted JS and breaks a
        // single-quoted string, halting page init so the tables never load.
        // Compile every emitted script to catch that class of bug at build time.
        const html = environmentPage({ contextRepo: "octo/app" });
        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        expect(scripts.length).toBeGreaterThan(0);
        for (const src of scripts) {
            expect(() => new vm.Script(src)).not.toThrow();
        }
    });
});

describe("graphDiffPage — passes repo/branch context so source links + popup work (not just diffMode)", () => {
    it("passes repoUrl, branch (head), and baseBranch to radiusRenderGraph so buildSourceUrl doesn't short-circuit on missing repoUrl", () => {
        const html = graphDiffPage({
            diffResources: sampleResources,
            diffBase: "main",
            diffHead: "feature",
            diffTargetRepo: "octo/app",
        });
        expect(html).toContain("radiusRenderGraph('graph-container', resources, {");
        expect(html).toContain("diffMode: true");
        expect(html).toContain("repoUrl: DIFF_REPO_URL");
        expect(html).toContain("branch: 'feature'");
        expect(html).toContain("baseBranch: 'main'");
        expect(html).toContain("var DIFF_REPO_URL = 'https://github.com/' + document.getElementById('diff-repo-select').value.trim();");
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
