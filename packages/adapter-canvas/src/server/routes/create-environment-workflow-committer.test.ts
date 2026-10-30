import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createWorkflowFileCommitter as createCoreCommitter } from "@radius-project/core";
import { createSetupWorkflowRecoveryPort } from "../services/setup-workflow-recovery.js";
import {
  createOperation,
  fromPersistedOperation,
  prepareProviderMutation,
  providerRecoveryManualGuidance,
  requestStop,
  settleProviderMutation,
  stopAtBoundary,
  toPersistedOperation
} from "../../operations.js";
import {
  createWorkflowFileCommitter,
  bindWorkflowFileCommitterPorts,
  recordedSetupBranchCreate,
  workflowContentDigest,
  type WorkflowFileCommitterPorts
} from "./create-environment-workflow-committer.js";
import type { CreateEnvironmentCommandResult } from "./create-environment-types.js";

interface GhCall {
  kind: "runGh" | "runGhWorkflow";
  args: string[];
}

interface Script {
  trace?: unknown[];
  runGh?: Partial<CreateEnvironmentCommandResult>[];
  runGhWorkflow?: Partial<CreateEnvironmentCommandResult>[];
  defaultBranch?: string | null;
  headSha?: string | null;
  createBranch?: { ok: boolean; stderr: string; timedOut?: boolean };
}

interface Harness {
  ports: WorkflowFileCommitterPorts;
  calls: GhCall[];
  steps: string[];
  tempWrites: string[];
  tempRemovals: string[];
}

const CONTENT = Buffer.from("on: push").toString("base64");
// sha256 of the exact bytes CONTENT carries, written out rather than recomputed
// with the production formula so a change to that formula is visible here.
const CONTENT_DIGEST =
  "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a";
// What the contents API answers a successful write with.
const PUT_RESPONSE = JSON.stringify({
  content: { sha: "blob-1" },
  commit: { sha: "commit-1" }
});
const NO_PROVENANCE = {
  commitSha: null,
  blobSha: null,
  contentSha256: CONTENT_DIGEST,
  previousBlobSha: null,
  previousBlobKnown: false
};
const KNOWN_ABSENT_PROVENANCE = {
  ...NO_PROVENANCE,
  previousBlobKnown: true
};

// `gh` and the filesystem are isolated behind scripted fakes that throw on any
// unmodelled call. `isProtectedBranchFailure` is pure and is imported, never
// doubled — a double for it could only diverge from production.
function harness(script: Script = {}): Harness {
  const calls: GhCall[] = [];
  const steps: string[] = [];
  const tempWrites: string[] = [];
  const tempRemovals: string[] = [];
  const runGh = [...(script.runGh ?? [])];
  const runGhWorkflow = [...(script.runGhWorkflow ?? [])];

  const take = (
    kind: GhCall["kind"],
    queue: Partial<CreateEnvironmentCommandResult>[],
    args: string[]
  ): Promise<CreateEnvironmentCommandResult> => {
    calls.push({ kind, args });
    script.trace?.push([kind, args]);
    const next = queue.shift();
    if (!next) throw new Error(`unscripted ${kind}: ${args.join(" ")}`);
    return Promise.resolve({
      code: next.code ?? 0,
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      ...(next.timedOut ? { timedOut: true } : {})
    });
  };

  return {
    calls,
    steps,
    tempWrites,
    tempRemovals,
    ports: {
      runGh: (args) => take("runGh", runGh, args),
      runGhWorkflow: (args) => take("runGhWorkflow", runGhWorkflow, args),
      getDefaultBranch: () => {
        if (!("defaultBranch" in script)) {
          throw new Error("unscripted getDefaultBranch");
        }
        return Promise.resolve(script.defaultBranch);
      },
      getBranchHeadSha: () => {
        if (!("headSha" in script)) {
          throw new Error("unscripted getBranchHeadSha");
        }
        return Promise.resolve(script.headSha);
      },
      createBranchRef: () => {
        if (!script.createBranch) throw new Error("unscripted createBranchRef");
        return Promise.resolve(script.createBranch);
      },
      tempFile: {
        write: (contents) => {
          tempWrites.push(contents);
          return `/tmp/body-${tempWrites.length}.json`;
        },
        remove: (path) => {
          tempRemovals.push(path);
        }
      },
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      pushStep: (message) => {
        steps.push(message);
      },
      now: () => 1700000000000
    }
  };
}

const target = { targetRepo: "octo/app", envName: "dev" };

afterEach(() => vi.useRealTimers());

it.each(["saved-base", "replacement", "absent", "malformed"] as const)(
  "settles only complete issued branch-create proof after shutdown (%s)",
  async (boundary) => {
    const operation = createOperation({ operationId: "op_branch-proof" });
    const create = prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0saved-branch\0base-sha"
    });
    settleProviderMutation(
      operation,
      create.mutationId,
      "outcome_unknown",
      "Lost acknowledgement"
    );
    const unknown = structuredClone(operation.providerRecovery);
    const h = harness({ defaultBranch: "main" });
    let stopped = false;
    const read = vi.fn(async () => {
      stopped = true;
      return {
        code: boundary === "absent" ? 1 : 0,
        stderr: boundary === "absent" ? "HTTP 404" : "",
        stdout:
          boundary === "malformed" ? "{" : (
            JSON.stringify({
              object: {
                sha: boundary === "saved-base" ? "base-sha" : "replacement"
              }
            })
          )
      };
    });
    h.ports.runGh = read;
    const persist = vi.fn(async () => {});
    h.ports.mutationRecovery = { operation, persist, isStopped: () => stopped };
    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
    expect(read).toHaveBeenCalledOnce();
    expect(h.calls).toEqual([]);
    expect(h.tempWrites).toEqual([]);
    if (boundary === "saved-base") {
      expect(operation.providerRecovery.mutations).toHaveLength(1);
      expect(operation.providerRecovery.mutations[0].status).toBe("confirmed");
      expect(persist).toHaveBeenCalledOnce();
    } else {
      expect(operation.providerRecovery).toEqual(unknown);
      expect(persist).not.toHaveBeenCalled();
    }
  }
);

