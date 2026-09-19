import { describe, expect, it } from "vitest";
import {
  admitCreateEnvironmentRequest,
  refuseUnlessServerOwned,
  SERVER_OWNED_REFUSAL,
  type AdmissionPorts,
  type CreateEnvironmentRequestData
} from "./create-environment-refusals.js";
import type {
  CreateEnvironmentOperation,
  OperationStartResult
} from "./create-environment-types.js";

const STAGE_IDENTITY = "authorize-identity";
const STAGE_CONFIGURE = "configure-environment";

interface Recorder {
  ports: AdmissionPorts;
  /** Operation ids the namespace rung resolved an account for. */
  claimReads: string[];
  entered: Array<{ operationId: string; stage: string }>;
  finished: Array<{ operationId: string; failure: Record<string, unknown> }>;
  diagnostics: Array<{ code: string; message: string }>;
  persistCalls: number;
}

function operation(
  overrides: Partial<CreateEnvironmentOperation> = {}
): CreateEnvironmentOperation {
  return {
    operationId: "op-1",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: STAGE_CONFIGURE,
    inputRequired: null,
    ...overrides
  } as CreateEnvironmentOperation;
}

interface Script {
  existing?: CreateEnvironmentOperation | null;
  stale?: boolean;
  start?: OperationStartResult;
  persistRejects?: Error;
  created?: CreateEnvironmentOperation;
  // The repository's environments as the namespace rung would read them from
  // GitHub: a name/value variable map per environment. `claimsFailure` scripts
  // the unreadable case the rung has to fail closed on.
  claimants?: Record<string, Record<string, string>>;
  claimsFailure?: string;
  claimsVariableFailure?: string;
  // No GitHub account pinned to the operation, so the claim read cannot run as
  // the account the customer selected.
  noPinnedAccount?: boolean;
}

// Every port is a scripted fake that throws on an unscripted call, except the
// two pure helpers (`isValidRepoSlug`, `errorMessage`) whose real behavior is
// the behavior under test.
function ports(script: Script = {}): Recorder {
  const entered: Recorder["entered"] = [];
  const finished: Recorder["finished"] = [];
  const diagnostics: Recorder["diagnostics"] = [];
  const recordedClaimReads: string[] = [];
  let persistCalls = 0;
  const recorder: Recorder = {
    entered,
    finished,
    diagnostics,
    claimReads: recordedClaimReads,
    get persistCalls() {
      return persistCalls;
    },
    ports: {
      namespaceClaimsFor: (operationId: string) => {
        recordedClaimReads.push(operationId);
        if (script.noPinnedAccount) return null;
        return {
          listEnvironmentNames: async () => {
            if (script.claimsFailure) {
              return { ok: false as const, reason: script.claimsFailure };
            }
            return {
              ok: true as const,
              names: Object.keys(script.claimants ?? {})
            };
          },
          readEnvironmentVariables: async (
            _repo: string,
            environment: string
          ) => {
            if (script.claimsVariableFailure) {
              return {
                ok: false as const,
                reason: script.claimsVariableFailure
              };
            }
            const variables = (script.claimants ?? {})[environment];
            if (!variables) {
              throw new Error(
                `unscripted readEnvironmentVariables(${environment})`
              );
            }
            return { ok: true as const, variables };
          }
        };
      },
      isValidRepoSlug: (repo) => /^[^/\s]+\/[^/\s]+$/.test(repo),
      getOperation: (operationId) => {
        if (!("existing" in script)) {
          throw new Error(`unscripted getOperation(${operationId})`);
        }
        return script.existing ?? null;
      },
      isStale: () => script.stale ?? false,
      // The real predicate: a closed record is never resumable, whatever else
      // about the continuation matches.
      isTerminalState: (state) =>
        [
          "succeeded",
          "succeeded_with_warnings",
          "action_required",
          "failed",
          "failed_partial",
          "cancelled"
        ].includes(String(state ?? "")),
      createOperation: (input) =>
        script.created ??
        operation({
          operationId: "op-new",
          repo: input.repo,
          environment: input.environment,
          provider: input.provider,
          journey: input.journey
        } as Partial<CreateEnvironmentOperation>),
      buildStages: () => [],
      startOperation: () => {
        if (!script.start) throw new Error("unscripted startOperation");
        return script.start;
      },
      persistOperations: async () => {
        persistCalls += 1;
        if (script.persistRejects) throw script.persistRejects;
      },
      reportOperationDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      },
      finishFailed: (op, failure) => {
        finished.push({ operationId: op.operationId, failure });
      },
      enterStage: (op, stage) => {
        entered.push({ operationId: op.operationId, stage });
      },
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      stageAuthorizeIdentity: STAGE_IDENTITY,
      stageConfigureEnvironment: STAGE_CONFIGURE
    }
  };
  return recorder;
}

