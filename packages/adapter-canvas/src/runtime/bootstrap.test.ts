import { describe, expect, it, vi } from "vitest";
import { bootstrapRadiusExtension } from "./bootstrap.js";
import {
  createFakeDependencies,
  createFakeSession
} from "./test-support/fakes.js";

describe("RU-20: production bootstrap", () => {
  it("joins exactly once with the factory declaration and attaches the result", async () => {
    const { deps, sessionHolder } = createFakeDependencies();
    const session = createFakeSession();
    const createCanvas = vi.fn((declaration) => ({
      sdkCanvas: declaration
    }));
    const joinSession = vi.fn(async () => session);

    const extension = await bootstrapRadiusExtension(deps, {
      createCanvas,
      joinSession
    });

    expect(createCanvas).toHaveBeenCalledOnce();
    expect(joinSession).toHaveBeenCalledOnce();
    expect(joinSession).toHaveBeenCalledWith({
      canvases: [{ sdkCanvas: extension.canvases[0] }],
      tools: extension.tools,
      hooks: extension.hooks
    });
    expect(sessionHolder.get()).toBe(session);
  });

  it("does not join merely by importing or constructing runtime factories", async () => {
    const { deps } = createFakeDependencies();
    const joinSession = vi.fn(async () => createFakeSession());

    expect(joinSession).not.toHaveBeenCalled();

    await bootstrapRadiusExtension(deps, {
      createCanvas: (declaration) => declaration,
      joinSession
    });
    expect(joinSession).toHaveBeenCalledOnce();
  });
});
