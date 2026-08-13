// Tests for the server-side HTML page renderers. Focus: the recipe-pack
// refactor removed all singleton-recipe / on-demand-bicep UI, and app.bicep is
// now authored solely by the Radius app-bicep skill. These tests assert the
// changed pages surface the skill/needsAppBicep messaging and no longer emit
// the removed generated-bicep state, while smoke-rendering every page so the
// module's branches stay exercised.

import { describe, it, expect } from "vitest";
import {
  CLIENT_REPO_BRANCH_JS,
  CLIENT_GRAPH_JS,
  CLIENT_DELETE_DIALOG_JS
} from "./client.js";
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

  it("derives graph line colours from text/background, not host border tokens", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    // Primer's --border-color-muted is FAINTER than --border-color-default, so
    // routing graph lines through --rad-stroke-strong (which falls back to it)
    // made them the weakest thing on the canvas. Mixing text into background
    // keeps contrast stable and inverts correctly in dark mode.
    for (const token of [
      "--rad-node-border",
      "--rad-edge",
      "--rad-edge-muted",
      "--rad-grid"
    ]) {
      const value = html.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];
      expect(value, `${token} should not be defined`).toBeTruthy();
      expect(value).toContain("color-mix");
      expect(value).toContain("var(--rad-text)");
      expect(value).not.toContain("--rad-stroke");
    }
  });

  it("keeps graph lines in a legible contrast order", () => {
    const html = pageShell("My Title", "<p>hello</p>");
    const pct = (token: string) =>
      Number(
        html
          .match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]
          ?.match(/var\(--rad-text\)\s+(\d+)%/)?.[1]
      );
    // Edges read strongest, then node borders, then the muted edge; the
    // background grid stays well below all of them so it never competes.
    expect(pct("--rad-edge")).toBeGreaterThanOrEqual(pct("--rad-node-border"));
    expect(pct("--rad-node-border")).toBeGreaterThan(pct("--rad-edge-muted"));
    expect(pct("--rad-edge-muted")).toBeGreaterThan(pct("--rad-grid"));
    // All load-bearing lines need enough mix to stay visible in both themes.
    expect(pct("--rad-edge-muted")).toBeGreaterThanOrEqual(35);
  });
});

