import { describe, it, expect, vi } from "vitest";
import { graphPage } from "./graph-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";
import { extractBrowserFunction } from "../../test/support/pages/browser-script.js";

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

describe("graphPage — state rendering and escaping", () => {
  it("offers the branch selector and generation guidance before a graph exists", () => {
    const html = graphPage({ contextRepo: "octo/app" });
    expect(html).toContain('id="graph-app"');
    expect(html).toContain('id="graph-branch"');
    expect(html).toContain(
      "Select a branch to generate the application graph."
    );
    expect(html).toContain(
      '<button id="deploy-app-btn" class="rad-btn rad-btn--primary" style="margin-top:0;" disabled>Plan Deployment</button>'
    );
    expect(html).toContain('id="graph-container-wrapper"');
  });

  it("names the app-bicep skill as the author of a missing model", () => {
    const html = graphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill."
    );
    expect(html).toContain("Drafting .radius/app.bicep");
    // The recipe-pack model has no server-side bicep generation endpoint.
    expect(html).not.toContain("/generated-bicep");
    expect(html).not.toContain("/api/generate-bicep");
  });

  it("reports load failures instead of leaving the progress view running", () => {
    const html = graphPage({ contextRepo: "octo/app" });
    expect(html).toContain(
      "setProgressState(Math.min(lastProgressPercent, 95), 'Graph generation failed', 'Error: ' + d.error, 'The workflow stopped before completion.', 'error');"
    );
    expect(html).toContain(
      "setProgressState(Math.min(lastProgressPercent, 95), 'Graph generation failed', 'Failed to continue generating the application graph.', 'Please try again.', 'error');"
    );
    expect(html).toContain(
      "setProgressState(100, 'Application graph ready', 'Application graph generated successfully.', 'Completed successfully.', 'success');"
    );
  });

  it("mounts the resolved graph with the selected branch and repository", () => {
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: "octo/app",
      graphBranch: "feature/x"
    });
    expect(html).toContain(
      '<input type="hidden" id="graph-repo" value="octo/app">'
    );
    expect(html).toContain('<option value="feature/x" selected>feature/x<');
    expect(html).toContain('<div id="graph-container"></div>');
    expect(html).toContain('id="graph-refresh-status"');
    expect(html).toContain("var CURRENT_BRANCH = 'feature/x';");
  });

  it("serializes the graph resources so the browser parses the same structure", () => {
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: "octo/app"
    });
    const serialized = html.match(/var resources = (\[[\s\S]*?\]);/)?.[1];
    expect(serialized).toBeTruthy();
    expect(JSON.parse(String(serialized))).toEqual(sampleResources);
  });

  it("falls back to main when no branch is known", () => {
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: "octo/app",
      graphBranch: ""
    });
    expect(html).toContain("var CURRENT_BRANCH = 'main';");
  });

  it("keeps hostile repository and branch context inside their script strings", () => {
    const initial = graphPage({
      contextRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE
    });
    expectSafeInlineScripts(initial);
    expect(readEmittedValue(initial, "CONTEXT_REPO")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(initial, "CONTEXT_BRANCH")).toBe(HOSTILE_STATE);

    const loaded = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: HOSTILE_STATE,
      graphBranch: HOSTILE_STATE
    });
    expectSafeInlineScripts(loaded);
    expect(readEmittedValue(loaded, "CURRENT_BRANCH")).toBe(HOSTILE_STATE);
    // The repository still reaches an HTML attribute, which stays escaped.
    expect(loaded).not.toContain('value="</script>');
  });

  it("serializes hostile graph resources without ending the script element", () => {
    const html = graphPage({
      graphResources: [
        {
          id: HOSTILE_STATE,
          name: HOSTILE_STATE,
          type: HOSTILE_STATE,
          connections: []
        }
      ],
      graphTargetRepo: "octo/app"
    });
    expectSafeInlineScripts(html);
    expect(readEmittedValue(html, "resources")).toEqual([
      {
        id: HOSTILE_STATE,
        name: HOSTILE_STATE,
        type: HOSTILE_STATE,
        connections: []
      }
    ]);
  });

  it("escapes repository and branch context for the HTML attributes it renders", () => {
    const hostile = "octo/<img src=x>'\"&";
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: hostile,
      graphBranch: hostile
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain(
      '<input type="hidden" id="graph-repo" value="octo/&lt;img src=x&gt;&#39;&quot;&amp;">'
    );
    expect(html).toContain(
      '<option value="octo/&lt;img src=x&gt;&#39;&quot;&amp;" selected>'
    );
    // The same value reaches a JavaScript string, where it is JS-escaped rather
    // than HTML-escaped, and still reads back as the original text.
    expect(readEmittedValue(html, "CURRENT_BRANCH")).toBe(hostile);
    expectSafeInlineScripts(html);
  });

  it("renders an API-provided hostile branch as text when the selection changes", async () => {
    const html = graphPage({
      graphResources: sampleResources,
      graphTargetRepo: "octo/app",
      graphBranch: "main"
    });
    const container = { innerHTML: "" };
    const branchText = { textContent: "" };
    const branchOptions: Array<{
      value: string;
      textContent: string;
      selected: boolean;
    }> = [];
    const branchSelect = {
      innerHTML: "",
      appendChild: (option: (typeof branchOptions)[number]) =>
        branchOptions.push(option)
    };
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    const browserFunctions = new Function(
      "document",
      "fetch",
      "window",
      "CONTEXT_REPO",
      "CURRENT_BRANCH",
      `${extractBrowserFunction(html, "handleGraphBranchChange")}
${extractBrowserFunction(html, "populateGraphBranches")}
return {
  handleGraphBranchChange: handleGraphBranchChange,
  populateGraphBranches: populateGraphBranches
};`
    )(
      {
        getElementById: (id: string) =>
          ({
            "graph-container": container,
            "graph-regeneration-branch": branchText,
            "graph-branch": branchSelect
          })[id] ?? null,
        createElement: () => ({ value: "", textContent: "", selected: false })
      },
      (url: string, init: { body: string }) => {
        fetchCalls.push({ url, body: JSON.parse(init.body) });
        return Promise.resolve({
          json: () =>
            Promise.resolve(
              url === "/api/discover-branches" ?
                {
                  branches: [{ name: HOSTILE_STATE, sha: "worktree" }]
                }
              : {}
            )
        });
      },
      { location: { reload: () => undefined } },
      "octo/app",
      "main"
    ) as {
      handleGraphBranchChange: (this: { value: string }) => void;
      populateGraphBranches: () => void;
    };

    browserFunctions.populateGraphBranches();
    await vi.waitFor(() => expect(branchOptions).toHaveLength(1));
    browserFunctions.handleGraphBranchChange.call({
      value: branchOptions[0].value
    });

    expect(branchOptions[0].value).toBe(HOSTILE_STATE);
    expect(branchOptions[0].textContent).toContain(HOSTILE_STATE);
    expect(container.innerHTML).not.toContain("<script>alert(1)");
    expect(container.innerHTML).toContain('id="graph-regeneration-branch"');
    expect(branchText.textContent).toBe(HOSTILE_STATE);
    expect(fetchCalls).toEqual([
      {
        url: "/api/discover-branches",
        body: { repo: "octo/app" }
      },
      {
        url: "/api/load-graph",
        body: { repo: "octo/app", branch: HOSTILE_STATE }
      }
    ]);
    expect(html).toContain(
      "addEventListener('change', handleGraphBranchChange)"
    );
  });
});
