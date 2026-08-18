import { describe, it, expect } from "vitest";
import { environmentPage } from "./environment-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";

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
    const start = html.indexOf("+ env + '…', provider: provider");
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

describe("environmentPage — sub-tab selection and pane composition", () => {
  it("shows the environments pane and hides credentials by default", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    expect(html).toContain('<section id="pane-environments" style="">');
    expect(html).toContain(
      '<section id="pane-credentials" style="display:none;">'
    );
    expect(html).toContain(
      '<a href="/?page=environment" data-subtab="environments" class="rad-subtab rad-subtab--active">'
    );
    expect(html).toContain(
      '<a href="/?page=credentials" data-subtab="credentials" class="rad-subtab">'
    );
  });

  it("shows the credentials pane when the credentials page is requested", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      activeSubtab: "credentials"
    });
    expect(html).toContain(
      '<section id="pane-environments" style="display:none;">'
    );
    expect(html).toContain('<section id="pane-credentials" style="">');
    expect(html).toContain(
      '<a href="/?page=credentials" data-subtab="credentials" class="rad-subtab rad-subtab--active">'
    );
  });

  it("treats any other sub-tab value as environments rather than hiding both panes", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      activeSubtab: "nonsense"
    });
    expect(html).toContain('<section id="pane-environments" style="">');
    expect(html).toContain(
      '<section id="pane-credentials" style="display:none;">'
    );
  });

  it("composes both panes and the whole client script exactly once", () => {
    const html = environmentPage({ contextRepo: "octo/app" });
    const count = (needle: string) => html.split(needle).length - 1;
    expect(count('<section id="pane-environments"')).toBe(1);
    expect(count('<section id="pane-credentials"')).toBe(1);
    expect(count("function switchSubtab(")).toBe(1);
    expect(count("function renderEnvProgress(")).toBe(1);
    expect(count("function showAppPicker(")).toBe(1);
    expect(count("function loadCredTable(")).toBe(1);
  });
});

describe("environmentPage — environment listing and deletion", () => {
  const html = environmentPage({ contextRepo: "octo/app" });

  it("lists the repository's environments and states the empty case", () => {
    expect(html).toContain(
      "fetch('/api/list-environments?repo=' + encodeURIComponent(CTX_REPO))"
    );
    expect(html).toContain("No environments created yet.");
    expect(html).toContain('id="env-table-body"');
  });

  it("reports a listing failure instead of rendering an empty table", () => {
    expect(html).toContain("Could not load environments.");
  });

  it("keeps polling while an environment is still pending", () => {
    expect(html).toContain(
      "if (envs.some(function(e) { return e.status === 'pending'; }))"
    );
    expect(html).toContain("envPollTimer = setTimeout(loadEnvTable, 10000);");
  });

  it("routes deletion through the delete-environment API", () => {
    expect(html).toContain("fetch('/api/delete-environment'");
    expect(html).toContain("if (res.d && res.d.code === 'app-deployed')");
    // The conflict never navigates on a timer: see client-environments.test.ts
    // for the dialog behaviour this replaced.
    expect(html).not.toContain("Redirecting you to delete the application");
  });

  it("selects a saved credential profile rather than inline cloud fields", () => {
    expect(html).toContain('id="env-profile-select"');
    expect(html).toContain("function loadProfilesIntoEnvSelect(");
    expect(html).toContain("/api/credential-profiles");
  });
});

describe("environmentPage — credential profile pane", () => {
  const html = environmentPage({
    contextRepo: "octo/app",
    activeSubtab: "credentials"
  });

  it("offers an Azure and an AWS credential form behind one provider selector", () => {
    expect(html).toContain('id="cred-provider-select"');
    expect(html).toContain('id="cred-panel-azure"');
    expect(html).toContain('id="cred-panel-aws"');
    expect(html).toContain('id="az-tenant-id"');
    expect(html).toContain('id="az-sub-id"');
    expect(html).toContain('id="aws-account-id"');
    expect(html).toContain('id="aws-region"');
    expect(html).toContain('id="aws-role-arn"');
  });

  it("lists saved profiles and states the empty case", () => {
    expect(html).toContain('id="cred-table-body"');
    expect(html).toContain("function loadCredTable()");
    expect(html).toContain("No credential profiles yet.");
  });

  it("keeps saving disabled until verification succeeds", () => {
    expect(html).toContain(
      '<button id="save-cred-btn" class="rad-btn rad-btn--primary" style="margin:0; padding:11px 22px; font-size:14px;" disabled>Save Credential Profile</button>'
    );
    expect(html).toContain("function markVerified(user, extra)");
    expect(html).toContain(
      "document.getElementById('save-cred-btn').disabled = !(credVerified && credPackagesVerified)"
    );
  });

  it("surfaces a verification failure without discarding the entered profile", () => {
    expect(html).toContain("function credVerifyError(msg)");
    expect(html).toContain('id="cred-verify-status"');
    expect(html).toContain("fetch('/api/verify-azure-login'");
    expect(html).toContain("fetch('/api/verify-aws-login'");
  });
});