describe("graphHeader / graphHeaderClose", () => {
  it("renders the nav header and matching close markup", () => {
    expect(graphHeader("graph")).toContain("<");
    expect(graphHeaderClose()).toContain("<");
  });

  it("links each mode named in the lede to its own sub-tab", () => {
    const html = graphHeader("graph");
    const expected: Array<[string, string]> = [
      ["Modeled", "graph"],
      ["Planned", "planned"],
      ["Deployed", "deployed"],
      ["Diff", "graph-diff"]
    ];
    for (const [label, page] of expected) {
      expect(html).toContain(
        `<a href="?page=${page}" class="rad-lede-link" onclick="radiusNavTo(event, '${page}')"><strong>${label}</strong></a>`
      );
    }
  });

  it("keeps the lede links pointing at the same routes as the nav", () => {
    const html = graphHeader("planned");
    // Every route referenced by a lede link must also exist as a nav sub-tab.
    const ledeRoutes = [
      ...html.matchAll(
        /class="rad-lede-link" onclick="radiusNavTo\(event, '([^']+)'\)"/g
      )
    ];
    expect(ledeRoutes).toHaveLength(4);
    for (const [, route] of ledeRoutes) {
      expect(html).toContain(`data-page="${route}"`);
    }
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
    expect(html).toContain('id="planned-subtitle"');
    expect(html).toContain(
      "The planned application graph previews the infrastructure"
    );
    expect(html).toContain(">Loading…</button>");
    expect(html).toContain(
      "radiusPopulatePlannedSelectors(CONTEXT_REPO, ENV_PROVIDERS, CONTEXT_BRANCH, CONTEXT_ENV)"
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

  it("opens the creation form directly when deep-linked with ?new=1", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    // The "Create Environment" call to action on the graph pages links to
    // /?page=environment&new=1 and must land on the form, not the table.
    expect(html).toContain("get('new') === '1'");
    expect(html).toContain("showEnvForm({ name: '' })");
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
    expect(html).toContain(
      "'/api/operations/' + encodeURIComponent(operationId) + '/resume/'"
    );
  });

  it("keeps ordinary resume failures retryable, terminates expired prompts, and abandons cancelled prompts", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "error.retryPrompt = payload.code !== 'operation-input-expired';"
    );
    expect(html).toContain(
      "error.operation.failure.code === 'operation-input-expired'"
    );
    expect(html).toContain(
      "if (error && error.retryPrompt) promptingRequestedAt = '';"
    );
    expect(html).toContain("error.abandonOperation = true");
    expect(html).toContain(
      "'/api/operations/' + encodeURIComponent(operationId) + '/abandon'"
    );
    expect(html).toContain("if (!response.ok) {");
    expect(html).toContain("promptingRequestedAt = '';");
  });

  it("validates Azure tenant and subscription before switching to progress", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "provider === 'azure' && (!(selectedProfile.subscriptionId || '').trim() || !(selectedProfile.tenantId || '').trim())"
    );
    expect(html).toContain(
      "The selected profile needs both a tenant ID and subscription ID."
    );
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
    expect(html).toContain(
      "envData.clusterResourceGroup = clusterResourceGroup;"
    );
    expect(html).toContain(
      "var warnings = op.steps.filter(function(s) { return s.state === 'warning'; })"
    );
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
    expect(html).toContain(
      "envData.appName = appNameEl ? appNameEl.value.trim() : '';"
    );
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
    // Synthetic rows are tagged so they can't offer a Delete button for a
    // deployment record GitHub hasn't created yet (which would falsely report a
    // successful delete mid-deploy).
    expect(html).toContain("synthetic: true");
    expect(html).toContain(
      "var delDisabled = (status === 'deleting' || dep.synthetic) ? ' disabled' : '';"
    );
    // The in-flight list refresh stops once the real record shows up, and the
    // poll is capped so a stuck run can't fan out fresh=1 fetches forever.
    expect(html).toContain("if (recordSeen) return;");
    expect(html).toContain(
      "if (DEPLOY_RECORDS_PRESENT[opKey(app, env)]) { recordSeen = true; return; }"
    );
    expect(html).toContain("if (++wfTicks > 720) {");
  });

  it("applies the same quiet in-flight polling to the Delete Deployment flow", () => {
    const html = deployingPage({
      contextRepo: "octo/app",
      contextBranch: "feature-x"
    });
    // The delete poll keeps the row showing "Deleting…" via a quiet refresh, so
    // the table no longer flashes a loading placeholder every ~4s during a
    // delete (matching the deploy flow's in-flight polling).
    expect(html).toContain(
      'loadDeployments(true, true); // keep the row showing "Deleting…" (quiet)'
    );
    // The initial optimistic "deleting" refresh is also quiet so the existing
    // row flips in place without a flash.
    expect(html).toContain(
      "OP_STATUS[opKey(dep.app, dep.environment)] = 'deleting';"
    );
    // A synthetic row is only created for a not-yet-recorded op (deploy's
    // "pending"), never for "deleting" — a delete acts on an existing record, so
    // once it's gone there must be no phantom "Deleting…" row.
    expect(html).toContain(
      "if (present[k] || OP_STATUS[k] === 'deleting') return;"
    );
    // The delete is acknowledged immediately with a banner (mirroring the deploy
    // flow) so the button click isn't left looking like it did nothing while the
    // workflow spins up.
    expect(html).toContain(
      "'Deleting deployment of application <strong>' + escapeHtmlClient(dep.app)"
    );
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

  it("renders the subtitle and wires the adaptive primary button", () => {
    const html = deployedGraphPage({
      contextRepo: "octo/app",
      contextBranch: "feature-x"
    });
    expect(html).toContain('id="deployed-subtitle"');
    expect(html).toContain(
      "The deployed application graph depicts the selected application"
    );
    expect(html).toContain('id="deployed-subtitle-hint"');
    expect(html).toContain("radiusApplyDeployedEnvState(HAS_ENVS,");
    expect(html).toContain("radiusDeployDeployedApp(");
    expect(html).toContain("/api/list-deployments?repo=");
    expect(html).toContain('var CONTEXT_BRANCH = "feature-x"');
  });

  // The disabled-while-deleting guard only works if the page actually feeds the
  // selected environment's status into the adaptive state function, and then
  // keeps polling so the button re-enables once the delete resolves.
  it("passes the deployment status through and polls while a delete runs", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("deploymentStatus(app, env)");
    expect(html).toContain("function deploymentStatus(");
    expect(html).toContain("scheduleStatePoll(");
    expect(html).toContain("deploymentStatus(app, env) === 'deleting'");
  });

  // A transient GitHub failure comes back as HTTP 200 with
  // { deployments: [], error }. Clearing the map on that response would make an
  // environment with an in-flight deploy/delete look empty, flipping the button
  // back to "Deploy Application" and letting the user start a conflicting
  // operation. This runs the emitted function for real, because the behavior
  // only exists as a string in the page and a substring assertion would not
  // prove the error path preserves anything.
  describe("deployment-state loading survives a transient listing failure", () => {
    // Pull the emitted loadDeploymentStates out of the page and run it against
    // fake state, returning what it left behind.
    async function runLoad(
      response: unknown,
      previous: Record<string, string>
    ) {
      const html = deployedGraphPage({ contextRepo: "octo/app" });
      const start = html.indexOf("function loadDeploymentStates()");
      expect(start).toBeGreaterThan(-1);
      // Brace-match to the end of the function so the harness gets exactly it.
      let depth = 0;
      let end = -1;
      for (let i = html.indexOf("{", start); i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      expect(end).toBeGreaterThan(start);
      const source = html.slice(start, end);

      const state = {
        DEPLOYMENTS_BY_ENV: { ...previous },
        DEPLOYMENT_STATES_STALE: false
      };
      const fetchFake = () =>
        response instanceof Error ?
          Promise.reject(response)
        : Promise.resolve({ json: () => Promise.resolve(response) });
      const harness = new Function(
        "CONTEXT_REPO",
        "fetch",
        "state",
        `var DEPLOYMENTS_BY_ENV = state.DEPLOYMENTS_BY_ENV;
         var DEPLOYMENT_STATES_STALE = state.DEPLOYMENT_STATES_STALE;
         ${source}
         return loadDeploymentStates().then(function () {
           return { map: DEPLOYMENTS_BY_ENV, stale: DEPLOYMENT_STATES_STALE };
         });`
      );
      return (await harness("octo/app", fetchFake, state)) as {
        map: Record<string, string>;
        stale: boolean;
      };
    }

    it("keeps the last-known deployments and flags them stale on an error payload", async () => {
      const result = await runLoad(
        { deployments: [], error: "GitHub API rate limit exceeded" },
        { prod: "deleting" }
      );
      expect(result.map).toEqual({ prod: "deleting" });
      expect(result.stale).toBe(true);
    });

    it("keeps the last-known deployments when the request itself fails", async () => {
      const result = await runLoad(new Error("network down"), {
        prod: "success"
      });
      expect(result.map).toEqual({ prod: "success" });
      expect(result.stale).toBe(true);
    });

    it("replaces the map and clears the stale flag on a good response", async () => {
      const result = await runLoad(
        { deployments: [{ environment: "staging", status: "success" }] },
        { prod: "deleting" }
      );
      expect(result.map).toEqual({ staging: "success" });
      expect(result.stale).toBe(false);
    });

    // An empty list is a real answer, unlike an error, so it must clear.
    it("clears the map when the listing is genuinely empty", async () => {
      const result = await runLoad({ deployments: [] }, { prod: "success" });
      expect(result.map).toEqual({});
      expect(result.stale).toBe(false);
    });
  });

  // The button must be held disabled while the listing is unreadable, and the
  // page must keep polling so it recovers without a manual reload.
  it("feeds the stale flag into the button state and polls until it clears", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("DEPLOYMENT_STATES_STALE");
    expect(html).toContain(
      "deploymentStatus(app, env), DEPLOYMENT_STATES_STALE"
    );
    expect(html).toContain(
      "deploymentStatus(app, env) === 'deleting' || DEPLOYMENT_STATES_STALE"
    );
  });

  it("places the primary button inline with the selectors", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    const controls = html.match(
      /<div class="rad-deployed-controls">([\s\S]*?)<\/div>\n/
    )?.[0];
    // The button must live INSIDE the controls row so it sits on the same
    // line as the Application/Environment dropdowns.
    expect(html).toMatch(
      /<div class="rad-deployed-controls">[\s\S]*id="deployed-delete-btn"[\s\S]*?<\/div>/
    );
    expect(controls).toBeTruthy();
  });

  it("treats a failed deployment as deployed so it can be cleaned up", () => {
    const html = deployedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("return !!DEPLOYMENTS_BY_ENV[env];");
    expect(html).toContain("dep.status || 'unknown'");
  });
});

