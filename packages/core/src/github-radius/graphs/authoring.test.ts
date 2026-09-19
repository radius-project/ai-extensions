import { describe, expect, it } from "vitest";
import {
  appModelHandoffKey,
  modelAuthoringTarget,
  requestModelAuthoring
} from "./authoring.js";
import type {
  AuthoringClaim,
  ModelAuthoringPorts,
  ModelInteraction
} from "./authoring.js";
import type { AppModelStatus } from "./model-status.js";
import type { GraphSource } from "./pipeline.js";

const source: GraphSource = {
  kind: "workspace",
  repo: "owner/app",
  branch: "feature",
  workspacePath: "authorized-workspace"
};
const request = { repo: source.repo, sources: [source] };

function status(
  kind: "missing" | "up-to-date" | "source-changed" = "missing"
): AppModelStatus {
  return {
    repo: source.repo,
    branch: "feature",
    refreshable: true,
    freshness: {
      status: kind,
      stale: kind === "source-changed",
      requiresConfirmation: false,
      reason: kind,
      appBicepHash: "hash",
      origin: null
    }
  };
}

function harness(model = status()) {
  let claim: AuthoringClaim | null = null;
  let reserved: string | undefined;
  let attempt: string | undefined;
  let delivered = false;
  const interactions: ModelInteraction[] = [];
  const notices: AppModelStatus[] = [];
  const waits: number[] = [];
  const releasedMemos: string[] = [];
  const ports: ModelAuthoringPorts = {
    resolveStatus: async () => model,
    evaluateSource: async () => ({
      status: "single",
      dockerfiles: ["Dockerfile"]
    }),
    modelingInFlight: async () => false,
    wait: async (ms) => {
      waits.push(ms);
    },
    requestInteraction: async (interaction) => {
      interactions.push(interaction);
    },
    staleNotice: (value) => {
      notices.push(value);
    },
    refreshKey: (value) => `refresh:${value.branch}`,
    shouldRequestRefresh: () => true,
    releaseRefreshMemo: (key) => {
      releasedMemos.push(key);
    },
    claims: {
      current: () => claim,
      claim(target, key) {
        if (claim?.key === key) return null;
        claim = { target, key };
        return claim;
      },
      owns: (value) => claim === value,
      release(value) {
        if (claim === value) claim = null;
      },
      markDelivered: () => {
        delivered = true;
      }
    },
    reservation: {
      has: (key) => reserved === key,
      reserve: (key) => {
        reserved = key;
      },
      owns: (key) => reserved === key,
      release: (key) => {
        if (reserved === key) reserved = undefined;
      },
      beginAttempt: () => {
        attempt = "attempt-1";
        return attempt;
      },
      releaseAttempt: (_sources, token) => {
        if (attempt === token) attempt = undefined;
      }
    }
  };
  return {
    ports,
    interactions,
    notices,
    waits,
    releasedMemos,
    state: () => ({ claim, reserved, attempt, delivered })
  };
}

