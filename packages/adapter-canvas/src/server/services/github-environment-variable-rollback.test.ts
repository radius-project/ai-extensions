import { describe, expect, it } from "vitest";
import {
  rollbackGitHubEnvironmentVariables as rollbackVariables,
  type GitHubEnvironmentVariableRollbackArtifact,
  type GitHubVariableCommandResult
} from "./github-environment-variable-rollback.js";

const VARIABLE_PATH =
  "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID";
const ENVIRONMENT_PATH = "/repos/octo/app/environments/dev";

function artifact(
  overrides: Partial<GitHubEnvironmentVariableRollbackArtifact> = {}
): GitHubEnvironmentVariableRollbackArtifact {
  return {
    repo: "octo/app",
    environment: "dev",
    environmentProviderId: "env-1",
    name: "AZURE_CLIENT_ID",
    valueSha256:
      "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
    previousValue: null,
    previousKnown: true,
    target: "octo/app:dev variable AZURE_CLIENT_ID",
    identity: "octo/app:dev:azure_client_id",
    ...overrides
  };
}

function command(
  overrides: Partial<GitHubVariableCommandResult> = {}
): GitHubVariableCommandResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

function environment(id = "env-1"): GitHubVariableCommandResult {
  return command({ stdout: JSON.stringify({ id, name: "dev" }) });
}

function rollbackGitHubEnvironmentVariables(
  input: Omit<Parameters<typeof rollbackVariables>[0], "operation" | "persist">
) {
  return rollbackVariables({
    ...input,
    operation: { operationId: "op-variable-cleanup" },
    persist: async () => {}
  });
}

