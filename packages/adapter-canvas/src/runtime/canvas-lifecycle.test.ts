import { describe, expect, it, vi } from "vitest";
import {
  reloadCanvasInstance,
  SOURCE_EDITOR_INSTANCE_PREFIX,
  sourceEditorInstanceId
} from "./canvas-lifecycle.js";

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

describe("sourceEditorInstanceId", () => {
  it("gives two different source files two different editor handles", () => {
    // The defect this guards: a shared handle makes the host focus the panel
    // already showing the first file instead of opening the second one.
    expect(sourceEditorInstanceId("src/app.ts")).not.toBe(
      sourceEditorInstanceId("src/worker.ts")
    );
  });

  it("returns the same handle for the same file so re-clicking a node reuses its panel", () => {
    expect(sourceEditorInstanceId("src/app.ts")).toBe(
      sourceEditorInstanceId("src/app.ts")
    );
  });

  it("keeps the path readable in the handle behind the shared prefix", () => {
    const id = sourceEditorInstanceId("services/api/Dockerfile");
    expect(id.startsWith(`${SOURCE_EDITOR_INSTANCE_PREFIX}-`)).toBe(true);
    expect(id).toContain("services-api-dockerfile");
  });

  it("separates paths that slug identically", () => {
    // Both slug to "src-a-b", so only the digest keeps them apart.
    expect(sourceEditorInstanceId("src/a.b")).not.toBe(
      sourceEditorInstanceId("src/a_b")
    );
  });

  it("separates long paths that share a slug prefix past the cutoff", () => {
    const shared = `deep/${"nested/".repeat(12)}`;
    expect(sourceEditorInstanceId(`${shared}first.ts`)).not.toBe(
      sourceEditorInstanceId(`${shared}second.ts`)
    );
  });

  it("emits a usable handle with no trailing separator for a path with no slug characters", () => {
    const id = sourceEditorInstanceId("///");
    expect(id.startsWith(`${SOURCE_EDITOR_INSTANCE_PREFIX}-`)).toBe(true);
    expect(id).not.toMatch(/--|-$/);
  });

  it("trims a separator left at the slug cutoff", () => {
    // The 60-char slug window ends exactly on the separator before "ts".
    const id = sourceEditorInstanceId(`${"a".repeat(60)}/ts`);
    expect(id).not.toContain("--");
    expect(id).toContain(`-${"a".repeat(60)}-`);
  });
});