describe.each(["new", 0, 11] as const)(
  "workflow nested reads (%s prior attempts)",
  (attempts) => {
    it.each([
      "content",
      "absent",
      "malformed-content",
      "digest",
      "between-pages",
      "page-100",
      "malformed-history",
      "denied",
      "rejection",
      "ambiguous",
      "unmatched",
      "positive"
    ] as const)(
      "fences shutdown during %s without losing issued positive proof",
      async (boundary) => {
        let operation = createOperation({
          operationId: "op_workflow-nested",
          repo: "octo/app",
          environment: "dev",
          provider: "azure"
        });
        const marker = `radius-operation:op_workflow-nested:workflow:p:${CONTENT_DIGEST.slice(0, 16)}`;
        if (attempts !== "new") {
          const mutation = prepareProviderMutation(operation, {
            kind: "github_workflow.put",
            target: "octo/app:<default>:p",
            intent: {
              branch: "<default>",
              path: "p",
              previousBlobSha: null,
              previousBlobKnown: true,
              contentSha256: CONTENT_DIGEST,
              operationMarker: marker
            }
          });
          settleProviderMutation(
            operation,
            mutation.mutationId,
            "outcome_unknown",
            "Lost acknowledgement"
          );
          operation.providerRecovery.mutations[0].reconcileAttempts = attempts;
          operation = fromPersistedOperation(toPersistedOperation(operation));
          expect(
            operation.providerRecovery.mutations[0].reconcileAttempts ?? 0
          ).toBe(attempts);
        }
        const h = harness();
        let stopped = false;
        let unknown: unknown;
        const persist = vi.fn(async () => {});
        let savesAtShutdown = 0;
        const shutdown = () => {
          unknown = structuredClone(operation.providerRecovery);
          savesAtShutdown = persist.mock.calls.length;
          stopped = true;
        };
        const fullPage = Array.from({ length: 100 }, (_, i) => ({
          sha: String(i).padStart(40, "0"),
          commit: { message: "unrelated" }
        }));
        const matching = {
          sha: "a".repeat(40),
          commit: { message: `Radius-Operation: ${marker}` }
        };
        const read = vi.fn(async (args: string[]) => {
          if (args.includes("--jq"))
            return { code: 1, stdout: "", stderr: "HTTP 404" };
          if (args[1].includes("/contents/")) {
            if (
              ["content", "absent", "malformed-content", "digest"].includes(
                boundary
              )
            )
              shutdown();
            return {
              code: boundary === "absent" ? 1 : 0,
              stdout:
                boundary === "malformed-content" ? "{" : (
                  JSON.stringify({
                    sha: "blob-1",
                    content: boundary === "digest" ? "b3RoZXI=" : CONTENT
                  })
                ),
              stderr: boundary === "absent" ? "HTTP 404" : ""
            };
          }
          if (!args[1].includes("/commits?"))
            throw new Error(`Unexpected read ${args}`);
          if (boundary !== "page-100" || args[1].endsWith("page=100"))
            shutdown();
          if (boundary === "rejection") throw new Error("Read rejected");
          return {
            code: boundary === "denied" ? 1 : 0,
            stdout:
              boundary === "malformed-history" ? "{" : (
                JSON.stringify(
                  boundary === "between-pages" || boundary === "page-100" ?
                    fullPage
                  : boundary === "ambiguous" ? [matching, matching]
                  : boundary === "unmatched" ? []
                  : [matching]
                )
              ),
            stderr: boundary === "denied" ? "HTTP 403" : ""
          };
        });
        const write = vi.fn(async () => ({
          code: 1,
          stdout: "",
          stderr: "ECONNRESET"
        }));
        h.ports.runGh = read;
        h.ports.runGhWorkflow = write;
        h.ports.mutationRecovery = {
          operation,
          persist,
          isStopped: () => stopped
        };
        const pending = createWorkflowFileCommitter(
          h.ports,
          target
        ).commitWorkflowFileSmart("p", CONTENT, "m");
        if (boundary === "positive") {
          await expect(pending).resolves.toMatchObject({
            ok: true,
            blobSha: "blob-1",
            commitSha: matching.sha
          });
          expect(operation.providerRecovery.mutations[0].status).toBe(
            "confirmed"
          );
        } else {
          await expect(pending).rejects.toMatchObject({
            code: "setup-execution-interrupted"
          });
          expect(operation.providerRecovery).toEqual(unknown);
          expect(persist).toHaveBeenCalledTimes(savesAtShutdown);
        }
        expect(read).toHaveBeenCalledTimes(
          (
            ["content", "absent", "malformed-content", "digest"].includes(
              boundary
            )
          ) ?
            2
          : boundary === "page-100" ? 102
          : 3
        );
        expect(write).toHaveBeenCalledTimes(attempts === "new" ? 1 : 0);
        expect(h.tempRemovals).toEqual(["/tmp/body-1.json"]);
      }
    );
  }
);

