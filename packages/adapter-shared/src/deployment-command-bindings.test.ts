import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import {
  createDeploymentCommandBindings,
  type DeploymentCommandExecutor
} from "./deployment-command-bindings.js";
import { createDeploymentDeferred } from "../test/support/deployment.js";

function harness() {
  const end = vi.fn();
  const execute = vi.fn<DeploymentCommandExecutor>(
    (_command, _args, _options, callback) => {
      callback(null, "  result\n", "");
      return { stdin: { end } };
    }
  );
  return {
    execute,
    end,
    bindings: createDeploymentCommandBindings({ execute })
  };
}

describe("deployment command bindings", () => {
  it("preserves literal argv and stdin through a real subprocess without inherited credentials", async () => {
    const execute: DeploymentCommandExecutor = (
      _command,
      args,
      options,
      callback
    ) =>
      execFile(
        process.execPath,
        [
          "-e",
          "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(1),input,token:process.env.GH_TOKEN})));",
          "--",
          ...args
        ],
        { ...options, env: options.env ?? {}, encoding: "utf8" },
        callback
      );
    const bindings = createDeploymentCommandBindings({ execute });
    const args = [
      "secret",
      "set",
      "fixture; & echo untouched",
      "path with spaces"
    ];
    const input = '{ "password": "fixture-only" }\n';
    const result = await bindings.runGhWithStdin(args, input, {
      env: { GH_TOKEN: "fixture-only" }
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args,
      input,
      token: "fixture-only"
    });
    expect(result.stderr).toBe("");
  });

  it("passes argv literally and leaves credential selection to the executor", async () => {
    const h = harness();
    const args = [
      "workflow",
      "run",
      "deploy.yml",
      "--ref",
      "feature; echo untouched"
    ];
    expect(await h.bindings.runGh(args)).toEqual({
      code: 0,
      stdout: "  result\n",
      stderr: ""
    });
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(
      "gh",
      args,
      { timeout: 30000 },
      expect.any(Function)
    );
    expect(h.end).not.toHaveBeenCalled();
  });

  it("preserves explicit credential environments, including an explicitly stripped environment", async () => {
    const h = harness();
    const env = {
      GH_TOKEN: "fixture-only",
      GITHUB_TOKEN: "fixture-only",
      PATH: "fixture-path"
    };
    await h.bindings.runGh(["api", "fixture"], { env });
    expect(h.execute.mock.calls[0][2].env).toBe(env);
    const stripped = { PATH: "fixture-path" };
    await h.bindings.runGh(["api", "fixture"], { env: stripped });
    expect(h.execute.mock.calls[1][2].env).toBe(stripped);
    expect(env.GH_TOKEN).toBe("fixture-only");
  });

  it("writes secret input through stdin without including it in argv or trimming it", async () => {
    const h = harness();
    const args = ["secret", "set", "RADIUS_DEPLOY_PARAMS"];
    const input = '{ "password": "fixture-only" }\n';
    const env = { PATH: "fixture-path" };
    await h.bindings.runGhWithStdin(args, input, { env });
    expect(h.execute).toHaveBeenCalledExactlyOnceWith(
      "gh",
      args,
      { timeout: 30000, env },
      expect.any(Function)
    );
    expect(h.end).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("preserves an intentionally empty stdin value but does not write absent stdin", async () => {
    const h = harness();
    await h.bindings.runGhWithStdin(["secret", "set", "fixture"], "");
    expect(h.end).toHaveBeenCalledExactlyOnceWith("");
    h.end.mockClear();
    await h.bindings.runGhWithStdin(["api", "fixture"], undefined);
    expect(h.end).not.toHaveBeenCalled();
  });

  it("tolerates unavailable input pipes for both stdin-fed and ordinary commands", async () => {
    const h = harness();
    h.execute.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "", "");
      return { stdin: null };
    });
    await expect(
      h.bindings.runGhWithStdin(["secret", "set", "fixture"], "fixture-only")
    ).resolves.toMatchObject({ code: 0 });
    await expect(
      h.bindings.runCliCommand("az", ["account", "show"])
    ).resolves.toMatchObject({ code: 0 });
  });

  it("retains failed and uncertain outcomes without retrying or changing credentials", async () => {
    const h = harness();
    const error = { code: null, killed: true, signal: "SIGTERM" };
    h.execute.mockImplementation((_command, _args, _options, callback) => {
      callback(error, "", "workflow scope required");
      return { stdin: { end: h.end } };
    });
    expect(await h.bindings.runGh(["workflow", "run"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "workflow scope required",
      timedOut: true
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(
      await h.bindings.runGhWithStdin(["secret", "set"], "fixture-only")
    ).toMatchObject({ code: 1, timedOut: true });
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("closes ordinary CLI stdin and preserves default or explicitly bounded timeouts", async () => {
    const h = harness();
    await h.bindings.runCliCommand("az", ["account", "show"]);
    expect(h.execute.mock.calls[0][2]).toEqual({ timeout: 60000 });
    expect(h.end).toHaveBeenCalledExactlyOnceWith();
    await h.bindings.runCliCommand("az", ["account", "show"], 15000);
    expect(h.execute.mock.calls[1][2]).toEqual({ timeout: 15000 });
  });

  it("lets the callback settle an ordinary command even when stdin closure fails", async () => {
    const h = harness();
    h.end.mockImplementation(() => {
      throw new Error("pipe closed");
    });
    await expect(h.bindings.runCliCommand("az", [])).resolves.toMatchObject({
      code: 0
    });
    await expect(
      h.bindings.runGhWithStdin(["secret", "set"], "fixture-only")
    ).resolves.toMatchObject({ code: 0 });
  });

  it("propagates failure to deliver stdin before a command answers", async () => {
    const h = harness();
    h.execute.mockImplementation(() => ({
      stdin: {
        end: () => {
          throw new Error("stdin unavailable");
        }
      }
    }));
    await expect(
      h.bindings.runGhWithStdin(["secret", "set"], "fixture-only")
    ).rejects.toThrow("stdin unavailable");
  });

  it("rejects synchronous process startup failures rather than reporting success", async () => {
    const h = harness();
    h.execute.mockImplementation(() => {
      throw new Error("spawn unavailable");
    });
    await expect(h.bindings.runGh(["api", "fixture"])).rejects.toThrow(
      "spawn unavailable"
    );
    await expect(h.bindings.ghOrThrow(["api", "fixture"])).rejects.toThrow(
      "spawn unavailable"
    );
  });

  it("returns trimmed lookup output and preserves the original error object", async () => {
    const h = harness();
    expect(await h.bindings.ghOrThrow(["api", "fixture"])).toBe("result");
    expect(h.execute.mock.calls[0][2]).toEqual({ timeout: 12000 });
    const failure = Object.assign(
      new Error("credential-aware executor failure"),
      { code: 1 }
    );
    h.execute.mockImplementation((_command, _args, _options, callback) => {
      callback(failure, "", "detail");
      return {};
    });
    await expect(h.bindings.ghOrThrow(["api", "fixture"], 9000)).rejects.toBe(
      failure
    );
    expect(h.execute.mock.calls[1][2]).toEqual({ timeout: 9000 });
  });

  it("waits for an asynchronous callback instead of treating process creation as acknowledgement", async () => {
    const ready = createDeploymentDeferred<void>();
    const finish = createDeploymentDeferred<void>();
    const execute: DeploymentCommandExecutor = (
      _command,
      _args,
      _options,
      callback
    ) => {
      void finish.promise.then(() => callback(null, "", ""));
      ready.resolve();
      return {};
    };
    const bindings = createDeploymentCommandBindings({ execute });
    const settled = vi.fn();
    const result = bindings.ghOrThrow(["api", "fixture"]).then(settled);
    await ready.promise;
    expect(settled).not.toHaveBeenCalled();
    finish.resolve();
    await result;
    expect(settled).toHaveBeenCalledExactlyOnceWith("");
  });
});
