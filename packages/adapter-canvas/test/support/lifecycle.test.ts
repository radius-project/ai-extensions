import { describe, expect, it } from "vitest";
import {
  createLifecycleFixture,
  createStrictLifecyclePorts
} from "./lifecycle.js";

describe("strict lifecycle support", () => {
  it("throws on every unmodeled port rather than manufacturing successful outcomes", async () => {
    const ports = createStrictLifecyclePorts();
    for (const [family, port] of Object.entries(ports)) {
      for (const [name, method] of Object.entries(port)) {
        if (typeof method !== "function")
          throw new Error("Port member is not callable");
        if (family === "ids" || (family === "clock" && name === "now")) {
          expect(() => Reflect.apply(method, port, [])).toThrow(
            `${family}.${name}`
          );
        } else {
          await expect(Reflect.apply(method, port, [])).rejects.toThrow(
            `${family}.${name}`
          );
        }
      }
    }
  });
  it("creates isolated deterministic IDs, real state, and once-only guarded continuations", async () => {
    const first = createLifecycleFixture();
    const second = createLifecycleFixture();
    const action = await first.pendingAction();
    expect(second.binding.registry.knownOperations()).toEqual([]);
    expect(await first.binding.execute(action.intent)).toMatchObject({
      result: { state: "running" }
    });
    expect(await first.binding.execute(action.intent)).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(action.continuations()).toBe(1);
    await first.binding.close();
    await second.binding.close();
  });
});