describe.each(["create", "delete"] as const)(
  "core-injected branch %s recovery",
  (kind) => {
    it.each(["page", "exact", "negative", "positive"] as const)(
      "uses the core assertion at the nested %s boundary",
      async (boundary) => {
        const operation = createOperation({ operationId: "op_workflow" });
        operation.recoveryState = "provider_reconciliation_pending";
        const branch = "radius/setup-dev-workflows-workflow";
        const create = prepareProviderMutation(operation, {
          kind: "github_branch.create",
          target: `octo/app\0${branch}\0sha-1`
        });
        settleProviderMutation(
          operation,
          create.mutationId,
          "outcome_unknown",
          "Lost create acknowledgement"
        );
        operation.providerRecovery.mutations[0].reconcileAttempts = 11;
        const h = harness({ defaultBranch: "main" });
        let stopped = false;
        let unknown: unknown;
        let exactReads = 0;
        let savesAtShutdown = 0;
        const persist = vi.fn(async () => {});
        const shutdown = () => {
          unknown = structuredClone(operation.providerRecovery);
          savesAtShutdown = persist.mock.calls.length;
          stopped = true;
        };
        const read = vi.fn(async (args: string[]) => {
          if (args[1].includes("/matching-refs/")) {
            if (boundary === "page" || boundary === "exact") shutdown();
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify(
                boundary === "page" ?
                  Array.from({ length: 100 }, (_, i) => ({
                    ref: `refs/heads/${branch}-${i}`
                  }))
                : []
              )
            };
          }
          if (args[1].includes("/git/ref/heads/")) {
            exactReads++;
            if (exactReads === 1 && kind === "delete")
              return {
                code: 0,
                stderr: "",
                stdout: '{"object":{"sha":"sha-1"}}'
              };
            if (exactReads === 2) shutdown();
            return {
              code: boundary === "negative" && exactReads === 2 ? 0 : 1,
              stderr: "HTTP 404",
              stdout: ""
            };
          }
          throw new Error(`Unexpected read ${args}`);
        });
        h.ports.runGh = read;
        const write = vi.fn(async () => ({
          code: 1,
          stderr: "ECONNRESET",
          stdout: ""
        }));
        h.ports.runGhWorkflow = write;
        // Production binds transport first; core injects recovery afterwards.
        const ports = bindWorkflowFileCommitterPorts(h.ports);
        ports.mutationRecovery = createSetupWorkflowRecoveryPort(
          operation,
          persist,
          () => stopped
        );
        const pending = createCoreCommitter(
          ports,
          target
        ).commitWorkflowFileSmart("p", CONTENT, "m");
        if (kind === "delete" && boundary === "positive") {
          await expect(pending).rejects.toMatchObject({
            code: "provider-mutation-recovered-rollback"
          });
          expect(operation.providerRecovery.mutations.at(-1)?.status).toBe(
            "confirmed"
          );
        } else {
          await expect(pending).rejects.toMatchObject({
            code: "setup-execution-interrupted"
          });
          expect(operation.providerRecovery).toEqual(unknown);
          expect(persist).toHaveBeenCalledTimes(savesAtShutdown);
        }
        expect(read).toHaveBeenCalledTimes(
          boundary === "page" || boundary === "exact" ? 2 : 3
        );
        expect(write).toHaveBeenCalledTimes(kind === "delete" ? 1 : 0);
        expect(h.tempWrites).toEqual([]);
      }
    );
  }
);

it("does not start history after shutdown during matching content reconciliation", async () => {
  const operation = createOperation({
    operationId: "workflow-content-shutdown"
  });
  const h = harness({
    runGh: [
      { code: 1, stderr: "HTTP 404" },
      { stdout: JSON.stringify({ sha: "blob-1", content: CONTENT }) },
      {
        stdout: JSON.stringify([
          {
            sha: "a".repeat(40),
            commit: {
              message: `Radius-Operation: radius-operation:workflow-content-shutdown:workflow:p:${CONTENT_DIGEST.slice(0, 16)}`
            }
          }
        ])
      }
    ],
    runGhWorkflow: [{ code: 1, stderr: "ECONNRESET" }]
  });
  let stopped = false;
  let unknown: unknown;
  const read = h.ports.runGh;
  h.ports.runGh = async (args) => {
    const result = await read(args);
    if (!args.includes("--jq")) {
      unknown = structuredClone(operation.providerRecovery);
      stopped = true;
    }
    return result;
  };
  h.ports.mutationRecovery = {
    operation,
    isStopped: () => stopped,
    persist: async () => {}
  };
  await expect(
    createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
      "p",
      CONTENT,
      "m"
    )
  ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
  expect(h.calls).toHaveLength(3);
  expect(operation.providerRecovery).toEqual(unknown);
  expect(h.tempRemovals).toEqual(["/tmp/body-1.json"]);
});

it.each(["github_workflow.put", "github_branch.create"])(
  "sends no %s request when shutdown wins prepared-intent persistence",
  async (kind) => {
    const operation = createOperation({ operationId: "held-publication" });
    const h = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const branch = vi.spyOn(h.ports, "createBranchRef");
    let stopped = false;
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepared = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const statuses: string[] = [];
    h.ports.mutationRecovery = {
      operation,
      isStopped: () => stopped,
      persist: async () => {
        const mutation = operation.providerRecovery.mutations.at(-1);
        if (mutation?.kind !== kind) return;
        statuses.push(mutation.status);
        if (mutation.status === "prepared") {
          entered();
          await gate;
        }
      }
    };
    const pending = createWorkflowFileCommitter(
      h.ports,
      target
    ).commitWorkflowFileSmart("p", CONTENT, "m");
    const rejected = expect(pending).rejects.toMatchObject({
      code: "setup-execution-interrupted"
    });
    await prepared;
    const before = h.calls.length;
    stopped = true;
    release();
    await rejected;
    expect(h.calls).toHaveLength(before);
    expect(branch).not.toHaveBeenCalled();
    expect(statuses).toEqual(["prepared", "not_applied"]);
    expect(h.tempRemovals).toEqual(
      h.tempWrites.map((_, index) => `/tmp/body-${index + 1}.json`)
    );
  }
);

