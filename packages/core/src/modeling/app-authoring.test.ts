import { describe, expect, it, vi } from "vitest";
import type { GraphSourceIdentity, GraphSourceRead } from "../graph-source.js";
import {
  appAuthoringRequired,
  findAppModelRefresh,
  hasModelableSource,
  inspectAppModelFailure,
  observeAppModel,
  prepareAppAuthoring,
  readAppModelEvidence
} from "./app-authoring.js";
import type { AppModelFreshness } from "./app-origin.js";

const source: GraphSourceIdentity = {
  kind: "workspace",
  repo: "example/project",
  ref: "topic",
  definitionPath: ".radius/app.bicep"
};
const missing: GraphSourceRead = { status: "absent", source };
const unavailable: GraphSourceRead = {
  status: "unavailable",
  source,
  diagnostic: "read failed"
};
const present: GraphSourceRead = {
  status: "present",
  source,
  content: "model"
};
const empty: GraphSourceRead = { ...present, content: " " };
const freshness: AppModelFreshness = {
  status: "up-to-date",
  stale: false,
  requiresConfirmation: false,
  reason: "",
  appBicepHash: "matching",
  origin: {
    generatedAt: "",
    sourceCommit: "commit",
    radiusVersion: "",
    appBicepHash: "matching"
  }
};

describe("authoring eligibility", () => {
  const absent = {
    refreshable: false,
    freshness: { ...freshness, status: "missing" as const }
  };
  const stale = {
    refreshable: true,
    freshness: { ...freshness, stale: true }
  };
  const unverified = {
    refreshable: true,
    freshness: { ...freshness, requiresConfirmation: true }
  };

  it("requests missing-model authoring only for nonempty selections with no models", () => {
    expect(appAuthoringRequired([])).toBe(false);
    expect(appAuthoringRequired([absent, absent])).toBe(true);
    expect(appAuthoringRequired([absent, stale])).toBe(false);
  });

  it("prioritizes overwrite confirmation and never refreshes a remote model", () => {
    expect(findAppModelRefresh([stale, unverified])).toEqual({
      kind: "confirmation",
      model: unverified
    });
    expect(findAppModelRefresh([absent, stale])).toEqual({
      kind: "refresh",
      model: stale
    });
    expect(
      findAppModelRefresh([{ ...stale, refreshable: false }])
    ).toBeUndefined();
  });

  it("only refuses confirmed absence of source", () => {
    const none = { status: "none" as const, dockerfiles: [] };
    expect(hasModelableSource([none, none])).toBe(false);
    expect(hasModelableSource([none, null])).toBe(true);
  });

  it("uses the branch listing for ambiguity without reopening a selected subdirectory", async () => {
    const listPaths = vi.fn(async () => [
      "apps/api/Dockerfile",
      "apps/web/Dockerfile"
    ]);
    const reads = {
      evaluate: async () => ({
        status: "ambiguous" as const,
        dockerfiles: ["apps/api/Dockerfile", "apps/web/Dockerfile"]
      }),
      listPaths,
      explicitlySelectedDirectory: () => false
    };
    await expect(prepareAppAuthoring(reads)).resolves.toMatchObject({
      kind: "handoff",
      brief: expect.stringContaining("apps/api")
    });
    await expect(
      prepareAppAuthoring({
        ...reads,
        explicitlySelectedDirectory: () => true
      })
    ).resolves.toEqual({ kind: "handoff" });
    listPaths.mockClear();
    await expect(
      prepareAppAuthoring({
        ...reads,
        evaluate: async () => null
      })
    ).resolves.toEqual({ kind: "handoff" });
    await expect(
      prepareAppAuthoring({
        ...reads,
        evaluate: async () => ({ status: "none", dockerfiles: [] })
      })
    ).resolves.toEqual({ kind: "unsupported" });
    expect(listPaths).not.toHaveBeenCalled();
  });
});

