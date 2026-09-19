import { describe, expect, it } from "vitest";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

describe("deploy service dependency validation", () => {
  it("accepts a set where every required seam is callable", () => {
    expect(() =>
      assertDeployDependencies(
        "createThing",
        { a: () => {}, b: () => {}, extra: 7 },
        ["a", "b"]
      )
    ).not.toThrow();
  });

  it("accepts an empty requirement list", () => {
    expect(() => assertDeployDependencies("createThing", {}, [])).not.toThrow();
  });

  it.each([
    ["absent", {}],
    ["undefined", { a: undefined }],
    ["null", { a: null }],
    ["a non-function value", { a: "not callable" }]
  ])("rejects a seam that is %s", (_name, provided) => {
    expect(() =>
      assertDeployDependencies<{ a?: unknown }>("createThing", provided, ["a"])
    ).toThrow("createThing is missing required dependencies: a");
  });

  it("names every missing seam in declaration order", () => {
    expect(() =>
      assertDeployDependencies<{
        a?: unknown;
        b?: unknown;
        c?: unknown;
      }>("createThing", { b: () => {} }, ["a", "b", "c"])
    ).toThrow("createThing is missing required dependencies: a, c");
  });
});
