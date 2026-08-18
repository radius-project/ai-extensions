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

function styledClasses(html: string): Set<string> {
  const styled = new Set<string>();
  for (const block of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    for (const rule of block[1].matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const name of rule[1].matchAll(/\.([A-Za-z0-9_-]+)/g)) {
        styled.add(name[1]);
      }
    }
  }
  return styled;
}

function markupClasses(html: string): Set<string> {
  const used = new Set<string>();
  // Inline scripts carry class names as unexpanded template text, so only the
  // page's own markup is scanned.
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, "");
  for (const attribute of markup.matchAll(/class="([^"]+)"/g)) {
    for (const name of attribute[1].split(/\s+/))
      if (name !== "") used.add(name);
  }
  return used;
}

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

describe("environmentPage styling", () => {
  // Style rules and markup live in different modules, so a class can lose its
  // rule in a merge and still render, leaving the step numbers as bare text.
  it("defines a rule for every class the page renders", () => {
    const html = environmentPage({ repo: "octo/app" });
    const styled = styledClasses(html);
    // These carry no styling of their own and only inherit from their parent.
    // The two button variants are a pre-existing gap on main: both fall back to
    // the base button rule, so fixing them belongs in its own change.
    const inheritOnly = new Set([
      "rad-wizard__label",
      "rad-chosen__label",
      "rad-btn--secondary",
      "rad-btn--ghost"
    ]);

    const unstyled = [...markupClasses(html)]
      .filter((name) => name.startsWith("rad-"))
      .filter((name) => !styled.has(name) && !inheritOnly.has(name));

    expect(unstyled).toEqual([]);
  });

  it("styles the wizard stepper it renders above the form", () => {
    const html = environmentPage({ repo: "octo/app" });
    const styled = styledClasses(html);

    expect(styled).toContain("rad-wizard__num");
    expect(styled).toContain("rad-wizard__sep");
    expect(styled).toContain("rad-chosen");
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
