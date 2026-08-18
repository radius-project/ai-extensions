import { describe, expect, it } from "vitest";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import { HOSTILE_STATE } from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { deployedGraphPage } from "./deployed-graph-page.js";

describe("deployedGraphPage", () => {
  it("renders deployment controls, dialogs and one generated entry", () => {
    const html = deployedGraphPage({
      contextRepo: "octo/app",
      contextBranch: "feature",
      deployProvider: "azure"
    });
    expect(html).toContain('id="deployed-app-select"');
    expect(html).toContain('id="deployed-env-select"');
    expect(html).toContain('id="deploy-delete-modal"');
    expect(html).toContain('id="deployed-deleting-modal"');
    expect(html).toContain(browserEntryMarker("deployed-graph-page"));
    expect(html.split(browserScript("deployed-graph-page"))).toHaveLength(2);
    expect(readBrowserPageState(html, "radius-deployed-graph-state")).toEqual({
      repo: "octo/app",
      branch: "feature",
      graphBranch: "feature",
      provider: "azure"
    });
  });

  it("uses the session branch rather than defaulting to main", () => {
    const html = deployedGraphPage({
      deployingRepo: "octo/app",
      deployingBranch: "worktree"
    });
    expect(
      readBrowserPageState(html, "radius-deployed-graph-state")
    ).toMatchObject({
      repo: "octo/app",
      graphBranch: "worktree"
    });
  });

  it("keeps hostile state inert", () => {
    const html = deployedGraphPage({
      contextRepo: HOSTILE_STATE,
      contextBranch: HOSTILE_STATE
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(
      readBrowserPageState(html, "radius-deployed-graph-state")
    ).toMatchObject({
      repo: HOSTILE_STATE,
      branch: HOSTILE_STATE
    });
  });
});
