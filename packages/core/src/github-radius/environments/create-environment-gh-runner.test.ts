import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createWorkflowScopeGhRunner as createRunner } from "./create-environment-gh-runner.js";
import type {
  CreateEnvironmentCliExec,
  CreateEnvironmentCliOptions
} from "./create-environment-types.js";
import type { SelectedGhExecutor } from "./execution-ports.js";
import {
  createOperation,
  operationDomain,
  recordGitHubEnvironmentVariable
} from "../../../test/support/environment-operation-domain.js";

const createWorkflowScopeGhRunner = (
  ports: Omit<
    Parameters<typeof createRunner>[0],
    "operationDomain" | "hashString"
  >,
  target: Parameters<typeof createRunner>[1],
  selectedExecutor?: Parameters<typeof createRunner>[2]
) =>
  createRunner(
    {
      ...ports,
      operationDomain,
      hashString: (value) => createHash("sha256").update(value).digest("hex")
    },
    target,
    selectedExecutor
  );

function successfulSelectedGhExecutor(
  options: {
    login?: string;
    credentialSource?: "keyring" | "injected";
    requiresKeyringSwitch?: boolean;
    scopes?: string[];
    run?: SelectedGhExecutor["run"];
  } = {}
): SelectedGhExecutor {
  const run: SelectedGhExecutor["run"] =
    options.run ??
    (async () => {
      throw new Error("Unexpected GitHub command.");
    });
  return {
    login: options.login ?? "octocat",
    credentialSource: options.credentialSource ?? "keyring",
    requiresKeyringSwitch: options.requiresKeyringSwitch ?? true,
    scopes: options.scopes ?? ["repo", "workflow", "write:packages"],
    run,
    async runOrThrow(args, message, commandOptions) {
      const result = await run(args, commandOptions);
      if (result.code !== 0) {
        const detail = result.stderr || result.stdout;
        throw new Error(detail ? `${message}: ${detail}` : message);
      }
      return result;
    },
    async verifyIdentity() {},
    packageCredentials: () => ({
      username: options.login ?? "octocat",
      token: "synthetic-package-credential",
      source: "keyring"
    }),
    redact: (value) => value,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
}

interface Invocation {
  command: string;
  args: string[];
  options: CreateEnvironmentCliOptions;
  stdin: string | null;
}

interface ScriptedResult {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
}

// `gh` isolates a real binary, so it stays a scripted fake that throws on any
// call the scenario did not model.
function fakeCli(script: ScriptedResult[]): {
  cliExec: CreateEnvironmentCliExec;
  calls: Invocation[];
} {
  const calls: Invocation[] = [];
  const remaining = [...script];
  const cliExec: CreateEnvironmentCliExec = (
    command,
    args,
    options,
    callback
  ) => {
    const next = remaining.shift();
    if (!next) {
      throw new Error(
        `unscripted cli call: ${command} ${args.join(" ")} (call ${calls.length + 1})`
      );
    }
    const call: Invocation = { command, args, options, stdin: null };
    calls.push(call);
    queueMicrotask(() => {
      const failed = "code" in next && next.code !== 0;
      callback(
        failed ?
          Object.assign(new Error("gh failed"), { code: next.code ?? null })
        : null,
        next.stdout ?? "",
        next.stderr ?? ""
      );
    });
    return {
      stdin: {
        end(chunk: string) {
          call.stdin = chunk;
          return undefined;
        }
      }
    };
  };
  return { cliExec, calls };
}

const target = {
  targetRepo: "octo/app",
  envName: "dev",
  environmentProviderId: "env-1"
};

function mutationRecovery(operation: ReturnType<typeof createOperation>) {
  return {
    operation,
    persist: async () => {},
    recordVariable: (
      entry: Parameters<typeof recordGitHubEnvironmentVariable>[1]
    ) => {
      recordGitHubEnvironmentVariable(operation, entry);
    }
  };
}

function environmentIdentity(args: string[]) {
  return args[0] === "api" && args[1] === "/repos/octo/app/environments/dev" ?
      {
        code: 0,
        stdout: JSON.stringify({ id: "env-1", name: "dev" }),
        stderr: ""
      }
    : null;
}

describe("the workflow-scope gh runner", () => {
  it("passes explicit stdin and timeout through the selected-account boundary", async () => {
    const calls: unknown[] = [];
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("Ambient credentials are forbidden");
        },
        readProcessEnv: () => ({})
      },
      target,
      successfulSelectedGhExecutor({
        run: async (args, options) => {
          calls.push({ args, options });
          return { code: 0, stdout: "created", stderr: "" };
        }
      })
    );
    await runner.runGh(["api", "--input", "-"], "body", { timeout: 1500 });
    expect(calls).toEqual([
      {
        args: ["api", "--input", "-"],
        options: { timeout: 1500, stdin: "body" }
      }
    ]);
  });

  it("supports an executor without a stdin stream", async () => {
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: (_command, _args, _options, callback) => {
          callback(null, "ok", "");
          return {};
        },
        readProcessEnv: () => ({})
      },
      target
    );
    expect(await runner.runGh(["api", "/x"], "body")).toEqual({
      code: 0,
      stdout: "ok",
      stderr: ""
    });
  });

  it("rechecks environment identity after a variable 404 before assuming absence", async () => {
    const op = createOperation({ operationId: "identity-after-404" });
    const { cliExec, calls } = fakeCli([
      { stdout: '{"id":"env-1"}' },
      { code: 1, stderr: "HTTP 404" },
      { stdout: '{"id":"replacement"}' }
    ]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      { ...target, mutationRecovery: mutationRecovery(op) }
    );
    await expect(runner.setEnvironmentVariable("A", "value")).rejects.toThrow(
      "now has id replacement"
    );
    expect(calls.every((call) => call.args[0] === "api")).toBe(true);
    expect(op.providerRecovery.mutations).toEqual([]);
  });

  it.each<{
    intent: Record<string, string | number | boolean | null>;
    previousKnown: boolean;
    previousValue: string | null;
  }>([
    { intent: {}, previousKnown: false, previousValue: null },
    {
      intent: { previousKnown: true, previousValue: "old" },
      previousKnown: true,
      previousValue: "old"
    },
    {
      intent: { previousKnown: true, previousValue: null },
      previousKnown: true,
      previousValue: null
    },
    {
      intent: { previousKnown: false, previousValue: false },
      previousKnown: false,
      previousValue: null
    }
  ])(
    "reconciles an older journal's predecessor evidence $intent without rewriting",
    async ({ intent, previousKnown, previousValue }) => {
      const op = createOperation({ operationId: "older-variable-journal" });
      operationDomain.prepareProviderMutation(op, {
        kind: "github_environment_variable.put",
        target: "octo/app:dev:A",
        intent
      });
      const { cliExec, calls } = fakeCli([
        { stdout: '{"id":"env-1"}' },
        { stdout: '{"name":"A","value":"value"}' }
      ]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => ({}) },
        { ...target, mutationRecovery: mutationRecovery(op) }
      );
      expect(await runner.setEnvironmentVariable("A", "value")).toBe(true);
      expect(calls.every((call) => call.args[0] === "api")).toBe(true);
      expect(op.providerRecovery.mutations[0].status).toBe("confirmed");
      expect(op.setupArtifacts.githubEnvironmentVariables).toEqual([
        expect.objectContaining({ previousKnown, previousValue })
      ]);
    }
  );

  it("requires immutable environment identity before journaled writes", async () => {
    const op = createOperation({ operationId: "identity-required" });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("Must not execute");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        environmentProviderId: null,
        mutationRecovery: mutationRecovery(op)
      }
    );
    await expect(runner.setEnvironmentVariable("A", "value")).rejects.toThrow(
      "immutable id"
    );
    expect(op.providerRecovery.mutations).toEqual([]);
  });

  it.each([
    { label: "malformed JSON", result: { code: 0, stdout: "{", stderr: "" } },
    {
      label: "non-object JSON",
      result: { code: 0, stdout: "null", stderr: "" }
    },
    { label: "no id", result: { code: 0, stdout: "{}", stderr: "" } },
    {
      label: "blank id",
      result: { code: 0, stdout: '{"id":" ","node_id":" "}', stderr: "" }
    },
    {
      label: "stdout error",
      result: { code: 1, stdout: "identity offline", stderr: "" }
    },
    { label: "empty error", result: { code: 1, stdout: "", stderr: "" } }
  ])(
    "refuses $label environment identity before mutation",
    async ({ result }) => {
      const op = createOperation({ operationId: "identity-unreadable" });
      let calls = 0;
      const runner = createWorkflowScopeGhRunner(
        {
          cliExec: () => {
            throw new Error("Ambient credentials are forbidden");
          },
          readProcessEnv: () => ({})
        },
        { ...target, mutationRecovery: mutationRecovery(op) },
        successfulSelectedGhExecutor({
          run: async (args) => {
            expect(args).toEqual(["api", "/repos/octo/app/environments/dev"]);
            calls++;
            return result;
          }
        })
      );
      await expect(runner.setEnvironmentVariable("A", "value")).rejects.toThrow(
        "Radius did not write"
      );
      expect(calls).toBe(1);
      expect(op.providerRecovery.mutations).toEqual([]);
    }
  );

  it.each([{ id: 17 }, { node_id: "17" }])(
    "accepts numeric or node identity %j and records the confirmed write",
    async (identity) => {
      const op = createOperation({ operationId: "identity-matched" });
      let writes = 0;
      const runner = createWorkflowScopeGhRunner(
        {
          cliExec: () => {
            throw new Error("Ambient credentials are forbidden");
          },
          readProcessEnv: () => ({})
        },
        {
          ...target,
          environmentProviderId: "17",
          mutationRecovery: mutationRecovery(op)
        },
        successfulSelectedGhExecutor({
          run: async (args) => {
            if (args[0] === "variable") {
              writes++;
              return { code: 0, stdout: "", stderr: "" };
            }
            if (args[1] === "/repos/octo/app/environments/dev") {
              return {
                code: "0",
                stdout: JSON.stringify(identity),
                stderr: ""
              };
            }
            expect(args[1]).toContain("/variables/A");
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          }
        })
      );
      expect(await runner.setEnvironmentVariable("A", "value")).toBe(true);
      expect(writes).toBe(1);
      expect(op.providerRecovery.mutations[0].status).toBe("confirmed");
      expect(op.setupArtifacts.githubEnvironmentVariables).toEqual([
        expect.objectContaining({ name: "A", environmentProviderId: "17" })
      ]);
    }
  );

  it.each([
    [
      "variable unavailable",
      "variable",
      { code: 1, stdout: "", stderr: "" },
      "provider-mutation-outcome-unknown"
    ],
    [
      "variable malformed",
      "variable",
      { code: 0, stdout: "{", stderr: "" },
      "provider-mutation-manual-required"
    ],
    [
      "environment replaced",
      "environment",
      { code: 0, stdout: '{"id":"replacement"}', stderr: "" },
      "provider-mutation-manual-required"
    ],
    [
      "variable stdout failure",
      "variable",
      { code: 1, stdout: "read unavailable", stderr: "" },
      "provider-mutation-outcome-unknown"
    ]
  ] as const)(
    "does not repeat a timed-out write when reconciliation finds %s",
    async (_label, failingRead, failure, code) => {
      const op = createOperation({ operationId: "reconcile-variable" });
      let writes = 0;
      const runner = createWorkflowScopeGhRunner(
        {
          cliExec: () => {
            throw new Error("Ambient credentials are forbidden");
          },
          readProcessEnv: () => ({})
        },
        { ...target, mutationRecovery: mutationRecovery(op) },
        successfulSelectedGhExecutor({
          run: async (args) => {
            if (args[0] === "variable") {
              writes++;
              return {
                code: 1,
                stdout: "",
                stderr: "timed out",
                timedOut: true
              };
            }
            const isEnvironment =
              args[1] === "/repos/octo/app/environments/dev";
            if (writes && isEnvironment === (failingRead === "environment"))
              return failure;
            if (isEnvironment)
              return { code: 0, stdout: '{"id":"env-1"}', stderr: "" };
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          }
        })
      );
      await expect(
        runner.setEnvironmentVariable("A", "value")
      ).rejects.toMatchObject({ code });
      expect(writes).toBe(1);
      expect(op.setupArtifacts.githubEnvironmentVariables).toEqual([]);
    }
  );

  it("routes selected-account commands through the pinned executor", async () => {
    const calls: string[][] = [];
    const pinned = successfulSelectedGhExecutor({
      login: "selected",
      run: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "ok", stderr: "" };
      }
    });

    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({ GH_TOKEN: "ambient" })
      },
      target,
      pinned
    );

    await expect(runner.runGhWorkflow(["workflow", "run"])).resolves.toEqual({
      code: 0,
      stdout: "ok",
      stderr: ""
    });
    expect(calls).toEqual([["workflow", "run"]]);
  });

  it("resolves the exit code, stdout and stderr of a failing command instead of rejecting", async () => {
    const { cliExec, calls } = fakeCli([
      { code: 3, stdout: "out", stderr: "boom" }
    ]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.runGh(["api", "/x"])).resolves.toEqual({
      code: 3,
      stdout: "out",
      stderr: "boom"
    });
    expect(calls[0]?.command).toBe("gh");
    expect(calls[0]?.options.timeout).toBe(30000);
  });

  it("reports a null exit code as a failure rather than a success", async () => {
    // `ExecFileException.code` is nullable when the child was signalled, and a
    // nullish code must not read as 0.
    const { cliExec } = fakeCli([{ code: null, stderr: "killed" }]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.runGh(["api", "/x"])).resolves.toMatchObject({
      code: 1
    });
  });

  describe("the selected GitHub executor test helper", () => {
    it("matches the production runOrThrow failure contract", async () => {
      const executor = successfulSelectedGhExecutor({
        run: async () => ({ code: 1, stdout: "", stderr: "denied" })
      });

      await expect(
        executor.runOrThrow(["api", "user"], "Identity failed")
      ).rejects.toThrow("Identity failed: denied");
    });

    it("uses the caller message when a failure has no detail", async () => {
      const executor = successfulSelectedGhExecutor({
        run: async () => ({ code: 1, stdout: "", stderr: "" })
      });

      await expect(
        executor.runOrThrow(["api", "user"], "Identity failed")
      ).rejects.toThrow(/^Identity failed$/);
    });
  });

  it("writes stdin to the child when the caller supplies it", async () => {
    const { cliExec, calls } = fakeCli([{ stdout: "{}" }]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await runner.runGh(["api", "--input", "-"], '{"a":1}');
    expect(calls[0]?.stdin).toBe('{"a":1}');
  });

  it("throws with the command's own detail appended to the caller's message", async () => {
    const { cliExec } = fakeCli([{ code: 1, stderr: "  HTTP 404  " }]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.runGhOrThrow(["api", "/x"], "Nope")).rejects.toThrow(
      "Nope: HTTP 404"
    );
  });

  it("throws the bare message when the command produced no detail", async () => {
    const { cliExec } = fakeCli([{ code: 1 }]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.runGhOrThrow(["api", "/x"], "Nope")).rejects.toThrow(
      /^Nope$/
    );
  });

  it.each<[value: string | undefined, label: string]>([
    ["", "an empty value"],
    [undefined, "an absent value"]
  ])("skips setting an environment variable for %s", async (value) => {
    // The fake throws on any call, so a no-op is asserted by the absence of one.
    const { cliExec, calls } = fakeCli([]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.setEnvironmentVariable("A", value)).resolves.toBe(
      false
    );
    expect(calls).toEqual([]);
  });

  it("sets an environment variable against the target environment and repo", async () => {
    const { cliExec, calls } = fakeCli([{ stdout: "" }]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.setEnvironmentVariable("A", "1")).resolves.toBe(true);
    expect(calls[0]?.args).toEqual([
      "variable",
      "set",
      "A",
      "--body",
      "1",
      "--env",
      "dev",
      "--repo",
      "octo/app"
    ]);
  });

  it("does not write a variable to a replacement environment", async () => {
    const operation = createOperation({ operationId: "op_replacement" });
    let writes = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        if (args[0] === "variable") writes += 1;
        return {
          code: 0,
          stdout: JSON.stringify({ id: "env-2", name: "dev" }),
          stderr: ""
        };
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toMatchObject(
      {
        code: "provider-mutation-manual-required"
      }
    );
    expect(writes).toBe(0);
    expect(operation.providerRecovery.mutations).toEqual([]);
  });

  it("rechecks environment identity immediately before writing", async () => {
    const operation = createOperation({
      operationId: "op_replaced_during_read"
    });
    let environmentReads = 0;
    let writes = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        if (
          args[0] === "api" &&
          args[1] === "/repos/octo/app/environments/dev"
        ) {
          environmentReads += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              id: environmentReads === 1 ? "env-1" : "env-2",
              name: "dev"
            }),
            stderr: ""
          };
        }
        if (args[0] === "api") {
          return {
            code: 0,
            stdout: JSON.stringify({ name: "A", value: "old" }),
            stderr: ""
          };
        }
        writes += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toMatchObject(
      {
        code: "provider-mutation-manual-required"
      }
    );
    expect(writes).toBe(0);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied"
    });
  });

  it("records a failed pre-mutation identity read as not applied", async () => {
    const operation = createOperation({
      operationId: "op_identity_unreadable"
    });
    let environmentReads = 0;
    let writes = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        if (
          args[0] === "api" &&
          args[1] === "/repos/octo/app/environments/dev"
        ) {
          environmentReads += 1;
          return environmentReads === 1 ?
              {
                code: 0,
                stdout: JSON.stringify({ id: "env-1", name: "dev" }),
                stderr: ""
              }
            : { code: 1, stdout: "", stderr: "HTTP 503: unavailable" };
        }
        if (args[0] === "api") {
          return {
            code: 0,
            stdout: JSON.stringify({ name: "A", value: "old" }),
            stderr: ""
          };
        }
        writes += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      "HTTP 503"
    );
    expect(writes).toBe(0);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied"
    });
  });

  it("does not overwrite a variable changed after its preflight", async () => {
    const operation = createOperation({ operationId: "op_value_changed" });
    let variableReads = 0;
    let writes = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "api") {
          variableReads += 1;
          return {
            code: 0,
            stdout: JSON.stringify({
              name: "A",
              value: variableReads === 1 ? "old" : "manual"
            }),
            stderr: ""
          };
        }
        writes += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toMatchObject(
      {
        code: "provider-mutation-manual-required"
      }
    );
    expect(writes).toBe(0);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied"
    });
  });

  it("reconciles a timed-out variable write by exact name and value", async () => {
    const operation = createOperation({ operationId: "op_variable" });
    const calls: string[][] = [];
    let variableReads = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        calls.push(args);
        if (args[0] === "variable") {
          return {
            code: 1,
            stdout: "",
            stderr: "timed out",
            timedOut: true
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          variableReads += 1;
          if (variableReads <= 2) {
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          }
          return {
            code: 0,
            stdout: JSON.stringify({ name: "A", value: "1" }),
            stderr: ""
          };
        }
        if (args[0] === "api" && args[1]?.includes("/environments/dev")) {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).resolves.toBe(true);
    expect(calls.filter((args) => args[0] === "variable")).toHaveLength(1);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      kind: "github_environment_variable.put",
      status: "confirmed",
      intent: {
        name: "A"
      }
    });
    expect(operation.providerRecovery.mutations[0].intent?.valueSha256).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(operation.setupArtifacts.githubEnvironmentVariables).toEqual([
      expect.objectContaining({
        name: "A",
        previousValue: null,
        previousKnown: true
      })
    ]);
  });

  it("refuses to overwrite a variable changed outside the operation", async () => {
    const operation = createOperation({ operationId: "op_variable_conflict" });
    let variableReads = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "variable") {
          return {
            code: 1,
            stdout: "",
            stderr: "socket hang up",
            timedOut: true
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          variableReads += 1;
          if (variableReads <= 2) {
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          }
          return {
            code: 0,
            stdout: JSON.stringify({ name: "A", value: "manual" }),
            stderr: ""
          };
        }
        if (args[0] === "api" && args[1]?.includes("/environments/dev")) {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toMatchObject(
      {
        code: "provider-mutation-manual-required"
      }
    );
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "manual_required"
    });
  });

  it("checks for a manual value before retrying a conclusively refused write", async () => {
    const operation = createOperation({ operationId: "op_variable_retry" });
    const calls: string[][] = [];
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        calls.push(args);
        if (
          calls.filter((call) => call[0] === "variable").length === 1 &&
          args[0] === "variable"
        ) {
          return {
            code: 1,
            stdout: "",
            stderr: "HTTP 429: Too Many Requests"
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          return {
            code: 0,
            stdout: JSON.stringify({ name: "A", value: "manual" }),
            stderr: ""
          };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      "HTTP 429"
    );
    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toMatchObject(
      {
        code: "provider-mutation-manual-required"
      }
    );
    expect(calls.filter((args) => args[0] === "variable")).toHaveLength(1);
  });

  it("accepts an exact value that appeared after a conclusively refused write", async () => {
    const operation = createOperation({ operationId: "op_variable_exact" });
    let writes = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "variable") {
          writes += 1;
          return {
            code: 1,
            stdout: "",
            stderr: "HTTP 429: Too Many Requests"
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          return {
            code: 0,
            stdout: JSON.stringify({ name: "A", value: "1" }),
            stderr: ""
          };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      "HTTP 429"
    );
    await expect(runner.setEnvironmentVariable("A", "1")).resolves.toBe(true);
    expect(writes).toBe(1);
  });

  it("records an ambiguous write as not applied only after proving the variable absent", async () => {
    const operation = createOperation({ operationId: "op_variable_absent" });
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "variable") {
          return {
            code: 1,
            stdout: "",
            stderr: "timed out",
            timedOut: true
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        }
        if (args[0] === "api" && args[1]?.includes("/environments/dev")) {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      'Failed to set A on GitHub environment "dev"'
    );
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied"
    });
  });

  it.each([
    ["invalid JSON", "{oops"],
    ["a missing value", JSON.stringify({ name: "A" })]
  ])("refuses %s variable state before writing", async (_label, stdout) => {
    const operation = createOperation({
      operationId: `op_variable_malformed_${_label.replace(/\s+/g, "_")}`
    });
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "variable") {
          return {
            code: 1,
            stdout: "",
            stderr: "socket hang up",
            timedOut: true
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          return { code: 0, stdout, stderr: "" };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      "Radius did not write the variable"
    );
    expect(operation.providerRecovery.mutations).toEqual([]);
  });

  it("leaves an ambiguous variable write unresolved when provider state cannot be read", async () => {
    const operation = createOperation({
      operationId: "op_variable_unreadable"
    });
    let variableReads = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "variable") {
          return {
            code: 1,
            stdout: "",
            stderr: "socket hang up",
            timedOut: true
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          variableReads += 1;
          if (variableReads <= 2) {
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          }
          return { code: 1, stdout: "", stderr: "HTTP 503: unavailable" };
        }
        if (args[0] === "api" && args[1]?.includes("/environments/dev")) {
          return { code: 0, stdout: "{}", stderr: "" };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toMatchObject(
      {
        code: "provider-mutation-outcome-unknown"
      }
    );
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "outcome_unknown"
    });
  });

  it("does not retry a refused variable write while its preflight read is unavailable", async () => {
    const operation = createOperation({ operationId: "op_variable_preflight" });
    let writes = 0;
    let variableReads = 0;
    const pinned = successfulSelectedGhExecutor({
      run: async (args) => {
        const identity = environmentIdentity(args);
        if (identity) return identity;
        if (args[0] === "variable") {
          writes += 1;
          return {
            code: 1,
            stdout: "",
            stderr: "HTTP 429: Too Many Requests"
          };
        }
        if (args[0] === "api" && args[1]?.includes("/variables/A")) {
          variableReads += 1;
          return variableReads <= 2 ?
              {
                code: 0,
                stdout: JSON.stringify({ name: "A", value: "old" }),
                stderr: ""
              }
            : { code: 1, stdout: "", stderr: "" };
        }
        throw new Error(`unscripted gh call: ${args.join(" ")}`);
      }
    });
    const runner = createWorkflowScopeGhRunner(
      {
        cliExec: () => {
          throw new Error("ambient cli path must not run");
        },
        readProcessEnv: () => ({})
      },
      {
        ...target,
        mutationRecovery: mutationRecovery(operation)
      },
      pinned
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      "HTTP 429"
    );
    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      "Radius did not write the variable"
    );
    expect(writes).toBe(1);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "not_applied"
    });
  });

  it("propagates a failure to set an environment variable", async () => {
    const { cliExec } = fakeCli([{ code: 1, stderr: "denied" }]);
    const runner = createWorkflowScopeGhRunner(
      { cliExec, readProcessEnv: () => ({}) },
      target
    );

    await expect(runner.setEnvironmentVariable("A", "1")).rejects.toThrow(
      'Failed to set A on GitHub environment "dev": denied'
    );
  });

  describe("the workflow-scope retry", () => {
    it("does not retry a command that already succeeded", async () => {
      const { cliExec, calls } = fakeCli([{ stdout: "ok" }]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => ({ GH_TOKEN: "t" }) },
        target
      );

      await expect(runner.runGhWorkflow(["workflow", "run"])).resolves.toEqual({
        code: 0,
        stdout: "ok",
        stderr: ""
      });
      expect(calls).toHaveLength(1);
    });

    it("does not retry when no token was injected", async () => {
      const { cliExec, calls } = fakeCli([{ code: 1, stderr: "HTTP 404" }]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => ({ PATH: "/usr/bin" }) },
        target
      );

      await expect(
        runner.runGhWorkflow(["workflow", "run"])
      ).resolves.toMatchObject({ code: 1, stderr: "HTTP 404" });
      expect(calls).toHaveLength(1);
    });

    it("does not retry a failed mutation under a different credential", async () => {
      const { cliExec, calls } = fakeCli([
        { code: 1, stderr: "HTTP 404" },
        { stdout: "dispatched" }
      ]);
      const runner = createWorkflowScopeGhRunner(
        {
          cliExec,
          readProcessEnv: () => ({
            GH_TOKEN: "gh",
            GITHUB_TOKEN: "github",
            PATH: "/usr/bin"
          })
        },
        target
      );

      await expect(
        runner.runGhWorkflow(["workflow", "run"])
      ).resolves.toMatchObject({
        code: 1,
        stderr: "HTTP 404"
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.options.env).toBeUndefined();
    });

    it("keeps the original failure when the retry also fails", async () => {
      const { cliExec, calls } = fakeCli([
        { code: 1, stderr: "the meaningful one" },
        { code: 1, stderr: "the second, vaguer one" }
      ]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => ({ GITHUB_TOKEN: "t" }) },
        target
      );

      await expect(
        runner.runGhWorkflow(["workflow", "run"])
      ).resolves.toMatchObject({ stderr: "the meaningful one" });
      expect(calls).toHaveLength(1);
    });

    it("forwards stdin on the retry as well as the first attempt", async () => {
      const { cliExec, calls } = fakeCli([
        { code: 1, stderr: "HTTP 404" },
        { stdout: "ok" }
      ]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => ({ GH_TOKEN: "t" }) },
        target
      );

      await runner.runGhWorkflow(["api", "--input", "-"], "payload");
      expect(calls.map((call) => call.stdin)).toEqual(["payload"]);
    });

    it("does not inspect a newly injected token to choose a retry credential", async () => {
      const env: NodeJS.ProcessEnv = {};
      const { cliExec, calls } = fakeCli([
        { code: 1, stderr: "HTTP 404" },
        { stdout: "ok" }
      ]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => env },
        target
      );

      env.GH_TOKEN = "injected-after-construction";

      await expect(
        runner.runGhWorkflow(["workflow", "run"])
      ).resolves.toMatchObject({
        code: 1,
        stderr: "HTTP 404"
      });
      expect(calls).toHaveLength(1);
    });

    it("stops retrying once the injected token is removed mid-session", async () => {
      const env: NodeJS.ProcessEnv = { GH_TOKEN: "t" };
      const { cliExec, calls } = fakeCli([{ code: 1, stderr: "HTTP 404" }]);
      const runner = createWorkflowScopeGhRunner(
        { cliExec, readProcessEnv: () => env },
        target
      );

      delete env.GH_TOKEN;

      await expect(
        runner.runGhWorkflow(["workflow", "run"])
      ).resolves.toMatchObject({ code: 1 });
      expect(calls).toHaveLength(1);
    });
  });
});
