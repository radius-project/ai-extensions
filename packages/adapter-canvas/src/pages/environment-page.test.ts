import { describe, expect, it } from "vitest";
import { ENVIRONMENT_PAGE_STATE_ID } from "../browser/environment/page.js";
import { DEPLOY_RESULT_STATE_ID } from "../browser/pages/deploy-result-page.js";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts
} from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { environmentPage } from "./environment-page.js";

describe("environmentPage", () => {
  it("renders both environment and credential panes with the environments tab active", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      contextBranch: "feature/x"
    });

    expect(html).toContain('id="pane-environments" style=""');
    expect(html).toContain('id="pane-credentials" style="display:none;"');
    expect(html).toContain('data-subtab="environments"');
    expect(html).toContain('data-subtab="credentials"');
    expect(html).toContain('id="env-table-body"');
    expect(html).toContain('id="cred-table-body"');
  });

  it("activates the credentials pane from page state", () => {
    const html = environmentPage({
      activeSubtab: "credentials",
      contextRepo: "octo/app"
    });

    expect(html).toContain('id="pane-environments" style="display:none;"');
    expect(html).toContain('id="pane-credentials" style=""');
    expect(html).toContain(
      'data-subtab="credentials" class="rad-subtab rad-subtab--active"'
    );
  });

  it("renders operation progress, recovery, credential, and discovery controls", () => {
    const html = environmentPage({ contextRepo: "octo/app" });

    for (const id of [
      "env-progress-panel",
      "env-progress-stages",
      "env-progress-steps",
      "env-progress-failure",
      "env-progress-resume",
      "env-progress-dismiss",
      "env-smr-modal",
      "env-appselect-modal",
      "env-profile-button",
      "env-gh-account-button",
      "az-use-existing-link",
      "cred-provider-select",
      "btn-verify-azure",
      "btn-verify-aws",
      "save-cred-btn",
      "deploy-btn"
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="env-progress-overlay"');
    expect(html).not.toContain("type=range");
  });

  it("serializes state and injects the environment entry exactly once", () => {
    const html = environmentPage({
      contextRepo: "octo/app",
      contextBranch: "feature/x",
      activeSubtab: "credentials"
    });

    expect(readBrowserPageState(html, ENVIRONMENT_PAGE_STATE_ID)).toEqual({
      repo: "octo/app",
      branch: "feature/x",
      activeSubtab: "credentials"
    });
    expect(html).toContain(browserEntryMarker("environment-page"));
    expect(html.split(browserScript("environment-page"))).toHaveLength(2);
    expectSafeInlineScripts(html);
  });

  it("preserves state fallback and escapes hostile form values", () => {
    const html = environmentPage({
      targetRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE,
      envName: HOSTILE_STATE
    });

    expect(readBrowserPageState(html, ENVIRONMENT_PAGE_STATE_ID)).toEqual({
      repo: HOSTILE_STATE,
      branch: HOSTILE_STATE,
      activeSubtab: "environments"
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expectSafeInlineScripts(html);
  });
});

describe("environmentPage deployment result", () => {
  it("renders a successful result with a safe workflow link and reset entry", () => {
    const html = environmentPage({
      deployAttempt: { id: "attempt-1" },
      deployResult: {
        message: "Started",
        workflowUrl: "https://github.com/octo/app/actions/runs/1",
        workflow: "name: deploy"
      }
    });

    expect(html).toContain("Deployment Initiated");
    expect(html).toContain("Started");
    expect(html).toContain('href="https://github.com/octo/app/actions/runs/1"');
    expect(html).toContain("name: deploy");
    expect(readBrowserPageState(html, DEPLOY_RESULT_STATE_ID)).toEqual({
      attemptId: "attempt-1"
    });
    expect(html).toContain(browserEntryMarker("deploy-result-page"));
    expect(html.split(browserScript("deploy-result-page"))).toHaveLength(2);
  });

  it("renders explicit failure and drops unsafe workflow URLs", () => {
    const html = environmentPage({
      deployResult: {
        error: "<failed>",
        message: "",
        workflowUrl: "javascript:alert(1)"
      }
    });

    expect(html).toContain("Deployment Failed");
    expect(html).toContain("&lt;failed&gt;");
    expect(html).not.toContain("javascript:");
    expect(readBrowserPageState(html, DEPLOY_RESULT_STATE_ID)).toEqual({
      attemptId: ""
    });
    expectSafeInlineScripts(html);
  });

  it("keeps hostile result and attempt data inert", () => {
    const html = environmentPage({
      deployAttempt: { id: HOSTILE_STATE },
      deployResult: {
        error: HOSTILE_STATE,
        message: "",
        workflowUrl: HOSTILE_STATE,
        workflow: HOSTILE_STATE
      }
    });

    expect(readBrowserPageState(html, DEPLOY_RESULT_STATE_ID)).toEqual({
      attemptId: HOSTILE_STATE
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expectSafeInlineScripts(html);
  });
});
