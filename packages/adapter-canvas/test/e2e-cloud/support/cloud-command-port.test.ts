import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CloudCommandError,
  createNodeCloudFixturePorts,
  describeError,
  expectSuccess,
  normalizeCommandResult,
  parseJsonArray,
  type CloudCommandResult
} from "./cloud-command-port.js";

function result(overrides: Partial<CloudCommandResult>): CloudCommandResult {
  return { code: 0, stdout: "", stderr: "", ...overrides };
}

describe("normalizeCommandResult", () => {
  it("reports exit code zero and the captured output for a successful command", () => {
    expect(normalizeCommandResult(null, "ok\n", "")).toEqual({
      code: 0,
      stdout: "ok\n",
      stderr: ""
    });
  });

  it("preserves a numeric exit code", () => {
    expect(normalizeCommandResult({ code: 3 }, "", "boom").code).toBe(3);
  });

  it.each([
    ["a signal or timeout code", { code: "ETIMEDOUT" }],
    ["a null code", { code: null }],
    ["no code at all", {}],
    ["an exit code of zero alongside an error", { code: 0 }]
  ])("reports a non-zero code for %s", (_label, error) => {
    // A killed process must never read as success: `Number("ETIMEDOUT")` is
    // NaN, which would compare falsely against every code the callers check.
    expect(normalizeCommandResult(error, "", "").code).toBe(1);
  });

  it("substitutes empty strings for undefined streams", () => {
    expect(normalizeCommandResult(null, undefined, undefined)).toEqual({
      code: 0,
      stdout: "",
      stderr: ""
    });
  });
});

describe("describeError", () => {
  it("uses an Error's message", () => {
    expect(describeError(new Error("group is locked"))).toBe("group is locked");
  });

  it.each([
    ["a string rejection", "directory vanished", "directory vanished"],
    ["a null rejection", null, "null"],
    ["a numeric rejection", 42, "42"]
  ])("stringifies %s", (_label, thrown, expected) => {
    expect(describeError(thrown)).toBe(expected);
  });
});

