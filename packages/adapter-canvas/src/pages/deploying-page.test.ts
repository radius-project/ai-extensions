import { describe, it, expect } from "vitest";
import { deployingPage } from "./deploying-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";

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
      "var delDisabled = (status === 'pending' || status === 'deleting' || dep.synthetic) ? ' disabled' : '';"
    );
    expect(html).toContain("function resumeRedirectedDeployment()");
    expect(html).toContain("OP_STATUS[key] = 'pending'");
    expect(html).toContain(
      "if (!recordSeen && DEPLOY_RECORDS_PRESENT[key]) recordSeen = true"
    );
    expect(html).toContain("if (!recordSeen) loadDeployments(true, true)");
    expect(html).toContain(
      "if (!resumeRedirectedDeployment()) loadDeployments()"
    );
    // A server-side 409 must unwind the optimistic row rather than pretending
    // the conflicting deployment started successfully.
    expect(html).toContain("if (result.ok) return;");
    expect(html).toContain(
      "(result.d && result.d.error) || 'Could not start the deployment.'"
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

describe("deployingPage — listing states, deployment context and escaping", () => {
  const html = deployingPage({
    contextRepo: "octo/app",
    contextBranch: "feature/x"
  });

  it("offers the three selectors with the deploy action disabled until they load", () => {
    expect(html).toContain('id="deploy-app-select"');
    expect(html).toContain('id="deploy-env-select"');
    expect(html).toContain('id="deploy-branch-select"');
    expect(html).toContain(
      '<button id="deploy-now-btn" class="rad-btn rad-btn--primary" style="margin:0;" disabled>Deploy</button>'
    );
    expect(html).toContain("Loading deployments…");
  });

  it("maps every deployment status to its own dot and label", () => {
    expect(html).toContain(
      "var map = { success: ['success','Success'], failed: ['failed','Failed'], pending: ['pending','Pending'], deleting: ['deleting','Deleting…'] };"
    );
  });

  it("keeps the last-known listing visible when the listing request fails", () => {
    expect(html).toContain("Could not load deployments.");
    expect(html).toContain("function loadDeployments(fresh, quiet) {");
  });

  it("acknowledges a started deployment and reports a failed one with its run", () => {
    expect(html).toContain(
      "showInline('success', 'Deployment of application <strong>' + escapeHtmlClient(app)"
    );
    expect(html).toContain(
      "function showDeployFailed(app, env, errText, runUrl, kind, branch, repairing, handoff)"
    );
    expect(html).toContain('id="deploy-progress-fail-actions"');
    expect(html).toContain('id="deploy-fail-repair-note"');
  });

  it("explains the automatic repair attempt rather than silently retrying", () => {
    expect(html).toContain(
      "Copilot is analyzing the failure and will repair and redeploy if the app model caused it — follow along in the chat."
    );
  });

  it("renders the deployments section of the top navigation", () => {
    expect(html).toContain("<title>Deployments — Radius</title>");
    expect(html).toContain(
      '<a href="/?page=deploying" class="rad-topnav__tab rad-topnav__tab--active"'
    );
  });

  it("serializes the repository and branch context as JSON literals", () => {
    expect(html).toContain('var CTX_REPO = "octo/app";');
    expect(html).toContain('var CTX_BRANCH = "feature/x";');
  });

  it("falls back through planned, graph and deploying context before defaulting the branch", () => {
    expect(deployingPage({ plannedRepo: "octo/planned" })).toContain(
      'var CTX_REPO = "octo/planned";'
    );
    expect(deployingPage({ graphTargetRepo: "octo/graph" })).toContain(
      'var CTX_REPO = "octo/graph";'
    );
    expect(deployingPage({ deployingRepo: "octo/deploying" })).toContain(
      'var CTX_REPO = "octo/deploying";'
    );
    expect(deployingPage({})).toContain('var CTX_BRANCH = "main";');
  });

  it("escapes the branch in the selector and keeps a hostile repo inside its JSON literal", () => {
    const hostile = "octo/<img src=x>'\"&";
    const rendered = deployingPage({
      contextRepo: hostile,
      contextBranch: hostile
    });
    // The branch reaches an HTML attribute and text node, so it is HTML-escaped;
    // the repository reaches a JavaScript string, so it is JSON-encoded.
    expect(rendered).toContain(
      '<option value="octo/&lt;img src=x&gt;&#39;&quot;&amp;">octo/&lt;img src=x&gt;&#39;&quot;&amp;</option>'
    );
    expect(readEmittedValue(rendered, "CTX_REPO")).toBe(hostile);
    expectSafeInlineScripts(rendered);
  });

  it("survives state that tries to close the script element", () => {
    const rendered = deployingPage({
      contextRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE
    });
    expectSafeInlineScripts(rendered);
    expect(readEmittedValue(rendered, "CTX_REPO")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(rendered, "CTX_BRANCH")).toBe(HOSTILE_STATE);
    expect(rendered).not.toContain("<script>alert(1)</script>");
  });
});
