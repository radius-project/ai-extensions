import { describe, expect, it } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import {
  deleteGitHubEnvironmentIdempotent,
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureCancelled,
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment,
  selectedEnvironmentReader,
  type GitHubEnvironmentCommandResult,
  type GitHubEnvironmentReadResult
} from "./github-environment.js";

function result(
  overrides: Partial<GitHubEnvironmentCommandResult> = {}
): GitHubEnvironmentCommandResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    ...overrides
  };
}

function readResult(
  overrides: Partial<GitHubEnvironmentReadResult> = {}
): GitHubEnvironmentReadResult {
  return {
    ok: true,
    status: 200,
    json: {},
    stderr: "",
    ...overrides
  };
}

describe("ensureGitHubEnvironment", () => {
  it("returns GitHub's canonical name without mutating an existing environment", async () => {
    const calls: string[] = [];
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson: async (apiPath) => {
        calls.push(apiPath);
        return readResult({ json: { name: "Production" } });
      },
      runGh: async () => {
        throw new Error("existing environment must not be mutated");
      }
    });

    expect(ensured).toEqual({
      name: "Production",
      state: "reused",
      providerId: null
    });
    expect(calls).toEqual(["/repos/octo/app/environments/production"]);
  });

  it("creates a missing environment and returns the canonical created name", async () => {
    const reads: string[] = [];
    const mutations: string[][] = [];
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "Production West",
      readGitHubJson: async (apiPath) => {
        reads.push(apiPath);
        return apiPath === "/repos/octo/app" ?
            readResult({ json: { full_name: "octo/app" } })
          : readResult({ ok: false, status: 404, stderr: "Not Found" });
      },
      runGh: async (args) => {
        mutations.push(args);
        return result({
          stdout: JSON.stringify({
            name: "Production West",
            created_at: "2026-08-22T00:00:00.000Z"
          })
        });
      },
      now: () => Date.parse("2026-08-22T00:00:00.000Z")
    });

    expect(ensured).toEqual({
      name: "Production West",
      state: "created_candidate",
      providerId: null,
      creationProof: { proven: true, detail: null }
    });
    expect(reads).toEqual([
      "/repos/octo/app/environments/Production%20West",
      "/repos/octo/app"
    ]);
    expect(mutations).toEqual([
      [
        "api",
        "--method",
        "PUT",
        "/repos/octo/app/environments/Production%20West"
      ]
    ]);
  });

  it("honors a short Retry-After for a transient environment read", async () => {
    let reads = 0;
    const sleeps: number[] = [];
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson: async () => {
        reads += 1;
        return reads === 1 ?
            readResult({
              ok: false,
              status: 429,
              stderr: "Retry-After: 2"
            })
          : readResult({ json: { name: "production", id: 17 } });
      },
      runGh: async () => {
        throw new Error("an existing environment must not be mutated");
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    expect(ensured).toMatchObject({
      name: "production",
      state: "reused",
      providerId: "17"
    });
    expect(reads).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry before Retry-After when it exceeds the read budget", async () => {
    let reads = 0;
    const sleeps: number[] = [];
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () => {
          reads += 1;
          return readResult({
            ok: false,
            status: 429,
            stderr: "Retry-After: 60"
          });
        },
        runGh: async () => {
          throw new Error("must not mutate");
        },
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        }
      })
    ).rejects.toMatchObject({ code: "github-environment-lookup-failed" });
    expect(reads).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("honors an HTTP-date Retry-After without retrying early", async () => {
    let reads = 0;
    const now = Date.parse("2026-08-25T00:00:00.000Z");
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () => {
          reads += 1;
          return readResult({
            ok: false,
            status: 429,
            stderr: "Retry-After: Tue, 25 Aug 2026 00:01:00 GMT"
          });
        },
        runGh: async () => {
          throw new Error("must not mutate");
        },
        now: () => now,
        sleep: async () => {
          throw new Error("must not retry before Retry-After");
        }
      })
    ).rejects.toMatchObject({ code: "github-environment-lookup-failed" });
    expect(reads).toBe(1);
  });

  it("does not retry an authorization failure", async () => {
    let reads = 0;
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () => {
          reads += 1;
          return readResult({
            ok: false,
            status: 403,
            stderr: "Forbidden"
          });
        },
        runGh: async () => {
          throw new Error("must not mutate");
        },
        sleep: async () => {}
      })
    ).rejects.toMatchObject({ code: "github-environment-lookup-failed" });
    expect(reads).toBe(1);
  });

  it("checks Stop after repository reads and before environment creation", async () => {
    let mutations = 0;

    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) =>
          apiPath === "/repos/octo/app" ?
            readResult({ json: { full_name: "octo/app" } })
          : readResult({ ok: false, status: 404 }),
        beforeCreate: async () => false,
        runGh: async () => {
          mutations += 1;
          return result();
        }
      })
    ).rejects.toBeInstanceOf(GitHubEnvironmentEnsureCancelled);
    expect(mutations).toBe(0);
  });

  // A journaled attempt reaches the create path to be reconciled, not rewritten.
  // Stopping before that read would strand the provenance the Stop is about to
  // make terminal, so the gate is never consulted for it.
  it("reconciles a journaled attempt without consulting the Stop gate", async () => {
    const operation = createOperation({ operationId: "op_environment" });
    const mutation = prepareProviderMutation(operation, {
      kind: "github_environment.put",
      target: "octo/app:production"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      "The provider request ended without a response."
    );
    let stopChecks = 0;
    let mutations = 0;

    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) =>
          apiPath === "/repos/octo/app" ?
            readResult({ json: { full_name: "octo/app" } })
          : readResult({ ok: false, status: 404 }),
        beforeCreate: async () => {
          stopChecks += 1;
          return false;
        },
        runGh: async () => {
          mutations += 1;
          return result();
        },
        mutationRecovery: { operation, persist: async () => {} }
      })
    ).rejects.toBeInstanceOf(GitHubEnvironmentEnsureError);
    expect(stopChecks).toBe(0);
    expect(mutations).toBe(0);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied"
    });
  });

  // A PUT nobody saw the answer to recorded no id. What sits under the name
  // afterwards may be what it made or what somebody made since, and a creation
  // timestamp fits both — so the read is handed to a person, never adopted.
  describe("an environment found after a PUT with no acknowledged id", () => {
    async function interrupted(
      rereadJson: Record<string, unknown>,
      putStartedAt = "2026-08-22T00:00:00.000Z"
    ) {
      const operation = createOperation({ operationId: "op_environment" });
      let environmentReads = 0;
      let putCalls = 0;
      const failure = await ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) => {
          if (apiPath === "/repos/octo/app") {
            return readResult({ json: { full_name: "octo/app" } });
          }
          environmentReads += 1;
          return environmentReads === 1 ?
              readResult({ ok: false, status: 404 })
            : readResult({ json: rereadJson });
        },
        runGh: async () => {
          putCalls += 1;
          return result({ code: 1, timedOut: true });
        },
        mutationRecovery: { operation, persist: async () => {} },
        now: () => Date.parse(putStartedAt)
      }).catch((error: unknown) => error);
      return { operation, failure, putCalls };
    }

    it("refuses to claim it, however well the timestamp fits", async () => {
      const { operation, failure, putCalls } = await interrupted({
        name: "production",
        created_at: "2026-08-22T00:00:00.000Z"
      });

      expect(failure).toBeInstanceOf(ProviderMutationRecoveryError);
      expect((failure as ProviderMutationRecoveryError).code).toBe(
        "provider-mutation-manual-required"
      );
      expect((failure as Error).message).toContain(
        "never recorded an id for the environment"
      );
      // The PUT is not retried and the environment is not adopted.
      expect(putCalls).toBe(1);
      expect(operation.providerRecovery).toMatchObject({
        state: "manual_required",
        mutations: [{ status: "manual_required", providerId: null }]
      });
    });

    it("refuses a replacement created inside the tolerance window", async () => {
      // The customer made their own environment under this name seconds after
      // the interrupted request. Its creation time is indistinguishable.
      const { operation, failure } = await interrupted({
        id: 7654321,
        name: "production",
        created_at: "2026-08-22T00:00:30.000Z"
      });

      expect((failure as Error).message).toContain("id 7654321");
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "manual_required",
        providerId: null
      });
    });

    it("still settles a reread that proves the environment absent", async () => {
      const operation = createOperation({ operationId: "op_environment" });
      let environmentReads = 0;

      const failure = await ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) => {
          if (apiPath === "/repos/octo/app") {
            return readResult({ json: { full_name: "octo/app" } });
          }
          environmentReads += 1;
          return readResult({ ok: false, status: 404 });
        },
        runGh: async () => result({ code: 1, timedOut: true }),
        mutationRecovery: { operation, persist: async () => {} }
      }).catch((error: unknown) => error);

      // Absence is an answer, so the mutation resolves rather than hanging.
      expect(failure).toBeInstanceOf(GitHubEnvironmentEnsureError);
      expect(environmentReads).toBeGreaterThan(0);
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "not_applied"
      });
    });
  });

  // A confirmed PUT means GitHub made the environment, but the name it is under
  // can be deleted and recreated by anyone. Ownership after a restart is proven
  // by the id that write recorded still answering for the name — a creation
  // timestamp alone would also fit the replacement.
  describe("a confirmed PUT found again after a restart", () => {
    function confirmed(providerId: string | null) {
      const operation = createOperation({ operationId: "op_environment" });
      const mutation = prepareProviderMutation(operation, {
        kind: "github_environment.put",
        target: "octo/app:production"
      });
      mutation.preparedAt = "2026-08-22T00:00:00.000Z";
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "confirmed",
        null,
        providerId
      );
      return operation;
    }

    function restore(operation: object, json: Record<string, unknown>) {
      return ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () => readResult({ json }),
        runGh: async () => {
          throw new Error("confirmed PUT must not replay");
        },
        mutationRecovery: {
          operation: operation as object & { operationId: string },
          persist: async () => {}
        }
      });
    }

    it("proves ownership when the name still answers for the id it recorded", async () => {
      await expect(
        restore(confirmed("1234567"), {
          id: 1234567,
          name: "production",
          created_at: "2026-08-22T00:00:00.000Z"
        })
      ).resolves.toEqual({
        name: "production",
        state: "created_candidate",
        providerId: "1234567",
        creationProof: { proven: true, detail: null }
      });
    });

    it("proves nothing when the name was recreated under a new id", async () => {
      // The customer deleted the environment and made another with the same
      // name after the crash. Its creation timestamp fits the interrupted
      // request just as well, so only the id can tell them apart.
      await expect(
        restore(confirmed("1234567"), {
          id: 7654321,
          name: "production",
          created_at: "2026-08-22T00:00:01.000Z"
        })
      ).resolves.toEqual({
        name: "production",
        state: "created_candidate",
        providerId: "7654321",
        // Said out loud, so the customer is told a resource was left behind
        // rather than finding it later with no explanation.
        creationProof: {
          proven: false,
          detail: expect.stringContaining(
            "not the 1234567 this request created"
          )
        }
      });
    });

    it("proves nothing for a confirmed entry written before ids were recorded", async () => {
      await expect(
        restore(confirmed(null), {
          id: 1234567,
          name: "production",
          created_at: "2026-08-22T00:00:00.000Z"
        })
      ).resolves.toEqual({
        name: "production",
        state: "created_candidate",
        providerId: "1234567",
        creationProof: {
          proven: false,
          detail: expect.stringContaining(
            "before Radius captured GitHub's own id"
          )
        }
      });
    });

    it("proves nothing when GitHub now reports no id for the name", async () => {
      await expect(
        restore(confirmed("1234567"), {
          name: "production",
          created_at: "2026-08-22T00:00:00.000Z"
        })
      ).resolves.toEqual({
        name: "production",
        state: "created_candidate",
        providerId: null,
        creationProof: {
          proven: false,
          detail: expect.stringContaining("reports id none")
        }
      });
    });

    it("records the id in the same write that confirms the mutation", async () => {
      const operation = createOperation({ operationId: "op_environment" });
      let persists = 0;

      await ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) =>
          apiPath === "/repos/octo/app" ?
            readResult({ json: { full_name: "octo/app" } })
          : readResult({ ok: false, status: 404, json: null }),
        runGh: async () =>
          result({
            stdout: JSON.stringify({ id: 1234567, name: "production" })
          }),
        mutationRecovery: {
          operation,
          persist: async () => {
            persists += 1;
          }
        }
      });

      const settled = operation.providerRecovery.mutations.find(
        (entry: { kind: string }) => entry.kind === "github_environment.put"
      );
      // Status and id land together, so a crash cannot leave a confirmed
      // mutation whose id was never written.
      expect(settled).toMatchObject({
        status: "confirmed",
        providerId: "1234567"
      });
      expect(persists).toBeGreaterThan(0);
    });
  });

  it("fails closed when a timed-out PUT leaves an environment without ownership proof", async () => {
    const operation = createOperation({ operationId: "op_environment" });
    let environmentReads = 0;

    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) => {
          if (apiPath === "/repos/octo/app") {
            return readResult({ json: { full_name: "octo/app" } });
          }
          environmentReads += 1;
          return environmentReads === 1 ?
              readResult({ ok: false, status: 404 })
            : readResult({ json: { name: "production" } });
        },
        runGh: async () => result({ code: 1, timedOut: true }),
        mutationRecovery: { operation, persist: async () => {} }
      })
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("will not retry or delete it")
    });
    expect(operation.providerRecovery.state).toBe("manual_required");
  });

  it("retries a transient lookup failure to the bound, then fails closed", async () => {
    const calls: string[][] = [];

    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) => {
          calls.push(["api", apiPath]);
          return readResult({
            ok: false,
            status: 503,
            stderr: "HTTP 503: unavailable"
          });
        },
        runGh: async () => {
          throw new Error("lookup failure must not mutate");
        },
        sleep: async () => {}
      })
    ).rejects.toMatchObject({
      code: "github-environment-lookup-failed",
      message:
        'Could not resolve GitHub environment "production". HTTP 503: unavailable'
    });
    expect(calls).toHaveLength(3);
  });

  it("retries the GitHub CLI standard connection diagnostic", async () => {
    let reads = 0;
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson: async () => {
        reads += 1;
        return reads === 1 ?
            readResult({
              ok: false,
              status: null,
              stderr: "error connecting to api.github.com"
            })
          : readResult({ json: { name: "production", id: 17 } });
      },
      runGh: async () => {
        throw new Error("an existing environment must not be mutated");
      },
      sleep: async () => {}
    });

    expect(ensured).toMatchObject({ state: "reused", providerId: "17" });
    expect(reads).toBe(2);
  });

  it("does not treat an unqualified Not Found message as authoritative absence", async () => {
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () =>
          readResult({
            ok: false,
            status: null,
            stderr: "GraphQL resource Not Found"
          }),
        runGh: async () => {
          throw new Error("ambiguous lookup failure must not mutate");
        }
      })
    ).rejects.toMatchObject({
      code: "github-environment-lookup-failed"
    });
  });

  it("uses an explicit fallback when a lookup failure has no diagnostic text", async () => {
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () =>
          readResult({ ok: false, status: 500, stderr: undefined }),
        runGh: async () => {
          throw new Error("failed lookup must not mutate");
        }
      })
    ).rejects.toMatchObject({
      code: "github-environment-lookup-failed",
      message:
        'Could not resolve GitHub environment "production". The GitHub API lookup failed.'
    });
  });

  describe("readEnsuredGitHubEnvironment", () => {
    const resolved = {
      environment: "production",
      context: {
        requestedEnvironment: "production",
        canonicalEnvironment: "Production"
      },
      setupArtifacts: {
        githubEnvironment: {
          state: "created_candidate",
          repo: "octo/app",
          name: "Production"
        }
      }
    };

    it("reuses a persisted canonical resolution", () => {
      expect(
        readEnsuredGitHubEnvironment(resolved, "octo/app", "Production")
      ).toEqual({
        name: "Production",
        state: "created_candidate",
        providerId: null
      });
    });

    it("reuses a persisted environment whose creation was proven", () => {
      expect(
        readEnsuredGitHubEnvironment(
          {
            ...resolved,
            setupArtifacts: {
              githubEnvironment: {
                state: "created",
                repo: "octo/app",
                name: "Production"
              }
            }
          },
          "octo/app",
          "Production"
        )
      ).toEqual({ name: "Production", state: "created", providerId: null });
    });

    it.each([
      [{ ...resolved, environment: "staging" }, "octo/app", "Production"],
      [
        {
          ...resolved,
          context: {
            requestedEnvironment: "staging",
            canonicalEnvironment: "Production"
          }
        },
        "octo/app",
        "Production"
      ],
      [
        { ...resolved, context: { canonicalEnvironment: "Production" } },
        "octo/app",
        "Production"
      ],
      [
        {
          ...resolved,
          context: {
            requestedEnvironment: "",
            canonicalEnvironment: "Production"
          }
        },
        "octo/app",
        "Production"
      ],
      [
        {
          ...resolved,
          context: {
            requestedEnvironment: "production",
            canonicalEnvironment: "production"
          }
        },
        "octo/app",
        "Production"
      ],
      [{ ...resolved, setupArtifacts: {} }, "octo/app", "Production"],
      [resolved, "octo/other", "Production"],
      [resolved, "octo/app", "production"]
    ])(
      "does not trust a stale or incomplete persisted resolution",
      (operation, repo, environment) => {
        expect(
          readEnsuredGitHubEnvironment(operation, repo, environment)
        ).toBeNull();
      }
    );
  });

  it("surfaces create failures without claiming an environment candidate", async () => {
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async (apiPath) =>
          apiPath === "/repos/octo/app" ?
            readResult({ json: { full_name: "octo/app" } })
          : readResult({ ok: false, status: 404 }),
        runGh: async () => result({ code: 1, stdout: "HTTP 403" })
      })
    ).rejects.toMatchObject({
      code: "github-environment-create-failed",
      createdCandidate: null
    });
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["an array", []],
    ["a missing name", {}],
    ["a blank name", { name: "   " }]
  ])("rejects %s from an existing environment lookup", async (_label, json) => {
    await expect(
      ensureGitHubEnvironment({
        repo: "octo/app",
        requestedName: "production",
        readGitHubJson: async () => readResult({ json }),
        runGh: async () => {
          throw new Error("malformed lookup must not mutate");
        }
      })
    ).rejects.toMatchObject({
      code: "github-environment-name-missing",
      createdCandidate: null
    });
  });

  it("retains candidate provenance when create succeeds without a canonical name", async () => {
    const thrown = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson: async (apiPath) =>
        apiPath === "/repos/octo/app" ?
          readResult({ json: { full_name: "octo/app" } })
        : readResult({ ok: false, status: 404 }),
      runGh: async () => result({ stdout: "{}" })
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubEnvironmentEnsureError);
    expect(thrown).toMatchObject({
      code: "github-environment-name-missing",
      createdCandidate: { repo: "octo/app", name: "production" }
    });
  });

  it("is idempotent across a create followed by the case-insensitive rerun", async () => {
    let canonicalName: string | null = null;
    let putCalls = 0;
    const runGh = async (_args: string[]) => {
      putCalls += 1;
      canonicalName = "Production";
      return result({ stdout: JSON.stringify({ name: canonicalName }) });
    };
    const readGitHubJson = async (apiPath: string) =>
      apiPath === "/repos/octo/app" ?
        readResult({ json: { full_name: "octo/app" } })
      : canonicalName ? readResult({ json: { name: canonicalName } })
      : readResult({ ok: false, status: 404 });

    const first = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson,
      runGh,
      now: () => 1_700_000_000_000
    });
    const second = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson,
      runGh
    });

    expect(first).toEqual({
      name: "Production",
      state: "created_candidate",
      providerId: null,
      creationProof: {
        proven: false,
        detail:
          "GitHub did not report when the environment was created, so Radius cannot prove this request created it."
      }
    });
    expect(second).toEqual({
      name: "Production",
      state: "reused",
      providerId: null
    });
    expect(putCalls).toBe(1);
  });

  it.each([
    {
      status: 404,
      stderr: "HTTP 404: Not Found",
      message:
        'Could not confirm repository "octo/app" before creating GitHub environment "production". HTTP 404: Not Found'
    },
    {
      status: 403,
      stderr: "HTTP 403: Resource not accessible",
      message:
        'Could not confirm repository "octo/app" before creating GitHub environment "production". HTTP 403: Resource not accessible'
    },
    {
      status: null,
      stderr: "",
      message:
        'Could not confirm repository "octo/app" before creating GitHub environment "production". The repository is missing or inaccessible to the selected GitHub account.'
    }
  ])(
    "does not create when repository confirmation fails with status $status",
    async ({ status, stderr, message }) => {
      const reads: string[] = [];
      await expect(
        ensureGitHubEnvironment({
          repo: "octo/app",
          requestedName: "production",
          readGitHubJson: async (apiPath) => {
            reads.push(apiPath);
            return apiPath.endsWith("/environments/production") ?
                readResult({ ok: false, status: 404 })
              : readResult({ ok: false, status, stderr });
          },
          runGh: async () => {
            throw new Error("unavailable repository must not be mutated");
          }
        })
      ).rejects.toMatchObject({
        code: "github-environment-repository-unavailable",
        message
      });
      expect(reads).toEqual([
        "/repos/octo/app/environments/production",
        "/repos/octo/app"
      ]);
    }
  );
});