describe("GitHub environment variable rollback", () => {
  it("deletes a variable that was absent before setup", async () => {
    const calls: string[][] = [];
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact()],
      run: async (args) => {
        calls.push(args);
        if (args[1] === ENVIRONMENT_PATH) return environment();
        if (args[1] === VARIABLE_PATH) {
          return command({
            stdout: JSON.stringify({
              name: "AZURE_CLIENT_ID",
              value: "1"
            })
          });
        }
        return command();
      }
    });

    expect(calls).toEqual([
      ["api", ENVIRONMENT_PATH],
      ["api", VARIABLE_PATH],
      ["api", ENVIRONMENT_PATH],
      ["api", VARIABLE_PATH],
      [
        "variable",
        "delete",
        "AZURE_CLIENT_ID",
        "--env",
        "dev",
        "--repo",
        "octo/app"
      ]
    ]);
    expect(outcome).toMatchObject({
      blocked: false,
      warnings: [],
      results: [
        { outcome: "deleted", artifactType: "github_environment_variable" }
      ]
    });
  });

  it("restores the previous value", async () => {
    const calls: string[][] = [];
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 2,
      variables: [artifact({ previousValue: "old" })],
      run: async (args) => {
        calls.push(args);
        return (
          args[1] === ENVIRONMENT_PATH ? environment()
          : args[1] === VARIABLE_PATH ?
            command({
              stdout: JSON.stringify({
                name: "AZURE_CLIENT_ID",
                value: "1"
              })
            })
          : command()
        );
      }
    });

    expect(calls[4]).toEqual([
      "variable",
      "set",
      "AZURE_CLIENT_ID",
      "--body",
      "old",
      "--env",
      "dev",
      "--repo",
      "octo/app"
    ]);
    expect(outcome.results[0]?.outcome).toBe("restored");
  });

  it.each([
    ["already absent", artifact(), command({ code: 1, stderr: "HTTP 404" })],
    [
      "already restored",
      artifact({
        previousValue: "old",
        valueSha256:
          "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b"
      }),
      command({
        stdout: JSON.stringify({
          name: "AZURE_CLIENT_ID",
          value: "old"
        })
      })
    ]
  ])("converges when the variable is %s", async (_label, variable, first) => {
    const calls: string[][] = [];
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [variable],
      run: async (args) => {
        calls.push(args);
        if (args[1] === ENVIRONMENT_PATH) return environment();
        if (args[0] === "api" && args[1] === VARIABLE_PATH) return first;
        throw new Error(`unexpected mutation: ${args.join(" ")}`);
      }
    });

    expect(calls.every((args) => args[0] === "api")).toBe(true);
    expect(outcome.blocked).toBe(false);
    expect(["not_found", "restored"]).toContain(outcome.results[0]?.outcome);
  });

  it("blocks cleanup when a customer changed the variable", async () => {
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact()],
      run: async (args) =>
        args[1] === ENVIRONMENT_PATH ?
          environment()
        : command({
            stdout: JSON.stringify({
              name: "AZURE_CLIENT_ID",
              value: "manual"
            })
          })
    });

    expect(outcome).toMatchObject({
      blocked: true,
      results: [{ outcome: "skipped" }]
    });
    expect(outcome.warnings[0]).toContain("changed after Radius configured it");
  });

  it.each([
    ["unreadable", command({ code: 1, stderr: "HTTP 503" }), "warning"],
    ["malformed array", command({ stdout: "[]" }), "warning"],
    ["malformed null", command({ stdout: "null" }), "warning"],
    ["malformed JSON", command({ stdout: "{" }), "warning"],
    [
      "malformed fields",
      command({ stdout: JSON.stringify({ name: "OTHER" }) }),
      "warning"
    ],
    ["unknown predecessor", null, "skipped"]
  ])("blocks cleanup for %s state", async (_label, read, expected) => {
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [
        artifact({
          previousKnown: read !== null
        })
      ],
      run: async (args) => {
        if (args[1] === ENVIRONMENT_PATH) return environment();
        if (!read)
          throw new Error("unknown predecessor must not read variable");
        return read;
      }
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]?.outcome).toBe(expected);
  });

  it("accepts a lost mutation response only after the previous state is visible", async () => {
    let reads = 0;
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact({ previousValue: "old" })],
      run: async (args) => {
        if (args[1] === ENVIRONMENT_PATH) return environment();
        if (args[0] === "variable") {
          return command({ code: 1, stderr: "socket hang up" });
        }
        reads += 1;
        return command({
          stdout: JSON.stringify({
            name: "AZURE_CLIENT_ID",
            value: reads <= 2 ? "1" : "old"
          })
        });
      }
    });

    expect(outcome.blocked).toBe(false);
    expect(outcome.results[0]?.outcome).toBe("restored");
  });

  it("does not retry a failed restore while the Radius value remains", async () => {
    let mutations = 0;
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact({ previousValue: "old" })],
      run: async (args) => {
        if (args[1] === ENVIRONMENT_PATH) return environment();
        if (args[0] === "variable") {
          mutations += 1;
          return command({ code: 1, stderr: "timed out" });
        }
        return command({
          stdout: JSON.stringify({
            name: "AZURE_CLIENT_ID",
            value: "1"
          })
        });
      }
    });

    expect(mutations).toBe(1);
    expect(outcome).toMatchObject({
      blocked: true,
      results: [{ outcome: "skipped" }]
    });
  });

  it("does not replay a journaled rollback whose response was lost", async () => {
    const operation = { operationId: "op-lost-cleanup" };
    let mutations = 0;
    const run = async (args: string[]) => {
      if (args[1] === ENVIRONMENT_PATH) return environment();
      if (args[0] === "variable") {
        mutations += 1;
        return command({ code: 1, stderr: "socket hang up" });
      }
      return command({
        stdout: JSON.stringify({
          name: "AZURE_CLIENT_ID",
          value: "1"
        })
      });
    };
    const input = {
      attempt: 1,
      operation,
      persist: async () => {},
      variables: [artifact({ previousValue: "old" })],
      run
    };

    const first = await rollbackVariables(input);
    const second = await rollbackVariables({ ...input, attempt: 2 });

    expect(first.results[0]?.outcome).toBe("skipped");
    expect(second.results[0]?.outcome).toBe("skipped");
    expect(mutations).toBe(1);
  });

  it("does not mutate a replacement environment", async () => {
    let mutations = 0;
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact()],
      run: async (args) => {
        if (args[0] === "variable") mutations += 1;
        return environment("env-2");
      }
    });

    expect(mutations).toBe(0);
    expect(outcome).toMatchObject({
      blocked: true,
      results: [{ outcome: "skipped" }]
    });
    expect(outcome.warnings[0]).toContain("now has id env-2");
  });

  it.each([
    [
      "missing saved id",
      artifact({ environmentProviderId: null }),
      environment(),
      0
    ],
    [
      "unreadable environment",
      artifact(),
      command({ code: 1, stderr: "HTTP 503" }),
      1
    ],
    ["invalid environment JSON", artifact(), command({ stdout: "{" }), 1],
    ["null environment", artifact(), command({ stdout: "null" }), 1],
    ["missing environment id", artifact(), command({ stdout: "{}" }), 1]
  ])("blocks cleanup for %s", async (_label, variable, response, calls) => {
    let reads = 0;
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [variable],
      run: async () => {
        reads += 1;
        return response;
      }
    });

    expect(reads).toBe(calls);
    expect(outcome).toMatchObject({
      blocked: true,
      results: [{ outcome: "warning" }]
    });
  });

  it("rechecks environment identity immediately before mutation", async () => {
    let environmentReads = 0;
    let mutations = 0;
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact()],
      run: async (args) => {
        if (args[1] === ENVIRONMENT_PATH) {
          environmentReads += 1;
          return environment(environmentReads === 1 ? "env-1" : "env-2");
        }
        if (args[1] === VARIABLE_PATH) {
          return command({
            stdout: JSON.stringify({
              name: "AZURE_CLIENT_ID",
              value: "1"
            })
          });
        }
        mutations += 1;
        return command();
      }
    });

    expect(mutations).toBe(0);
    expect(outcome).toMatchObject({
      blocked: true,
      results: [{ outcome: "skipped" }]
    });
  });

  it("does not reconcile a lost response against a replacement environment", async () => {
    let environmentReads = 0;
    const outcome = await rollbackGitHubEnvironmentVariables({
      attempt: 1,
      variables: [artifact({ previousValue: "old" })],
      run: async (args) => {
        if (args[1] === ENVIRONMENT_PATH) {
          environmentReads += 1;
          return environment(environmentReads < 3 ? "env-1" : "env-2");
        }
        if (args[0] === "variable") {
          return command({ code: 1, stderr: "socket hang up" });
        }
        return command({
          stdout: JSON.stringify({
            name: "AZURE_CLIENT_ID",
            value: "1"
          })
        });
      }
    });

    expect(outcome).toMatchObject({
      blocked: true,
      results: [{ outcome: "skipped" }]
    });
  });
});
