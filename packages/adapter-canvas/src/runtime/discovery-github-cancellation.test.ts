import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createDiscoveryGitHubRead } from "./discovery-github-read.js";
it("cancels a pending selected-account GET and releases the request listener", async () => {
  const listeners = new Set<() => void>();
  let aborted = false;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const get = createDiscoveryGitHubRead({
    verify: async () => portSuccess(undefined),
    executor: async (login) => ({
      login,
      run: async (_args, options) => {
        if (!options?.signal) throw new Error("Expected request signal");
        const signal = options.signal;
        started?.();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("Request cancelled")),
            { once: true }
          );
        });
      }
    })
  });
  const pending = get(
    "/repos/owner/repo/environments",
    {
      requestId: "read",
      cancellation: {
        get aborted() {
          return aborted;
        },
        onAbort: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      }
    },
    {
      operation: "environment.list",
      principalRef: "github:reader",
      authorizationRef: "auth",
      target: { repo: "owner/repo" }
    }
  );
  await ready;
  aborted = true;
  for (const listener of listeners) listener();
  expect(await pending).toMatchObject({ status: "cancelled" });
  expect(listeners.size).toBe(0);
});
