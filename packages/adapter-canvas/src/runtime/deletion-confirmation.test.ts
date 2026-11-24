import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { confirmDeletion } from "./deletion-confirmation.js";
import { createSessionHolder } from "./session.js";

function session(
  confirm: (message: string) => Promise<boolean>,
  supported = true
) {
  return {
    capabilities: { ui: { elicitation: supported } },
    ui: { confirm, select: async () => null },
    send: () => undefined,
    rpc: { canvas: { open: async () => undefined } }
  };
}

describe("host deletion confirmation", () => {
  const prompt = "Delete application api in org/repo, environment test?";
  const active = () => true;

  it("returns the current host's decision on the exact request", async () => {
    const holder = createSessionHolder();
    const confirm = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    holder.set(session(confirm));
    await expect(confirmDeletion(holder, prompt, active)).resolves.toBe(false);
    await expect(confirmDeletion(holder, prompt, active)).resolves.toBe(true);
    expect(confirm.mock.calls).toEqual([[prompt], [prompt]]);
  });

  it("does not prompt an unsupported host", async () => {
    const holder = createSessionHolder();
    const confirm = vi.fn(async () => true);
    holder.set(session(confirm, false));
    await expect(
      confirmDeletion(holder, prompt, active)
    ).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("does not carry approval across session replacement", async () => {
    const holder = createSessionHolder();
    const answer = createDeferred<boolean>();
    holder.set(session(() => answer.promise));
    const pending = confirmDeletion(holder, prompt, active);
    holder.set(session(async () => true));
    answer.resolve(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it("discards late approval on shutdown and does not prompt again", async () => {
    const holder = createSessionHolder();
    const answer = createDeferred<boolean>();
    const confirm = vi.fn(() => answer.promise);
    holder.set(session(confirm));
    let running = true;
    const isActive = () => running;
    const pending = confirmDeletion(holder, prompt, isActive);
    running = false;
    answer.resolve(true);
    await expect(pending).resolves.toBeUndefined();
    await expect(
      confirmDeletion(holder, prompt, isActive)
    ).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("treats an unsuccessful host RPC as unavailable, not approval", async () => {
    const holder = createSessionHolder();
    holder.set(
      session(async () => {
        throw new Error("Host disconnected");
      })
    );
    await expect(
      confirmDeletion(holder, prompt, active)
    ).resolves.toBeUndefined();
  });
});
