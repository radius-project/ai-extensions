import { describe, expect, it } from "vitest";
import { createWorkflowScopeGhRunner } from "./create-environment-gh-runner.js";
import type {
  CreateEnvironmentCliExec,
  CreateEnvironmentCliOptions
} from "./create-environment-types.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";

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

const target = { targetRepo: "octo/app", envName: "dev" };

describe("the workflow-scope gh runner", () => {
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