it("publication baseline parity: recovered empty-branch deletion", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1700000000000);
  const trace: unknown[] = [];
  const h = harness({
    trace,
    runGh: [{ code: 0, stdout: '{"object":{"sha":"sha-1"}}' }],
    runGhWorkflow: [{ code: 0 }],
    defaultBranch: "main",
    headSha: "sha-1"
  });
  const operation = createOperation({ operationId: "op_workflow" });
  operation.recoveryState = "provider_reconciliation_pending";
  prepareProviderMutation(operation, {
    kind: "github_branch.create",
    target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
    providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
  });
  h.ports.mutationRecovery = {
    isStopped: () => false,
    operation,
    persist: async () => {
      trace.push([
        "save",
        JSON.parse(JSON.stringify(operation.providerRecovery))
      ]);
    }
  };
  await expect(
    createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
      "p",
      CONTENT,
      "m"
    )
  ).rejects.toMatchObject({ code: "provider-mutation-recovered-rollback" });
  expect(h.calls.filter((call) => call.args.includes("DELETE"))).toHaveLength(
    1
  );
  expect({
    trace,
    steps: h.steps,
    durable: operation.providerRecovery
  }).toMatchSnapshot();
});

describe("committing a workflow file", () => {
  it("does not commit twice after a successful write, persisted stop, and restart", async () => {
    const operation = createOperation({ operationId: "op_workflow" });
    const saved: string[] = [];
    const commitSha = "a".repeat(40);
    const first = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [
        {
          code: 0,
          stdout: JSON.stringify({
            content: { sha: "blob-1" },
            commit: { sha: commitSha }
          })
        }
      ]
    });
    first.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {
        saved.push(JSON.stringify(toPersistedOperation(operation)));
      }
    };
    const file = ".github/workflows/a.yml";
    const written = await createWorkflowFileCommitter(
      first.ports,
      target
    ).commitWorkflowFileSmart(file, CONTENT, "Add a");

    expect(written).toMatchObject({ ok: true, commitSha });
    expect(JSON.parse(saved.at(-1) ?? "{}").providerRecovery.mutations).toEqual(
      [
        expect.objectContaining({
          kind: "github_workflow.put",
          status: "confirmed"
        })
      ]
    );
    expect(requestStop(operation)).toBe(true);
    stopAtBoundary(operation, "after-workflow-commit");
    const persisted = JSON.stringify(toPersistedOperation(operation));
    const reloaded = fromPersistedOperation(JSON.parse(persisted));
    expect(reloaded).toMatchObject({
      state: "cancelled",
      control: { stop: { boundary: "after-workflow-commit" } }
    });

    const second = harness({
      runGh: [
        { code: 0, stdout: "blob-1" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-1", content: CONTENT })
        },
        {
          code: 0,
          stdout: JSON.stringify([
            {
              sha: commitSha,
              commit: {
                message:
                  "Add a\n\nRadius-Operation: radius-operation:op_workflow:workflow:.github/workflows/a.yml:fff71b97a5a94949"
              }
            }
          ])
        }
      ]
    });
    second.ports.mutationRecovery = {
      isStopped: () => false,
      operation: reloaded,
      persist: async () => {
        saved.push(JSON.stringify(toPersistedOperation(reloaded)));
      }
    };

    await expect(
      createWorkflowFileCommitter(second.ports, target).commitWorkflowFileSmart(
        file,
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual(written);
    expect(
      first.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toHaveLength(1);
    expect(
      second.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toEqual([]);
    expect(second.calls.map((call) => call.args[1])).toEqual([
      "/repos/octo/app/contents/.github/workflows/a.yml",
      "/repos/octo/app/contents/.github/workflows/a.yml",
      "/repos/octo/app/commits?per_page=100&page=1"
    ]);
    expect(second.tempRemovals).toEqual(["/tmp/body-1.json"]);
    expect(reloaded.state).toBe("cancelled");
  });

  it("does not write when the workflow already matches generated content", async () => {
    const bytes = Buffer.from(CONTENT, "base64");
    const blobSha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    const h = harness({
      runGh: [{ code: "0", stdout: blobSha }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual({
      ok: true,
      changed: false,
      stderr: "",
      viaPr: false,
      commitSha: null,
      blobSha,
      contentSha256: CONTENT_DIGEST,
      previousBlobSha: blobSha,
      previousBlobKnown: true
    });
    expect(h.calls.filter((call) => call.kind === "runGhWorkflow")).toEqual([]);
    expect(h.tempWrites).toEqual([]);
  });

  it("does not trust stdout from a failed string command code", async () => {
    const h = harness({
      runGh: [{ code: "ENOENT", stdout: "untrusted-blob" }],
      runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
    });

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      previousBlobSha: null,
      previousBlobKnown: false
    });
    expect(JSON.parse(h.tempWrites[0] ?? "{}")).not.toHaveProperty("sha");
  });

  it("uses the workflow path to distinguish equal-content operation markers", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        { code: 1, stderr: "HTTP 404: Not Found" }
      ],
      runGhWorkflow: [
        { code: 0, stdout: PUT_RESPONSE },
        { code: 0, stdout: PUT_RESPONSE }
      ]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("first.yml", CONTENT, "Add first");
    await committer.commitWorkflowFileSmart(
      "second.yml",
      CONTENT,
      "Add second"
    );

    const messages = h.tempWrites.map(
      (body) => JSON.parse(body).message as string
    );
    expect(messages[0]).toContain(
      "radius-operation:op_workflow:workflow:first.yml:fff71b97a5a94949"
    );
    expect(messages[1]).toContain(
      "radius-operation:op_workflow:workflow:second.yml:fff71b97a5a94949"
    );
  });

  it("adopts an unchanged workflow write from branch history after a timed-out response", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        {
          code: 0,
          stdout: JSON.stringify(
            Array.from({ length: 100 }, () => ({
              sha: "d".repeat(40),
              commit: { message: "Unrelated commit" }
            }))
          )
        },
        {
          code: 0,
          // GitHub excludes an unchanged-content commit from path-filtered
          // history, but paginated branch history still returns its marker.
          stdout: JSON.stringify([
            {
              sha: "a".repeat(40),
              commit: {
                message:
                  "Add a\n\nRadius-Operation: radius-operation:op_workflow:workflow:.github/workflows/a.yml:fff71b97a5a94949"
              }
            }
          ])
        }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({
      ok: true,
      viaPr: false,
      commitSha: "a".repeat(40),
      blobSha: "blob-recovered",
      contentSha256: CONTENT_DIGEST,
      previousBlobKnown: true
    });
    expect(
      h.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toHaveLength(1);
    expect(
      h.calls
        .filter((call) => call.args[1]?.includes("/commits?"))
        .map((call) => call.args[1])
    ).toEqual([
      "/repos/octo/app/commits?per_page=100&page=1",
      "/repos/octo/app/commits?per_page=100&page=2"
    ]);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      intent: {
        branch: "<default>",
        path: ".github/workflows/a.yml",
        previousBlobSha: null,
        previousBlobKnown: true,
        contentSha256: CONTENT_DIGEST
      }
    });
  });

  it("stops pagination once the exact commit is found on a full page", async () => {
    const operationMarker =
      "radius-operation:op_workflow:workflow:.github/workflows/a.yml:fff71b97a5a94949";
    const history = [
      {
        sha: "a".repeat(40),
        commit: { message: `Add a\n\nRadius-Operation: ${operationMarker}` }
      },
      ...Array.from({ length: 99 }, () => ({
        sha: "d".repeat(40),
        commit: { message: "Unrelated commit" }
      }))
    ];
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 0, stdout: JSON.stringify(history) }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({ ok: true, commitSha: "a".repeat(40) });
    expect(
      h.calls.filter((call) => call.args[1]?.includes("/commits?"))
    ).toHaveLength(1);
  });

  it("stops pagination once the operation marker is ambiguous", async () => {
    const operationMarker =
      "radius-operation:op_workflow:workflow:.github/workflows/a.yml:fff71b97a5a94949";
    const history = [
      {
        sha: "a".repeat(40),
        commit: { message: `Add a\n\nRadius-Operation: ${operationMarker}` }
      },
      {
        sha: "b".repeat(40),
        commit: { message: `Add a\n\nRadius-Operation: ${operationMarker}` }
      },
      ...Array.from({ length: 98 }, () => ({
        sha: "d".repeat(40),
        commit: { message: "Unrelated commit" }
      }))
    ];
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 0, stdout: JSON.stringify(history) }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("one exact commit")
    });
    expect(
      h.calls.filter((call) => call.args[1]?.includes("/commits?"))
    ).toHaveLength(1);
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["a non-array response", JSON.stringify({ message: "unexpected" })]
  ])("fails closed for %s in commit history", async (_label, history) => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 0, stdout: history }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("unreadable commit history")
    });
  });

  it("fails closed when commit history exceeds the pagination bound", async () => {
    const fullPage = JSON.stringify(
      Array.from({ length: 100 }, () => ({
        sha: "d".repeat(40),
        commit: { message: "Unrelated commit" }
      }))
    );
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        ...Array.from({ length: 100 }, () => ({
          code: 0,
          stdout: fullPage
        }))
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("could not finish searching")
    });
    expect(
      h.calls.filter((call) => call.args[1]?.includes("/commits?"))
    ).toHaveLength(100);
  });

  it("fails closed immediately when commit history cannot be read", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 1, stderr: "commit history temporarily unavailable" }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("unreadable commit history")
    });
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "manual_required"
    });
  });

  it("fails closed when exact created commit provenance cannot be recovered", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 0, stdout: "[]" }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("one exact commit")
    });
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "manual_required"
    });
  });

  it("fails closed when the workflow path changed after a timed-out response", async () => {
    const otherContent = Buffer.from("different").toString("base64");
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({
            sha: "blob-other",
            content: otherContent
          })
        }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("will not overwrite or remove it")
    });
    expect(operation.providerRecovery.state).toBe("manual_required");
  });

  it("commits straight to the default branch and reports no pull request", async () => {
    const h = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 0 }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual({
      ok: true,
      changed: true,
      stderr: "",
      viaPr: false,
      ...KNOWN_ABSENT_PROVENANCE
    });
    expect(committer.pullRequestState()).toBeUndefined();
    expect(h.steps).toEqual([]);
    expect(h.calls[1]?.args).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/octo/app/contents/.github/workflows/a.yml",
      "--input",
      "/tmp/body-1.json"
    ]);
    expect(JSON.parse(h.tempWrites[0] ?? "{}")).toEqual({
      message: "Add a",
      content: CONTENT
    });
  });

  it("updates an existing file by carrying its blob sha", async () => {
    const h = harness({
      runGh: [{ code: 0, stdout: "  abc123\n" }],
      runGhWorkflow: [{ code: 0 }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart(
      ".github/workflows/a.yml",
      CONTENT,
      "Update a"
    );
    expect(JSON.parse(h.tempWrites[0] ?? "{}")).toEqual({
      message: "Update a",
      content: CONTENT,
      sha: "abc123"
    });
  });

  it("removes the request body file after the commit, success or failure", async () => {
    const h = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("p", CONTENT, "m");
    expect(h.tempRemovals).toEqual(["/tmp/body-1.json"]);
  });

  it("captures the commit, blob and content identities of a successful write", async () => {
    const h = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    // Everything a later rollback needs to prove this file is still Radius's
    // own work, captured at the moment of the write rather than reconstructed.
    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual({
      ok: true,
      changed: true,
      stderr: "",
      viaPr: false,
      commitSha: "commit-1",
      blobSha: "blob-1",
      contentSha256: CONTENT_DIGEST,
      previousBlobSha: null,
      previousBlobKnown: true
    });
  });

  it("records the blob it replaced so a rollback can restore it", async () => {
    const h = harness({
      runGh: [{ code: 0, stdout: "  existing-blob\n" }],
      runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Update a"
      )
    ).resolves.toMatchObject({ previousBlobSha: "existing-blob" });
    await expect(
      createWorkflowFileCommitter(
        harness({
          runGh: [{ code: 1, stderr: "HTTP 500" }],
          runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
        }).ports,
        target
      ).commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toMatchObject({ previousBlobKnown: false });
  });

  it("keeps a failed commit free of provenance", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr: "HTTP 500",
      viaPr: false
    });
  });

  it("surfaces a non-permission failure verbatim without opening a pull request", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500: server error" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr: "HTTP 500: server error",
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });
});

