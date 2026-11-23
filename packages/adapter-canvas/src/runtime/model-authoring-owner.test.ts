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
    cancel: vi.fn(),
    validate: vi.fn(),
    promote: vi.fn(() => ({ published: ["app.bicep"], gitError: "" }))
  });
  const first = staging("/workspace/.radius/.staging-managed-one");
  const second = staging("/workspace/.radius/.staging-managed-two");
  const ports = {
    staging: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    resolveTarget: vi.fn(async () => target),
    validate: vi.fn(async () => {})
  };
  const owner = createModelAuthoringOwner(ports);
  owner.begin("one", target, () => true);
  return { owner, target, ports, first, second };
}

describe("model authoring owner", () => {
  it("lets a started publication settle, but only the replacement can publish or promote afterward", async () => {
    const { owner, target, first, second } = fixture();
    const started = createDeferred<void>();
    const publisher = createDeferred<string>();
    const publication = owner.publish("one", async (dir) => {
      expect(dir).toBe(first.stagingDir);
      started.resolve();
      return publisher.promise;
    });
    await started.promise;
    await expect(owner.finish("one")).rejects.toThrow("work running");
    owner.begin("two", target, () => true);
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

  it("does not promote if the source changes while validation is running", async () => {
    const { owner, target, ports, first } = fixture();
    const validating = createDeferred<void>();
    const checked = createDeferred<void>();
    ports.validate.mockImplementationOnce(() => {
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
    owner.close();
    pending.resolve(target);
    await result;
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(() => owner.begin("two", target, () => true)).toThrow(
      "Cannot establish"
    );
  });
});
