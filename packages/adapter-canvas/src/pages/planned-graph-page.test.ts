import { describe, it, expect } from "vitest";
import { plannedGraphPage } from "./planned-graph-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";

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

  it("serializes selector-triggered planning in both render paths", () => {
    const empty = plannedGraphPage({
      contextRepo: "octo/app",
      contextBranch: "main"
    });
    const loaded = plannedGraphPage({
      plannedResources: sampleResources,
      plannedRepo: "octo/app",
      plannedBranch: "main"
    });
    for (const html of [empty, loaded]) {
      expect(html).toContain("radiusCreatePlanScheduler(runPlan");
      expect(html).toContain("if (!isCurrent()) return;");
      expect(html).toContain("RADIUS_PLAN_ENVS_STALE");
    }
  });
});

describe("plannedGraphPage — state rendering and guidance", () => {
  it("asks for a plan before one exists and disables the action until selectors load", () => {
    const html = plannedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      '<div id="plan-status" class="status info">Generating the planned application graph…</div>'
    );
    expect(html).toContain(
      '<button id="plan-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Loading…</button>'
    );
    expect(html).toContain('id="planned-app"');
    expect(html).toContain('id="planned-branch"');
    expect(html).toContain('id="planned-env"');
  });

  it("explains what is missing while a plan cannot be resolved", () => {
    const html = plannedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "Select a branch to preview the planned deployment."
    );
    expect(html).toContain(
      "Create an environment to preview the planned deployment for this application."
    );
    expect(html).toContain(
      "Environments could not be loaded. Try again before planning a deployment."
    );
  });

  it("surfaces planning errors and incomplete responses as errors, not silence", () => {
    const html = plannedGraphPage({ contextRepo: "octo/app" });
    expect(html).toContain("'Error: ' + d.error");
    expect(html).toContain(
      "The planned deployment response was incomplete. Try again."
    );
    expect(html).toContain("statusEl0.className = 'status error'");
  });

  it("points an unmodelled application at the app-bicep skill rather than generating a recipe", () => {
    const html = plannedGraphPage({
      plannedResources: sampleResources,
      plannedRepo: "octo/app"
    });
    expect(html).toContain(
      "Copilot is generating .radius/app.bicep with the Radius app-bicep skill"
    );
    expect(html).toContain("the planned graph will appear once it is saved.");
    for (const rendered of [html, plannedGraphPage({ contextRepo: "o/a" })]) {
      expect(rendered).not.toContain("/generated-bicep");
      expect(rendered).not.toContain("/api/generate-recipe");
    }
  });

  it("keeps the resolved plan's selectors, environment and provider context", () => {
    const html = plannedGraphPage({
      plannedResources: sampleResources,
      plannedRepo: "octo/app",
      plannedBranch: "feature/x",
      plannedEnvironment: "prod",
      plannedProvider: "aws"
    });
    expect(html).toContain("var CONTEXT_REPO = 'octo/app';");
    expect(html).toContain("var CONTEXT_BRANCH = 'feature/x';");
    expect(html).toContain("var CONTEXT_ENV = 'prod';");
    expect(html).toContain("ENV_PROVIDERS[env] || 'aws'");
    expect(html).toContain(
      "radiusDeployPlannedApp(this, CONTEXT_REPO, ENV_PROVIDERS, 'aws')"
    );
    const serialized = html.match(/var resources = (\[[\s\S]*?\]);/)?.[1];
    expect(JSON.parse(String(serialized))).toEqual(sampleResources);
  });

  it("defaults the provider to azure and the branch to main when nothing is selected", () => {
    const html = plannedGraphPage({});
    expect(html).toContain("ENV_PROVIDERS[env] || 'azure'");
    expect(html).toContain("var CONTEXT_BRANCH = 'main';");
    expect(html).toContain("var CONTEXT_ENV = '';");
  });

  it("keeps hostile repository, branch, environment and provider inside their script strings", () => {
    for (const html of [
      plannedGraphPage({
        contextRepo: HOSTILE_STATE,
        contextBranch: HOSTILE_STATE,
        envName: HOSTILE_STATE,
        deployProvider: HOSTILE_STATE
      }),
      plannedGraphPage({
        plannedResources: sampleResources,
        plannedRepo: HOSTILE_STATE,
        plannedBranch: HOSTILE_STATE,
        plannedEnvironment: HOSTILE_STATE,
        plannedProvider: HOSTILE_STATE
      })
    ]) {
      expectSafeInlineScripts(html);
      expect(readEmittedValue(html, "CONTEXT_REPO")).toBe(HOSTILE_STATE);
      expect(readEmittedValue(html, "CONTEXT_BRANCH")).toBe(HOSTILE_STATE);
      expect(readEmittedValue(html, "CONTEXT_ENV")).toBe(HOSTILE_STATE);
      // The provider is interpolated into a JavaScript string of its own, so it
      // must be JS-escaped there too.
      expect(html).toContain(
        "ENV_PROVIDERS[env] || '\\u003c/script\\u003e\\u003cscript\\u003e"
      );
    }
  });

  it("serializes hostile planned resources without ending the script element", () => {
    const resources = [
      {
        id: HOSTILE_STATE,
        name: HOSTILE_STATE,
        type: HOSTILE_STATE,
        connections: []
      }
    ];
    const html = plannedGraphPage({
      plannedResources: resources,
      plannedRepo: "octo/app"
    });
    expectSafeInlineScripts(html);
    expect(readEmittedValue(html, "resources")).toEqual(resources);
  });

  it("never emits raw markup from repository, branch or environment context", () => {
    // The planned page routes all of its state into JavaScript strings, so the
    // guarantee is JS escaping plus no raw markup anywhere in the document.
    const hostile = "octo/<img src=x>'\"&";
    for (const html of [
      plannedGraphPage({ contextRepo: hostile, contextBranch: hostile }),
      plannedGraphPage({
        plannedResources: sampleResources,
        plannedRepo: hostile,
        plannedBranch: hostile,
        plannedEnvironment: hostile
      })
    ]) {
      expect(html).not.toContain("<img src=x>");
      expect(readEmittedValue(html, "CONTEXT_REPO")).toBe(hostile);
      expect(readEmittedValue(html, "CONTEXT_BRANCH")).toBe(hostile);
      expectSafeInlineScripts(html);
    }
  });
});