describe("deleteGitHubEnvironmentIdempotent", () => {
  function deletePorts(
    gh: (args: string[]) => Promise<{
      code: number | string;
      stdout?: string;
      stderr?: string;
    }>
  ) {
    const calls: string[][] = [];
    const invalidated: string[] = [];
    return {
      calls,
      invalidated,
      ports: {
        runGh: (args: string[]) => {
          calls.push(args);
          return gh(args);
        },
        invalidateEnvListCache: (repo: string) => {
          invalidated.push(repo);
        }
      }
    };
  }

  // A gh fake that answers the DELETE and the follow-up environment listing
  // separately, so the 404 absence check can be exercised deterministically.
  function deleteThenList(
    del: { code: number | string; stderr?: string },
    list: { code: number | string; stdout?: string; stderr?: string }
  ): (args: string[]) => Promise<{
    code: number | string;
    stdout?: string;
    stderr?: string;
  }> {
    return async (args: string[]) => (args.includes("--paginate") ? list : del);
  }

  it("deletes a live environment and invalidates the env-list cache", async () => {
    const { ports, calls, invalidated } = deletePorts(async () => ({
      code: 0
    }));

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "prod env",
      ports
    );

    expect(outcome).toEqual({ outcome: "deleted" });
    expect(calls).toEqual([
      ["api", "--method", "DELETE", "/repos/octo/app/environments/prod%20env"]
    ]);
    expect(invalidated).toEqual(["octo/app"]);
  });

  it("treats a string '0' exit code as a successful delete", async () => {
    const { ports, invalidated } = deletePorts(async () => ({ code: "0" }));

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome).toEqual({ outcome: "deleted" });
    expect(invalidated).toEqual(["octo/app"]);
  });

  it("treats an HTTP 404 as already-gone only once a readable listing confirms absence", async () => {
    const { ports, calls, invalidated } = deletePorts(
      deleteThenList(
        { code: 1, stderr: "gh: HTTP 404 Not Found" },
        { code: 0, stdout: "prod\nstaging\n" }
      )
    );

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome).toEqual({ outcome: "not_found" });
    expect(invalidated).toEqual(["octo/app"]);
    // The absence was verified against a complete listing, not the bare 404.
    expect(calls[1]).toEqual([
      "api",
      "--paginate",
      "-H",
      "Accept: application/vnd.github+json",
      "/repos/octo/app/environments",
      "--jq",
      ".environments[].name"
    ]);
  });

  it("treats a case-insensitive 'not found' message as already-gone when the listing is empty", async () => {
    const { ports, invalidated } = deletePorts(
      deleteThenList(
        { code: 1, stderr: "environment Not Found" },
        { code: 0, stdout: "" }
      )
    );

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome).toEqual({ outcome: "not_found" });
    expect(invalidated).toEqual(["octo/app"]);
  });

  it("does NOT treat a 404 as absence when the listing still shows the environment", async () => {
    const { ports, invalidated } = deletePorts(
      deleteThenList(
        { code: 1, stderr: "gh: HTTP 404 Not Found" },
        { code: 0, stdout: "prod\nDev\nstaging\n" }
      )
    );

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome.outcome).toBe("failed");
    expect(outcome.detail).toMatch(/permission problem rather than absence/);
    // A permission-masked 404 must never invalidate the cache as if gone.
    expect(invalidated).toEqual([]);
  });

  it("does NOT treat a 404 as absence when the listing is unreadable", async () => {
    const { ports, invalidated } = deletePorts(
      deleteThenList(
        { code: 1, stderr: "gh: HTTP 404 Not Found" },
        { code: 1, stderr: "HTTP 403: forbidden" }
      )
    );

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome.outcome).toBe("failed");
    expect(outcome.detail).toBe("HTTP 403: forbidden");
    expect(invalidated).toEqual([]);
  });

  it("falls back to a default detail when a 404 listing is unreadable without stderr", async () => {
    const { ports, invalidated } = deletePorts(
      deleteThenList({ code: 1, stderr: "gh: HTTP 404 Not Found" }, { code: 1 })
    );

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome.outcome).toBe("failed");
    expect(outcome.detail).toMatch(/may be masking a permission problem/);
    expect(invalidated).toEqual([]);
  });

  it("reports a genuine failure with the trimmed stderr and never invalidates the cache", async () => {
    const { ports, invalidated } = deletePorts(async () => ({
      code: 1,
      stderr: "  HTTP 500 boom  "
    }));

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome).toEqual({ outcome: "failed", detail: "HTTP 500 boom" });
    expect(invalidated).toEqual([]);
  });

  it("falls back to a default message when a failure has no stderr", async () => {
    const { ports, invalidated } = deletePorts(async () => ({ code: 1 }));

    const outcome = await deleteGitHubEnvironmentIdempotent(
      "octo/app",
      "dev",
      ports
    );

    expect(outcome).toEqual({
      outcome: "failed",
      detail: "Deleting the GitHub environment failed."
    });
    expect(invalidated).toEqual([]);
  });
});

