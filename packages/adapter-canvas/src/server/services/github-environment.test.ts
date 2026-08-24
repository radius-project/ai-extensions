import { describe, expect, it } from "vitest";
import {
  createOperation,
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";
import {
  ensureGitHubEnvironment,
  selectedEnvironmentReader,
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment,
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

  it("fails closed on lookup errors that are not an explicit HTTP 404", async () => {
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
        }
      })
    ).rejects.toMatchObject({
      code: "github-environment-lookup-failed",
      message:
        'Could not resolve GitHub environment "production". HTTP 503: unavailable'
    });
    expect(calls).toHaveLength(1);
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
