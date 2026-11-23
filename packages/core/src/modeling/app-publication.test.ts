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

  it("orders writes to one target after a failed predecessor without blocking other targets", async () => {
    const { ports, publication } = fixture();
    let finishFirst: (error: Error) => void = () => {
      throw new Error("First publication did not start");
    };
    ports.publishRecipe.mockImplementationOnce(() => {
      return new Promise<string>((_resolve, reject) => {
        finishFirst = reject;
      });
    });
    const target = "br:ghcr.io/org/repo/database:v1";
    const request = (file: string, reference: string) =>
      publication.publishRecipe("workspace", "org/repo", {
        file,
        target: reference
      });
    const older = request("old.bicep", target);
    const olderResult = expect(older).rejects.toThrow("unknown outcome");
    await vi.waitFor(() => expect(ports.publishRecipe).toHaveBeenCalledOnce());
    const successor = request("new.bicep", target);
    await request("cache.bicep", "br:ghcr.io/org/repo/cache:v1");
    expect(ports.publishRecipe).toHaveBeenCalledTimes(2);
    expect(ports.publishRecipe).not.toHaveBeenCalledWith("new.bicep", target);
    finishFirst(new Error("unknown outcome"));
    await olderResult;
    await expect(successor).resolves.toEqual({
      kind: "published",
      reference: "registry reference"
    });
    expect(ports.publishRecipe).toHaveBeenLastCalledWith("new.bicep", target);
  });
});