describe("selectedEnvironmentReader", () => {
  it("reads through the executor it was built from, not ambient gh", async () => {
    const seen: string[][] = [];
    const read = selectedEnvironmentReader({
      run: async (args) => {
        seen.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ id: 1234567, name: "dev" }),
          stderr: ""
        };
      }
    });

    await expect(
      read(["api", "/repos/octo/app/environments/dev"])
    ).resolves.toEqual({
      code: 0,
      stdout: JSON.stringify({ id: 1234567, name: "dev" }),
      stderr: ""
    });
    expect(seen).toEqual([["api", "/repos/octo/app/environments/dev"]]);
  });

  it.each([
    [
      "a refused read",
      { code: 1, stdout: "", stderr: "HTTP 403: Forbidden" },
      { code: 1, stdout: "", stderr: "HTTP 403: Forbidden" }
    ],
    [
      "a missing resource reported with a string code",
      { code: "1", stdout: "", stderr: "HTTP 404: Not Found" },
      { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
    ]
  ])(
    "keeps %s a failure rather than an empty answer",
    async (_label, response, expected) => {
      const read = selectedEnvironmentReader({
        run: async () => response
      });

      // An empty, successful-looking result would read as "the environment is
      // gone" and let a delete go out on a masked 404.
      await expect(
        read(["api", "/repos/octo/app/environments/dev"])
      ).resolves.toEqual(expected);
    }
  );

  it("treats an exit code it cannot parse as a failure", async () => {
    const read = selectedEnvironmentReader({
      run: async () => ({ code: undefined as never, stderr: "no answer" })
    });

    await expect(
      read(["api", "/repos/octo/app/environments/dev"])
    ).resolves.toEqual({ code: 1, stdout: "", stderr: "no answer" });
  });
});

