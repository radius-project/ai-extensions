import { describe, expect, it, vi } from "vitest";
import { reloadCanvasInstance } from "./canvas-lifecycle.mjs";

const context = {
  extensionId: "plugin:radius",
  canvasId: "radius",
  instanceId: "radius-panel"
};

describe("reloadCanvasInstance", () => {
  it("reopens the existing canvas instance through the runtime", async () => {
    const open = vi.fn().mockResolvedValue({ instanceId: "radius-panel" });
    const session = { rpc: { canvas: { open } } };

    await reloadCanvasInstance(session, context);

    expect(open).toHaveBeenCalledWith({
      extensionId: "plugin:radius",
      canvasId: "radius",
      instanceId: "radius-panel"
    });
  });

  it("echoes the supplied input so a provider-side reopen stays on the same page", async () => {
    const open = vi.fn().mockResolvedValue({});
    const session = { rpc: { canvas: { open } } };

    await reloadCanvasInstance(session, context, { page: "graph" });

    expect(open).toHaveBeenCalledWith({
      extensionId: "plugin:radius",
      canvasId: "radius",
      instanceId: "radius-panel",
      input: { page: "graph" }
    });
  });

  it("swallows a reload failure and logs it best-effort instead of throwing", async () => {
    const open = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const log = vi.fn();
    const session = { rpc: { canvas: { open } }, log };

    await expect(
      reloadCanvasInstance(session, context, { page: "planned" })
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("radius-panel");
    expect(log.mock.calls[0][1]).toEqual({ level: "warning" });
  });

  it("does not throw when logging is unavailable on a failed reload", async () => {
    const open = vi.fn().mockRejectedValue(new Error("boom"));
    const session = { rpc: { canvas: { open } } };

    await expect(
      reloadCanvasInstance(session, context)
    ).resolves.toBeUndefined();
  });
});