describe("explicit non-Canvas authoring policy", () => {
  it("can request authoring without a host attempt token and release a failed delivery", async () => {
    const h = harness();
    h.ports.reservation.beginAttempt = () => undefined;
    h.ports.requestInteraction = async () => {
      throw new Error("unsupported agent");
    };
    await expect(requestModelAuthoring(request, h.ports)).rejects.toThrow(
      "unsupported agent"
    );
    expect(h.state().claim).toBeNull();
  });

  it("requests agent work only after source checks, grace polling and status revalidation", async () => {
    const h = harness();
    await expect(
      requestModelAuthoring(request, h.ports)
    ).resolves.toMatchObject({
      kind: "interaction-requested",
      interaction: {
        kind: "author",
        sources: [source],
        attemptToken: "attempt-1"
      }
    });
    expect(h.waits).toEqual(Array<number>(15).fill(1000));
    expect(h.state()).toMatchObject({
      delivered: true,
      reserved: undefined,
      attempt: "attempt-1"
    });
    await expect(requestModelAuthoring(request, h.ports)).resolves.toEqual({
      kind: "already-claimed"
    });
    expect(h.interactions).toHaveLength(1);
  });

  it.each(["source", "poll", "settled", "send"] as const)(
    "releases reservations on %s failure",
    async (failure) => {
      const h = harness();
      const fail = async (): Promise<never> => {
        throw new Error("unavailable");
      };
      if (failure === "source") h.ports.evaluateSource = fail;
      if (failure === "poll") h.ports.modelingInFlight = fail;
      if (failure === "settled") {
        let count = 0;
        h.ports.resolveStatus = async () => (count++ === 0 ? status() : fail());
      }
      if (failure === "send") h.ports.requestInteraction = fail;
      await expect(requestModelAuthoring(request, h.ports)).rejects.toThrow(
        "unavailable"
      );
      expect(h.state()).toEqual({
        claim: null,
        reserved: undefined,
        attempt: undefined,
        delivered: false
      });
    }
  );

  it("never turns unavailable model evidence into an authoring request", async () => {
    const h = harness();
    h.ports.resolveStatus = async () => {
      throw new Error("permission denied");
    };
    await expect(requestModelAuthoring(request, h.ports)).rejects.toThrow(
      "permission denied"
    );
    expect(h.interactions).toEqual([]);
    expect(h.state().claim).toBeNull();
  });

  it("declines unsupported source without consuming future retry eligibility", async () => {
    const h = harness();
    h.ports.evaluateSource = async () => ({ status: "none", dockerfiles: [] });
    await expect(requestModelAuthoring(request, h.ports)).resolves.toEqual({
      kind: "unsupported"
    });
    expect(h.state().claim).toBeNull();
    expect(h.interactions).toEqual([]);
  });

  it("defers to an existing run without retaining a reservation", async () => {
    const h = harness();
    h.ports.modelingInFlight = async () => true;
    await expect(requestModelAuthoring(request, h.ports)).resolves.toEqual({
      kind: "already-claimed"
    });
    expect(h.state().claim).toBeNull();
    expect(h.waits).toEqual([]);
  });

  it("rechecks the model after polling instead of treating agent liveness as validated output", async () => {
    const h = harness();
    let reads = 0;
    h.ports.resolveStatus = async () =>
      status(reads++ === 0 ? "missing" : "up-to-date");
    await expect(requestModelAuthoring(request, h.ports)).resolves.toEqual({
      kind: "model-present"
    });
    expect(h.interactions).toEqual([]);
    expect(h.state().claim).toBeNull();
  });

  it.each(["initial", "source", "poll", "settled"] as const)(
    "rejects a generation superseded during %s",
    async (stage) => {
      const h = harness();
      let current = stage !== "initial";
      if (stage === "source")
        h.ports.evaluateSource = async () => {
          current = false;
          return { status: "single", dockerfiles: ["Dockerfile"] };
        };
      if (stage === "poll")
        h.ports.wait = async () => {
          current = false;
        };
      if (stage === "settled") {
        let reads = 0;
        h.ports.resolveStatus = async () => {
          if (reads++ > 0) current = false;
          return status();
        };
      }
      await expect(
        requestModelAuthoring({ ...request, isCurrent: () => current }, h.ports)
      ).resolves.toEqual({ kind: "stale" });
      expect(h.interactions).toEqual([]);
      expect(h.state().claim).toBeNull();
    }
  );

  it.each([false, true])(
    "requests refresh with confirmation=%s and deduplicates it",
    async (confirm) => {
      const model = status("source-changed");
      model.freshness.requiresConfirmation = confirm;
      const h = harness(model);
      await expect(
        requestModelAuthoring(request, h.ports)
      ).resolves.toMatchObject({
        kind: "interaction-requested",
        interaction: {
          kind: confirm ? "confirm-refresh" : "refresh",
          status: model
        }
      });
      await expect(requestModelAuthoring(request, h.ports)).resolves.toEqual({
        kind: "unchanged"
      });
      expect(h.interactions).toHaveLength(1);
    }
  );

  it("releases refresh memo and reservation after interaction delivery fails", async () => {
    const h = harness(status("source-changed"));
    h.ports.requestInteraction = async () => {
      throw new Error("agent unavailable");
    };
    await expect(requestModelAuthoring(request, h.ports)).rejects.toThrow(
      "agent unavailable"
    );
    expect(h.releasedMemos).toEqual(["refresh:feature"]);
    expect(h.state().reserved).toBeUndefined();
  });

  it("honors a previously requested refresh without consuming the view reservation", async () => {
    const h = harness(status("source-changed"));
    h.ports.shouldRequestRefresh = () => false;
    await expect(requestModelAuthoring(request, h.ports)).resolves.toEqual({
      kind: "unchanged"
    });
    expect(h.state().reserved).toBeUndefined();
  });

  it("only reports remote drift and never requests commits, pushes or regeneration", async () => {
    const model = status("source-changed");
    model.refreshable = false;
    const h = harness(model);
    await expect(
      requestModelAuthoring(
        {
          repo: source.repo,
          sources: [{ kind: "committed", repo: source.repo, ref: "feature" }]
        },
        h.ports
      )
    ).resolves.toEqual({ kind: "unchanged" });
    expect(h.notices).toEqual([model]);
    expect(h.interactions).toEqual([]);
  });

  it("releases an old missing-model claim once a model is present", async () => {
    const h = harness(status("up-to-date"));
    h.ports.claims.claim(modelAuthoringTarget(source.repo, ["feature"]), "old");
    await requestModelAuthoring(request, h.ports);
    expect(h.state().claim).toBeNull();
  });

  it.each([
    { repo: "", sources: [source] },
    { repo: source.repo, sources: [] }
  ])("ignores an empty authoring target", async (input) => {
    const h = harness();
    await expect(requestModelAuthoring(input, h.ports)).resolves.toEqual({
      kind: "unchanged"
    });
    expect(h.interactions).toEqual([]);
  });

  it("keys evidence and preserves unambiguous target branches", () => {
    const model = status("source-changed");
    const original = appModelHandoffKey(source.repo, ["feature"], [model]);
    model.freshness.origin = {
      generatedAt: "today",
      sourceCommit: "commit",
      skillVersion: "version",
      appBicepHash: "hash"
    };
    expect(appModelHandoffKey(source.repo, ["feature"], [model])).not.toBe(
      original
    );
    expect(modelAuthoringTarget(source.repo, ["a,b"])).not.toBe(
      modelAuthoringTarget(source.repo, ["a", "b"])
    );
  });
});
