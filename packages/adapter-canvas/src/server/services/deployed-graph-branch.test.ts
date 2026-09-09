import { describe, expect, it } from "vitest";
import {
  modeledResourcesForBranch,
  resolveDeployedGraphBranch
} from "./deployed-graph-branch.js";
import type { CanvasState } from "../../shared.js";

const REPO = "octo/todolist";

function state(overrides: Partial<CanvasState> = {}): CanvasState {
  return { ...overrides } as CanvasState;
}

const workspaceMatches = () => true;
const workspaceDiffers = () => false;

describe("resolveDeployedGraphBranch", () => {
  it("prefers the worktree branch over every other source", () => {
    expect(
      resolveDeployedGraphBranch(
        state({
          workspaceBranch: "worktree",
          contextRepo: REPO,
          contextBranch: "context",
          graphTargetRepo: REPO,
          graphBranch: "graph"
        }),
        REPO,
        workspaceMatches
      )
    ).toBe("worktree");
  });

  it("ignores a worktree branch that belongs to another repository", () => {
    expect(
      resolveDeployedGraphBranch(
        state({
          workspaceBranch: "worktree",
          contextRepo: REPO,
          contextBranch: "context"
        }),
        REPO,
        workspaceDiffers
      )
    ).toBe("context");
  });

  it.each([
    [
      "the page context",
      { contextRepo: REPO, contextBranch: "context" },
      "context"
    ],
    [
      "the running deploy",
      { deployingRepo: REPO, deployingBranch: "deploying" },
      "deploying"
    ],
    [
      "the planned graph",
      { plannedRepo: REPO, plannedBranch: "planned" },
      "planned"
    ],
    [
      "the modeled graph",
      { graphTargetRepo: REPO, graphBranch: "graph" },
      "graph"
    ]
  ])("falls back to %s", (_label, overrides, expected) => {
    expect(
      resolveDeployedGraphBranch(state(overrides), REPO, workspaceDiffers)
    ).toBe(expected);
  });

  it("ignores branches recorded for a different repository", () => {
    expect(
      resolveDeployedGraphBranch(
        state({
          contextRepo: "octo/other",
          contextBranch: "context",
          graphTargetRepo: "octo/other",
          graphBranch: "graph"
        }),
        REPO,
        workspaceDiffers
      )
    ).toBe("main");
  });

  it("uses main only as the floor", () => {
    expect(resolveDeployedGraphBranch(state(), REPO, workspaceDiffers)).toBe(
      "main"
    );
  });
});

describe("modeledResourcesForBranch", () => {
  it("returns the modeled graph for exactly this repository and branch", () => {
    const resources = [{ id: "a", name: "api", type: "t" }];

    expect(
      modeledResourcesForBranch(
        state({
          graphTargetRepo: REPO,
          graphBranch: "main",
          graphResources: resources
        }),
        REPO,
        "main"
      )
    ).toBe(resources);
  });

  it.each([
    ["another repository", { graphTargetRepo: "octo/other" }],
    ["another branch", { graphBranch: "feature" }],
    ["no modeled graph", { graphResources: null }]
  ])("reports none for %s", (_label, overrides) => {
    expect(
      modeledResourcesForBranch(
        state({
          graphTargetRepo: REPO,
          graphBranch: "main",
          graphResources: [{ id: "a" }],
          ...overrides
        }),
        REPO,
        "main"
      )
    ).toBeNull();
  });
});
