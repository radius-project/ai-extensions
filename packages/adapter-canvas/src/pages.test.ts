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
  serializeBrowserFunction
} from "./pages.js";

const REMOVED_TOKENS = [
  "bicepGenerated",
  "generatedWarning",
  "defGenerated",
  "/generated-bicep"
];
const sampleResources = [
  {
    id: "app/web",
    name: "web",
    type: "Applications.Core/containers",
    connections: []
  }
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
    expect(html).toContain(
      'title="https://github.com/radius-project/ai-extensions/issues/new?template=feedback-or-bug-report.yml"'
    );
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
    expect(html).toContain(
      "--rad-bg-subtle: color-mix(in srgb, var(--rad-text) 6%, var(--rad-bg))"
    );
    expect(html).toContain("--rad-neutral-bg: var(--rad-bg-subtle)");
    expect(html).toContain("--rad-node-bg: var(--rad-surface)");
    expect(html).toContain("--rad-success: var(--text-color-success");
    expect(html).toContain("--rad-warning: var(--text-color-warning");
    expect(html).toContain("--rad-danger: var(--text-color-danger");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("matchMedia");
    expect(html).not.toContain("prefers-color-scheme");
    expect(html).not.toContain(
      "--rad-bg-subtle: var(--background-color-segmented"
    );
    expect(html).not.toContain(
      "--rad-neutral-bg: var(--background-color-segmented"
    );
  });

  it("keeps React Flow chrome transparent over the themed graph surface", () => {
    const html = pageShell("My Title", '<div id="graph-container"></div>');
    const flowStyles = html.match(
      /\.react-flow, \.react-flow__renderer, \.react-flow__pane\s*\{([^}]*)\}/
    )?.[1];
    expect(flowStyles).toContain("background: transparent");
  });

  it("excludes radio and checkbox inputs from the 100%-width form-field rule", () => {
    // The app-registration picker builds each option as a flex row of
    // [radio][text]. A bare `input` selector in the width:100% rule stretches
    // the radio to fill the row and shoves the label text far to the right
    // (see the empty GITHUB-card style regression). The width rule must skip
    // radios/checkboxes so they keep their intrinsic size.
    const html = pageShell("My Title", "<p>hello</p>");
    expect(html).toContain(
      'input:not([type="radio"]):not([type="checkbox"]), select, .rad-select {'
    );
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

  it("posts to /api/load-graph and keeps retrying while app.bicep is being generated", () => {
    expect(html).toContain("/api/load-graph");
    expect(html).toContain("requestGraphLoad()");
    expect(html).toContain("window.radiusGraphRetryTimer");
    expect(html).toContain("d.reload");
    expect(html).toContain("d.stale");
    expect(html).toContain("scheduleGraphRetry(1000)");
    expect(html).toContain("d.error");
  });

  it("ignores stale callbacks and progress updates after the run finishes", () => {
    expect(html).toContain("var graphRunFinished = false");
    expect(html).toContain(
      "window.radiusGraphRunToken !== graphRunToken || graphRunFinished"
    );
    expect(html).toContain(
      "window.radiusGraphRunToken !== graphRunToken || !graphRunFinished"
    );
  });

  it("renders a staged progress bar with duration guidance and terminal states", () => {
    expect(html).toContain('id="progress-stage"');
    expect(html).toContain('id="progress-percent"');
    expect(html).toContain('id="progress-bar-fill"');
    expect(html).toContain('id="progress-eta"');
    expect(html).toContain("Usually completes in about 5 minutes.");
    expect(html).toContain(
      "Still running — complex repositories can take a little longer than 5 minutes."
    );
    expect(html).toContain("Application graph generated successfully.");
    expect(html).toContain("Graph generation failed");
  });

  it("emits none of the removed generated-bicep tokens", () => {
    for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
  });
});

