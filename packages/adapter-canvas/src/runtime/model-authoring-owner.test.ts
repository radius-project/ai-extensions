import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { createModelAuthoringOwner } from "./model-authoring-owner.js";

function fixture(current = () => true, settled?: (promoted: boolean) => void) {
  const target = {
    repo: "org/repo",
    branch: "work",
    workspace: "/workspace",
    sourceRevision: "revision"
  };
  const committed = vi.fn();
  const staging = (stagingDir: string) => ({
    stagingDir,
    artifact: vi.fn(() => {
      throw new Error("No fixture artifact configured");
    }),
    assertBaseline: vi.fn(),
    cancel: vi.fn(),
    validate: vi.fn((check: (file: string) => Promise<void>) =>
      check(`${stagingDir}/app.bicep`)
    ),
    promote: vi.fn(
      async (
        prepareCommit: () => Promise<void>,
        beforeCommit: () => void,
        options?: { onFilesystemCommitted?: () => void }
      ) => {
        await prepareCommit();
        beforeCommit();
        committed(stagingDir);
        options?.onFilesystemCommitted?.();
        return { published: ["app.bicep"], gitError: "" };
      }
    )
  });
  const first = staging("/workspace/.radius/.staging-managed-one");
  const second = staging("/workspace/.radius/.staging-managed-two");
  const ports = {
    staging: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    resolveTarget: vi.fn(async () => target)
  };
  const validate = vi.fn(async () => {});
  const owner = createModelAuthoringOwner(ports);
  owner.begin("one", target, current, validate, settled);
  return { owner, target, ports, first, second, validate, committed };
}

