import { describe, expect, it } from "vitest";
import { createRadiusCanvasInstanceRegistry } from "./canvas-instance-registry.js";

describe("createRadiusCanvasInstanceRegistry", () => {
  it("keeps the first live instance authoritative until it closes", () => {
    const registry = createRadiusCanvasInstanceRegistry();

    expect(registry.claim("legacy-panel")).toBe("legacy-panel");
    expect(registry.claim("radius-panel")).toBe("legacy-panel");
    expect(registry.current()).toBe("legacy-panel");

    registry.release("radius-panel");
    expect(registry.current()).toBe("legacy-panel");

    registry.release("legacy-panel");
    expect(registry.current()).toBeUndefined();
    expect(registry.claim("radius-panel")).toBe("radius-panel");
  });
});