describe("graphPage — with resources branch", () => {
  const html = graphPage({
    graphResources: sampleResources,
    graphTargetRepo: "octo/app",
    graphBranch: "main"
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
    expect(html).toContain(
      "graphController = graphController.update(d.resources) || graphController"
    );
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
        graphBranch: "main"
      });
      expect(html).toContain("var resources = [];");
      expect(html).toContain("radiusRenderGraph('graph-container', resources");
      expect(html).not.toContain(
        "Select a branch to generate the application graph"
      );
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
      workspaceBranch: "feature-x"
    });
    expect(html).toContain("localSource: true");
  });

  it("passes localSource:false for a remote/non-workspace selection", () => {
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: "octo/app",
      graphBranch: "main"
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
      graphFromWorkspace: false
    });
    expect(html).toContain("localSource: false");
  });

  it("honors the persisted graphFromWorkspace:true", () => {
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: "octo/app",
      graphBranch: "main",
      graphFromWorkspace: true
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
      workspaceBranch: "feature-x"
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
      plannedFromWorkspace: false
    });
    expect(html).toContain("localSource: false");
  });

  it("renders the empty (plan) branch with no removed tokens", () => {
    const html = plannedGraphPage({
      contextRepo: "octo/app",
      contextBranch: "main"
    });
    expect(html).toContain("Plan Deployment");
    expect(html).toContain(
      "radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH)"
    );
    for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
  });

  it("renders the with-resources branch with no removed tokens", () => {
    const html = plannedGraphPage({
      plannedResources: sampleResources,
      plannedRepo: "octo/app"
    });
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
    const html = environmentPage({
      contextRepo: "octo/app",
      activeSubtab: "credentials"
    });
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

  it("keeps interactive prompt errors separate from cleanup narration", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("err.steps = data.steps");
    expect(html).toContain("err.cleanup = data.cleanup");
    expect(html).not.toContain("data.steps.join('; ')");
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
      "var(--border-color-muted,#d8dee4)"
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
    expect(html).toContain(
      "The Microsoft Entra app GitHub Actions signs in as"
    );
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
    expect(html).toMatch(
      /getElementById\('new-env-btn'\)\.addEventListener\('click',\s*function\(\)\s*\{\s*showEnvForm/
    );
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
    expect(html).toContain('data-default-name="radius-deploy-octo-app"');
    expect(html).toContain(
      "nameEl.value = (picked && picked.displayName) || choice.appId"
    );
    expect(html).toContain(
      "nameEl.value = nameEl.getAttribute('data-default-name') || ''"
    );
  });

  it("re-syncs the profile combo when returning to an open env form (stale-profile regression)", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    // Repro: open the env form, use the combo's "+ Create new profile" action
    // to add a profile on the Credentials subtab, then switch back to
    // Environments. switchSubtab() must refresh the combo (preserving the
    // current selection) so the new profile appears without a full canvas
    // reload — but only while the form is visible, so discovery doesn't fire
    // on the hidden landing view.
    expect(html).toMatch(
      /if\s*\(envForm\s*&&\s*envForm\.style\.display\s*!==\s*'none'\)\s*loadProfilesIntoEnvSelect\(envProfileSelect\.value\)/
    );
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
    expect(html).toContain(
      "'/api/github-identity?repo=' + encodeURIComponent(CTX_REPO"
    );
    expect(html).toContain("idUrl += '&fresh=1'");
    expect(html).toContain("visibilitychange");
    expect(html).toContain(
      "window.addEventListener('focus', envGhAutoRecheck)"
    );
  });

  it("gates credential profiles on GitHub Packages access with explicit remediation", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="cred-ghcr-section"');
    expect(html).toContain('id="cred-ghcr-command"');
    expect(html).toContain('id="cred-ghcr-copy"');
    expect(html).toContain('id="cred-ghcr-retry"');
    expect(html).toContain("I’ve updated permissions — retry");
    expect(html).toContain(
      "' && gh auth refresh -h github.com -s read:packages -s write:packages'"
    );
    expect(html).toContain("function loadCredGitHubAccess(fresh)");
    expect(html).toContain(
      "'/api/github-identity' + (fresh ? '?fresh=1' : '')"
    );
    expect(html).toContain(
      "document.getElementById('save-cred-btn').disabled = !(credVerified && credPackagesVerified)"
    );
    expect(html).toContain("navigator.clipboard.writeText(command)");
  });

  it("scopes the AKS grant to the cluster's own resource group and surfaces setup warnings on success", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    // The cluster's own RG (from discovery) is sent independently of the
    // editable deployment RG combo, so the server scopes AKS Cluster Admin to
    // the cluster's real path even when the deployment RG differs.
    expect(html).toContain("function findAzureClusterResourceGroup(");
    expect(html).toContain(
      "clusterResourceGroup = findAzureClusterResourceGroup(cluster)"
    );
    expect(html).toContain("clusterResourceGroup: clusterResourceGroup");
    expect(html).toContain(
      "payload.clusterResourceGroup = params.clusterResourceGroup"
    );
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
    expect(html).toContain(
      "window.__azureClusters = sortByName(data.clusters || [])"
    );
    expect(html).toContain(
      "populateSelect('azure-rg-select', sortByName(data.resourceGroups || [])"
    );
    expect(html).toContain(
      "populateSelect('azure-namespace-select', sortByName("
    );
    // Selecting a resource group filters the cluster list to that RG.
    expect(html).toContain(
      "if ((all[i].resourceGroup || '') === rg) filtered.push(all[i])"
    );
    // Selecting a cluster still back-fills its resource group (bidirectional link).
    expect(html).toContain("rgSel.value = cluster.resourceGroup;");
  });

  it("always sends appName on create so explicit-empty is server-detectable", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("params.appName !== undefined");
  });

  it("requires in-canvas consent before asking Copilot to start Azure login", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="azure-cli-assist-modal"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("data.code === 'az-login-required'");
    expect(html).toContain(
      "showAzureCliAssistPrompt('login', data.tenantId || tenantId, data.error)"
    );
    expect(html).toContain(
      "document.getElementById('azure-cli-assist-confirm').addEventListener('click'"
    );
    expect(html).not.toContain("confirm('No active Azure session.");
    expect(html).toContain("/api/azure-cli-assist");
    expect(html).toContain("fallbackMessage ? ' ' + fallbackMessage : ''");
  });

  it("requires in-canvas consent before asking Copilot to install Azure CLI", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("data.code === 'az-cli-missing'");
    expect(html).toContain(
      "showAzureCliAssistPrompt('install', data.tenantId || tenantId, data.error)"
    );
    expect(html).toContain(
      "Would you like Copilot to attempt to install it and then start Azure login?"
    );
    expect(html).toContain("Ask Copilot to install");
    expect(html).not.toContain("confirm('Azure CLI is not installed.");
  });

  it("surfaces repo admin access at open: fetches identity with ?repo and renders repoAccess", () => {
    // Comment #9: the repo admin preflight was submit-only, so a write/maintain
    // developer only hit the 403 after filling the whole form. The client now
    // passes its repo to /api/github-identity so the server folds the preflight
    // in, and renders the returned repoAccess message in the account note — an
    // early, additive heads-up beside the account it concerns.
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "'/api/github-identity?repo=' + encodeURIComponent(CTX_REPO"
    );
    expect(html).toContain("if (id.repoAccess)");
    // A successful account switch must re-run the preflight for the new
    // account (the switch response carries no repoAccess), so the switch
    // handler re-loads identity rather than trusting res.d.identity.
    expect(html).toContain("loadGitHubIdentity(true);");
  });

  it("single-sources the tested azure-oidc helpers into the client via .toString() (no hand-copied twins)", () => {
    // Comment #10: formatServesReposLabel / discoverStatusText were duplicated
    // as untested browser copies. They are now serialized from azure-oidc.ts
    // into the client bundle, so the shipping client runs the exact tested
    // code and the call sites reference the real functions.
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "var formatServesReposLabel = function formatServesReposLabel("
    );
    expect(html).toContain(
      "var discoverStatusText = function discoverStatusText("
    );
    expect(html).toContain("discoverStatusText(data, 'azure')");
    expect(html).toContain("discoverStatusText(data, 'aws')");
    expect(html).toContain("formatServesReposLabel(serves)");
    // The hand-copied twins must be gone.
    expect(html).not.toContain("formatServesReposLabelClient");
  });

  it("keeps stable browser helper names when the bundled function name is mangled", () => {
    function Fi(data: unknown): unknown {
      return data;
    }
    expect(serializeBrowserFunction("discoverStatusText", Fi)).toMatch(
      /^var discoverStatusText = function Fi\(data\)/
    );
    expect(() => serializeBrowserFunction("bad-name", Fi)).toThrow(
      'Invalid browser function name "bad-name".'
    );
  });

  it("emits only syntactically valid client <script> blocks (init-halt guard)", () => {
    // The client scripts live inside a template literal, so an escaped
    // apostrophe (\\') un-escapes to a raw ' in the emitted JS and breaks a
    // single-quoted string, halting page init so the tables never load.
    // Parse every emitted script with new Function to catch that class of bug
    // at build time without executing it.
    const html = environmentPage({ contextRepo: "octo/app" });
    const scripts = [
      ...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)
    ].map((m) => m[1]);
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

describe("deployingPage — Deployments landing", () => {
  it("emits only syntactically valid client <script> blocks (init-halt guard)", () => {
    // The Deployments page carries non-trivial inline client logic (branch
    // discovery + selected-branch dispatch) inside a template literal, so an
    // unescaped backtick or stray delimiter silently closes the outer literal
    // and halts page init. Compile every emitted script to catch that class
    // of bug (it already caught a stray backtick during development).
    const html = deployingPage({
      contextRepo: "octo/app",
      contextBranch: "feature-x"
    });
    const scripts = [
      ...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)
    ].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) {
      expect(() => new Function(src)).not.toThrow();
    }
  });

  it("renders a Branch selector defaulting to the session branch and dispatches it", () => {
    const html = deployingPage({
      contextRepo: "octo/app",
      contextBranch: "feature-x"
    });
    // The Branch selector is visible (not a hidden input) and seeded with the
    // active session branch, and the dispatch reads the selected branch.
    expect(html).toContain('id="deploy-branch-select"');
    expect(html).toContain("feature-x");
    expect(html).toContain(
      "var deployBranch = (branchSelect && branchSelect.value) || CTX_BRANCH;"
    );
    expect(html).toContain("branch: deployBranch");
  });

  it("auto-refreshes the deployments table after a deploy starts (synthetic row + quiet in-flight polling)", () => {
    const html = deployingPage({
      contextRepo: "octo/app",
      contextBranch: "feature-x"
    });
    // Fix 1: loadDeployments takes a quiet flag and renders a synthetic row for
    // any optimistic OP_STATUS op that has no server record yet, so a brand-new
    // deployment appears immediately instead of staying invisible until the run
    // reaches a terminal state or Refresh is clicked.
    expect(html).toContain("function loadDeployments(fresh, quiet) {");
    expect(html).toContain("var synthetic = [];");
    expect(html).toContain("var rows = synthetic.concat(deps);");
    // The quiet flag suppresses the "Loading…" placeholder on background refreshes.
    expect(html).toContain(
      'if (!quiet) body.innerHTML = \'<tr><td colspan="6" style="color:var(--rad-text-tertiary);">Loading deployments…</td></tr>\';'
    );
    // Fix 2: while the run is still in flight, the deploy-status poll quietly
    // refreshes the list so the real GitHub record replaces the synthetic row.
    expect(html).toContain("loadDeployments(true, true);");
  });
});

