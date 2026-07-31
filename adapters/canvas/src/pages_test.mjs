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

    it("inherits the Copilot host theme without creating Radius-owned theme state", () => {
        const html = pageShell("My Title", "<p>hello</p>");
        expect(html).toContain("color-scheme: var(--color-scheme, inherit)");
        expect(html).toContain("--rad-bg: var(--background-color-default, Canvas)");
        expect(html).toContain("--rad-text: var(--text-color-default, CanvasText)");
        expect(html).toContain("--rad-bg-subtle: color-mix(in srgb, var(--rad-text) 6%, var(--rad-bg))");
        expect(html).toContain("--rad-neutral-bg: var(--rad-bg-subtle)");
        expect(html).toContain("--rad-node-bg: var(--rad-surface)");
        expect(html).toContain("--rad-success: var(--text-color-success");
        expect(html).toContain("--rad-warning: var(--text-color-warning");
        expect(html).toContain("--rad-danger: var(--text-color-danger");
        expect(html).not.toContain("localStorage");
        expect(html).not.toContain("matchMedia");
        expect(html).not.toContain("prefers-color-scheme");
        expect(html).not.toContain("--rad-bg-subtle: var(--background-color-segmented");
        expect(html).not.toContain("--rad-neutral-bg: var(--background-color-segmented");
    });

    it("keeps React Flow chrome transparent over the themed graph surface", () => {
        const html = pageShell("My Title", "<div id=\"graph-container\"></div>");
        const flowStyles = html.match(/\.react-flow, \.react-flow__renderer, \.react-flow__pane\s*\{([^}]*)\}/)?.[1];
        expect(flowStyles).toContain("background: transparent");
    });

    it("excludes radio and checkbox inputs from the 100%-width form-field rule", () => {
        // The app-registration picker builds each option as a flex row of
        // [radio][text]. A bare `input` selector in the width:100% rule stretches
        // the radio to fill the row and shoves the label text far to the right
        // (see the empty GITHUB-card style regression). The width rule must skip
        // radios/checkboxes so they keep their intrinsic size.
        const html = pageShell("My Title", "<p>hello</p>");
        expect(html).toContain('input:not([type="radio"]):not([type="checkbox"]), select, .rad-select {');
        // The bare selector (which would balloon the radio) must be gone.
        expect(html).not.toMatch(/\n\s*input, select, \.rad-select \{/);
    });

    it("constrains graph type labels to the node card width", () => {
        const html = pageShell("My Title", "<p>hello</p>");
        const typeStyles = html.match(/\.rad-node__type\s*\{([^}]*)\}/)?.[1];
        expect(typeStyles).toContain("width: 100%");
        expect(typeStyles).toContain("overflow: hidden");
        expect(typeStyles).toContain("white-space: nowrap");
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

    it("refreshes the modeled graph from app.bicep when the panel reloads", () => {
        expect(html).toContain("refresh: true");
        expect(html).toContain("graphController = graphController.update(d.resources) || graphController");
        expect(html).toContain("Unable to refresh the application graph");
    });

    it("shows automatic app.bicep regeneration as progress rather than an error", () => {
        expect(html).toContain("d.needsAppBicep");
        expect(html).toContain("generatingStatus.className = 'status info'");
        expect(html).toContain("Copilot is rebuilding the application graph");
    });

    it("emits none of the removed generated-bicep tokens", () => {
        for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
    });

    describe("graphPage — successfully loaded empty graph", () => {
        it("renders an empty graph instead of returning to the generate prompt", () => {
            const html = graphPage({
                graphLoaded: true,
                graphResources: [],
                graphTargetRepo: "octo/app",
                graphBranch: "main",
            });
            expect(html).toContain("var resources = [];");
            expect(html).toContain("radiusRenderGraph('graph-container', resources");
            expect(html).not.toContain("Select a branch to generate the application graph");
        });
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
        // The "Serves:" label is lazy-loaded per app so the picker renders
        // immediately instead of blocking on one az FIC-list per owned app.
        expect(html).toContain("/api/azure-app-serves-repos?appId=");
        expect(html).toContain("servesSlots");
        expect(html).toContain("loadServesLabels");
    });

    it("uses semantic theme tokens throughout environment modal content", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain('id="env-smr-modal"');
        expect(html).toContain('id="env-appselect-modal"');
        expect(html).toContain("box-shadow:0 8px 30px var(--rad-shadow)");
        for (const legacyToken of [
            "var(--background-color-default,#fff)",
            "var(--text-color-default,#1f2328)",
            "var(--text-color-muted,#656d76)",
            "var(--border-color-muted,#d8dee4)",
        ]) {
            expect(html).not.toContain(legacyToken);
        }
        expect(html).not.toContain("box-shadow:0 8px 30px rgba(");
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
        // both hitting the cache-busting fresh=1 identity endpoint (now carrying
        // ?repo so the server folds in the repo admin preflight).
        expect(html).toContain('id="env-gh-recheck"');
        expect(html).toContain("'/api/github-identity?repo=' + encodeURIComponent(CTX_REPO");
        expect(html).toContain("idUrl += '&fresh=1'");
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

    it("links the Azure RG and cluster dropdowns and sorts discovered resources (Nicole regression)", () => {
        // Regression: the cluster dropdown listed every AKS cluster regardless of
        // the selected resource group, the two dropdowns were not linked RG->cluster,
        // and neither list was sorted. Discovery now sorts clusters/RGs/namespaces,
        // filters the cluster list to the selected RG, and keeps the cluster->RG
        // back-fill so the two stay linked both ways.
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain("function sortByName(");
        expect(html).toContain("function renderAzureClusters(");
        expect(html).toContain("window.__azureClusters = sortByName(data.clusters || [])");
        expect(html).toContain("populateSelect('azure-rg-select', sortByName(data.resourceGroups || [])");
        expect(html).toContain("populateSelect('azure-namespace-select', sortByName(");
        // Selecting a resource group filters the cluster list to that RG.
        expect(html).toContain("if ((all[i].resourceGroup || '') === rg) filtered.push(all[i])");
        // Selecting a cluster still back-fills its resource group (bidirectional link).
        expect(html).toContain("rgSel.value = cluster.resourceGroup;");
    });


    it("always sends appName on create so explicit-empty is server-detectable", () => {
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain("params.appName !== undefined");
    });

    it("surfaces repo admin access at open: fetches identity with ?repo and renders repoAccess", () => {
        // Comment #9: the repo admin preflight was submit-only, so a write/maintain
        // developer only hit the 403 after filling the whole form. The client now
        // passes its repo to /api/github-identity so the server folds the preflight
        // in, and renders the returned repoAccess message in the account note — an
        // early, additive heads-up beside the account it concerns.
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain("'/api/github-identity?repo=' + encodeURIComponent(CTX_REPO");
        expect(html).toContain("if (id.repoAccess)");
        // A successful account switch must re-run the preflight for the new
        // account (the switch response carries no repoAccess), so the switch
        // handler re-loads identity rather than trusting res.d.identity.
        expect(html).toContain("loadGitHubIdentity(true);");
    });

    it("single-sources the tested azure-oidc helpers into the client via .toString() (no hand-copied twins)", () => {
        // Comment #10: formatServesReposLabel / discoverStatusText were duplicated
        // as untested browser copies. They are now serialized from azure-oidc.mjs
        // into the client bundle, so the shipping client runs the exact tested
        // code and the call sites reference the real functions.
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).toContain("function formatServesReposLabel(");
        expect(html).toContain("function discoverStatusText(");
        expect(html).toContain("discoverStatusText(data, 'azure')");
        expect(html).toContain("discoverStatusText(data, 'aws')");
        expect(html).toContain("formatServesReposLabel(serves)");
        // The hand-copied twins must be gone.
        expect(html).not.toContain("formatServesReposLabelClient");
    });

    it("emits only syntactically valid client <script> blocks (init-halt guard)", () => {
        // The client scripts live inside a template literal, so an escaped
        // apostrophe (\\') un-escapes to a raw ' in the emitted JS and breaks a
        // single-quoted string, halting page init so the tables never load.
        // Parse every emitted script with new Function to catch that class of bug
        // at build time without executing it.
        const html = environmentPage({ contextRepo: "octo/app" });
        const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        expect(scripts.length).toBeGreaterThan(0);
        for (const src of scripts) {
            expect(() => new Function(src)).not.toThrow();
        }
    });

    it("never references the undeclared CONTEXT_REPO — this page's repo var is CTX_REPO", () => {
        // Regression: loadGitHubIdentity was pasted with `CONTEXT_REPO`, an
        // identifier declared in OTHER page scripts (graph/diff pages) but never
        // in environmentPage — this page declares `var CTX_REPO`. At runtime that
        // read throws `ReferenceError: CONTEXT_REPO is not defined`, halting
        // showEnvForm before the GitHub account field loads, so the GITHUB card
        // renders empty. The compile-only init-halt guard can't catch an
        // undeclared free variable, so assert the identifier never appears here.
        const html = environmentPage({ contextRepo: "octo/app" });
        expect(html).not.toContain("CONTEXT_REPO");
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

describe("graphDiffPage — comparison errors", () => {
    it.each([{ diffResources: [] }, { diffResources: sampleResources }])("surfaces an automatic comparison failure with existing resources: $diffResources", ({ diffResources }) => {
        const html = graphDiffPage({
            diffError: "Unable to compile head graph",
            diffResources,
            diffTargetRepo: "octo/app",
            diffBase: "main",
            diffHead: "feature",
        });
        expect(html).toContain("Unable to compile head graph");
        expect(html).toContain('class="status error"');
    });
});

describe("deployedGraphPage", () => {
    it("uses resolved concrete labels with planned topology and solid lines", () => {
        const html = deployedGraphPage({ contextRepo: "octo/app" });
        const renderGraph = html.match(/function renderGraph\(resources, showDeployStatus\) \{([\s\S]*?)\n    \}/)?.[1];
        expect(renderGraph).toContain("deployedMode: !showDeployStatus");
        expect(renderGraph).toContain("deployMode: !!showDeployStatus");
    });

    it("renders terminal failed resources with deployment status styling", () => {
        const html = deployedGraphPage({ contextRepo: "octo/app" });
        expect(html).toContain("st === 'failed'");
        expect(html).toContain("renderGraph(liveRes, true)");
        expect(html).toContain("renderGraph(resources, false)");
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

    it("does not render known light-only component surfaces", () => {
        const html = cases.flatMap(([, primary, secondary]) => [primary(), secondary?.() || ""]).join("\n");
        for (const literal of [
            "#ffebe9",
            "#ddf4ff",
            "#82071e",
            "#0a3069",
            "#54aeff",
            "#1e1e1e",
            "#edfaed",
            "#fff5b1",
            "#d73a49",
            "#b31d28",
        ]) {
            expect(html).not.toContain(literal);
        }
    });

    it("uses semantic danger tokens for delete button states", () => {
        const html = deployingPage({ deployRepo: "octo/app" });
        expect(html).toContain(".rad-ddlg__delete {");
        expect(html).toContain("background:var(--rad-danger-solid)");
        expect(html).toContain(".rad-ddlg__delete:hover { background:var(--rad-danger-solid-border); }");
        expect(html).not.toContain(".rad-ddlg__delete:hover { background:#b31d28; }");
    });

    it("references no --rad-* token that pageShell does not define", () => {
        // A var(--rad-foo, <fallback>) whose token is never defined silently
        // paints its light-only fallback in every theme (e.g. the --rad-muted
        // regression). Guard every page against undefined --rad-* references.
        const shell = pageShell("t", "");
        const defined = new Set([...shell.matchAll(/(--rad-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
        const html = cases.flatMap(([, primary, secondary]) => [primary(), secondary?.() || ""]).join("\n");
        const referenced = new Set([...html.matchAll(/var\((--rad-[a-z0-9-]+)/g)].map((m) => m[1]));
        const undefinedTokens = [...referenced].filter((t) => !defined.has(t));
        expect(undefinedTokens).toEqual([]);
    });
});