describe("a retry after the provider refused the first attempt", () => {
  it("does not prove creation against the rejected attempt's clock", async () => {
    // The rejected attempt wrote nothing and the engine restamps the retry, so
    // dating the ownership proof from it would stretch the 120s falsifier to
    // however long the customer waited before retrying. An environment that
    // existed an hour earlier would fall inside that window, be promoted to
    // "created by this setup", and be deleted by a later rollback.
    const REJECTED_AT = Date.parse("2026-08-25T10:00:00.000Z");
    const RETRY_AT = REJECTED_AT + 3 * 60 * 60 * 1000;
    const operation = createOperation({ operationId: "op_retry" });
    const rejected = prepareProviderMutation(operation, {
      kind: "github_environment.put",
      target: "octo/app:production"
    });
    rejected.preparedAt = new Date(REJECTED_AT).toISOString();
    settleProviderMutation(
      operation,
      rejected.mutationId,
      "not_applied",
      "The provider rejected the request."
    );

    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      readGitHubJson: async (apiPath) =>
        apiPath === "/repos/octo/app" ?
          readResult({ json: { full_name: "octo/app" } })
        : readResult({ ok: false, status: 404, stderr: "Not Found" }),
      runGh: async () =>
        result({
          stdout: JSON.stringify({
            name: "production",
            id: 4242,
            // Created an hour before the retry — and long after the rejected
            // attempt, but the falsifier must date from the retry.
            created_at: new Date(REJECTED_AT + 60 * 60 * 1000).toISOString()
          })
        }),
      now: () => RETRY_AT,
      mutationRecovery: { operation, persist: async () => {} }
    });
    expect(ensured.creationProof?.proven).toBe(false);
    expect(ensured.creationProof?.proven).toBe(false);
  });
});