describe("graphDiffPage — passes repo/branch context so source links + popup work (not just diffMode)", () => {
  it("passes repoUrl, branch (head), and baseBranch to radiusRenderGraph so buildSourceUrl doesn't short-circuit on missing repoUrl", () => {
    const html = graphDiffPage({
      diffResources: sampleResources,
      diffBase: "main",
      diffHead: "feature",
      diffTargetRepo: "octo/app"
    });
    expect(html).toContain("radiusRenderGraph('graph-container', resources, {");
    expect(html).toContain("diffMode: true");
    expect(html).toContain("repoUrl: DIFF_REPO_URL");
    expect(html).toContain("branch: 'feature'");
    expect(html).toContain("baseBranch: 'main'");
    expect(html).toContain(
      "var DIFF_REPO_URL = 'https://github.com/' + document.getElementById('diff-repo-select').value.trim();"
    );
  });
});

describe("graphDiffPage — comparison errors", () => {
  it.each([{ diffResources: [] }, { diffResources: sampleResources }])(
    "surfaces an automatic comparison failure with existing resources: $diffResources",
    ({ diffResources }) => {
      const html = graphDiffPage({
        diffError: "Unable to compile head graph",
        diffResources,
        diffTargetRepo: "octo/app",
        diffBase: "main",
        diffHead: "feature"
      });
      expect(html).toContain("Unable to compile head graph");
      expect(html).toContain('class="status error"');
    }
  );
});