describe("model authoring owner", () => {
  const extension = () => "extension";

  it("rejects reuse of a live request token without replacing its staging", async () => {
    const { owner, target, first, second, ports, validate } = fixture();
    expect(() => owner.begin("one", target, () => true, validate)).toThrow(
      "Duplicate authoring request"
    );
    expect(ports.staging).toHaveBeenCalledOnce();
    expect(first.cancel).not.toHaveBeenCalled();
    await owner.finish("one");
    expect(first.promote).toHaveBeenCalledOnce();
    expect(second.promote).not.toHaveBeenCalled();
  });

  it("allows standalone publication in an unrelated worktree", async () => {
    const { owner, target } = fixture();
    expect(() => owner.assertStandalone(target.workspace)).toThrow(
      "active managed Radius authoring request"
    );
    expect(() => owner.assertStandalone("/other-worktree")).not.toThrow();
    await owner.close();
    expect(() => owner.assertStandalone(target.workspace)).not.toThrow();
  });

  it("does not start publication once validation has begun", async () => {
    const { owner, validate, first } = fixture();
    const started = createDeferred<void>();
    const checked = createDeferred<void>();
    validate.mockImplementationOnce(() => {
      started.resolve();
      return checked.promise;
    });
    const completion = owner.finish("one");
    await started.promise;
    const publish = vi.fn(async () => "unexpected publication");
    try {
      await expect(owner.publish("one", extension, publish)).rejects.toThrow(
        "already finalizing"
      );
      expect(publish).not.toHaveBeenCalled();
    } finally {
      checked.resolve();
      await completion;
    }
    expect(first.promote).toHaveBeenCalledOnce();
  });

  it("lets a started publication settle, but only the replacement can publish or promote afterward", async () => {
    const { owner, target, first, second } = fixture();
    const started = createDeferred<void>();
    const publisher = createDeferred<string>();
    const publication = owner.publish("one", extension, async (staging) => {
      expect(staging).toBe(first);
      started.resolve();
      return publisher.promise;
    });
    await started.promise;
    const completion = expect(owner.finish("one")).rejects.toThrow(
      "no longer current"
    );
    owner.begin(
      "two",
      target,
      () => true,
      async () => {}
    );
    publisher.resolve("published by one");
    await expect(publication).resolves.toBe("published by one");
    await completion;
    const late = vi.fn(async () => "not started");
    await expect(owner.publish("one", extension, late)).rejects.toThrow(
      "expired"
    );
    await expect(owner.finish("one")).rejects.toThrow("expired");
    await expect(owner.finish("two")).resolves.toEqual({
      published: ["app.bicep"],
      gitError: ""
    });
    expect(late).not.toHaveBeenCalled();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.promote).not.toHaveBeenCalled();
    expect(second.promote).toHaveBeenCalledOnce();
  });

  it("seals new admission and waits for queued publication before validating", async () => {
    const { owner, first, validate } = fixture();
    const queued = createDeferred<void>();
    const publication = owner.publish(
      "one",
      extension,
      async (_, __, guards) => {
        await queued.promise;
        await guards.prepareSpawn();
        guards.beforeSpawn();
      }
    );
    const completion = owner.finish("one");
    await expect(owner.publish("one", extension, vi.fn())).rejects.toThrow(
      "already finalizing"
    );
    expect(validate).not.toHaveBeenCalled();
    queued.resolve();
    await publication;
    await completion;
    expect(first.promote).toHaveBeenCalledOnce();
  });

  it("refuses promotion after an admitted publication fails, even after it has left the queue", async () => {
    const { owner, first, validate } = fixture();
    await expect(
      owner.publish("one", extension, async () => {
        throw new Error("publisher failed");
      })
    ).rejects.toThrow("publisher failed");
    await expect(owner.finish("one")).rejects.toThrow(
      "A required Radius publication failed"
    );
    expect(validate).not.toHaveBeenCalled();
    expect(first.promote).not.toHaveBeenCalled();
  });

  it("allows a successful retry of the same target without masking a different target's failure", async () => {
    const { owner, target, first, second } = fixture();
    const failed = async () => {
      throw new Error("publisher failed");
    };
    const published = async () => "published";
    await expect(owner.publish("one", extension, failed)).rejects.toThrow(
      "publisher failed"
    );
    await owner.publish("one", extension, published);
    await expect(owner.finish("one")).resolves.toMatchObject({
      published: ["app.bicep"]
    });
    expect(first.promote).toHaveBeenCalledOnce();

    owner.begin(
      "two",
      target,
      () => true,
      vi.fn(async () => {})
    );
    await expect(owner.publish("two", extension, failed)).rejects.toThrow(
      "publisher failed"
    );
    await owner.publish("two", () => "recipe", published);
    await expect(owner.finish("two")).rejects.toThrow(
      "required Radius publication failed"
    );
    expect(second.promote).not.toHaveBeenCalled();
  });

  it("settles only the stale owner on publication refusal and admits its replacement", async () => {
    let current = true;
    const settled = vi.fn();
    const { owner, target, first, second } = fixture(() => current, settled);
    current = false;
    const start = vi.fn();
    await expect(owner.publish("one", extension, start)).rejects.toThrow(
      "no longer current"
    );
    expect(owner.cancel("one")).toBe(false);
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    owner.begin(
      "two",
      target,
      () => true,
      vi.fn(async () => {})
    );
    await owner.finish("two");
    expect(second.promote).toHaveBeenCalledOnce();
  });

  it.each(["admission", "preparation"] as const)(
    "refuses publication when the model baseline changes before %s",
    async (when) => {
      const { owner, first } = fixture();
      const changed = () => {
        throw new Error("model baseline changed");
      };
      if (when === "admission")
        first.assertBaseline.mockImplementationOnce(changed);
      const spawn = vi.fn();
      await expect(
        owner.publish("one", extension, async (_, __, guards) => {
          first.assertBaseline.mockImplementationOnce(changed);
          await guards.prepareSpawn();
          guards.beforeSpawn();
          spawn();
        })
      ).rejects.toThrow("model baseline changed");
      expect(spawn).not.toHaveBeenCalled();
      expect(owner.cancel("one")).toBe(false);
    }
  );

  it("drains a started publication when closing without reviving its request", async () => {
    const { owner } = fixture();
    const started = createDeferred<void>();
    const effect = createDeferred<string>();
    const publication = owner.publish("one", extension, () => {
      started.resolve();
      return effect.promise;
    });
    await started.promise;
    const settled = vi.fn();
    const closing = owner.close().then(settled);
    await expect(owner.finish("one")).rejects.toThrow("expired");
    expect(settled).not.toHaveBeenCalled();
    effect.resolve("published");
    await expect(publication).resolves.toBe("published");
    await closing;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("settles a promoted revision as successful if its panel closes while Git indexing is still pending", async () => {
    const settled = vi.fn();
    const { owner, first } = fixture(undefined, settled);
    const indexing = createDeferred<void>();
    const indexed = createDeferred<void>();
    first.promote.mockImplementationOnce(async (prepare, commit, options) => {
      await prepare();
      commit();
      options?.onFilesystemCommitted?.();
      indexing.resolve();
      await indexed.promise;
      return { published: ["app.bicep"], gitError: "index locked" };
    });

    const completion = owner.finish("one");
    try {
      await indexing.promise;
      expect(owner.cancel("one")).toBe(true);
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      indexed.resolve();
    }
    await expect(completion).resolves.toMatchObject({
      gitError: "index locked"
    });
    expect(settled).toHaveBeenCalledOnce();
  });

  it("does not promote if the source changes while validation is running", async () => {
    const { owner, target, ports, committed, validate } = fixture();
    const validating = createDeferred<void>();
    const checked = createDeferred<void>();
    validate.mockImplementationOnce(() => {
      validating.resolve();
      return checked.promise;
    });
    const completion = expect(owner.finish("one")).rejects.toThrow(
      "source or worktree changed"
    );
    await validating.promise;
    ports.resolveTarget.mockResolvedValue({ ...target, branch: "next" });
    checked.resolve();
    await completion;
    expect(committed).not.toHaveBeenCalled();
  });

  it("refuses a publication that was still checking its source at close", async () => {
    const { owner, target, ports, first } = fixture();
    const pending = createDeferred<typeof target>();
    ports.resolveTarget.mockReturnValueOnce(pending.promise);
    const start = vi.fn(async () => "not started");
    const result = expect(
      owner.publish("one", extension, start)
    ).rejects.toThrow("no longer current");
    const closing = owner.close();
    pending.resolve(target);
    await result;
    await closing;
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(() =>
      owner.begin(
        "two",
        target,
        () => true,
        async () => {}
      )
    ).toThrow("Cannot establish");
  });
});
