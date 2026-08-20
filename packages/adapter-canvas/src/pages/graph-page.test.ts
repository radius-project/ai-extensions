import { describe, expect, it } from "vitest";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import { HOSTILE_STATE } from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { graphPage } from "./graph-page.js";

describe("graphPage", () => {
  it("renders the unloaded selector state and one generated entry", () => {
    const html = graphPage({
      graphTargetRepo: "octo/app",
      graphBranch: "feature"
    });
    expect(html).toContain('id="graph-app"');
    expect(html).toContain('id="graph-branch"');
    expect(html).toContain('<label for="graph-app">Application</label>');
    expect(html).toContain('<label for="graph-branch">Branch</label>');
    expect(html).toContain('id="graph-container-wrapper"');
    expect(html).toContain(browserEntryMarker("graph-page"));
    expect(html.split(browserScript("graph-page"))).toHaveLength(2);
    expect(readBrowserPageState(html, "radius-graph-page-state")).toEqual({
      repo: "octo/app",
      branch: "feature",
      resources: [],
      loaded: false,
      localSource: false
    });
  });

  it("renders resources with worktree provenance", () => {
    const resources = [{ id: "app/web", name: "web" }];
    const html = graphPage({
      graphResources: resources,
      graphLoaded: true,
      graphTargetRepo: "octo/app",
      graphBranch: "worktree",
      graphFromWorkspace: true
    });
    expect(html).toContain('id="graph-container"');
    expect(html).toContain('id="graph-refresh-status"');
    expect(readBrowserPageState(html, "radius-graph-page-state")).toEqual({
      repo: "octo/app",
      branch: "worktree",
      resources,
      loaded: true,
      localSource: true
    });
  });

  it("keeps hostile repository and branch state inert", () => {
    const html = graphPage({
      graphTargetRepo: HOSTILE_STATE,
      graphBranch: HOSTILE_STATE
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(readBrowserPageState(html, "radius-graph-page-state")).toMatchObject(
      {
        repo: HOSTILE_STATE,
        branch: HOSTILE_STATE
      }
    );
  });
});