describe("model evidence", () => {
  const recordedOrigin = {
    ...freshness.origin,
    sourceCommit: "a".repeat(40),
    appBicepHash: `sha256:${"b".repeat(64)}`,
    generatedAt: "2026-01-01T00:00:00.000Z",
    radiusVersion: "0.61"
  };

  function evidencePorts() {
    return {
      assertSource: vi.fn(async () => {}),
      origin: vi.fn(async (): Promise<string | null> =>
        JSON.stringify(recordedOrigin)
      ),
      headCommit: vi.fn(async () => "c".repeat(40)),
      sourceChangedSince: vi.fn(async (_commit: string) => false),
      modelRecoverable: vi.fn(async (): Promise<boolean | undefined> => false),
      radiusVersion: vi.fn(async () => "0.61"),
      hashAppBicep: () => recordedOrigin.appBicepHash
    };
  }

  it("keeps unavailable, absent and blank definitions distinct", () => {
    expect(observeAppModel(unavailable)).toEqual({
      kind: "unreadable",
      diagnostic: "read failed"
    });
    expect(observeAppModel(missing)).toEqual({ kind: "missing" });
    expect(observeAppModel(empty)).toEqual({ kind: "invalid" });
  });

  it("checks source drift against the recorded commit, not the current workspace head", async () => {
    const ports = evidencePorts();
    const { sourceChangedSince, modelRecoverable } = ports;
    await expect(readAppModelEvidence(present, ports)).resolves.toMatchObject({
      observation: { kind: "present", verification: "verified" }
    });
    expect(sourceChangedSince).toHaveBeenCalledExactlyOnceWith(
      recordedOrigin.sourceCommit
    );
    expect(modelRecoverable).not.toHaveBeenCalled();
    sourceChangedSince.mockResolvedValueOnce(true);
    await expect(readAppModelEvidence(present, ports)).resolves.toMatchObject({
      observation: { kind: "present", verification: "unverified" },
      freshness: { status: "source-changed" }
    });
    await expect(readAppModelEvidence(unavailable, ports)).rejects.toThrow(
      "read failed"
    );
    await expect(readAppModelEvidence(empty, ports)).rejects.toThrow(
      "is empty"
    );
  });

  it("reads recorded GitHub evidence without probing the workspace", async () => {
    const ports = evidencePorts();
    await expect(
      readAppModelEvidence(
        { ...present, source: { ...source, kind: "github" } },
        ports
      )
    ).resolves.toMatchObject({
      freshness: { origin: recordedOrigin },
      observation: { verification: "verified" }
    });
    expect(ports.origin).toHaveBeenCalledOnce();
    expect(ports.radiusVersion).toHaveBeenCalledOnce();
    expect(ports.assertSource).toHaveBeenCalledTimes(2);
    expect(ports.headCommit).not.toHaveBeenCalled();
    expect(ports.sourceChangedSince).not.toHaveBeenCalled();
    expect(ports.modelRecoverable).not.toHaveBeenCalled();
  });

  it.each([
    { recoverable: true, requiresConfirmation: false, reason: "no usable" },
    {
      recoverable: false,
      requiresConfirmation: true,
      reason: "uncommitted changes or is untracked"
    },
    {
      recoverable: undefined,
      requiresConfirmation: true,
      reason: "Git could not say"
    }
  ])(
    "uses workspace recoverability ($recoverable) when origin is absent",
    async ({ recoverable, requiresConfirmation, reason }) => {
      const ports = evidencePorts();
      ports.origin.mockResolvedValueOnce(null);
      ports.modelRecoverable.mockResolvedValueOnce(recoverable);
      await expect(readAppModelEvidence(present, ports)).resolves.toMatchObject(
        {
          freshness: {
            status: "unrecorded",
            requiresConfirmation,
            reason: expect.stringContaining(reason)
          }
        }
      );
      expect(ports.modelRecoverable).toHaveBeenCalledOnce();
      expect(ports.sourceChangedSince).not.toHaveBeenCalled();
      expect(ports.radiusVersion).not.toHaveBeenCalled();
    }
  );

  it("checks drift without looking up Radius when otherwise valid origin lacks a version", async () => {
    const ports = evidencePorts();
    const origin = { ...recordedOrigin, radiusVersion: "" };
    ports.origin.mockResolvedValueOnce(JSON.stringify(origin));
    await expect(readAppModelEvidence(present, ports)).resolves.toMatchObject({
      freshness: { origin },
      observation: { verification: "verified" }
    });
    expect(ports.sourceChangedSince).toHaveBeenCalledExactlyOnceWith(
      origin.sourceCommit
    );
    expect(ports.radiusVersion).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rechecks the checkout after an origin rejection (changed: %s)",
    async (changed) => {
      const ports = evidencePorts();
      const originError = new Error("origin unavailable");
      const checkoutError = new Error("checkout changed");
      ports.origin.mockRejectedValueOnce(originError);
      ports.assertSource.mockResolvedValueOnce(undefined);
      if (changed) ports.assertSource.mockRejectedValueOnce(checkoutError);
      await expect(readAppModelEvidence(present, ports)).rejects.toBe(
        changed ? checkoutError : originError
      );
      expect(ports.origin).toHaveBeenCalledOnce();
      expect(ports.assertSource).toHaveBeenCalledTimes(2);
      expect(ports.headCommit).not.toHaveBeenCalled();
    }
  );

  it("stops subsequent probes when the checkout changes during the head read", async () => {
    const ports = evidencePorts();
    let finishHead: (value: string) => void = () => {
      throw new Error("Head read not initialized");
    };
    const head = new Promise<string>((resolve) => {
      finishHead = resolve;
    });
    const checkoutError = new Error("checkout changed");
    const started = new Promise<void>((resolve) => {
      ports.headCommit.mockImplementationOnce(() => {
        resolve();
        return head;
      });
    });
    const result = readAppModelEvidence(present, ports);
    const rejected = expect(result).rejects.toBe(checkoutError);
    await started;
    ports.assertSource.mockRejectedValueOnce(checkoutError);
    finishHead("c".repeat(40));
    await rejected;
    expect(ports.assertSource).toHaveBeenCalledTimes(3);
    expect(ports.sourceChangedSince).not.toHaveBeenCalled();
    expect(ports.modelRecoverable).not.toHaveBeenCalled();
    expect(ports.radiusVersion).not.toHaveBeenCalled();
  });
  it("requires a fresh model with matching origin evidence", () => {
    expect(observeAppModel(present)).toEqual({
      kind: "present",
      verification: "unchecked"
    });
    expect(observeAppModel(present, freshness)).toMatchObject({
      verification: "verified"
    });
    for (const candidate of [
      { ...freshness, status: "source-changed" as const },
      { ...freshness, origin: null },
      { ...freshness, appBicepHash: "different" },
      { ...freshness, requiresConfirmation: true }
    ]) {
      expect(observeAppModel(present, candidate)).toMatchObject({
        verification: "unverified"
      });
    }
  });
});

describe("permanent failure observation", () => {
  const ports = {
    current: () => true,
    readModel: async () => missing,
    readSourceRevision: async () => "current revision"
  };

  it("suppresses stale callbacks after either read", async () => {
    await expect(
      inspectAppModelFailure({
        ...ports,
        current: () => false,
        readModel: async () => unavailable
      })
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      inspectAppModelFailure({
        ...ports,
        current: vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
      })
    ).resolves.toEqual({ kind: "stale" });
  });

  it("refuses a present model or propagates an unreadable model", async () => {
    await expect(
      inspectAppModelFailure({
        ...ports,
        readModel: async () => present
      })
    ).resolves.toEqual({ kind: "model-present" });
    await expect(
      inspectAppModelFailure({
        ...ports,
        readModel: async () => unavailable
      })
    ).rejects.toThrow("read failed");
  });

  it("keeps the original source revision when known and falls back when absent", async () => {
    const readSourceRevision = vi.fn(ports.readSourceRevision);
    await expect(
      inspectAppModelFailure({
        ...ports,
        readSourceRevision,
        baseline: "original"
      })
    ).resolves.toEqual({ kind: "recordable", sourceRevision: "original" });
    expect(readSourceRevision).not.toHaveBeenCalled();
    await expect(
      inspectAppModelFailure({
        ...ports,
        readModel: async () => empty
      })
    ).resolves.toEqual({
      kind: "recordable",
      sourceRevision: "current revision"
    });
  });
});