describe("the protected-branch pull-request fallback", () => {
  it("adopts a timed-out operation-specific branch without creating a duplicate", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        {
          code: 0,
          stdout: JSON.stringify({ object: { sha: "sha-1" } })
        },
        { code: 1, stderr: "HTTP 404: Not Found" }
      ],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }, { code: 0 }],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: false, stderr: "terminated", timedOut: true }
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toMatchObject({ ok: true, viaPr: true });
    expect(operation.providerRecovery.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "github_branch.create",
          status: "confirmed"
        })
      ])
    );
  });

  it("removes a recovered empty setup branch before automatic rollback", async () => {
    const h = harness({
      runGh: [
        {
          code: 0,
          stdout: JSON.stringify({ object: { sha: "sha-1" } })
        }
      ],
      runGhWorkflow: [{ code: 0 }],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).rejects.toMatchObject({
      code: "provider-mutation-recovered-rollback"
    });
    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
  });

  it("reports no removal and starts no rollback when GitHub refuses the delete", async () => {
    const h = harness({
      runGh: [
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "HTTP 403: Required status check is not met" }
      ],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required"
    });
    // One delete attempt, never repeated, and no rollback claimed off the back
    // of a removal that did not happen.
    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(
      operation.providerRecovery.mutations.find(
        (entry: { kind: string }) => entry.kind === "github_branch.delete"
      )
    ).toMatchObject({ status: "manual_required" });
    // Manual guidance is what stops the automatic rollback from starting off a
    // removal that never happened; the record still offers a customer-driven
    // rollback for the resources Radius can prove it owns.
    expect(providerRecoveryManualGuidance(operation)).toContain(
      "Remove that exact branch yourself"
    );
  });

  it("leaves the delete unresolved when its answer is lost rather than refused", async () => {
    const h = harness({
      runGh: [
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) },
        // The reconcile read that follows the lost delete.
        { code: 1, stderr: "HTTP 500: server error" }
      ],
      runGhWorkflow: [{ code: 1, stderr: "socket hang up" }],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });
    expect(
      operation.providerRecovery.mutations.find(
        (entry: { kind: string }) => entry.kind === "github_branch.delete"
      )
    ).toMatchObject({ status: "outcome_unknown" });
    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
  });

  it("creates a branch off the default branch head and re-commits there", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }, { code: 0 }],
      defaultBranch: "trunk",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: true,
      changed: true,
      stderr: "",
      viaPr: true,
      ...KNOWN_ABSENT_PROVENANCE
    });
    expect(committer.pullRequestState()).toEqual({
      branch: "radius/setup-dev-workflows-1700000000000",
      base: "trunk"
    });
    expect(h.steps).toEqual([
      'ℹ️ No permission to push to "trunk" directly — committing workflows to branch "radius/setup-dev-workflows-1700000000000" and opening a pull request.'
    ]);
    // The retry reads the blob sha on the new ref, not on the default branch.
    expect(h.calls[2]?.args[1]).toBe(
      "/repos/octo/app/contents/p?ref=radius%2Fsetup-dev-workflows-1700000000000"
    );
    expect(JSON.parse(h.tempWrites[1] ?? "{}")).toMatchObject({
      branch: "radius/setup-dev-workflows-1700000000000"
    });
  });

  it("finishes the first fallback commit when Stop arrives after branch creation", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        { code: 1, stderr: "HTTP 404: Not Found" }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 0, stdout: PUT_RESPONSE }
      ],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const operation = createOperation({ operationId: "op_workflow" });
    const boundaries: string[] = [];
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {
        const fallbackWrite = operation.providerRecovery.mutations.find(
          (entry: {
            kind: string;
            status: string;
            intent?: { branch?: string };
          }) =>
            entry.kind === "github_workflow.put" &&
            entry.intent?.branch === "radius/setup-dev-workflows-workflow" &&
            entry.status === "prepared"
        );
        if (fallbackWrite) requestStop(operation);
      },
      beforeMutation: async (kind) => {
        boundaries.push(kind);
        return true;
      }
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).resolves.toMatchObject({ ok: true, viaPr: true });

    expect(operation.stopRequested).toBe(true);
    expect(
      boundaries.filter((kind) => kind === "github_workflow.put")
    ).toHaveLength(1);
    expect(
      h.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toHaveLength(2);
  });

  it("refuses PR fallback when the repository reports no default branch", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: null
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr:
        "protected branch (PR fallback failed: could not resolve the repository default branch)",
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });

  it("reports the branch commit failure when the fallback commit is refused too", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 1, stderr: "HTTP 422: branch is behind" }
      ],
      defaultBranch: "trunk",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    // The branch exists, so the failure belongs to it: no provenance is
    // reported, and the caller is told the commit went through the pull-request
    // path.
    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr: "HTTP 422: branch is behind",
      viaPr: true
    });
    expect(committer.pullRequestState()).toMatchObject({ base: "trunk" });
  });

  it("sends every later commit to the established branch without probing the default branch again", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        { code: 1, stderr: "HTTP 404: Not Found" },
        { code: 1, stderr: "HTTP 404: Not Found" }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 0 },
        { code: 0 }
      ],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("first", CONTENT, "m");
    await expect(
      committer.commitWorkflowFileSmart("second", CONTENT, "m")
    ).resolves.toEqual({
      ok: true,
      changed: true,
      stderr: "",
      viaPr: true,
      ...KNOWN_ABSENT_PROVENANCE
    });
    // `createBranchRef` is scripted once; a second branch creation would exhaust
    // it and throw, so a single announcement pins the laziness.
    expect(h.steps).toHaveLength(1);
  });

  it("reports a failed commit on the pull-request branch as a pull-request commit", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }, { code: 1 }],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 0 },
        { code: 1, stderr: "HTTP 422" }
      ],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("first", CONTENT, "m");
    await expect(
      committer.commitWorkflowFileSmart("second", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr: "HTTP 422",
      viaPr: true
    });
  });

  it("keeps the original refusal and explains the fallback failure when the base head cannot be resolved", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: "main",
      headSha: null
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr:
        'protected branch (PR fallback failed: could not resolve head of base branch "main")',
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });

  it("keeps the original refusal when the branch cannot be created", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: false, stderr: "name already exists" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      changed: false,
      stderr:
        'protected branch (PR fallback failed: could not create branch "radius/setup-dev-workflows-1700000000000": name already exists)',
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });
});