describe("deployedGraphPage", () => {
  it("uses resolved concrete labels with planned topology and solid lines", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    const renderGraph = html.match(
      /function renderGraph\(resources, showDeployStatus\) \{([\s\S]*?)\n    \}/
    )?.[1];
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
  const cases: Array<readonly [string, () => string, (() => string) | null]> = [
    ["oidcPage", () => oidcPage({ provider: "azure" }), () => oidcPage({})],
    [
      "graphDiffPage",
      () =>
        graphDiffPage({
          branches: ["main", "dev"],
          branchShas: { main: "abcdef1234567" },
          diffBase: "main",
          diffHead: "dev"
        }),
      () => graphDiffPage({ diffResources: sampleResources })
    ],
    [
      "deployedGraphPage",
      () => deployedGraphPage({ deployedResources: sampleResources }),
      () => deployedGraphPage({})
    ],
    [
      "environmentPage empty",
      () => environmentPage({}),
      () => environmentPage(undefined)
    ],
    [
      "environmentPage result",
      () =>
        environmentPage({
          deployResult: { message: "ok", workflowUrl: "https://x" }
        }),
      null
    ],
    [
      "environmentPage error",
      () => environmentPage({ deployResult: { error: "boom" } }),
      null
    ],
    [
      "deployingPage",
      () => deployingPage({ deployRepo: "octo/app" }),
      () => deployingPage({})
    ]
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
    const html = cases
      .flatMap(([, primary, secondary]) => [primary(), secondary?.() || ""])
      .join("\n");
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
      "#b31d28"
    ]) {
      expect(html).not.toContain(literal);
    }
  });

  it("uses semantic danger tokens for delete button states", () => {
    const html = deployingPage({ deployRepo: "octo/app" });
    expect(html).toContain(".rad-ddlg__delete {");
    expect(html).toContain("background:var(--rad-danger-solid)");
    expect(html).toContain(
      ".rad-ddlg__delete:hover { background:var(--rad-danger-solid-border); }"
    );
    expect(html).not.toContain(
      ".rad-ddlg__delete:hover { background:#b31d28; }"
    );
  });

  it("references no --rad-* token that pageShell does not define", () => {
    // A var(--rad-foo, <fallback>) whose token is never defined silently
    // paints its light-only fallback in every theme (e.g. the --rad-muted
    // regression). Guard every page against undefined --rad-* references.
    const shell = pageShell("t", "");
    const defined = new Set(
      [...shell.matchAll(/(--rad-[a-z0-9-]+)\s*:/g)].map((m) => m[1])
    );
    const html = cases
      .flatMap(([, primary, secondary]) => [primary(), secondary?.() || ""])
      .join("\n");
    const referenced = new Set(
      [...html.matchAll(/var\((--rad-[a-z0-9-]+)/g)].map((m) => m[1])
    );
    const undefinedTokens = [...referenced].filter((t) => !defined.has(t));
    expect(undefinedTokens).toEqual([]);
  });
});

