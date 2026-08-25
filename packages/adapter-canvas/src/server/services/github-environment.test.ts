import { describe, expect, it } from "vitest";
import {
  ensureGitHubEnvironment,
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

    expect(ensured).toEqual({ name: "Production", state: "reused" });
    expect(calls).toEqual(["/repos/octo/app/environments/production"]);
  });

  it("creates a missing environment and returns the canonical created name", async () => {
    const reads: string[] = [];
    const mutations: string[][] = [];
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "Production West",
      now: () => 1_700_000_000_000,
      readGitHubJson: async (apiPath) => {
        reads.push(apiPath);
        return apiPath === "/repos/octo/app" ?
            readResult({ json: { full_name: "octo/app" } })
          : readResult({ ok: false, status: 404, stderr: "Not Found" });
      },
      runGh: async (args) => {
        mutations.push(args);
        return result({
          stdout: JSON.stringify({ name: "Production West" })
        });
      }
    });

    expect(ensured).toEqual({
      name: "Production West",
      state: "created_candidate",
      creationEvidence: {
        putResponseBody: JSON.stringify({ name: "Production West" }),
        putStartedAtMs: 1_700_000_000_000
      }
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
        state: "created_candidate"
      });
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
      creationEvidence: {
        putResponseBody: JSON.stringify({ name: "Production" }),
        putStartedAtMs: 1_700_000_000_000
      }
    });
    expect(second).toEqual({ name: "Production", state: "reused" });
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
