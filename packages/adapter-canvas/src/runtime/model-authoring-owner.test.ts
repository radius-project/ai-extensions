import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { createModelAuthoringOwner } from "./model-authoring-owner.js";

function fixture() {
  const target = {
    repo: "org/repo",
    branch: "work",
    workspace: "/workspace",
    sourceRevision: "revision"
  };
  const staging = (stagingDir: string) => ({
    stagingDir,
    artifact: vi.fn(() => {
      throw new Error("No fixture artifact configured");
    }),
    cancel: vi.fn(),
    validate: vi.fn((check: (file: string) => Promise<void>) =>
      check(`${stagingDir}/app.bicep`)
    ),
    promote: vi.fn(() => ({ published: ["app.bicep"], gitError: "" }))
  });
  const first = staging("/workspace/.radius/.staging-managed-one");
  const second = staging("/workspace/.radius/.staging-managed-two");
  const ports = {
    staging: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    resolveTarget: vi.fn(async () => target)
  };
  const validate = vi.fn(async () => {});
  const owner = createModelAuthoringOwner(ports);
  owner.begin("one", target, () => true, validate);
  return { owner, target, ports, first, second, validate };
}

describe("model authoring owner", () => {
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
      await expect(owner.publish("one", publish)).rejects.toThrow(
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
    const publication = owner.publish("one", async (staging) => {
      expect(staging).toBe(first);
      started.resolve();
      return publisher.promise;
    });
    await started.promise;
    await expect(owner.finish("one")).rejects.toThrow("work running");
    owner.begin(
      "two",
      target,
      () => true,
      async () => {}
    );
    publisher.resolve("published by one");
    await expect(publication).resolves.toBe("published by one");
    const late = vi.fn(async () => "not started");
    await expect(owner.publish("one", late)).rejects.toThrow("expired");
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

  it("drains a started publication when closing without reviving its request", async () => {
    const { owner } = fixture();
    const started = createDeferred<void>();
    const effect = createDeferred<string>();
    const publication = owner.publish("one", () => {
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

  it("does not promote if the source changes while validation is running", async () => {
    const { owner, target, ports, first, validate } = fixture();
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
    expect(first.promote).not.toHaveBeenCalled();
  });

  it("refuses a publication that was still checking its source at close", async () => {
    const { owner, target, ports, first } = fixture();
    const pending = createDeferred<typeof target>();
    ports.resolveTarget.mockReturnValueOnce(pending.promise);
    const start = vi.fn(async () => "not started");
    const result = expect(owner.publish("one", start)).rejects.toThrow(
      "no longer current"
    );
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