describe("rung 1 — the server-owned gate", () => {
  it("refuses a request that does not carry the server-owned token", () => {
    expect(refuseUnlessServerOwned(false)).toEqual({
      status: 403,
      body: {
        error: "This endpoint is reserved for server-owned operations.",
        code: "server-owned-operation-required"
      }
    });
  });

  it("admits a server-owned request", () => {
    expect(refuseUnlessServerOwned(true)).toBeNull();
  });

  it("publishes the refusal as a shared constant so the wire body has one source", () => {
    expect(refuseUnlessServerOwned(false)).toBe(SERVER_OWNED_REFUSAL);
  });
});

describe("the create-environment refusal ladder", () => {
  it("rung 2 — refuses 400 when no target repository was supplied", async () => {
    const recorder = ports();
    const result = await admitCreateEnvironmentRequest({}, recorder.ports);

    expect(result).toEqual({
      outcome: "refused",
      operation: null,
      refusal: {
        status: 400,
        body: { error: "No target repository specified." }
      }
    });
  });

  it("rung 2 — treats an empty repository string as no repository", async () => {
    // `data.repo || ""`, so "" falls to this rung rather than reaching the slug
    // check with an empty value.
    const recorder = ports();
    const result = await admitCreateEnvironmentRequest(
      { repo: "" },
      recorder.ports
    );

    expect(result).toMatchObject({
      refusal: {
        status: 400,
        body: { error: "No target repository specified." }
      }
    });
  });

  it("rung 3 — refuses 400 with the offending slug quoted", async () => {
    const recorder = ports();
    const result = await admitCreateEnvironmentRequest(
      { repo: "not-a-slug" },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "refused",
      operation: null,
      refusal: {
        status: 400,
        body: {
          error: 'Invalid repository "not-a-slug". Expected "owner/repo".',
          code: "invalid-repo"
        }
      }
    });
  });

  it.each([
    ["the operation does not exist", { existing: null }],
    ["the operation is stale", { existing: operation(), stale: true }],
    ["the repository differs", { existing: operation({ repo: "other/repo" }) }],
    [
      "the environment differs",
      { existing: operation({ environment: "prod" }) }
    ],
    ["the provider differs", { existing: operation({ provider: "aws" }) }],
    [
      "the operation is past the stages this route may continue",
      { existing: operation({ currentStage: "verify" }) }
    ],
    [
      "the operation is waiting on user input",
      { existing: operation({ inputRequired: { kind: "consent" } }) }
    ]
  ] as Array<[string, Script]>)(
    "rung 4 — refuses 409 when %s",
    async (_why, script) => {
      const recorder = ports(script);
      const result = await admitCreateEnvironmentRequest(
        { repo: "octo/app", operationId: "op-1" },
        recorder.ports
      );

      expect(result).toEqual({
        outcome: "refused",
        operation: null,
        refusal: {
          status: 409,
          body: {
            error:
              "The environment request does not match the setup operation it is continuing.",
            code: "operation-continuation-mismatch",
            operationId: "op-1"
          }
        }
      });
      expect(recorder.entered).toEqual([]);
    }
  );

  it("rung 5 — refuses 409 naming the repository and the operation already running", async () => {
    const recorder = ports({
      start: { ok: false, conflict: { operationId: "op-running" } }
    });
    const result = await admitCreateEnvironmentRequest(
      { repo: "octo/app" },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "refused",
      // Deliberately null: a rejected start does not own the record that is
      // already running, so the caller's catch must not finalize it.
      operation: null,
      refusal: {
        status: 409,
        body: {
          error: "Setup is already running for octo/app.",
          code: "operation-in-progress",
          operationId: "op-running"
        }
      }
    });
    expect(recorder.persistCalls).toBe(0);
  });

  it("rung 5 — distinguishes cleanup authority from a running operation", async () => {
    const recorder = ports({
      start: {
        ok: false,
        reason: "previous-cleanup-required",
        conflict: { operationId: "op-cleanup" }
      }
    });

    await expect(
      admitCreateEnvironmentRequest({ repo: "octo/app" }, recorder.ports)
    ).resolves.toEqual({
      outcome: "refused",
      operation: null,
      refusal: {
        status: 409,
        body: {
          error:
            "An earlier setup for octo/app must finish deletion before a new setup can start.",
          code: "previous-cleanup-required",
          operationId: "op-cleanup"
        }
      }
    });
    expect(recorder.persistCalls).toBe(0);
  });

  it("rung 6 — refuses 500, finalizes the record and reports a diagnostic when the recovery record cannot be saved", async () => {
    const recorder = ports({
      start: { ok: true },
      persistRejects: new Error("disk full")
    });
    const result = await admitCreateEnvironmentRequest(
      { repo: "octo/app" },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "refused",
      operation: expect.objectContaining({ operationId: "op-new" }),
      refusal: {
        status: 500,
        body: {
          error:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          code: "operation-persistence-failed",
          operationId: "op-new"
        }
      }
    });
    expect(recorder.diagnostics).toEqual([
      {
        code: "operation-store-write-failed",
        message: "Could not persist setup operation op-new: disk full"
      }
    ]);
    expect(recorder.finished).toEqual([
      {
        operationId: "op-new",
        failure: {
          code: "operation-persistence-failed",
          stage: STAGE_CONFIGURE,
          stepSeq: null,
          message:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          classification: "unknown"
        }
      }
    ]);
    // The configure stage is never entered on this rung: the record is closed.
    expect(recorder.entered).toEqual([]);
  });

  // Rung 7. The invariant the wizard's own check cannot carry: the browser's
  // listing can be empty because nothing is claimed or because nothing could be
  // read, and only this rung can tell those apart.
  it("rung 7 — refuses 409 naming the environment that holds the namespace", async () => {
    const recorder = ports({
      existing: operation({ environment: "prod" }),
      claimants: {
        dev: {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "payments"
        }
      }
    });

    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "prod",
        operationEnvironment: "prod",
        operationId: "op-1",
        provider: "azure",
        subscriptionId: "sub-1",
        cluster: "aks-1",
        namespace: "payments"
      },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "refused",
      operation: null,
      refusal: {
        status: 409,
        body: {
          error:
            'Namespace "payments" on cluster "aks-1" already belongs to environment "dev". Radius allows one environment per namespace, so choose a different namespace or deploy to "dev".',
          code: "namespace-already-claimed",
          environment: "dev"
        }
      }
    });
    // Refused before any record was created, so nothing is left to reconcile.
    expect(recorder.persistCalls).toBe(0);
  });

  it.each([
    ["the environment list", { claimsFailure: "gh: forbidden" }],
    ["an environment's variables", { claimsVariableFailure: "gh: forbidden" }]
  ])(
    "rung 7 — fails closed when %s cannot be read",
    async (_label, failure) => {
      const recorder = ports({
        existing: operation({ environment: "prod" }),
        claimants: {
          dev: {
            RADIUS_MANAGED: "true",
            AZURE_CLIENT_ID: "client-1",
            AZURE_AKS_CLUSTER_NAME: "aks-1"
          }
        },
        ...failure
      });

      const result = await admitCreateEnvironmentRequest(
        {
          repo: "octo/app",
          environment: "prod",
          operationEnvironment: "prod",
          operationId: "op-1",
          provider: "azure",
          subscriptionId: "sub-1",
          cluster: "aks-1",
          namespace: "payments"
        },
        recorder.ports
      );

      expect(result).toEqual({
        outcome: "refused",
        operation: null,
        refusal: {
          status: 409,
          body: {
            error:
              "Radius created nothing because it could not confirm which namespaces octo/app's environments already use: gh: forbidden",
            code: "namespace-claims-unavailable"
          }
        }
      });
      expect(recorder.persistCalls).toBe(0);
    }
  );

  it("rung 7 — fails closed when a managed environment cannot describe itself", async () => {
    const recorder = ports({
      // Radius-managed, but without the marker that says which cloud it is, so
      // its claim cannot be established and might be the requested namespace.
      existing: operation({ environment: "prod" }),
      claimants: {
        dev: { RADIUS_MANAGED: "true", KUBERNETES_NAMESPACE: "payments" }
      }
    });

    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "prod",
        operationEnvironment: "prod",
        operationId: "op-1",
        provider: "azure",
        subscriptionId: "sub-1",
        cluster: "aks-1",
        namespace: "payments"
      },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "refused",
      operation: null,
      refusal: {
        status: 409,
        body: {
          error:
            'Radius created nothing because it could not confirm which namespaces octo/app\'s environments already use: environment "dev" does not record its cloud provider.',
          code: "namespace-claims-unavailable"
        }
      }
    });
    expect(recorder.persistCalls).toBe(0);
  });

  // The claim read is authoritative, so it has to run as the account pinned to
  // this operation. Reading as the ambient `gh` account would refuse a creation
  // the selected account could have proven safe.
  it("rung 7 — reads the claims through the account pinned to the operation", async () => {
    const recorder = ports({
      existing: operation({ environment: "prod" }),
      claimants: {
        dev: {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "orders"
        }
      }
    });

    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "prod",
        operationEnvironment: "prod",
        operationId: "op-1",
        provider: "azure",
        subscriptionId: "sub-1",
        cluster: "aks-1",
        namespace: "payments"
      },
      recorder.ports
    );

    expect(result.outcome).toBe("admitted");
    // Resolved against this operation, not against an ambient account.
    expect(recorder.claimReads).toEqual(["op-1"]);
  });

  it("rung 7 — fails closed when the operation has no pinned account", async () => {
    const recorder = ports({
      existing: operation({ environment: "prod" }),
      noPinnedAccount: true
    });

    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "prod",
        operationEnvironment: "prod",
        operationId: "op-1",
        provider: "azure",
        subscriptionId: "sub-1",
        cluster: "aks-1",
        namespace: "payments"
      },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "refused",
      operation: null,
      refusal: {
        status: 409,
        body: {
          error:
            "Radius created nothing because it could not confirm which namespaces octo/app's environments already use: the GitHub account pinned to this setup is unavailable.",
          code: "namespace-claims-unavailable"
        }
      }
    });
    expect(recorder.persistCalls).toBe(0);
  });

  it("rung 7 — admits a save that keeps the environment's own namespace", async () => {
    const recorder = ports({
      existing: operation(),
      claimants: {
        dev: {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "payments"
        }
      },
      start: { ok: true } as OperationStartResult
    });

    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "dev",
        operationEnvironment: "dev",
        operationId: "op-1",
        provider: "azure",
        subscriptionId: "sub-1",
        cluster: "aks-1",
        namespace: "payments"
      },
      recorder.ports
    );

    expect(result.outcome).toBe("admitted");
  });

  // The identity gap: the same cluster name in another subscription is another
  // cluster, and refusing it would block a legitimate environment.
  it("rung 7 — admits the same namespace on a same-named cluster elsewhere", async () => {
    const recorder = ports({
      existing: operation({ environment: "prod" }),
      claimants: {
        dev: {
          RADIUS_MANAGED: "true",
          AZURE_CLIENT_ID: "client-1",
          AZURE_SUBSCRIPTION_ID: "sub-1",
          AZURE_AKS_CLUSTER_NAME: "aks-1",
          KUBERNETES_NAMESPACE: "payments"
        }
      },
      start: { ok: true } as OperationStartResult
    });

    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "prod",
        operationEnvironment: "prod",
        operationId: "op-1",
        provider: "azure",
        subscriptionId: "sub-2",
        cluster: "aks-1",
        namespace: "payments"
      },
      recorder.ports
    );

    expect(result.outcome).toBe("admitted");
  });

  it("descends the ladder in order, so a malformed slug is refused before any operation lookup", async () => {
    // `getOperation` is unscripted here and throws if reached, which is how the
    // ordering is pinned rather than by reading the source.
    const recorder = ports();
    await expect(
      admitCreateEnvironmentRequest(
        { repo: "bad slug", operationId: "op-1" },
        recorder.ports
      )
    ).resolves.toMatchObject({ refusal: { status: 400 } });
  });
});

