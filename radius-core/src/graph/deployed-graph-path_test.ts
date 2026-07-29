import { describe, expect, it } from "vitest";
import {
  DEFAULT_RADIUS_SCOPE,
  RADIUS_GRAPH_BRANCH,
  deployedGraphPath,
} from "./deployed-graph-path.js";

describe("deployed-graph-path constants", () => {
  it("names the orphan branch used by the reader/writer contract", () => {
    expect(RADIUS_GRAPH_BRANCH).toBe("radius-graph");
  });

  it("defaults the Radius resource-group scope to the CLI default", () => {
    // Kept in sync with MODELED_GRAPH_DEFAULTS.resourceGroup so a scaffold
    // built from the modeled graph and the persisted deployed graph agree on
    // where a resource lives.
    expect(DEFAULT_RADIUS_SCOPE).toBe("default");
  });
});

describe("deployedGraphPath", () => {
  it("addresses one deployment by (sourceBranch, scope, env)", () => {
    expect(
      deployedGraphPath({
        sourceBranch: "main",
        scope: "default",
        environment: "aks-dev",
      }),
    ).toBe("main/.radius/deployments/default-aks-dev/app-graph.json");
  });

  it("preserves '/'-separated source branches as a nested prefix", () => {
    // A feature/x branch reads as feature/x/.radius/... on the orphan branch,
    // so `git ls-tree radius-graph` at a glance still shows which source
    // branches have persisted artifacts.
    expect(
      deployedGraphPath({
        sourceBranch: "feature/x",
        scope: "default",
        environment: "dev",
      }),
    ).toBe("feature/x/.radius/deployments/default-dev/app-graph.json");
  });

  it("slugs the scope+env segment to a single legal directory name", () => {
    // Mixed case and non-alphanumerics collapse; a caller can't smuggle path
    // separators through the scope or environment inputs.
    expect(
      deployedGraphPath({
        sourceBranch: "main",
        scope: "My/Scope",
        environment: "Prod US",
      }),
    ).toBe("main/.radius/deployments/my-scope-prod-us/app-graph.json");
  });

  it.each([
    { sourceBranch: "" },
    { sourceBranch: "   " },
    { sourceBranch: "/main" },
    { sourceBranch: "main/" },
    { sourceBranch: "main/../etc" },
    { sourceBranch: "feature//x" },
    { sourceBranch: "main\\x" },
  ])("rejects invalid sourceBranch %j", ({ sourceBranch }) => {
    expect(() =>
      deployedGraphPath({
        sourceBranch,
        scope: "default",
        environment: "dev",
      }),
    ).toThrow(/sourceBranch/);
  });

  it("rejects a scope with no alphanumeric characters", () => {
    expect(() =>
      deployedGraphPath({
        sourceBranch: "main",
        scope: "---",
        environment: "dev",
      }),
    ).toThrow(/scope/);
  });

  it("rejects an environment with no alphanumeric characters", () => {
    expect(() =>
      deployedGraphPath({
        sourceBranch: "main",
        scope: "default",
        environment: "   ",
      }),
    ).toThrow(/environment/);
  });
});
