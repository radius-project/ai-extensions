import { describe, expect, it } from "vitest";
import {
  createLifecycleRouting,
  type KnownLifecycleOperation
} from "./lifecycle-routing.js";

describe("per-family lifecycle routing", () => {
  it("keeps current mutation families on legacy routing", () => {
    const routing = createLifecycleRouting({ knownOperations: () => [] });
    expect(routing.selection("environment").writer).toBe("legacy");
    expect(routing.selection("deployment").writer).toBe("legacy");
    expect(routing.claimDispatch("deployment", "op")).toBe("legacy");
    expect(() => routing.claimDispatch("deployment", "op")).toThrow(
      "redispatched"
    );
  });
  it("retains legacy/new readers and controls across cutover and rollback without executing work", () => {
    const operations: KnownLifecycleOperation[] = [
      {
        operationId: "old",
        family: "environment",
        owner: "legacy",
        needsControl: true
      }
    ];
    const routing = createLifecycleRouting({
      knownOperations: () => operations
    });
    expect(() =>
      routing.transition("environment", {
        writer: "lifecycle",
        readers: ["lifecycle"],
        controllers: ["lifecycle"]
      })
    ).toThrow("orphan");
    routing.transition("environment", {
      writer: "lifecycle",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    expect(routing.claimDispatch("environment", "new")).toBe("lifecycle");
    routing.transition("environment", {
      writer: "legacy",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    expect(routing.address("old", true)).toBe("legacy");
    expect(routing.address("new", true)).toBe("lifecycle");
    expect(() =>
      routing.transition("environment", {
        writer: "legacy",
        readers: ["legacy"],
        controllers: ["legacy"]
      })
    ).toThrow("orphan");
    expect(() => routing.claimDispatch("environment", "new")).toThrow(
      "redispatched"
    );
  });
  it("rejects missing inventories, incompatible writers and contradictory identities", () => {
    expect(() =>
      Reflect.apply(createLifecycleRouting, undefined, [{}])
    ).toThrow("inventory");
    const routing = createLifecycleRouting({ knownOperations: () => [] });
    expect(() =>
      routing.transition("definition", {
        writer: "legacy",
        readers: [],
        controllers: []
      })
    ).toThrow("compatible");
    expect(() => routing.address("missing")).toThrow("not known");
    const conflicting = createLifecycleRouting({
      knownOperations: () => [
        {
          operationId: "same",
          family: "environment",
          owner: "legacy",
          needsControl: true
        },
        {
          operationId: "same",
          family: "environment",
          owner: "lifecycle",
          needsControl: true
        }
      ]
    });
    expect(() => conflicting.address("same")).toThrow("Conflicting");
  });
  it("fails closed if newly discovered records have no compatible reader or controller", () => {
    const operations: KnownLifecycleOperation[] = [];
    const routing = createLifecycleRouting({
      knownOperations: () => operations
    });
    routing.transition("environment", {
      writer: "legacy",
      readers: ["legacy"],
      controllers: ["legacy"]
    });
    operations.push({
      operationId: "discovered",
      family: "environment",
      owner: "lifecycle",
      needsControl: true
    });
    expect(() => routing.address("discovered")).toThrow("compatible reader");
    expect(() => routing.address("discovered", true)).toThrow(
      "compatible reader"
    );
    expect(() =>
      Reflect.apply(routing.selection, undefined, ["unknown"])
    ).toThrow("Unknown");
    operations.push({
      operationId: "discovered",
      family: "definition",
      owner: "lifecycle",
      needsControl: true
    });
    expect(() => routing.address("discovered")).toThrow("Conflicting");
  });
});
