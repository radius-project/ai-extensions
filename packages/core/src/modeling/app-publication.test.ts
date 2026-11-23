import { describe, expect, it, vi } from "vitest";
import { createAppPublication } from "./app-publication.js";

function fixture() {
  const ports = {
    resolveExisting: vi.fn((_workspace, value, fallback) => value ?? fallback),
    resolveTarget: vi.fn((_workspace, value, fallback) => value ?? fallback),
    stagingPrefix: vi.fn(() => ".staging-run/"),
    validateRegistryTarget: vi.fn<() => string | null>(() => null),
    exists: vi.fn(() => true),
    compileExtension: vi.fn(async () => {}),
    publishRecipe: vi.fn(async () => "registry reference")
  };
  return { ports, publication: createAppPublication(ports) };
}

describe("application publication", () => {
  it("compiles staged assets locally without publishing to the registry", async () => {
    const { ports, publication } = fixture();
    await expect(
      publication.compileExtension("workspace", {})
    ).resolves.toEqual({
      kind: "compiled",
      target: ".radius/.staging-run/custom-types.tgz"
    });
    expect(ports.compileExtension).toHaveBeenCalledWith(
      ".radius/.staging-run/custom-types.yaml",
      ".radius/.staging-run/custom-types.tgz"
    );
    expect(ports.publishRecipe).not.toHaveBeenCalled();
  });

  it("refuses missing assets without calling either writer", async () => {
    const { ports, publication } = fixture();
    ports.exists.mockReturnValue(false);
    await expect(
      publication.compileExtension("workspace", {})
    ).resolves.toEqual({
      kind: "missing",
      path: ".radius/.staging-run/custom-types.yaml"
    });
    await expect(
      publication.publishRecipe("workspace", "org/repo", { file: "recipe" })
    ).resolves.toEqual({
      kind: "missing",
      path: "recipe"
    });
    expect(ports.compileExtension).not.toHaveBeenCalled();
    expect(ports.publishRecipe).not.toHaveBeenCalled();
  });

  it("refuses a registry target before touching the artifact and never retries a failed write", async () => {
    const { ports, publication } = fixture();
    const input = { file: "recipe", target: " target " };
    ports.validateRegistryTarget.mockReturnValueOnce("wrong repository");
    await expect(
      publication.publishRecipe("workspace", "org/repo", input)
    ).resolves.toEqual({
      kind: "refused",
      error: "wrong repository"
    });
    expect(ports.resolveExisting).not.toHaveBeenCalled();
    ports.publishRecipe.mockRejectedValueOnce(new Error("unknown outcome"));
    await expect(
      publication.publishRecipe("workspace", "org/repo", input)
    ).rejects.toThrow("unknown outcome");
    expect(ports.publishRecipe).toHaveBeenCalledExactlyOnceWith(
      "recipe",
      "target"
    );
    await expect(
      publication.publishRecipe("workspace", "org/repo", input)
    ).resolves.toEqual({
      kind: "published",
      reference: "registry reference"
    });
  });
});