describe("graphDiffPage", () => {
  it("renders the subtitle on both the empty and rendered paths", () => {
    const empty = graphDiffPage({
      branches: ["main", "dev"],
      diffBase: "main",
      diffHead: "dev"
    });
    const rendered = graphDiffPage({ diffResources: sampleResources });
    for (const html of [empty, rendered]) {
      expect(html).toContain('id="graph-diff-subtitle"');
      expect(html).toContain(
        "The application graph diff compares the application model"
      );
      expect(html).toContain("added, removed, or modified");
    }
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
    const accepted = html.indexOf("fetch('/api/operations'", start);
    expect(start).toBeGreaterThan(-1);
    expect(focus).toBeGreaterThan(start);
    expect(accepted).toBeGreaterThan(focus);
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
      "'/api/verify-status?repo=' + encodeURIComponent(repo) + '&environment=' + encodeURIComponent(environment) + '&operationId=' + encodeURIComponent(operationId)"
    );
    expect(html).toContain(
      "if (v.state === 'success') {\n                                hideEnvProgress();"
    );
    expect(html).toContain(
      "showEnvSuccessBanner(provider || 'azure', environment)"
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

  it("leaves live verification polling to the server-owned operation", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).not.toContain(
      "if (op.currentStage === 'verify' && environment)"
    );
    expect(
      html.match(/fetch\('\/api\/verify-status\?repo='/g) || []
    ).toHaveLength(1);
    expect(html).toContain("If the extension restarts after");
  });

  it("renders deliberate cancellation without failed styling", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("op.terminalState === 'cancelled'");
    expect(html).toContain("Environment setup cancelled.");
    expect(html).toContain(
      "cancelledPanel.classList.remove('env-progress--done', 'env-progress--failed')"
    );
  });

  it("bounds reconnect verification without treating transient unknown as terminal", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain("var verifyDeadlineMs = 45 * 60 * 1000;");
    expect(html).toContain(
      "Date.now() - verifyDispatchedAtMs > verifyDeadlineMs"
    );
    expect(html).toContain("v.state === 'expired' || v.terminal");
    expect(html).not.toContain("v.state === 'unknown' || v.terminal");
    expect(html).toContain(
      "if (op.verification && op.verification.dispatchedAt) verifyDispatchedAtMs = Number(op.verification.dispatchedAt);"
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
    expect(html).toContain("op.terminalState === 'action_required'");
    expect(html).toContain("showEnvActionRequired");
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

  it("starts setup with one accepted operation request", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      contextBranch: "feature"
    });
    expect(html).toContain("fetch('/api/operations'");
    expect(html).not.toContain("fetch('/api/azure-auto-setup'");
    expect(html).not.toContain("fetch('/api/create-environment'");
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

// Inline <script> blocks in pages.ts are template-literal strings, so a syntax
// error in one is invisible to tsc, eslint and prettier — it surfaces only at
// runtime as a silently dead script (this has caused a real "perpetual
// Loading…" bug). Parsing every emitted block is the only cheap guard.
describe("inline scripts", () => {
  const renderers: Array<[string, () => string]> = [
    ["graphPage", () => graphPage({})],
    ["plannedGraphPage", () => plannedGraphPage({})],
    ["graphDiffPage", () => graphDiffPage({})],
    ["deployedGraphPage", () => deployedGraphPage({})],
    ["environmentPage", () => environmentPage({})],
    ["deployingPage", () => deployingPage({})],
    ["oidcPage", () => oidcPage({})]
  ];

  it.each(renderers)(
    "%s emits only parseable script blocks",
    (_name, render) => {
      const blocks = render().match(/<script>([\s\S]*?)<\/script>/g) || [];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const src = block.slice("<script>".length, -"</script>".length);
        expect(() => new Function(src)).not.toThrow();
      }
    }
  );
});

// Function declarations hoist within a <script> block but not across blocks, so
// a page whose body script uses a shared helper injected *after* it dies with a
// ReferenceError — taking every later statement with it, which surfaces as a
// permanently stuck "Loading…". Each block parses fine alone, so only an
// ordering check catches this. The shared libraries are exactly the code that
// crosses block boundaries, so they are what this pins.
describe("shared client helpers are injected before the page body uses them", () => {
  const SHARED_LIBS = [
    CLIENT_REPO_BRANCH_JS,
    CLIENT_GRAPH_JS,
    CLIENT_DELETE_DIALOG_JS
  ];

  // Top-level declarations of the shared libraries: the names pages may rely on.
  const sharedHelpers = [
    ...new Set(
      SHARED_LIBS.flatMap((lib) =>
        [...lib.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map(
          (m) => m[1]
        )
      )
    )
  ];

  const renderers: Array<[string, () => string]> = [
    ["graphPage", () => graphPage({})],
    ["plannedGraphPage", () => plannedGraphPage({})],
    ["graphDiffPage", () => graphDiffPage({})],
    ["deployedGraphPage", () => deployedGraphPage({})],
    ["environmentPage", () => environmentPage({})],
    ["deployingPage", () => deployingPage({})],
    ["oidcPage", () => oidcPage({})]
  ];

  it("finds the shared helpers to check", () => {
    expect(sharedHelpers).toContain("radiusCreateDeleteDeploymentDialog");
    expect(sharedHelpers).toContain("radiusApplyDeployedEnvState");
  });

  it.each(renderers)(
    "%s uses no shared helper before it is defined",
    (_name, render) => {
      // Compare by block, not by character offset: within a single block a
      // forward reference is fine, because declarations hoist to its top.
      const blocks = (
        render().match(/<script>([\s\S]*?)<\/script>/g) || []
      ).map((b) => b.slice("<script>".length, -"</script>".length));
      const violations: string[] = [];
      for (const name of sharedHelpers) {
        const declaredIn = blocks.findIndex((src) =>
          new RegExp(`^function\\s+${name}\\s*\\(`, "m").test(src)
        );
        if (declaredIn === -1) continue;
        const usedIn = blocks.findIndex(
          (src, i) =>
            i !== declaredIn && new RegExp(`\\b${name}\\s*\\(`).test(src)
        );
        if (usedIn !== -1 && usedIn < declaredIn) {
          violations.push(
            `${name} used in block ${usedIn} but defined in block ${declaredIn}`
          );
        }
      }
      expect(violations).toEqual([]);
    }
  );
});

// Deleting a deployment tears down live infrastructure irreversibly. Every
// surface that offers it must use the same 3-step type-to-confirm dialog — a
// page shipping a lighter confirmation of its own lowers the bar product-wide.
describe("delete-deployment confirmation is uniform", () => {
  const DIALOG_IDS = [
    "deploy-delete-modal",
    "deploy-delete-body",
    "deploy-delete-app",
    "deploy-delete-env",
    "deploy-delete-close"
  ];

  it.each([
    ["deployedGraphPage", () => deployedGraphPage({})],
    ["deployingPage", () => deployingPage({})]
  ])("%s renders the shared dialog", (_name, render) => {
    const html = render();
    expect(html).toContain('class="rad-ddlg"');
    for (const id of DIALOG_IDS) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("radiusCreateDeleteDeploymentDialog");
  });

  it("the Deployed graph page no longer ships a one-click confirm", () => {
    const html = deployedGraphPage({});
    expect(html).not.toContain("deployed-delete-confirm");
    expect(html).not.toContain("deployed-delete-cancel");
    expect(html).not.toContain("Are you sure you want to delete");
  });

  it("both pages emit byte-identical dialog markup", () => {
    const extract = (html: string) => {
      const start = html.indexOf('<div id="deploy-delete-modal"');
      expect(start).toBeGreaterThan(-1);
      return html.slice(
        start,
        html.indexOf("</div>", html.indexOf('id="deploy-delete-body"'))
      );
    };
    expect(extract(deployedGraphPage({}))).toBe(extract(deployingPage({})));
  });
});
