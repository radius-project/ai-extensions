import { expect, it } from "vitest";
import {
  portAbsent,
  portFailure,
  portSuccess,
  type SourceSnapshot,
  type RequestControl,
  type AuthorizedScope
} from "@radius-project/core/lifecycle";
import { createApplicationReadAdapter } from "./application-read.js";

const observedAt = "2026-09-15T00:00:00Z";
const target = {
  repo: "owner/repo",
  definition: ".radius/app.bicep",
  source: {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: `sha256:${"a".repeat(64)}`
  }
};
const scope: AuthorizedScope<"application.inspect"> = {
  operation: "application.inspect",
  principalRef: "reader",
  authorizationRef: "auth",
  target: { ...target, application: "app" }
};
const control: RequestControl = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
it("rejects a canonical resolver selecting another definition", async () => {
  const f = fixture({
    resolveSelection: async () =>
      portSuccess({ ...target, definition: "other.bicep" })
  });
  expect(
    await f.reader.list(
      {
        ...scope,
        operation: "application.list",
        target: { repo: target.repo }
      },
      {},
      control
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
});

it("lists an explicitly selected current-workspace definition without probing alternatives", async () => {
  const definitions: Array<string | undefined> = [];
  const f = fixture({
    resolveSelection: async (_scope, definition) => {
      definitions.push(definition);
      return portSuccess(target);
    }
  });
  expect(
    await f.reader.list(
      {
        ...scope,
        operation: "application.list",
        target: { repo: target.repo }
      },
      { definition: target.definition },
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { items: [{ authored: { definition: target.definition } }] }
  });
  expect(definitions).toEqual([target.definition]);
});

it("reports unavailable deployed evidence when a combined inspection has no matching deployment", async () => {
  const result = await fixture().reader.inspect(
    {
      ...scope,
      target: { ...scope.target, environment: "dev" }
    },
    control
  );
  expect(result.status).toBe("ok");
  const f = fixture({
    deployed: async () =>
      portSuccess({
        items: [],
        observation: {
          quality: "current",
          completeness: "complete",
          evidence: "workflow"
        }
      })
  });
  expect(
    await f.reader.inspect(
      { ...scope, target: { ...scope.target, environment: "dev" } },
      control
    )
  ).toMatchObject({
    status: "ok",
    value: {
      authored: { definition: target.definition },
      deployed: [
        { environment: "dev", observation: { completeness: "unavailable" } }
      ],
      observation: { completeness: "partial" }
    }
  });
});
it("rejects mismatched snapshots and releases them without reading their contents", async () => {
  let released = false;
  const f = fixture({
    source: {
      capture: async () =>
        portSuccess({
          status: "captured",
          snapshot: {
            ...snapshot,
            selection: { ...target, definition: "other.bicep" }
          }
        }),
      readText: async () => {
        throw new Error("Mismatched snapshot must not be read");
      },
      releaseSnapshot: async () => {
        released = true;
        return portSuccess({ status: "released" });
      }
    }
  });
  expect(await f.reader.inspect(scope, control)).toMatchObject({
    status: "unavailable"
  });
  expect(released).toBe(true);
});
it.each(["absent", "failed"] as const)(
  "preserves %s capture after default discovery without guessing an empty list",
  async (status) => {
    const f = fixture({
      source: {
        capture: async () =>
          status === "failed" ?
            portFailure("PRECONDITION_FAILED")
          : portAbsent({
              quality: "current",
              completeness: "complete",
              evidence: "source",
              observedAt
            }),
        readText: async () => {
          throw new Error("Absent snapshot");
        },
        releaseSnapshot: async () => {
          throw new Error("No snapshot acquired");
        }
      }
    });
    expect(
      await f.reader.list(
        {
          ...scope,
          operation: "application.list",
          target: { repo: target.repo }
        },
        {},
        control
      )
    ).toMatchObject({
      status: "failed",
      error: {
        code: status === "absent" ? "SOURCE_CHANGED" : "PRECONDITION_FAILED"
      }
    });
  }
);
it("does not replace explicit Git-source or deployed listing failures with empty success", async () => {
  const { portFailure } = await import("@radius-project/core/lifecycle");
  const failure = portFailure("SOURCE_CHANGED");
  let captures = 0;
  const f = fixture({
    source: {
      capture: async () =>
        ++captures === 1 ?
          portAbsent({
            quality: "current",
            completeness: "complete",
            evidence: "source",
            observedAt
          })
        : failure,
      readText: async () => {
        throw new Error("No snapshot");
      },
      releaseSnapshot: async () => {
        throw new Error("No snapshot");
      }
    },
    deployed: async () => failure
  });
  const list = {
    ...scope,
    operation: "application.list" as const,
    target: { repo: target.repo }
  };
  expect(
    await f.reader.list(
      list,
      {
        source: { kind: "git", ref: "feature", expectedCommit: "a".repeat(40) }
      },
      control
    )
  ).toEqual(failure);
  expect(captures).toBe(2);
  expect(
    await f.reader.list(
      { ...list, target: { ...list.target, environment: "dev" } },
      {},
      control
    )
  ).toEqual(failure);
});
const definitionInput = {
  path: target.definition,
  kind: "definition" as const,
  contentHash: `sha256:${"b".repeat(64)}`,
  existed: true
};
const snapshot: SourceSnapshot = {
  snapshotRef: "snapshot",
  selection: target,
  provenance: {
    repo: target.repo,
    kind: "workspace",
    workspaceRef: "workspace",
    branch: "feature",
    fingerprint: target.source.expectedFingerprint,
    resolvedAt: observedAt
  },
  manifest: {
    completeness: "complete",
    definition: target.definition,
    fingerprint: target.source.expectedFingerprint,
    inputs: [definitionInput]
  }
};
it("inspects captured authored source without any environment, graph or deployment call and releases it", async () => {
  let released = 0;
  const reader = createApplicationReadAdapter({
    clock: { now: () => observedAt },
    extractAppName: () => "app",
    resolveSelection: async (_scope, definition) =>
      definition === target.definition ?
        portSuccess(target)
      : portAbsent({
          quality: "current",
          completeness: "complete",
          evidence: "source",
          observedAt
        }),
    deployed: async () => {
      throw new Error("No environment must be queried");
    },
    source: {
      capture: async () => portSuccess({ status: "captured", snapshot }),
      readText: async () =>
        portSuccess({ input: definitionInput, text: "app" }),
      releaseSnapshot: async () => {
        released++;
        return portSuccess({ status: "released" });
      }
    }
  });
  expect(await reader.inspect(scope, control)).toMatchObject({
    status: "ok",
    value: {
      target: { repo: "owner/repo", application: "app" },
      authored: {
        definition: target.definition,
        provenance: snapshot.provenance
      }
    }
  });
  expect(released).toBe(1);
});
it("retains confirmed definition absence rather than guessing a repository application name", async () => {
  const absent = portAbsent({
    quality: "current",
    completeness: "complete",
    evidence: "source",
    observedAt
  });
  const unexpected = async (): Promise<never> => {
    throw new Error("Unmodeled read");
  };
  const reader = createApplicationReadAdapter({
    clock: { now: () => observedAt },
    extractAppName: () => "",
    resolveSelection: unexpected,
    deployed: unexpected,
    source: {
      capture: async () => absent,
      readText: unexpected,
      releaseSnapshot: unexpected
    }
  });
  expect(await reader.inspect(scope, control)).toEqual(absent);
});

function fixture(
  overrides: Partial<
    import("./application-read.js").ApplicationReadDependencies
  > = {}
) {
  let released = 0;
  const observation = {
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "workflow" as const,
    observedAt
  };
  const reader = createApplicationReadAdapter({
    clock: { now: () => observedAt },
    extractAppName: () => "app",
    resolveSelection: async (_scope, definition) =>
      definition === target.definition ?
        portSuccess(target)
      : portAbsent({
          quality: "current",
          completeness: "complete",
          evidence: "source",
          observedAt
        }),
    deployed: async () =>
      portSuccess({
        items: [
          {
            target: { repo: "owner/repo", application: "app" },
            deployed: [{ environment: "dev", observation }],
            observation
          }
        ],
        observation
      }),
    source: {
      capture: async () => portSuccess({ status: "captured", snapshot }),
      readText: async () =>
        portSuccess({ input: definitionInput, text: "app" }),
      releaseSnapshot: async () => {
        released++;
        return portSuccess({ status: "released" });
      }
    },
    ...overrides
  });
  return { reader, released: () => released };
}

it("requires complete read dependencies", () => {
  expect(() =>
    Reflect.apply(createApplicationReadAdapter, undefined, [{}])
  ).toThrow("require");
});
it("keeps source-only, deployed-only and combined observations scoped separately", async () => {
  const f = fixture();
  expect(
    await f.reader.inspect(
      {
        ...scope,
        target: { repo: target.repo, environment: "dev", application: "app" }
      },
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { deployed: [{ environment: "dev" }] }
  });
  expect(
    await f.reader.inspect(
      { ...scope, target: { ...scope.target, environment: "dev" } },
      control
    )
  ).toMatchObject({
    status: "ok",
    value: {
      authored: { definition: target.definition },
      deployed: [{ environment: "dev" }]
    }
  });
  expect(
    await f.reader.inspect(
      { ...scope, target: { ...scope.target, application: "other" } },
      control
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
});
it.each(["", "${dynamic}", "has spaces", "a".repeat(129)])(
  "does not invent a static identity from %s",
  async (name) => {
    const f = fixture({ extractAppName: () => name });
    expect(await f.reader.inspect(scope, control)).toMatchObject({
      status: "unavailable"
    });
    expect(f.released()).toBe(1);
  }
);
it("keeps source closure failure, failed reads, cleanup failure and cancellation explicit", async () => {
  const { portFailure, portCancelled } =
    await import("@radius-project/core/lifecycle");
  const unexpected = async (): Promise<never> => {
    throw new Error("Unmodeled IO");
  };
  const incomplete = fixture({
    source: {
      capture: async () =>
        portSuccess({
          status: "incomplete",
          manifest: {
            completeness: "incomplete",
            definition: target.definition,
            inputs: [],
            diagnostics: []
          }
        }),
      readText: unexpected,
      releaseSnapshot: unexpected
    }
  });
  expect(await incomplete.reader.inspect(scope, control)).toMatchObject({
    status: "unavailable"
  });
  for (const readText of [
    async () => portFailure("EVIDENCE_MISMATCH"),
    async () => {
      throw new Error("Read failed");
    }
  ]) {
    let releases = 0;
    const f = fixture({
      source: {
        capture: async () => portSuccess({ status: "captured", snapshot }),
        readText,
        releaseSnapshot: async () => {
          releases++;
          return portSuccess({ status: "released" });
        }
      }
    });
    expect((await f.reader.inspect(scope, control)).status).not.toBe("ok");
    expect(releases).toBe(1);
  }
  const badCleanup = fixture({
    source: {
      capture: async () => portSuccess({ status: "captured", snapshot }),
      readText: async () =>
        portSuccess({ input: definitionInput, text: "app" }),
      releaseSnapshot: async () => portFailure("PRECONDITION_FAILED")
    }
  });
  expect(await badCleanup.reader.inspect(scope, control)).toMatchObject({
    status: "failed"
  });
  expect(
    await fixture().reader.inspect(scope, {
      ...control,
      cancellation: { ...control.cancellation, aborted: true }
    })
  ).toEqual(portCancelled("request_cancelled"));
});
it("retains authored evidence while explicitly identifying unavailable deployed evidence", async () => {
  const { portForbidden, portUnavailable, portCancelled } =
    await import("@radius-project/core/lifecycle");
  const unavailable = portUnavailable("RESULT_UNAVAILABLE", {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "workflow"
  });
  const combined = {
    ...scope,
    target: { ...scope.target, environment: "dev" }
  };
  expect(
    await fixture({ deployed: async () => unavailable }).reader.inspect(
      combined,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: {
      observation: { completeness: "partial" },
      deployed: [{ observation: { completeness: "unavailable" } }]
    }
  });
  for (const result of [portForbidden(), portCancelled("request_cancelled")])
    expect(
      await fixture({ deployed: async () => result }).reader.inspect(
        combined,
        control
      )
    ).toEqual(result);
  expect(
    await fixture({ deployed: async () => unavailable }).reader.inspect(
      {
        ...scope,
        target: { repo: target.repo, application: "app", environment: "dev" }
      },
      control
    )
  ).toEqual(unavailable);
  expect(
    await fixture().reader.inspect(
      {
        ...scope,
        target: { repo: target.repo, application: "other", environment: "dev" }
      },
      control
    )
  ).toMatchObject({ status: "unavailable" });
});
it("distinguishes discovered absence, source changes and rejected explicit source filters", async () => {
  const { portFailure } = await import("@radius-project/core/lifecycle");
  const list = {
    ...scope,
    operation: "application.list" as const,
    target: { repo: target.repo }
  };
  const absent = portAbsent({
    quality: "current",
    completeness: "complete",
    evidence: "source",
    observedAt
  });
  expect(await fixture().reader.list(list, {}, control)).toMatchObject({
    status: "ok",
    value: { items: [{ authored: { definition: target.definition } }] }
  });
  expect(
    await fixture({ resolveSelection: async () => absent }).reader.list(
      list,
      {},
      control
    )
  ).toMatchObject({ status: "ok", value: { items: [] } });
  expect(
    await fixture({
      resolveSelection: async () => portFailure("SOURCE_CHANGED")
    }).reader.list(list, {}, control)
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture().reader.list(list, { source: target.source }, control)
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture().reader.list(
      list,
      { source: target.source, definition: target.definition },
      control
    )
  ).toMatchObject({ status: "ok" });
  expect(
    await fixture().reader.list(
      { ...list, target: { ...list.target, environment: "dev" } },
      {},
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { items: [{ deployed: [{ environment: "dev" }] }] }
  });
});