describe("what survives a crash during a recovered branch delete", () => {
  function refusedDeleteHarness() {
    const h = harness({
      runGh: [
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "HTTP 403: Required status check is not met" }
      ],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\u0000radius/setup-dev-workflows-workflow\u0000sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    return { h, operation };
  }

  it("never persists the refusal as a resolved non-application", async () => {
    const { h, operation } = refusedDeleteHarness();
    // Every state the record reaches disk in. A crash can land on any of them,
    // so none may say the delete is settled while the branch is still there.
    const saved: Array<string | undefined> = [];
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {
        saved.push(
          operation.providerRecovery.mutations.find(
            (entry: { kind: string }) => entry.kind === "github_branch.delete"
          )?.status
        );
      }
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });

    expect(saved).toContain("manual_required");
    expect(saved).not.toContain("not_applied");
  });

  it("keeps the blocker after the refused record is reloaded", async () => {
    const { h, operation } = refusedDeleteHarness();
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });
    const reloaded = fromPersistedOperation(toPersistedOperation(operation));

    expect(providerRecoveryManualGuidance(reloaded)).toContain(
      "Remove that exact branch yourself"
    );
  });
});

describe("the predecessor blob a workflow retry records", () => {
  const PATH = ".github/workflows/a.yml";
  const MARKED_COMMIT = JSON.stringify([
    {
      sha: "b".repeat(40),
      commit: {
        message:
          "Add a\n\nRadius-Operation: radius-operation:op_workflow:workflow:.github/workflows/a.yml:fff71b97a5a94949"
      }
    }
  ]);

  it("captures the blob the retry actually read, not the refused attempt's", async () => {
    const operation = createOperation({ operationId: "op_workflow" });
    const first = harness({
      runGh: [{ code: 0, stdout: "blob-before" }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 409: Conflict" }]
    });
    first.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };
    await expect(
      createWorkflowFileCommitter(first.ports, target).commitWorkflowFileSmart(
        PATH,
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({ ok: false });

    // Somebody else changed the file between the refused write and the retry.
    const second = harness({
      runGh: [{ code: 0, stdout: "blob-after" }],
      runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
    });
    second.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(second.ports, target).commitWorkflowFileSmart(
        PATH,
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({
      ok: true,
      previousBlobSha: "blob-after",
      previousBlobKnown: true
    });
    expect(operation.providerRecovery.mutations[0].intent.previousBlobSha).toBe(
      "blob-after"
    );
  });

  it("keeps the predecessor of a write still awaiting an answer", async () => {
    const operation = createOperation({ operationId: "op_workflow" });
    const first = harness({
      runGh: [
        { code: 0, stdout: "blob-before" },
        { code: 1, stderr: "HTTP 500: server error" }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    first.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };
    await expect(
      createWorkflowFileCommitter(first.ports, target).commitWorkflowFileSmart(
        PATH,
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

    // The file moved on, but this write is being reconciled rather than
    // retried, so the blob a revert would restore is still the one it read.
    const second = harness({
      runGh: [
        { code: 0, stdout: "blob-after" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-written", content: CONTENT })
        },
        { code: 0, stdout: MARKED_COMMIT }
      ]
    });
    second.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(second.ports, target).commitWorkflowFileSmart(
        PATH,
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({ ok: true, previousBlobSha: "blob-before" });
    expect(
      second.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toEqual([]);
  });
});

describe("recovering a setup branch after the default branch moved", () => {
  const CREATE_TARGET =
    "octo/app\u0000radius/setup-dev-workflows-workflow\u0000sha-1";

  it("reads the branch and base commit the interrupted attempt journaled", () => {
    const operation = createOperation({ operationId: "op_workflow" });
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: CREATE_TARGET,
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });

    expect(recordedSetupBranchCreate(operation, "octo/app")).toEqual({
      branch: "radius/setup-dev-workflows-workflow",
      baseSha: "sha-1"
    });
  });

  it.each([
    ["there is no record at all", null],
    ["the record names another repository", "other/repo"],
    ["the recorded target is malformed", "malformed"]
  ])("returns nothing when %s", (_label, variant) => {
    const operation = createOperation({ operationId: "op_workflow" });
    if (variant === "other/repo") {
      prepareProviderMutation(operation, {
        kind: "github_branch.create",
        target: "other/repo\u0000radius/setup-dev-workflows-workflow\u0000sha-1"
      });
    } else if (variant === "malformed") {
      prepareProviderMutation(operation, {
        kind: "github_branch.create",
        target: "malformed"
      });
    }

    expect(recordedSetupBranchCreate(operation, "octo/app")).toBeNull();
  });

  it("settles the journaled create before any new default-branch write", async () => {
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: CREATE_TARGET,
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    const h = harness({
      runGh: [
        // The reconcile read of the recovered branch.
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) }
      ],
      runGhWorkflow: [{ code: 0 }],
      // The default branch advanced while the extension was down.
      defaultBranch: "main",
      headSha: "sha-moved"
    });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-recovered-rollback" });

    // Exactly one create entry, and it is the one the interrupted attempt
    // wrote. A second entry keyed on the moved head could never be settled,
    // which would hold the repository behind a journal nothing can clear.
    const creates = operation.providerRecovery.mutations.filter(
      (entry: { kind: string }) => entry.kind === "github_branch.create"
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      target: CREATE_TARGET,
      status: "confirmed"
    });
    expect(
      h.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toHaveLength(1);
    expect(
      operation.providerRecovery.mutations.some(
        (entry: { status: string }) =>
          entry.status === "prepared" || entry.status === "outcome_unknown"
      )
    ).toBe(false);
  });

  it("reconciles a branch workflow after that workflow advanced the branch", async () => {
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    const branchCreate = prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: CREATE_TARGET,
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    settleProviderMutation(
      operation,
      branchCreate.mutationId,
      "confirmed",
      "GitHub acknowledged the branch."
    );
    const marker = "radius-operation:op_workflow:workflow:p:fff71b97a5a94949";
    prepareProviderMutation(operation, {
      kind: "github_workflow.put",
      target: "octo/app:radius/setup-dev-workflows-workflow:p",
      intent: {
        branch: "radius/setup-dev-workflows-workflow",
        path: "p",
        previousBlobSha: null,
        previousBlobKnown: true,
        contentSha256: workflowContentDigest(CONTENT),
        operationMarker: marker
      }
    });
    const h = harness({
      runGh: [
        { code: 0, stdout: "blob-written" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-written", content: CONTENT })
        },
        {
          code: 0,
          stdout: JSON.stringify([
            {
              sha: "a".repeat(40),
              commit: { message: `m\n\nRadius-Operation: ${marker}` }
            }
          ])
        }
      ],
      defaultBranch: "main"
    });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).resolves.toMatchObject({ ok: true, viaPr: true });

    expect(
      h.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toHaveLength(0);
    expect(
      h.calls.find((call) => call.args[1]?.includes("/commits?"))?.args[1]
    ).toBe(
      "/repos/octo/app/commits?sha=radius%2Fsetup-dev-workflows-workflow&per_page=100&page=1"
    );
  });

  it("compares a recovered branch against the commit Radius cut it from", async () => {
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: CREATE_TARGET,
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    const h = harness({
      runGh: [
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "HTTP 403: Required status check is not met" }
      ],
      defaultBranch: "main",
      headSha: "sha-moved"
    });
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });

    // The branch is exactly as Radius left it, so the refusal is about the
    // delete GitHub rejected — not a claim the branch holds somebody's work.
    expect(providerRecoveryManualGuidance(operation)).toContain(
      "Remove that exact branch yourself"
    );
    const deletes = operation.providerRecovery.mutations.filter(
      (entry: { kind: string }) => entry.kind === "github_branch.delete"
    );
    expect(deletes).toHaveLength(1);
    expect(deletes[0].target).toBe(CREATE_TARGET);
  });
});

describe("the in-process recovered branch delete", () => {
  const CREATE_TARGET =
    "octo/app\u0000radius/setup-dev-workflows-workflow\u0000sha-1";
  const NOT_FOUND = { code: 1, stderr: "HTTP 404: Not Found" };

  function recovering() {
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: CREATE_TARGET,
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    return operation;
  }

  // The create reconcile read, then whatever the delete's own reconciliation
  // asks for.
  function script(...afterDelete: Array<Record<string, unknown>>) {
    return {
      runGh: [
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) },
        ...afterDelete
      ],
      runGhWorkflow: [{ code: 1, stderr: "terminated", timedOut: true }],
      defaultBranch: "main",
      headSha: "sha-1"
    };
  }

  function deleteMutation(operation: {
    providerRecovery: { mutations: Array<{ kind: string; status: string }> };
  }) {
    return operation.providerRecovery.mutations.find(
      (entry) => entry.kind === "github_branch.delete"
    );
  }

  it("does not call the branch gone from the ref endpoint's 404 alone", async () => {
    const operation = recovering();
    // The ref 404s and the ref listing is refused: the account may simply not
    // be allowed to see this repository's refs, so nothing is concluded.
    const h = harness(
      script(NOT_FOUND, {
        code: 1,
        stderr: "HTTP 403: Resource not accessible"
      })
    );
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

    expect(deleteMutation(operation)).toMatchObject({
      status: "outcome_unknown"
    });
  });

  it("settles the delete only from an exhaustive listing and a confirming reread", async () => {
    const operation = recovering();
    const h = harness(
      script(
        // The listing the account can complete, then the confirming reread.
        { code: 0, stdout: JSON.stringify([{ ref: "refs/heads/main" }]) },
        NOT_FOUND
      )
    );
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-recovered-rollback" });

    expect(deleteMutation(operation)).toMatchObject({ status: "confirmed" });
  });

  it("refuses when the listing still holds the branch", async () => {
    const operation = recovering();
    const h = harness(
      script(
        {
          code: 0,
          stdout: JSON.stringify([
            { ref: "refs/heads/radius/setup-dev-workflows-workflow" }
          ])
        },
        // The head read that decides which refusal the customer reads.
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) }
      )
    );
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });

    expect(deleteMutation(operation)).toMatchObject({
      status: "manual_required"
    });
    expect(providerRecoveryManualGuidance(operation)).toContain(
      "will not repeat the delete blindly"
    );
  });

  it("issues the delete exactly once whatever the reconciliation decides", async () => {
    const operation = recovering();
    const h = harness(
      script(NOT_FOUND, {
        code: 1,
        stderr: "HTTP 403: Resource not accessible"
      })
    );
    h.ports.mutationRecovery = {
      isStopped: () => false,
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
  });
});
