import { describe, expect, it } from "vitest";
import {
  ensureGitHubEnvironment,
  GitHubEnvironmentEnsureError,
  readEnsuredGitHubEnvironment,
  type GitHubEnvironmentCommandResult
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

describe("ensureGitHubEnvironment", () => {
  it("returns GitHub's canonical name without mutating an existing environment", async () => {
    const calls: string[][] = [];
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      runGh: async (args) => {
        calls.push(args);
        return result({
          code: "0",
          stdout: JSON.stringify({ name: "Production" })
        });
      }
    });

    expect(ensured).toEqual({ name: "Production", state: "reused" });
    expect(calls).toEqual([["api", "/repos/octo/app/environments/production"]]);
  });

  it("creates a missing environment and returns the canonical created name", async () => {
    const calls: string[][] = [];
    const ensured = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "Production West",
      runGh: async (args) => {
        calls.push(args);
        return args.includes("PUT") ?
            result({ stdout: JSON.stringify({ name: "Production West" }) })
          : result({ code: 1, stderr: "HTTP 404: Not Found" });
      }
    });

    expect(ensured).toEqual({
      name: "Production West",
      state: "created_candidate"
    });
    expect(calls).toEqual([
      ["api", "/repos/octo/app/environments/Production%20West"],
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
        runGh: async (args) => {
          calls.push(args);
          return result({ code: 1, stderr: "HTTP 503: unavailable" });
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
        runGh: async () =>
          result({ code: 1, stderr: "GraphQL resource Not Found" })
      })
    ).rejects.toMatchObject({
      code: "github-environment-lookup-failed"
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
      [resolved, "octo/app", "production"],
      [
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
      ]
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
        runGh: async (args) =>
          args.includes("PUT") ?
            result({ code: 1, stdout: "HTTP 403" })
          : result({ code: 1, stderr: "HTTP 404" })
      })
    ).rejects.toMatchObject({
      code: "github-environment-create-failed",
      createdCandidate: null
    });
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["an array", "[]"],
    ["a missing name", "{}"],
    ["a blank name", '{"name":"   " }']
  ])(
    "rejects %s from an existing environment lookup",
    async (_label, stdout) => {
      await expect(
        ensureGitHubEnvironment({
          repo: "octo/app",
          requestedName: "production",
          runGh: async () => result({ stdout })
        })
      ).rejects.toMatchObject({
        code: "github-environment-name-missing",
        createdCandidate: null
      });
    }
  );

  it("retains candidate provenance when create succeeds without a canonical name", async () => {
    const thrown = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      runGh: async (args) =>
        args.includes("PUT") ?
          result({ stdout: "{}" })
        : result({ code: 1, stderr: "HTTP 404" })
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
    const runGh = async (args: string[]) => {
      if (args.includes("PUT")) {
        putCalls += 1;
        canonicalName = "Production";
        return result({ stdout: JSON.stringify({ name: canonicalName }) });
      }
      return canonicalName ?
          result({ stdout: JSON.stringify({ name: canonicalName }) })
        : result({ code: 1, stderr: "HTTP 404" });
    };

    const first = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      runGh
    });
    const second = await ensureGitHubEnvironment({
      repo: "octo/app",
      requestedName: "production",
      runGh
    });

    expect(first).toEqual({
      name: "Production",
      state: "created_candidate"
    });
    expect(second).toEqual({ name: "Production", state: "reused" });
    expect(putCalls).toBe(1);
  });
});
