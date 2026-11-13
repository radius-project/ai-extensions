import { describe, expect, it, vi } from "vitest";
import { createCloudDiscoveryDiagnostics } from "./cloud-discovery-diagnostics.js";

function harness(
  options: {
    snapshot?: () => Promise<unknown>;
    save?: (body: string) => Promise<void>;
  } = {}
) {
  let saved = "";
  let snapshots = 0;
  const observer = createCloudDiscoveryDiagnostics(
    {
      testTitle: "create environment",
      retry: 0
    },
    {
      now: () => new Date(0),
      snapshot: async () => {
        snapshots++;
        return options.snapshot ?
            options.snapshot()
          : {
              cluster: "selected-cluster",
              namespace: "",
              options: ["Loading"],
              disabled: true
            };
      },
      save:
        options.save ??
        (async (body) => {
          saved = body;
        }),
      credentials: ["opaque-fixture-credential"]
    }
  );
  return {
    observer,
    saved: () => saved,
    payload: () => JSON.parse(saved),
    snapshots: () => snapshots
  };
}

describe("Cloud E2E discovery evidence", () => {
  it("records command diagnostics without saving unrelated response fields", async () => {
    const h = harness();
    await h.observer.discovery({
      diagnostics: {
        events: [{ step: "az aks list", exitCode: 0 }]
      },
      namespaces: ["default", "selected-team"],
      kubeconfig: "must-not-be-saved"
    });
    await expect(h.observer.guard(async () => "ready")).resolves.toBe("ready");
    await h.observer.save();
    expect(h.payload()).toMatchObject({
      testTitle: "create environment",
      events: [
        {
          kind: "discovery",
          details: { commands: [{ step: "az aks list", exitCode: 0 }] }
        }
      ]
    });
    expect(h.saved()).not.toContain("must-not-be-saved");
    expect(h.snapshots()).toBe(0);
  });

  it("fails an active form promptly and keeps only the first snapshot before retry or cleanup", async () => {
    let selector = "selected-cluster";
    const h = harness({ snapshot: async () => ({ cluster: selector }) });
    const pending = h.observer.guard(() => new Promise<never>(() => {}));
    const rejected = expect(pending).rejects.toThrow("kubectl refused");
    await h.observer.discovery({
      diagnostics: { events: [] },
      errors: { namespaces: "kubectl refused opaque-fixture-credential" },
      namespaces: []
    });
    await rejected;
    selector = "cleanup-changed-cluster";
    await h.observer.discovery({ error: "later failure" });
    await h.observer.discovery({
      diagnostics: { events: [] },
      namespaces: ["retry-success"]
    });
    await expect(h.observer.guard(async () => "no")).rejects.toThrow(
      "kubectl refused"
    );
    await h.observer.save();
    expect(h.snapshots()).toBe(1);
    expect(h.saved()).toContain("selected-cluster");
    expect(h.saved()).not.toContain("cleanup-changed-cluster");
    expect(h.saved()).not.toContain("opaque-fixture-credential");
    expect(h.saved()).toContain("[REDACTED]");
    expect(
      h
        .payload()
        .events.filter(
          (event: { kind: string }) => event.kind === "failure-snapshot"
        )
    ).toHaveLength(1);
  });

  it("records snapshot capture errors and propagates artifact write failures", async () => {
    const h = harness({
      snapshot: async () => {
        throw new Error("snapshot unavailable");
      },
      save: async () => {
        throw new Error("artifact unavailable");
      }
    });
    await h.observer.discovery({ error: "discovery failed" });
    await expect(h.observer.save()).rejects.toThrow("artifact unavailable");
    const readable = harness({
      snapshot: async () => {
        throw new Error("snapshot unavailable");
      }
    });
    await readable.observer.captureError(new Error("response unreadable"));
    await readable.observer.save();
    expect(readable.saved()).toContain("snapshot unavailable");
    expect(readable.saved()).toContain("response unreadable");
    expect(readable.saved()).toContain("capture-error");
  });

  it("reports missing diagnostics rather than claiming command capture succeeded", async () => {
    const h = harness();
    await h.observer.discovery(null);
    await expect(h.observer.guard(async () => "no")).rejects.toThrow(
      "no command diagnostics"
    );
  });

  it("limits a stalled snapshot and still fails the form with an explicit capture error", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ snapshot: () => new Promise<never>(() => {}) });
      const discovery = h.observer.discovery({ error: "namespace failure" });
      await vi.advanceTimersByTimeAsync(5000);
      await discovery;
      await expect(h.observer.guard(async () => "no")).rejects.toThrow(
        "5-second capture limit"
      );
      await h.observer.save();
      expect(h.saved()).toContain("capture-error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the first failure even after the event budget is exhausted", async () => {
    const h = harness();
    for (let index = 0; index < 65; index++)
      await h.observer.discovery({ diagnostics: { events: [] } });
    await h.observer.discovery({
      error: "first namespace failure",
      diagnostics: {
        events: [
          {
            step: "kubectl get namespaces",
            exitCode: null,
            signal: "SIGTERM",
            timedOut: true,
            durationMs: 10000,
            timeoutMs: 10000
          }
        ]
      }
    });
    for (let index = 0; index < 65; index++)
      await h.observer.captureError("later capture failure");
    await h.observer.save();
    expect(h.saved()).toContain("first namespace failure");
    expect(h.saved()).toContain("failure-snapshot");
    expect(h.snapshots()).toBe(1);
    expect(h.payload().events).toHaveLength(64);
    expect(
      h
        .payload()
        .events.find(
          (event: { kind: string }) => event.kind === "first-failure"
        ).details.evidence
    ).toMatchObject({
      commands: [
        expect.objectContaining({
          step: "kubectl get namespaces",
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          durationMs: 10000,
          timeoutMs: 10000
        })
      ]
    });
  });

  it("keeps first-failure evidence when request-snapshot errors fill the buffer", async () => {
    let failing = true;
    const h = harness({
      snapshot: async () => {
        if (failing) throw new Error("request snapshot unavailable");
        return { cluster: "selected-cluster" };
      }
    });
    for (let index = 0; index < 64; index++) await h.observer.requestSnapshot();
    failing = false;
    await h.observer.discovery({ error: "namespace failure" });
    await h.observer.save();
    const kinds = h
      .payload()
      .events.map((event: { kind: string }) => event.kind);
    expect(kinds).toContain("first-failure");
    expect(kinds).toContain("failure-snapshot");
    expect(kinds).toHaveLength(64);
  });

  it("does not return success when the action ends while the failure snapshot is captured", async () => {
    let release: (value: unknown) => void = () => {};
    const h = harness({
      snapshot: () => new Promise((resolve) => (release = resolve))
    });
    let finish: (value: string) => void = () => {};
    const guarded = h.observer.guard(
      () => new Promise<string>((resolve) => (finish = resolve))
    );
    const rejected = expect(guarded).rejects.toThrow("namespace failure");
    const discovery = h.observer.discovery({ error: "namespace failure" });
    finish("filled the form");
    await Promise.resolve();
    release({ cluster: "selected-cluster" });
    await discovery;
    await rejected;
  });

  it("bounds event count, namespace options and saved error output", async () => {
    const h = harness();
    for (let index = 0; index < 70; index++)
      await h.observer.discovery({
        diagnostics: { events: [{ error: "x".repeat(4000) }] },
        namespaces: Array.from({ length: 101 }, (_, i) => `namespace-${i}`)
      });
    await h.observer.save();
    expect(h.payload().events).toHaveLength(64);
    expect(h.payload().droppedEvents).toBe(6);
    expect(h.payload().events[0].details.namespaces).toHaveLength(100);
    expect(h.payload().events[0].details.commands[0].error).toBe(
      `${"x".repeat(2000)}[truncated]`
    );
  });

  it("bounds text in large records without losing structure and redacts headers and configurations", async () => {
    const h = harness({
      snapshot: async () => ({
        config: "kind: Config\nprivate data",
        header: "Authorization: Bearer private data"
      })
    });
    await h.observer.discovery({
      error: "namespaces failed",
      diagnostics: {
        events: Array.from({ length: 16 }, () => ({ error: "x".repeat(4000) }))
      }
    });
    await h.observer.save();
    expect(h.payload().events[0].details.commands).toHaveLength(16);
    expect(h.payload().events[0].details.commands[0].error).toHaveLength(2011);
    expect(h.saved()).not.toContain("private data");
    expect(h.saved().length).toBeLessThan(75000);
  });

  it("retains request state if the response renderer clears selectors before failure capture", async () => {
    let selector = "selected-cluster";
    const h = harness({ snapshot: async () => ({ cluster: selector }) });
    const beforeRequest = await h.observer.requestSnapshot();
    selector = "";
    await h.observer.discovery(
      { error: "cluster discovery failed" },
      beforeRequest
    );
    await h.observer.save();
    expect(
      h
        .payload()
        .events.find(
          (event: { kind: string }) => event.kind === "failure-snapshot"
        ).details
    ).toEqual({
      beforeRequest: { cluster: "selected-cluster" },
      atFailure: { cluster: "" }
    });
  });

  it("reports pre-request snapshot capture failure without hiding the discovery response", async () => {
    const h = harness({
      snapshot: async () => {
        throw new Error("request state unavailable");
      }
    });
    const beforeRequest = await h.observer.requestSnapshot();
    await h.observer.discovery({ error: "namespace failure" }, beforeRequest);
    await h.observer.save();
    expect(h.saved()).toContain("request-snapshot");
    expect(h.saved()).toContain("request state unavailable");
    expect(h.saved()).toContain("namespace failure");
  });

  it("redacts diagnostic text before any limit can cut a credential in half", async () => {
    const h = harness();
    await h.observer.discovery({
      diagnostics: {
        events: [{ error: `${"x".repeat(1995)}opaque-fixture-credential` }]
      }
    });
    await h.observer.save();
    expect(h.saved()).not.toContain("opaque-fixture");
    expect(h.payload().events[0].details.commands[0].error).toHaveLength(2011);
  });
});