describe("expectSuccess", () => {
  it("returns the result unchanged for a successful command", () => {
    const ok = result({ stdout: "[]" });

    expect(expectSuccess(ok, "az group show")).toBe(ok);
  });

  it("throws a CloudCommandError carrying the exit code and streams", () => {
    let thrown: unknown;
    try {
      expectSuccess(
        result({ code: 3, stdout: "partial", stderr: "ERROR: not found" }),
        "az group show"
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CloudCommandError);
    const error = thrown as CloudCommandError;
    expect(error.message).toBe(
      "az group show failed with exit code 3: ERROR: not found"
    );
    expect(error.code).toBe(3);
    expect(error.stdout).toBe("partial");
    expect(error.stderr).toBe("ERROR: not found");
    expect(error.name).toBe("CloudCommandError");
  });

  it("falls back to stdout when the failure wrote nothing to stderr", () => {
    expect(() =>
      expectSuccess(result({ code: 1, stdout: "ERROR: on stdout" }), "az login")
    ).toThrow("az login failed with exit code 1: ERROR: on stdout");
  });

  it("still reports a failure that produced no output at all", () => {
    expect(() => expectSuccess(result({ code: 127 }), "az version")).toThrow(
      "az version failed with exit code 127."
    );
  });
});

describe("parseJsonArray", () => {
  it("parses a JSON array from stdout", () => {
    expect(
      parseJsonArray(result({ stdout: '[{"appId":"a"}]' }), "az ad app list")
    ).toEqual([{ appId: "a" }]);
  });

  it("reads an empty array as no results", () => {
    expect(parseJsonArray(result({ stdout: "[]" }), "az ad app list")).toEqual(
      []
    );
  });

  it.each([
    ["an entirely empty body", ""],
    ["whitespace only", "   \n  "]
  ])("treats %s as no results, matching an az --query miss", (_label, body) => {
    expect(parseJsonArray(result({ stdout: body }), "az ad app list")).toEqual(
      []
    );
  });

  it("propagates a command failure instead of reading it as no results", () => {
    expect(() =>
      parseJsonArray(
        result({ code: 1, stderr: "ERROR: please run az login" }),
        "az ad app list"
      )
    ).toThrow("az ad app list failed with exit code 1: ERROR: please run az");
  });

  it("rejects malformed JSON rather than reporting an empty result", () => {
    expect(() =>
      parseJsonArray(result({ stdout: "{not json" }), "az ad app list")
    ).toThrow(/az ad app list returned output that is not valid JSON/);
  });

  it.each([
    ["an object", '{"appId":"a"}', "a JSON object"],
    ["a string", '"nope"', "a JSON string"],
    ["a number", "12", "a JSON number"],
    ["null", "null", "null"]
  ])(
    "rejects %s where an array was expected",
    (_label, stdout, description) => {
      expect(() =>
        parseJsonArray(result({ stdout }), "az ad app list")
      ).toThrow(
        `az ad app list returned ${description} where a JSON array was expected.`
      );
    }
  );
});

describe("createNodeCloudFixturePorts", () => {
  it("creates and removes a workspace directory under the system temp root", async () => {
    const ports = createNodeCloudFixturePorts();

    const dir = await ports.makeWorkspaceDir("radtest-canvas-unit");
    try {
      expect(path.isAbsolute(dir)).toBe(true);
      expect(path.dirname(dir)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(dir)).toMatch(/^radtest-canvas-unit-/);
      await expect(fs.stat(dir)).resolves.toBeDefined();
    } finally {
      await ports.removeDir(dir);
    }

    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("removes a directory that is already gone without failing", async () => {
    const ports = createNodeCloudFixturePorts();
    const dir = await ports.makeWorkspaceDir("radtest-canvas-unit");
    await ports.removeDir(dir);

    await expect(ports.removeDir(dir)).resolves.toBeUndefined();
  });

  it("supplies a clock and a unique id generator", () => {
    const ports = createNodeCloudFixturePorts();

    expect(ports.now()).toBeInstanceOf(Date);
    expect(ports.newUniqueId()).not.toBe(ports.newUniqueId());
    expect(ports.newUniqueId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("supplies a real polling delay", async () => {
    const ports = createNodeCloudFixturePorts();

    await expect(ports.wait(0)).resolves.toBeUndefined();
  });

  it("reports a non-zero exit rather than rejecting", async () => {
    const ports = createNodeCloudFixturePorts();

    // `git` is the one tool of the three guaranteed present in this repository's
    // environment, so this exercises the real runner without needing a cloud CLI.
    const failed = await ports.commands.runGit(
      ["rev-parse", "--verify", "refs/heads/definitely-not-a-branch-xyz"],
      process.cwd()
    );

    expect(failed.code).not.toBe(0);
    expect(`${failed.stderr}${failed.stdout}`).not.toBe("");
  });

  it("returns trimmed-free stdout and a zero code for a successful command", async () => {
    const ports = createNodeCloudFixturePorts();

    const ok = await ports.commands.runGit(
      ["rev-parse", "--is-inside-work-tree"],
      process.cwd()
    );

    expect(ok.code).toBe(0);
    expect(ok.stdout.trim()).toBe("true");
  });

  it("exposes az and gh runners that resolve rather than reject when the tool is absent", async () => {
    const ports = createNodeCloudFixturePorts();

    // No Azure or GitHub CLI is assumed here. Whether the tool exists or not,
    // the contract under test is the same: the port resolves with a result.
    for (const run of [ports.commands.runAz, ports.commands.runGh]) {
      const outcome = await run(["--version"]);
      expect(typeof outcome.code).toBe("number");
      expect(typeof outcome.stdout).toBe("string");
      expect(typeof outcome.stderr).toBe("string");
    }
  }, 30_000);
});
