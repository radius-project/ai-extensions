import { describe, expect, it, vi } from "vitest";
import { assertSetupExecutionActive } from "./setup-recovery-error.js";
import {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureCancelled,
  GitHubEnvironmentEnsureError,
  parseEnvironmentProviderId,
  type EnsureGitHubEnvironmentInput,
  type GitHubEnvironmentRecoveryPort
} from "./setup-github-environment.js";

const timestamp = "2026-09-11T20:00:00.000Z";
const created = {
  code: 0,
  stdout: JSON.stringify({
    name: "Production",
    id: 17,
    created_at: timestamp
  }),
  stderr: ""
};

function input(
  overrides: Partial<EnsureGitHubEnvironmentInput> = {}
): EnsureGitHubEnvironmentInput {
  return {
    repo: "octo/app",
    requestedName: "production",
    now: () => Date.parse(timestamp),
    sleep: async () => {
      throw new Error("Unexpected retry");
    },
    readGitHubJson: async (path) =>
      path === "/repos/octo/app" ? { ok: true } : { ok: false, status: 404 },
    runGh: async () => created,
    ...overrides
  };
}

describe("GitHub environment setup through domain ports", () => {
  it.each(["before", "lookup", "repository"] as const)(
    "fences shutdown at the %s read before mutation admission",
    async (boundary) => {
      let stopped = boundary === "before";
      const read = vi.fn(async (path: string) => {
        if (boundary === "lookup" || path === "/repos/octo/app") stopped = true;
        return { ok: false, status: 404 };
      });
      const execute = vi.fn(async (): Promise<never> => {
        throw new Error("Unexpected mutation");
      });
      await expect(
        ensureGitHubEnvironment(
          input({
            readGitHubJson: read,
            recovery: {
              assertActive: () => assertSetupExecutionActive(() => stopped),
              find: () => null,
              willWrite: () => true,
              execute
            }
          })
        )
      ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
      expect(read).toHaveBeenCalledTimes(
        boundary === "before" ? 0
        : boundary === "lookup" ? 1
        : 2
      );
      expect(execute).not.toHaveBeenCalled();
    }
  );

  it("preserves the read, stop, write and immutable identity transcript without Canvas", async () => {
    const calls: unknown[] = [];
    const ports = input({
      readGitHubJson: async (path) => {
        calls.push(["read", path]);
        return path === "/repos/octo/app" ?
            { ok: true }
          : { ok: false, status: 404 };
      },
      beforeCreate: async () => {
        calls.push(["stop-boundary"]);
        return true;
      },
      runGh: async (args) => {
        calls.push(["write", args]);
        return created;
      }
    });
    expect(await ensureGitHubEnvironment(ports)).toEqual({
      name: "Production",
      state: "created_candidate",
      providerId: "17",
      creationProof: { proven: true, detail: null }
    });
    expect(calls).toEqual([
      ["read", "/repos/octo/app/environments/production"],
      ["read", "/repos/octo/app"],
      ["stop-boundary"],
      [
        "write",
        ["api", "--method", "PUT", "/repos/octo/app/environments/production"]
      ]
    ]);
  });

  it("reads the live journal after the provider read instead of caching its earlier state", async () => {
    let confirmed = false;
    const recovery: GitHubEnvironmentRecoveryPort = {
      assertActive: () => {},
      find: () =>
        confirmed ?
          {
            kind: "github_environment.put",
            status: "confirmed",
            providerId: "17",
            preparedAt: timestamp,
            evidence: "acknowledged"
          }
        : null,
      willWrite: () => {
        throw new Error("A confirmed identity must not be written again");
      },
      execute: async () => {
        throw new Error("A confirmed identity must not be written again");
      }
    };
    const result = await ensureGitHubEnvironment(
      input({
        recovery,
        readGitHubJson: async () => {
          confirmed = true;
          return {
            ok: true,
            json: { name: "Production", id: 17, created_at: timestamp }
          };
        }
      })
    );
    expect(result).toEqual({
      name: "Production",
      state: "created_candidate",
      providerId: "17",
      creationProof: { proven: true, detail: null }
    });
  });

  it("propagates a recovery port's original error object", async () => {
    const failure = new Error("recovery interrupted");
    await expect(
      ensureGitHubEnvironment(
        input({
          recovery: {
            assertActive: () => {},
            find: () => null,
            willWrite: () => true,
            execute: async () => {
              throw failure;
            }
          }
        })
      )
    ).rejects.toBe(failure);
  });

  it("preserves cancellation identity without starting the mutation port", async () => {
    await expect(
      ensureGitHubEnvironment(
        input({
          beforeCreate: async () => false,
          runGh: async () => {
            throw new Error("Stop must prevent the write");
          }
        })
      )
    ).rejects.toBeInstanceOf(GitHubEnvironmentEnsureCancelled);
  });

  it("does not run a read when the existing read-attempt calculation yields NaN", async () => {
    await expect(
      ensureGitHubEnvironment(
        input({
          readAttempts: Number.NaN,
          readGitHubJson: async () => {
            throw new Error("The legacy NaN bound never enters the loop");
          }
        })
      )
    ).rejects.toMatchObject({
      code: "github-environment-lookup-failed",
      message:
        'Could not resolve GitHub environment "production". The GitHub API lookup did not run.'
    });
  });

  it.each([
    { status: 429, stderr: undefined, delay: 300 },
    { status: 503, stderr: "Retry-After: invalid", delay: 300 },
    { status: 503, stderr: "Retry-After: -1", delay: 0 },
    { status: null, stderr: "ECONNRESET", delay: 300 }
  ])("preserves bounded retry delay for $stderr", async (failure) => {
    const delays: number[] = [];
    let count = 0;
    const result = await ensureGitHubEnvironment(
      input({
        readGitHubJson: async () =>
          count++ === 0 ?
            { ok: false, status: failure.status, stderr: failure.stderr }
          : { ok: true, json: { name: "Production" } },
        sleep: async (delay) => {
          delays.push(delay);
        }
      })
    );
    expect(result.state).toBe("reused");
    expect(delays).toEqual([failure.delay]);
  });

  it("preserves the explicit create failure and diagnostic precedence", async () => {
    await expect(
      ensureGitHubEnvironment(
        input({ runGh: async () => ({ code: 1, stdout: "", stderr: "" }) })
      )
    ).rejects.toEqual(
      new GitHubEnvironmentEnsureError(
        'Failed to create GitHub environment "production". The GitHub API request failed.',
        "github-environment-create-failed"
      )
    );
  });

  it.each([
    { status: "not_applied", evidence: null },
    { status: "manual_required", evidence: "Review the pending mutation." },
    { status: "manual_required", evidence: null }
  ] as const)("honors an existing $status journal record", async (record) => {
    const pending = ensureGitHubEnvironment(
      input({
        readGitHubJson: async () => ({
          ok: true,
          json: { name: "Production", id: 17 }
        }),
        recovery: {
          assertActive: () => {},
          find: () => ({
            ...record,
            kind: "github_environment.put",
            preparedAt: timestamp
          }),
          willWrite: () => {
            throw new Error("Must settle the existing record first");
          },
          execute: async () => {
            throw new Error("Must not replay the previous write");
          }
        }
      })
    );
    if (record.status === "not_applied") {
      expect(await pending).toEqual({
        name: "Production",
        state: "reused",
        providerId: "17"
      });
    } else {
      await expect(pending).rejects.toMatchObject({
        code: "provider-mutation-manual-required",
        message:
          record.evidence ||
          'Radius cannot prove who created GitHub environment "octo/app:Production".'
      });
    }
  });

  it("rejects an acknowledged write with an unreadable response without guessing identity", async () => {
    const malformed = { ...created, stdout: "not-json" };
    await expect(
      ensureGitHubEnvironment(
        input({
          recovery: {
            assertActive: () => {},
            find: () => null,
            willWrite: () => true,
            execute: async (mutation) => {
              const value = mutation.accept(malformed);
              expect(mutation.providerIdOf?.(malformed, value)).toBeNull();
              return { state: "applied", value, recovered: false };
            }
          }
        })
      )
    ).rejects.toMatchObject({
      code: "github-environment-name-missing",
      createdCandidate: { repo: "octo/app", name: "production" }
    });
  });

  it("reports a reconciled absence without manufacturing command output", async () => {
    await expect(
      ensureGitHubEnvironment(
        input({
          recovery: {
            assertActive: () => {},
            find: () => null,
            willWrite: () => false,
            execute: async () => ({ state: "not_applied" })
          }
        })
      )
    ).rejects.toMatchObject({
      code: "github-environment-create-failed",
      message:
        'Failed to create GitHub environment "production". GitHub confirmed that the environment was not created.'
    });
  });

  it("preserves cancellation from the recovery engine's final pre-write boundary", async () => {
    await expect(
      ensureGitHubEnvironment(
        input({
          recovery: {
            assertActive: () => {},
            find: () => null,
            willWrite: () => true,
            execute: async () => ({ state: "cancelled" })
          }
        })
      )
    ).rejects.toBeInstanceOf(GitHubEnvironmentEnsureCancelled);
  });

  it.each([true, false])(
    "preserves reconciliation evidence when canonical identity is unavailable (readable=%s)",
    async (readable) => {
      let readCount = 0;
      const sentinel = new Error("reconciliation observed");
      await expect(
        ensureGitHubEnvironment(
          input({
            readGitHubJson: async () => {
              readCount++;
              return (
                readCount === 1 ? { ok: false, status: 404 }
                : readCount === 2 ? { ok: true }
                : { ok: readable, status: readable ? 200 : 403, json: {} }
              );
            },
            recovery: {
              assertActive: () => {},
              find: () => ({
                kind: "github_environment.put",
                status: "prepared",
                preparedAt: timestamp,
                evidence: null
              }),
              willWrite: () => false,
              execute: async (mutation) => {
                if (readable) {
                  expect(await mutation.reconcile()).toEqual({
                    state: "manual_required",
                    guidance:
                      'GitHub reports an environment at "octo/app:production", but not its canonical identity. Radius left it in place and will not retry or delete it.'
                  });
                } else {
                  await expect(mutation.reconcile()).rejects.toThrow(
                    "GitHub environment state could not be read."
                  );
                }
                throw sentinel;
              }
            }
          })
        )
      ).rejects.toBe(sentinel);
    }
  );

  it.each([
    [null, null],
    [{ id: Number.NaN, node_id: " node " }, "node"],
    [{ id: "", node_id: " " }, null],
    [{ id: " 17 ", node_id: "ignored" }, "17"]
  ])("normalizes provider identity %j without guessing", (value, expected) => {
    expect(parseEnvironmentProviderId(value)).toBe(expected);
  });
});
