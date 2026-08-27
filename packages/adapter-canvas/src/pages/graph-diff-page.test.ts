import { describe, expect, it } from "vitest";
import { browserEntryMarker, browserScript } from "../browser/scripts.js";
import { HOSTILE_STATE } from "../../test/support/pages/hostile-state.js";
import { readBrowserPageState } from "../../test/support/pages/browser-state.js";
import { unlabelledSelectIds } from "../../test/support/pages/labelled-controls.js";
import { graphDiffPage } from "./graph-diff-page.js";

describe("graphDiffPage", () => {
  it("gives every branch and application selector a programmatic name", () => {
    expect(
      unlabelledSelectIds(
        graphDiffPage({
          diffTargetRepo: "octo/app",
          diffBase: "main",
          diffHead: "feature"
        })
      )
    ).toEqual([]);
    expect(
      unlabelledSelectIds(
        graphDiffPage({
          diffTargetRepo: "octo/app",
          diffBase: "main",
          diffHead: "feature",
          branches: ["main", "feature"]
        })
      )
    ).toEqual([]);
  });

  it("renders the selector state and one generated entry", () => {
    const html = graphDiffPage({
      diffTargetRepo: "octo/app",
      diffBase: "main",
      diffHead: "feature"
    });
    expect(html).toContain('id="base-branch"');
    expect(html).toContain('id="head-branch"');
    expect(html).toContain(browserEntryMarker("graph-diff-page"));
    expect(html.split(browserScript("graph-diff-page"))).toHaveLength(2);
    expect(readBrowserPageState(html, "radius-graph-diff-state")).toEqual({
      repo: "octo/app",
      base: "main",
      head: "feature",
      workspaceBranch: "",
      resources: [],
      modelingError: ""
    });
  });

  it("renders diff counts and serializes resources", () => {
    const resources = [
      { id: "added", diffStatus: "added" },
      { id: "removed", diffStatus: "removed" },
      { id: "modified", diffStatus: "modified" },
      { id: "same", diffStatus: "unchanged" }
    ];
    const html = graphDiffPage({
      diffTargetRepo: "octo/app",
      diffBase: "main",
      diffHead: "feature",
      diffResources: resources
    });

    expect(html).toContain("+1 added");
    expect(html).toContain("-1 removed");
    expect(html).toContain("~1 modified");
    expect(html).toContain("1 unchanged");
    expect(html).toContain('id="graph-diff-summary"');
    expect(html).toContain(
      'style="color:var(--rad-diff-added)">+1 added</span>'
    );
    expect(html).toContain(
      'style="color:var(--rad-diff-removed)">-1 removed</span>'
    );
    expect(html).toContain(
      'style="color:var(--rad-diff-modified)">~1 modified</span>'
    );
    expect(readBrowserPageState(html, "radius-graph-diff-state")).toEqual({
      repo: "octo/app",
      base: "main",
      head: "feature",
      workspaceBranch: "",
      resources,
      modelingError: ""
    });
  });

  it("renders an empty diff compilation failure on the graph surface", () => {
    const html = graphDiffPage({
      diffTargetRepo: "octo/app",
      diffBase: "main",
      diffHead: "feature",
      diffError: "Your application model couldn't be compiled.",
      diffModelingFailed: true
    });

    expect(html).toContain('<div id="graph-container"></div>');
    expect(html).toContain(
      'id="diff-status" class="status error" style="display:none;"'
    );
    expect(readBrowserPageState(html, "radius-graph-diff-state")).toEqual({
      repo: "octo/app",
      base: "main",
      head: "feature",
      workspaceBranch: "",
      resources: [],
      modelingError: "Your application model couldn't be compiled."
    });
  });

  // The diff page is the only page that renders two branches at once, so it
  // ships the worktree branch name and lets the browser decide per node.
  it.each([
    ["populated", "octo/app", "feature"],
    ["empty for another repository", "other/app", ""]
  ])(
    "serializes a workspace branch %s on both the empty and populated payloads",
    (_label, workspaceRepo, expected) => {
      for (const diffResources of [
        [],
        [{ id: "added", diffStatus: "added" }]
      ]) {
        const html = graphDiffPage({
          diffTargetRepo: "octo/app",
          diffBase: "main",
          diffHead: "feature",
          diffResources,
          workspacePath: "C:\\work\\app",
          workspaceRepo,
          workspaceBranch: "feature"
        });
        expect(
          readBrowserPageState(html, "radius-graph-diff-state")
        ).toMatchObject({ workspaceBranch: expected });
      }
    }
  );

  it("keeps hostile branch and repository state inert", () => {
    const html = graphDiffPage({
      diffTargetRepo: HOSTILE_STATE,
      diffBase: HOSTILE_STATE,
      diffHead: HOSTILE_STATE
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(readBrowserPageState(html, "radius-graph-diff-state")).toMatchObject(
      {
        repo: HOSTILE_STATE,
        base: HOSTILE_STATE,
        head: HOSTILE_STATE
      }
    );
  });
});
