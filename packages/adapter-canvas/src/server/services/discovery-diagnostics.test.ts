import { describe, expect, it } from "vitest";
import { CommandFailure } from "../../command-failure.js";
import {
  observeDiscoveryCommands,
  type DiscoveryCommandEvent
} from "./discovery-diagnostics.js";

describe("discovery command observations", () => {
  it("records success timing and limits without retaining stdout or argv", async () => {
    const events: DiscoveryCommandEvent[] = [];
    let time = 0;
    const run = observeDiscoveryCommands(
      async () => {
        time = 53;
        return "private configuration output";
      },
      events,
      () => time
    );
    await expect(
      run("az", ["aks", "get-credentials", "--file", "private-path"], {
        timeout: 45000
      })
    ).resolves.toBe("private configuration output");
    expect(events).toEqual([
      {
        step: "az aks get-credentials",
        startedAt: "1970-01-01T00:00:00.000Z",
        durationMs: 53,
        timeoutMs: 45000,
        exitCode: 0,
        signal: null,
        timedOut: false
      }
    ]);
  });

  it.each([
    { code: 1, signal: null, killed: false, timedOut: false },
    { code: null, signal: "SIGTERM", killed: true, timedOut: true }
  ] as const)(
    "retains $code/$signal failure and rethrows the same error",
    async (fields) => {
      const events: DiscoveryCommandEvent[] = [];
      const error = new CommandFailure(
        Object.assign(new Error("command failed"), fields),
        "connection refused",
        10000,
        []
      );
      const run = observeDiscoveryCommands(
        async () => {
          throw error;
        },
        events,
        () => 100
      );
      await expect(
        run("kubectl", ["--kubeconfig", "private-path"], { timeout: 10000 })
      ).rejects.toBe(error);
      expect(events).toEqual([
        expect.objectContaining({
          step: "kubectl get namespaces",
          durationMs: 0,
          timeoutMs: 10000,
          exitCode: fields.code,
          signal: fields.signal,
          timedOut: fields.timedOut,
          error: "connection refused"
        })
      ]);
    }
  );

  it.each([
    new Error("client_secret=fixture-secret"),
    "password=fixture-secret"
  ])(
    "reports unstructured failures without inventing an exit code",
    async (error) => {
      const events: DiscoveryCommandEvent[] = [];
      const run = observeDiscoveryCommands(
        async () => {
          throw error;
        },
        events,
        () => 0
      );
      await expect(
        run("unrecognized", ["private", "arguments"], { timeout: 1 })
      ).rejects.toBe(error);
      expect(events[0]).toMatchObject({
        step: "discovery command",
        exitCode: null,
        signal: null,
        timedOut: false,
        error: expect.stringContaining("[REDACTED]")
      });
    }
  );
});
