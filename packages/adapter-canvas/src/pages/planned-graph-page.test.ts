import { describe, it, expect } from "vitest";
import { plannedGraphPage } from "./planned-graph-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";
import {
  createFakeStatus,
  extractBrowserFunction,
  type FetchCall
} from "../../test/support/pages/browser-script.js";

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

// Graph sub-tab navigation is a client-side partial swap (radiusNavTo replaces
// #graph-page-content), so the document never unloads and a plan scheduled by
// the page being left behind still runs — against a DOM whose controls are
// gone. Both emitted copies of runPlan must resolve their elements before
// dereferencing them.
interface PlanHarness {
  runPlan: (isCurrent: () => boolean) => Promise<void>;
  fetchCalls: FetchCall[];
}

function loadPlanScript(
  html: string,
  elements: Record<string, unknown>,
  options: { hasEnv?: boolean; envsStale?: boolean } = {}
): PlanHarness {
  const fetchCalls: FetchCall[] = [];
  const runPlan = new Function(
    "document",
    "window",
    "fetch",
    "CONTEXT_REPO",
    "CONTEXT_BRANCH",
    "ENV_PROVIDERS",
    "RADIUS_PLAN_HAS_ENV",
    "RADIUS_PLAN_ENVS_STALE",
    "RADIUS_PLAN_REQUEST_FAILED",
    "setInterval",
    "clearInterval",
    "setTimeout",
    `${extractBrowserFunction(html, "runPlan")}\nreturn runPlan;`
  )(
    { getElementById: (id: string) => elements[id] ?? null },
    { location: { reload: () => undefined } },
    (url: string, init: { body: string }) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({
        json: () => Promise.resolve({ message: "ok" })
      });
    },
    "octo/app",
    "main",
    { prod: "azure" },
    options.hasEnv ?? true,
    options.envsStale ?? false,
    false,
    () => 1,
    () => undefined,
    () => 1
  ) as PlanHarness["runPlan"];
  return { runPlan, fetchCalls };
}

function planControls(): Record<string, unknown> {
  const container = {
    innerHTML: "",
    querySelector: () => null,
    appendChild: () => undefined
  };
  return {
    "planned-branch": { value: "feature-x" },
    "planned-env": { value: "prod" },
    "plan-status": createFakeStatus(),
    "graph-container-wrapper": { innerHTML: "" },
    "graph-container": container,
    "progress-steps": container
  };
}

describe.each([
  [
    "empty state",
    () => plannedGraphPage({ contextRepo: "octo/app", contextBranch: "main" })
  ],
  [
    "rendered plan",
    () =>
      plannedGraphPage({
        plannedResources: sampleResources,
        plannedRepo: "octo/app",
        plannedBranch: "main"
      })
  ]
] as Array<[string, () => string]>)(
  "plannedGraphPage (%s) — runPlan after a client-side sub-tab swap",
  (_name, render) => {
    it("resolves without a request when every plan control has been swapped out", async () => {
      const harness = loadPlanScript(render(), {});
      await expect(harness.runPlan(() => true)).resolves.toBeUndefined();
      expect(harness.fetchCalls).toEqual([]);
    });

    it.each(["planned-branch", "planned-env"])(
      "resolves without a request when only #%s is missing",
      async (missing) => {
        const elements = planControls();
        delete elements[missing];
        const harness = loadPlanScript(render(), elements);
        await expect(harness.runPlan(() => true)).resolves.toBeUndefined();
        expect(harness.fetchCalls).toEqual([]);
      }
    );

    it("resolves without a request when the graph container is gone", async () => {
      const elements = planControls();
      delete elements["graph-container"];
      const harness = loadPlanScript(render(), elements);
      await expect(harness.runPlan(() => true)).resolves.toBeUndefined();
      expect(harness.fetchCalls).toEqual([]);
    });

    it("still plans against the selected branch and environment", async () => {
      const harness = loadPlanScript(render(), planControls());
      await harness.runPlan(() => true);
      expect(harness.fetchCalls).toEqual([
        {
          url: "/api/plan-graph",
          body: {
            repo: "octo/app",
            branch: "feature-x",
            provider: "azure",
            environment: "prod"
          }
        }
      ]);
    });
  }
);

// The empty-state copy renders into a wrapper it recreates on each run, so that
// lookup is a stale-DOM hazard of its own, distinct from the graph container.
describe("plannedGraphPage (empty state) — runPlan without its graph wrapper", () => {
  it("resolves without a request when the wrapper has been swapped out", async () => {
    const elements = planControls();
    delete elements["graph-container-wrapper"];
    const harness = loadPlanScript(
      plannedGraphPage({ contextRepo: "octo/app", contextBranch: "main" }),
      elements
    );
    await expect(harness.runPlan(() => true)).resolves.toBeUndefined();
    expect(harness.fetchCalls).toEqual([]);
  });
});