describe("environmentPage — non-blocking setup progress", () => {
  it("no longer renders a full-screen blocking overlay for creation", () => {
    // The blocking modal is the one thing every comparable agent-canvas
    // product avoids, and it trapped the user for up to eight minutes.
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).not.toContain('id="env-creating-modal"');
    expect(html).toContain('id="env-progress-panel"');
  });

  it("renders the panel inline on the environments landing, not as an overlay", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    const panel = html.slice(html.indexOf('id="env-progress-panel"'));
    expect(panel.slice(0, 200)).not.toContain("position:fixed");
    const landing = html.indexOf('<div id="env-landing">');
    expect(html.indexOf('id="env-progress-panel"')).toBeGreaterThan(landing);
    expect(html.indexOf('id="env-progress-panel"')).toBeLessThan(
      html.indexOf('id="new-env-btn"')
    );
    expect(html).toContain(
      'role="region" aria-label="Environment setup progress" tabindex="-1"'
    );
  });

  it("focuses and scrolls the progress panel into view when setup starts", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("function focusEnvProgressPanel()");
    expect(html).toContain("panel.focus({ preventScroll: true })");
    expect(html).toContain("panel.scrollIntoView({ behavior: reduceMotion");
    const start = html.indexOf("summary: 'Creating ' + env + '…'");
    const focus = html.indexOf("focusEnvProgressPanel();", start);
    const tracking = html.indexOf(
      "trackEnvProgress(targetRepo, env, provider);",
      start
    );
    expect(start).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(start);
    expect(tracking).toBeGreaterThan(focus);
  });

  it("offers dismissal only after setup reaches a terminal state", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="env-progress-dismiss"');
    expect(html).toContain(
      'aria-label="Dismiss completed environment setup progress"'
    );
    expect(html).toContain(
      "if (dismiss) dismiss.style.display = op.terminalState ? '' : 'none';"
    );
    expect(html).toContain(
      "if (actions) actions.style.display = op.terminalState ? 'flex' : 'none';"
    );
    expect(html).toContain(
      "envProgressDismiss.addEventListener('click', function() {\n    hideEnvProgress();"
    );
  });

  it("keeps the journey action beside dismissal when a return target exists", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "var canResume = op.terminalState && target && target.page === 'planned' && target.repo;"
    );
    expect(html).toContain(
      "if (resume) resume.style.display = canResume ? '' : 'none';"
    );
  });

  it("clears stale terminal banners before showing progress for a new setup", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("function hideEnvTerminalBanners()");
    expect(html).toContain(
      "['env-success-banner', 'env-error-banner', 'env-warning-banner', 'env-action-banner']"
    );
    const start = html.indexOf("showEnvLanding();");
    const clear = html.indexOf("hideEnvTerminalBanners();", start);
    const render = html.indexOf("renderEnvProgress({", start);
    expect(start).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(start);
    expect(render).toBeGreaterThan(clear);
  });

  it("shows stage, current activity and elapsed time instead of a percentage", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="env-progress-stages"');
    expect(html).toContain('id="env-progress-activity"');
    expect(html).toContain('id="env-progress-elapsed"');
    // The step count varies with branching (credentials can be skipped,
    // verification can never run), so a percentage could only be fiction.
    expect(html).not.toContain("env-progress__bar");
  });

  it("announces the activity line and does not rely on colour alone for state", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      'id="env-progress-activity" class="env-progress__activity" role="status" aria-live="polite"'
    );
    expect(html).toContain("ENV_STAGE_GLYPH");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("renders one inline failure card that covers cleanup results and retry readiness", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="env-progress-failure"');
    expect(html).toContain('id="env-progress-cleanup-removed"');
    expect(html).toContain('id="env-progress-cleanup-retained"');
    expect(html).toContain('id="env-progress-cleanup-warnings"');
    expect(html).toContain("function renderEnvFailureCard(op)");
    expect(html).toContain("Retry starts cleanly:");
  });

  it("describes commit-point retention, cleanup warnings, and retry readiness in the failure card copy", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    const failureCard = html.slice(
      html.indexOf("function renderEnvFailureCard(op)")
    );
    expect(failureCard).toContain(
      "Cleanup stopped at the commit point, so reusable artifacts were left in place."
    );
    expect(failureCard).toContain("Cleanup finished with warnings.");
    expect(failureCard).toContain(
      "Retry starts cleanly: ' + (retry.startsCleanly ? 'Yes' : 'No') + '. '"
    );
  });

  it("polls the operation record rather than the request that started it", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("/api/operations?repo=");
    // Rejoining on load is what makes navigating away safe.
    expect(html).toContain("resumeEnvProgress(CTX_REPO)");
  });

  it("falls back to verification status when the process-local operation record disappears", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "function trackEnvProgress(repo, environment, provider, onTerminal)"
    );
    expect(html).toContain("if (!op) {");
    expect(html).toContain(
      "// Verification is tracked separately from the process-local"
    );
    expect(html).toContain(
      "'/api/verify-status?repo=' + encodeURIComponent(repo) + '&environment=' + encodeURIComponent(environment)"
    );
    expect(html).toContain(
      "if (v.state === 'success') {\n                                hideEnvProgress();"
    );
    expect(html).toContain(
      "else hideEnvProgress();\n                                    })"
    );
  });

  it("does not treat a previous verification run as success before the new operation appears", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("var observedOperation = false;");
    expect(html).toContain(
      "if (!observedOperation) {\n                        envProgressTimer = setTimeout(tick, 1500);"
    );
    expect(html).toContain("observedOperation = true;");
    const noOperation = html.indexOf("if (!observedOperation)");
    const verifyFallback = html.indexOf(
      "fetch('/api/verify-status?repo='",
      noOperation
    );
    expect(noOperation).toBeGreaterThan(-1);
    expect(verifyFallback).toBeGreaterThan(noOperation);
  });

  it("does not replace a fresh setup panel with the previous terminal operation", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "if (!observedOperation && op && (op.environment !== environment || op.terminalState))"
    );
    const staleGuard = html.indexOf(
      "if (!observedOperation && op && (op.environment !== environment || op.terminalState))"
    );
    const observed = html.indexOf("observedOperation = true;", staleGuard);
    const render = html.indexOf("renderEnvProgress(op);", staleGuard);
    expect(staleGuard).toBeGreaterThan(-1);
    expect(observed).toBeGreaterThan(staleGuard);
    expect(render).toBeGreaterThan(observed);
  });

  it("polls verification while the live operation is in the verify stage", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    const liveVerify = html.indexOf(
      "if (op.currentStage === 'verify' && environment)"
    );
    const verifyRequest = html.indexOf(
      "fetch('/api/verify-status?repo='",
      liveVerify
    );
    expect(liveVerify).toBeGreaterThan(-1);
    expect(verifyRequest).toBeGreaterThan(liveVerify);
    expect(html.slice(liveVerify, verifyRequest + 500)).toContain(
      "v.state === 'success' || v.state === 'failed' ? 0 : 1500"
    );
  });

  it("re-hydrates terminal request failures from the shared operation record", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("function syncEnvFailureOperation(data)");
    expect(html).toContain("syncEnvFailureOperation(envResult)");
    expect(html).toContain("syncEnvFailureOperation(err)");
  });
});

