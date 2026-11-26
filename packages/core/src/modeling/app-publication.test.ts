import { describe, expect, it, vi } from "vitest";
import { createAppPublication } from "./app-publication.js";

const workspace = async () => ({
  workspacePath: "workspace",
  workspaceRepo: "org/repo"
});

function fixture() {
  const ports = {
    resolveExisting: vi.fn((_workspace, value, fallback) => value ?? fallback),
    validateRegistryTarget: vi.fn<() => string | null>(() => null),
    isUnconfirmedExit: vi.fn((_error: unknown) => false),
    exists: vi.fn(() => true),
    publishRecipe: vi.fn(async () => "registry reference")
  };
  return { ports, publication: createAppPublication(ports) };
}

describe("application publication", () => {
  it("drains the running publication and refuses queued writes at shutdown", async () => {
    const { publication } = fixture();
    let release = () => {};
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = publication.enqueue("recipe", async () => {
      started();
      await hold;
    });
    await running;
    const write = vi.fn(async () => {});
    const refused = expect(
      publication.enqueue("recipe", write)
    ).rejects.toThrow("shutting down");
    const drained = vi.fn();
    const closing = publication.close().then(drained);
    expect(drained).not.toHaveBeenCalled();
    release();
    await Promise.all([first, refused, closing]);
    expect(write).not.toHaveBeenCalled();
    expect(drained).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("refuses a missing Recipe file without calling the writer", async () => {
    const { ports, publication } = fixture();
    ports.exists.mockReturnValue(false);
    await expect(
      publication.publishRecipe(workspace, { file: "recipe" })
    ).resolves.toEqual({
      kind: "missing",
      path: "recipe"
    });
    expect(ports.publishRecipe).not.toHaveBeenCalled();
  });

  it("refuses a registry target before touching the artifact and never retries a failed write", async () => {
    const { ports, publication } = fixture();
    const input = { file: "recipe", target: " target " };
    ports.validateRegistryTarget.mockReturnValueOnce("wrong repository");
    await expect(publication.publishRecipe(workspace, input)).resolves.toEqual({
      kind: "refused",
      error: "wrong repository"
    });
    expect(ports.resolveExisting).not.toHaveBeenCalled();
    ports.publishRecipe.mockRejectedValueOnce(new Error("unknown outcome"));
    await expect(publication.publishRecipe(workspace, input)).rejects.toThrow(
      "unknown outcome"
    );
    expect(ports.publishRecipe).toHaveBeenCalledExactlyOnceWith(
      "recipe",
      "target",
      "workspace"
    );
    await expect(publication.publishRecipe(workspace, input)).resolves.toEqual({
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
      publication.publishRecipe(workspace, {
        file,
        target: reference
      });
    const older = request("old.bicep", target);
    const olderResult = expect(older).rejects.toThrow("unknown outcome");
    await vi.waitFor(() => expect(ports.publishRecipe).toHaveBeenCalledOnce());
    const successor = request("new.bicep", target);
    await request("cache.bicep", "br:ghcr.io/org/repo/cache:v1");
    expect(ports.publishRecipe).toHaveBeenCalledTimes(2);
    expect(ports.publishRecipe).not.toHaveBeenCalledWith(
      "new.bicep",
      target,
      "workspace"
    );
    finishFirst(new Error("unknown outcome"));
    await olderResult;
    await expect(successor).resolves.toEqual({
      kind: "published",
      reference: "registry reference"
    });
    expect(ports.publishRecipe).toHaveBeenLastCalledWith(
      "new.bicep",
      target,
      "workspace"
    );
  });

  it("reports an unconfirmed exit and refuses both a queued successor and later calls to that tag", async () => {
    const { ports, publication } = fixture();
    const unconfirmed = new Error("Windows process tree exit unconfirmed");
    ports.isUnconfirmedExit.mockImplementation(
      (error) => error === unconfirmed
    );
    ports.publishRecipe.mockRejectedValueOnce(unconfirmed);
    const target = "br:ghcr.io/org/repo/database:v1";
    const recipe = (reference: string) =>
      publication.publishRecipe(workspace, {
        file: "recipe.bicep",
        target: reference
      });

    const older = expect(recipe(target)).rejects.toBe(unconfirmed);
    const queued = expect(recipe(target)).rejects.toThrow(
      "previous process tree"
    );
    await Promise.all([older, queued]);
    await expect(recipe("BR:GHCR.IO/ORG/REPO/DATABASE:v1")).rejects.toThrow(
      "previous process tree"
    );
    expect(ports.publishRecipe).toHaveBeenCalledOnce();
    await expect(
      recipe("br:ghcr.io/org/repo/database:V1")
    ).resolves.toMatchObject({
      kind: "published"
    });
    await expect(recipe("br:ghcr.io/org/repo/cache:v1")).resolves.toMatchObject(
      {
        kind: "published"
      }
    );
  });

  it("holds an already queued same-tag call and refuses it without starting after an unconfirmed exit", async () => {
    const { publication, ports } = fixture();
    let failFirst: (error: Error) => void = () => {
      throw new Error("First publication did not start");
    };
    const unconfirmed = new Error("Windows process tree exit unconfirmed");
    ports.isUnconfirmedExit.mockImplementation(
      (error) => error === unconfirmed
    );
    const key = publication.recipeKey(" br:ghcr.io/org/repo/database:v1 ");
    const first = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failFirst = reject;
        })
    );
    const older = expect(publication.enqueue(key, first)).rejects.toBe(
      unconfirmed
    );
    const successor = vi.fn();
    const queued = expect(
      publication.enqueue(
        publication.recipeKey("BR:GHCR.IO/ORG/REPO/DATABASE:v1"),
        successor
      )
    ).rejects.toThrow("previous process tree");
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    expect(successor).not.toHaveBeenCalled();
    failFirst(unconfirmed);
    await Promise.all([older, queued]);
    expect(successor).not.toHaveBeenCalled();
  });

  it("reserves a recipe tag before resolving its workspace", async () => {
    const { publication, ports } = fixture();
    let releaseFirst: () => void = () => {
      throw new Error("Workspace lookup was not started");
    };
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const second = vi.fn(workspace);
    const target = "br:ghcr.io/org/repo/database:RC1";
    const older = publication.publishRecipe(
      async () => {
        await first;
        return workspace();
      },
      { target, file: "old.bicep" }
    );
    const newer = publication.publishRecipe(second, {
      target,
      file: "new.bicep"
    });
    try {
      await publication.publishRecipe(workspace, {
        target: "br:ghcr.io/org/repo/database:rc1",
        file: "other.bicep"
      });
      expect(second).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
      await Promise.all([older, newer]);
    }
    expect(ports.publishRecipe.mock.calls).toEqual([
      ["other.bicep", "br:ghcr.io/org/repo/database:rc1", "workspace"],
      ["old.bicep", target, "workspace"],
      ["new.bicep", target, "workspace"]
    ]);
  });

  it("does not mistake a registry port for a tag", () => {
    const { publication } = fixture();
    expect(publication.recipeKey("br:REGISTRY.EXAMPLE:5000/org/name:RC1")).toBe(
      "recipe:br:registry.example:5000/org/name:RC1"
    );
    expect(publication.recipeKey("br:REGISTRY.EXAMPLE:5000/org/name")).toBe(
      "recipe:br:registry.example:5000/org/name"
    );
  });
});
