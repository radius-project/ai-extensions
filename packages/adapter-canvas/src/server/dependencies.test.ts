import { describe, expect, it, vi } from "vitest";
import type { CanvasServerDependencies } from "./ports.js";
import { createCanvasServer } from "./create-canvas-server.js";
import {
  composeCanvasServerDependencies,
  createProductionCanvasServerDependencies
} from "./dependencies.js";

function dependencies(): CanvasServerDependencies {
  return {
    createHttpServer: vi.fn(),
    createRequestHandler: vi.fn(),
    createState: vi.fn(() => ({})),
    defaultPage: "graph",
    now: vi.fn(() => 10),
    preferredPort: vi.fn(async () => 0),
    prepareIdentity: vi.fn()
  };
}

describe("canvas server dependencies (SU-01)", () => {
  it("applies explicit overrides without widening downstream dependencies", () => {
    const defaults = dependencies();
    const now = vi.fn(() => 20);

    const composed = composeCanvasServerDependencies(defaults, { now });

    expect(composed.now).toBe(now);
    expect(composed.createState).toBe(defaults.createState);
    expect(Object.keys(composed).sort()).toEqual([
      "createHttpServer",
      "createRequestHandler",
      "createState",
      "defaultPage",
      "now",
      "preferredPort",
      "prepareIdentity"
    ]);
  });

  it("composes the production seams with the lifecycle defaults", () => {
    const createRequestHandler = vi.fn();
    const preferredPort = vi.fn(async () => 41234);
    const onStarted = vi.fn();
    const onStopped = vi.fn();
    const composed = createProductionCanvasServerDependencies({
      createRequestHandler,
      defaultPage: "planned",
      onStarted,
      onStopped,
      preferredPort
    });

    expect(composed.createRequestHandler).toBe(createRequestHandler);
    expect(composed.preferredPort).toBe(preferredPort);
    expect(composed.onStarted).toBe(onStarted);
    expect(composed.onStopped).toBe(onStopped);
    expect(composed.defaultPage).toBe("planned");
    expect(composed.createState()).toEqual({});
    expect(composed.now()).toBeGreaterThan(0);
  });

  it.each(["now", "preferredPort", "prepareIdentity"] as const)(
    "fails construction with the specific missing %s dependency",
    (name) => {
      const incomplete = { ...dependencies(), [name]: undefined };

      expect(() =>
        createCanvasServer(incomplete as unknown as CanvasServerDependencies)
      ).toThrow(`Missing canvas server dependency: ${name}`);
    }
  );
});