describe("environmentPage — pull-request terminal state", () => {
  it("renders an action-required outcome instead of polling for a verify run that was never dispatched", () => {
    // The server deliberately skips the verify dispatch on the PR path, so
    // the old client polled for eight minutes and then reported a correct
    // outcome as "Timed out waiting for credential verification".
    //
    // The branch keys off the server's stated `actionRequired` flag, not off
    // the presence of a pull-request URL. Once the server learned to dispatch
    // verification from a PR branch, a URL could accompany a run that was
    // genuinely verifying — and inferring "do not poll" from it would have
    // reintroduced #247 from the other direction.
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("if (envResult.actionRequired) {");
    const prBranch = html.slice(
      html.indexOf("if (envResult.actionRequired) {")
    );
    const untilPoll = prBranch.slice(
      0,
      prBranch.indexOf("function pollVerify")
    );
    expect(untilPoll).toContain("showEnvActionRequired");
    expect(untilPoll).toContain("return;");
  });

  it("has a dedicated banner that reads as informational, not as a failure", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="env-action-banner"');
    expect(html).toContain("is set up, but one step is left for you");
    expect(html).toContain("Review the pull request");
  });

  it("only links a pull request URL it recognises", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "pullRequestUrl.indexOf('https://github.com/') === 0"
    );
  });

  it("can explain manual PR creation when automatic PR creation failed", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("could not open a pull request automatically");
    expect(html).toContain("terminal.branch");
    expect(html).toContain("terminal.baseBranch");
  });

  it("continues both setup POSTs with the same operation id", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      contextBranch: "feature"
    });
    expect(html).toContain(
      "if (params.operationId) payload.operationId = params.operationId"
    );
    expect(html).toContain(
      "operationId: setupResult && setupResult.operationId"
    );
    expect(html).toContain(
      "operationId: err.operationId || params.operationId"
    );
  });

  it("captures and renders a planned-graph resume target", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      contextBranch: "feature"
    });
    expect(html).toContain(
      "resumeTarget: { page: 'planned', repo: targetRepo, branch: CTX_BRANCH }"
    );
    expect(html).toContain('id="env-progress-resume"');
    expect(html).toContain("target.page === 'planned'");
    expect(html).toContain("resumeReason: 'View planned graph'");
  });
});

