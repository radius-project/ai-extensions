import { describe, expect, it } from "vitest";
import { deletionInventoryResources } from "./deletion-inventory.js";

describe("deletionInventoryResources", () => {
  const resources = [{ name: "web", type: "Applications.Core/containers" }];

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      mode: "terminal",
      deletionInventory: {
        application: "app",
        environment: "dev",
        resources
      },
      ...overrides
    };
  }

  it("returns the resources when the inventory answers for the pair", () => {
    expect(deletionInventoryResources(payload(), "app", "dev")).toEqual(
      resources
    );
  });

  // The graph and the inventory can disagree on casing without disagreeing on
  // which deployment they describe.
  it("matches identity without regard to case", () => {
    expect(deletionInventoryResources(payload(), "APP", "DeV")).toEqual(
      resources
    );
  });

  it.each([
    ["a graph that is only modeled", payload({ mode: "greyed" }), "app", "dev"],
    [
      "a response with no mode",
      { deletionInventory: payload().deletionInventory },
      "app",
      "dev"
    ],
    ["an unnamed application", payload(), "", "dev"],
    ["an unnamed environment", payload(), "app", ""],
    ["another application's inventory", payload(), "other", "dev"],
    ["another environment's inventory", payload(), "app", "prod"],
    ["a response with no inventory", { mode: "terminal" }, "app", "dev"],
    ["a payload that is not a record", "nope", "app", "dev"]
  ])("names nothing for %s", (_label, body, application, environment) => {
    expect(deletionInventoryResources(body, application, environment)).toEqual(
      []
    );
  });
});
