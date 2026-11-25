import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { createModelAuthoringOwner } from "./model-authoring-owner.js";

const committedIdentity = {
  definitionHash: "fixture-definition",
  originHash: "fixture-origin"
};

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
    assertBaseline: vi.fn(),
    cancel: vi.fn(),
    validate: vi.fn((check: (dir: string) => Promise<void>) =>
      check(stagingDir)
    ),
    promote: vi.fn(
      async (
        prepareCommit: () => Promise<void>,
        beforeCommit: () => void,
        options?: {
          onFilesystemCommitted?: (identity: typeof committedIdentity) => void;
        }
      ) => {
        await prepareCommit();
        beforeCommit();
        committed(stagingDir);
        options?.onFilesystemCommitted?.(committedIdentity);
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
  it("counts staging only for the current owner of the selected worktree and branch", async () => {
    let active = true;
    const settled = vi.fn();
    const { owner, target, first } = fixture(() => active, settled);
    expect(
      owner.currentRun(target.repo, ["other"], target.workspace)
    ).toBeUndefined();
    expect(
      owner.currentRun(target.repo, [target.branch], "/other-worktree")
    ).toBeUndefined();
    expect(
      owner.currentRun(target.repo, [target.branch], target.workspace)
    ).toMatchObject({
      token: "one",
      stagingDir: first.stagingDir
    });

    active = false;
    expect(
      owner.currentRun(target.repo, [target.branch], target.workspace)
    ).toBeUndefined();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    await expect(owner.finish("one")).rejects.toThrow("expired");
  });

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
    expect(() => owner.assertStandalone(target.workspace)).toThrow(
      "Radius publication is shutting down"
    );
  });

  it("retires the old request only in the worktree that starts a replacement", async () => {
    const { owner, target, ports, first, second, validate } = fixture();
    const otherTarget = { ...target, workspace: "/other-worktree" };
    const replacement = { ...first, cancel: vi.fn() };
    ports.staging.mockReturnValueOnce(replacement);
    owner.begin("other", otherTarget, () => true, validate);
    owner.begin("replacement", target, () => true, validate);

    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).not.toHaveBeenCalled();
    await expect(owner.finish("one")).rejects.toThrow("expired");
    ports.resolveTarget.mockResolvedValue(otherTarget);
    await owner.finish("other");
    expect(second.promote).toHaveBeenCalledOnce();
    ports.resolveTarget.mockResolvedValue(target);
    await owner.finish("replacement");
  });

  it("settles a promoted revision as successful if its panel closes while Git indexing is still pending", async () => {
    const settled = vi.fn();
    const { owner, first, target } = fixture(undefined, settled);
    const indexing = createDeferred<void>();
    const indexed = createDeferred<void>();
    first.promote.mockImplementationOnce(async (prepare, commit, options) => {
      await prepare();
      commit();
      options?.onFilesystemCommitted?.(committedIdentity);
      indexing.resolve();
      await indexed.promise;
      return { published: ["app.bicep"], gitError: "index locked" };
    });

    const completion = owner.finish("one");
    try {
      await indexing.promise;
      expect(
        owner.currentRun(target.repo, [target.branch], target.workspace)
      ).toBeUndefined();
      owner.retire("one");
      expect(() => owner.cancel("one")).toThrow("cancellation is too late");
      expect(settled).not.toHaveBeenCalled();
    } finally {
      indexed.resolve();
    }
    await expect(completion).resolves.toMatchObject({
      gitError: "index locked"
    });
    expect(settled).toHaveBeenCalledExactlyOnceWith(true, committedIdentity);
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

  it("refuses a second completion while the first is finalizing, and settles open requests at close", async () => {
    const settled = vi.fn();
    const { owner, target, validate, committed } = fixture(undefined, settled);
    const checking = createDeferred<void>();
    validate.mockImplementationOnce(() => checking.promise);
    const completion = expect(owner.finish("one")).rejects.toThrow(
      "no longer current"
    );
    await expect(owner.finish("one")).rejects.toThrow("already finalizing");

    const closing = owner.close();
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      owner.currentRun(target.repo, [target.branch], target.workspace)
    ).toBeUndefined();
    checking.resolve();
    await completion;
    await expect(closing).resolves.toBe(true);
    expect(committed).not.toHaveBeenCalled();
  });
});