describe("operation status chip in the top navigation", () => {
  const shell = pageShell("Environments", "<div></div>", "environments");

  it("ships the chip on every page, hidden until it has something to report", () => {
    // It renders in the shell rather than on the environments page because
    // the whole point is to reach a user who has navigated away from there.
    const html = pageShell("Applications", "<div></div>", "applications");
    expect(html).toContain('id="rad-opchip"');
    expect(html).toContain('id="rad-opchip-label"');
    expect(html).toMatch(
      /<a class="rad-opchip" id="rad-opchip" href="\/\?page=environment" hidden/
    );
    expect(shell).toContain('id="rad-opchip"');
  });

  it("routes back to environments rather than opening anything on its own", () => {
    // Auto-focus on completion was rejected: it re-creates the modal's sin
    // with worse timing. The chip is a link the user chooses to follow.
    expect(shell).toContain('href="/?page=environment"');
    expect(shell).not.toContain('rad-opchip" onclick');
  });

  it("announces itself politely to assistive technology", () => {
    expect(shell).toMatch(/id="rad-opchip"[^>]*aria-live="polite"/);
    expect(shell).toContain(
      'class="rad-opchip__dot" id="rad-opchip-dot" aria-hidden="true"'
    );
  });

  it("carries the poller that fills it in", () => {
    expect(shell).toContain("/api/operations");
    expect(shell).toContain("radiusOpChipAck");
  });

  it("stops the pulse for anyone who has asked for less motion", () => {
    expect(shell).toContain("@media (prefers-reduced-motion: reduce)");
    expect(shell).toMatch(
      /prefers-reduced-motion[\s\S]*rad-opchip--running \.rad-opchip__dot \{ animation: none; \}/
    );
  });
});