describe("environmentPage — deployment result view", () => {
  it("reports a successful dispatch with its workflow link", () => {
    const html = environmentPage({
      deployResult: {
        message: "Deployment started",
        workflowUrl: "https://github.com/octo/app/actions/runs/1?check=1&x=2"
      },
      deployAttempt: { id: "attempt-1" }
    });
    expect(html).toContain("<title>Deployment Initiated — Radius</title>");
    expect(html).toContain('<div class="status success">Deployment started');
    expect(html).toContain(
      'href="https://github.com/octo/app/actions/runs/1?check=1&amp;x=2"'
    );
    expect(html).toContain('body: JSON.stringify({attemptId: "attempt-1"})');
    expect(html).toContain("/api/deploy-reset");
  });

  it("reports a failure as an error and keeps the escaped message", () => {
    const html = environmentPage({
      deployResult: { error: "boom <b>&</b>" }
    });
    expect(html).toContain("<title>Deployment Failed — Radius</title>");
    expect(html).toContain(
      '<div class="status error">boom &lt;b&gt;&amp;&lt;/b&gt;</div>'
    );
    expect(html).not.toContain("<b>&</b>");
    expect(html).not.toContain("View GitHub Actions workflow run");
  });

  it("shows the generated workflow escaped when the server returns one", () => {
    const html = environmentPage({
      deployResult: { message: "ok", workflow: "name: deploy <x>" }
    });
    expect(html).toContain("<h2>Generated Workflow</h2>");
    expect(html).toContain("name: deploy &lt;x&gt;");
  });

  it("sends an empty attempt id when the result carries no attempt", () => {
    const html = environmentPage({ deployResult: { message: "ok" } });
    expect(html).toContain('body: JSON.stringify({attemptId: ""})');
  });
});

describe("environmentPage — operation progress reports server text safely", () => {
  const progressHtml = environmentPage({ contextRepo: "octo/app" });

  it("writes every server-supplied message as text rather than markup", () => {
    for (const assignment of [
      "messageEl.textContent = op.failure && op.failure.message ? op.failure.message : 'The setup request failed.';",
      "document.getElementById('env-progress-title').textContent = op.summary || '';",
      "document.getElementById('env-progress-activity').textContent = activity;",
      "text.textContent = msg;"
    ]) {
      expect(progressHtml).toContain(assignment);
    }
  });

  it("builds the stage checklist from elements, never from concatenated markup", () => {
    expect(progressHtml).toContain("li.textContent = item;");
    expect(progressHtml).toContain(
      "li.textContent = (ENV_STAGE_GLYPH[step.state] || '·') + ' ' + step.label;"
    );
    expect(progressHtml).toContain(
      "label.textContent = stage.label + ' — ' + stage.state;"
    );
    expect(progressHtml).not.toContain("stagesEl.innerHTML = '<");
    expect(progressHtml).not.toContain("stepsEl.innerHTML = '<");
  });

  it("reports a verification failure and its run without trusting it as markup", () => {
    expect(progressHtml).toContain(
      "if (activity) activity.textContent = 'Credential verification failed. ' + (v.error || '');"
    );
    expect(progressHtml).toContain(
      "if (details && v.runUrl) details.textContent = 'View the run: ' + v.runUrl;"
    );
  });
});

describe("environmentPage — hostile deployment result and context", () => {
  it("links only an http(s) workflow run", () => {
    const linkFor = (html: string) =>
      html.match(
        /<a href="([^"]*)"[^>]*>View GitHub Actions workflow run/
      )?.[1];

    for (const workflowUrl of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "not a url",
      "/relative/run"
    ]) {
      const html = environmentPage({
        deployResult: { message: "ok", workflowUrl }
      });
      expect(linkFor(html), workflowUrl).toBeUndefined();
      expect(html).not.toContain("View GitHub Actions workflow run");
      expectSafeInlineScripts(html);
    }

    // An https destination stays linked, with the attribute escaped so a quote
    // in the URL cannot add an event handler.
    const linked = environmentPage({
      deployResult: {
        message: "ok",
        workflowUrl: 'https://x/run" onmouseover="alert(1)'
      }
    });
    expect(linkFor(linked)).toBe(
      "https://x/run&quot; onmouseover=&quot;alert(1)"
    );
    expect(linked).not.toContain('onmouseover="alert(1)"');
  });

  it("keeps a hostile attempt id inside the reset request literal", () => {
    const html = environmentPage({
      deployResult: { message: "ok" },
      deployAttempt: { id: HOSTILE_STATE }
    });
    expectSafeInlineScripts(html);
    const literal = html.match(/attemptId: (.*)\}\)/)?.[1];
    expect(literal).toBeTruthy();
    expect(new Function(`return ${literal};`)()).toBe(HOSTILE_STATE);
  });

  it("keeps hostile workspace context inside its script strings", () => {
    const html = environmentPage({
      contextRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE,
      envName: HOSTILE_STATE
    });
    expectSafeInlineScripts(html);
    expect(readEmittedValue(html, "CTX_REPO")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(html, "CTX_BRANCH")).toBe(HOSTILE_STATE);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("environmentPage — escaping of workspace context", () => {
  it("escapes the repository, branch and environment name it renders into inputs", () => {
    const hostile = "octo/<img src=x>'\"&";
    const html = environmentPage({
      contextRepo: hostile,
      contextBranch: hostile,
      envName: hostile
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain(
      '<input type="hidden" id="target-repo" value="octo/&lt;img src=x&gt;&#39;&quot;&amp;" />'
    );
    expect(html).toContain(
      'value="radius-deploy-octo-&lt;img src=x&gt;&#39;&quot;&amp;" data-default-name='
    );
    // The same repository reaches a JavaScript string, where it is JS-escaped
    // and still reads back as the original text.
    expect(readEmittedValue(html, "CTX_REPO")).toBe(hostile);
    expect(readEmittedValue(html, "CTX_BRANCH")).toBe(hostile);
    expectSafeInlineScripts(html);
  });
});