describe("admitting a create-environment request", () => {
  it("adopts the operation the identity route left running and enters the configure stage", async () => {
    const existing = operation({
      currentStage: STAGE_IDENTITY,
      environment: "production"
    });
    const recorder = ports({ existing });
    const result = await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        environment: "Production",
        operationEnvironment: "production",
        operationId: "op-1"
      },
      recorder.ports
    );

    expect(result).toEqual({
      outcome: "admitted",
      operation: existing,
      targetRepo: "octo/app",
      envName: "Production",
      provider: "azure"
    });
    expect(recorder.entered).toEqual([
      { operationId: "op-1", stage: STAGE_CONFIGURE }
    ]);
    // Adoption reuses the record, so nothing is started or persisted here.
    expect(recorder.persistCalls).toBe(0);
  });

  it("ignores a non-string operationId and starts a fresh operation instead", async () => {
    const recorder = ports({ start: { ok: true } });
    const result = await admitCreateEnvironmentRequest(
      { repo: "octo/app", operationId: 42 },
      recorder.ports
    );

    expect(result).toMatchObject({ outcome: "admitted" });
    expect(recorder.persistCalls).toBe(1);
  });

  it("starts a fresh operation, persists it, then enters the configure stage", async () => {
    const recorder = ports({ start: { ok: true } });
    const result = await admitCreateEnvironmentRequest(
      { repo: "octo/app", environment: "prod", provider: "aws" },
      recorder.ports
    );

    expect(result).toMatchObject({
      outcome: "admitted",
      targetRepo: "octo/app",
      envName: "prod",
      provider: "aws"
    });
    expect(recorder.persistCalls).toBe(1);
    expect(recorder.entered).toEqual([
      { operationId: "op-new", stage: STAGE_CONFIGURE }
    ]);
  });

  it.each([
    [
      "an empty environment",
      { repo: "octo/app", environment: "" },
      { envName: "dev", provider: "azure" }
    ],
    [
      "an empty provider",
      { repo: "octo/app", provider: "" },
      { envName: "dev", provider: "azure" }
    ]
  ] as Array<
    [
      string,
      CreateEnvironmentRequestData,
      { envName: string; provider: string }
    ]
  >)("defaults %s with `||`, not `??`", async (_case, data, expected) => {
    // `??` would keep "" here. The distinction is observable: an environment
    // named "" is not a valid GitHub environment.
    const recorder = ports({ start: { ok: true } });
    await expect(
      admitCreateEnvironmentRequest(data, recorder.ports)
    ).resolves.toMatchObject(expected);
  });

  it("records the journey the panel supplied, preferring resumeBranch over branch", async () => {
    let captured: Record<string, unknown> | null = null;
    const recorder = ports({ start: { ok: true } });
    const spied: AdmissionPorts = {
      ...recorder.ports,
      createOperation: (input) => {
        captured = input.journey;
        return recorder.ports.createOperation(input);
      }
    };

    await admitCreateEnvironmentRequest(
      {
        repo: "octo/app",
        origin: "panel",
        resumeTarget: "deploy",
        resumeBranch: "feature/x",
        branch: "ignored",
        resumeReason: "retry"
      },
      spied
    );

    expect(captured).toEqual({
      origin: "panel",
      resumeTarget: "deploy",
      resumeBranch: "feature/x",
      resumeReason: "retry"
    });
  });

  it("falls back to branch when no resumeBranch was supplied, and nulls the rest", async () => {
    let captured: Record<string, unknown> | null = null;
    const recorder = ports({ start: { ok: true } });
    const spied: AdmissionPorts = {
      ...recorder.ports,
      createOperation: (input) => {
        captured = input.journey;
        return recorder.ports.createOperation(input);
      }
    };

    await admitCreateEnvironmentRequest(
      { repo: "octo/app", branch: "main" },
      spied
    );

    expect(captured).toEqual({
      origin: null,
      resumeTarget: null,
      resumeBranch: "main",
      resumeReason: null
    });
  });

  it("omits the identity stage from a freshly started operation", async () => {
    // The identity work either already happened on the auto-setup route or
    // cannot happen at all; a stage that cannot run has no place in the
    // checklist, so it is omitted rather than rendered as skipped.
    let captured: { includeIdentity: boolean } | null = null;
    const recorder = ports({ start: { ok: true } });
    const spied: AdmissionPorts = {
      ...recorder.ports,
      buildStages: (input) => {
        captured = input;
        return [];
      }
    };

    await admitCreateEnvironmentRequest({ repo: "octo/app" }, spied);
    expect(captured).toEqual({ includeIdentity: false });
  });
});
