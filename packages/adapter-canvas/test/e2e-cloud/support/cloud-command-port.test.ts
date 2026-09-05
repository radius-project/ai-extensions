import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CloudCommandError,
  createRefreshingAzureCommandRunner,
  createNodeCloudFixturePorts,
  describeError,
  expectSuccess,
  normalizeAzureCommandResult,
  normalizeCommandResult,
  parseJsonArray,
  type CloudCommandResult
} from "./cloud-command-port.js";

const AZURE_ENV: NodeJS.ProcessEnv = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?job=1",
  AZURE_CLIENT_ID: "client-id",
  AZURE_TENANT_ID: "tenant-id",
  AZURE_SUBSCRIPTION_ID: "subscription-id"
};

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

  it("surfaces a missing tool's spawn diagnostic when both streams are empty", () => {
    const outcome = normalizeCommandResult(
      { code: "ENOENT", message: "spawn az ENOENT" },
      "",
      ""
    );

    expect(outcome).toEqual({
      code: 1,
      stdout: "",
      stderr: "spawn az ENOENT"
    });
    expect(() => expectSuccess(outcome, "az account show")).toThrow(
      "az account show failed with exit code 1: spawn az ENOENT"
    );
  });

  it("surfaces a timeout diagnostic when both streams are empty", () => {
    expect(
      normalizeCommandResult(
        { code: "ETIMEDOUT", message: "Command timed out after 900000ms" },
        "",
        ""
      )
    ).toEqual({
      code: 1,
      stdout: "",
      stderr: "Command timed out after 900000ms"
    });
  });

  it("preserves real stderr instead of prepending the callback message", () => {
    expect(
      normalizeCommandResult(
        { code: 1, message: "Command failed: gh api repository" },
        "",
        "gh: Not Found (HTTP 404)"
      )
    ).toEqual({
      code: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)"
    });
  });

  it("does not inject the callback message when stdout carries the diagnostic", () => {
    expect(
      normalizeCommandResult(
        { code: 1, message: "Command failed: az account show" },
        "ERROR: run az login",
        ""
      )
    ).toEqual({
      code: 1,
      stdout: "ERROR: run az login",
      stderr: ""
    });
  });

  it("keeps empty streams when an error has no message", () => {
    expect(normalizeCommandResult({ code: "ENOENT" }, "", "")).toEqual({
      code: 1,
      stdout: "",
      stderr: ""
    });
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

  describe("normalizeAzureCommandResult", () => {
    it("redacts injected and token-shaped credentials from both streams", () => {
      const opaque = "opaque-federated-token";
      const jwt =
        "eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJmaXh0dXJlIn0.fixture_signature";

      expect(
        normalizeAzureCommandResult(
          { code: 1 },
          `accessToken=${opaque}`,
          `failure: ${jwt}`,
          { AZURE_FEDERATED_TOKEN: opaque }
        )
      ).toEqual({
        code: 1,
        stdout: "accessToken=[REDACTED]",
        stderr: "failure: [REDACTED]"
      });
    });

    it("preserves non-secret Azure output", () => {
      expect(
        normalizeAzureCommandResult(
          null,
          '{"subscriptionId":"00000000-0000-0000-0000-000000000001"}',
          undefined,
          {}
        )
      ).toEqual({
        code: 0,
        stdout: '{"subscriptionId":"00000000-0000-0000-0000-000000000001"}',
        stderr: ""
      });
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

  describe("createRefreshingAzureCommandRunner", () => {
    function successfulFetch(
      assertion = "header.payload.signature"
    ): typeof fetch {
      return vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ value: assertion }), { status: 200 })
        )
      );
    }

    it("uses the initial azure/login session before the refresh boundary", async () => {
      let now = 0;
      const calls: string[][] = [];
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: successfulFetch(),
        runCommand: (args) => {
          calls.push([...args]);
          return Promise.resolve(result({ stdout: "ok" }));
        }
      });

      now = 99;
      await expect(run(["group", "list"])).resolves.toMatchObject({ code: 0 });
      expect(calls).toEqual([["group", "list"]]);
    });

    it("preserves an existing local Azure CLI session when Actions OIDC is unavailable", async () => {
      let now = 0;
      const runCommand = vi.fn((_: readonly string[]) =>
        Promise.resolve(result({ stdout: "local" }))
      );
      const run = createRefreshingAzureCommandRunner({
        env: {},
        now: () => now,
        refreshIntervalMs: 100,
        runCommand
      });

      now = 101;
      await expect(run(["group", "list"])).resolves.toMatchObject({
        code: 0,
        stdout: "local"
      });
      expect(runCommand).toHaveBeenCalledWith(["group", "list"]);
    });

    it("renews with a fresh assertion at the boundary before running the command", async () => {
      let now = 1_000;
      const calls: string[][] = [];
      const fetchImpl = successfulFetch();
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: fetchImpl,
        runCommand: (args) => {
          calls.push([...args]);
          return Promise.resolve(result({}));
        }
      });

      now += 100;
      await run(["group", "list"]);

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledWith(
        new URL(
          "https://oidc.example/token?job=1&audience=api%3A%2F%2FAzureADTokenExchange"
        ),
        expect.objectContaining({
          headers: { Authorization: "bearer request-token" }
        })
      );
      expect(calls).toEqual([
        [
          "login",
          "--service-principal",
          "--username",
          "client-id",
          "--tenant",
          "tenant-id",
          "--federated-token",
          "header.payload.signature",
          "--output",
          "none"
        ],
        ["account", "set", "--subscription", "subscription-id"],
        ["group", "list"]
      ]);
    });

    it("requests a new assertion for each renewal window", async () => {
      let now = 0;
      let assertion = 0;
      const fetchImpl = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ value: `header.payload.signature${++assertion}` }),
            { status: 200 }
          )
        )
      );
      const calls: string[][] = [];
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: fetchImpl,
        runCommand: (args) => {
          calls.push([...args]);
          return Promise.resolve(result({}));
        }
      });

      now = 100;
      await run(["group", "list"]);
      now = 200;
      await run(["group", "show"]);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(
        calls
          .filter((args) => args[0] === "login")
          .map((args) => args[args.indexOf("--federated-token") + 1])
      ).toEqual(["header.payload.signature1", "header.payload.signature2"]);
    });

    it("shares one renewal across concurrent Azure commands", async () => {
      let now = 0;
      let resolveFetch: ((response: Response) => void) | undefined;
      const fetchImpl = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );
      const calls: string[][] = [];
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: fetchImpl,
        runCommand: (args) => {
          calls.push([...args]);
          return Promise.resolve(result({}));
        }
      });

      now = 100;
      const first = run(["group", "list"]);
      const second = run(["account", "show"]);
      resolveFetch?.(
        new Response(JSON.stringify({ value: "header.payload.signature" }))
      );
      await Promise.all([first, second]);

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(calls.filter((args) => args[0] === "login")).toHaveLength(1);
      expect(calls.slice(-2)).toEqual([
        ["group", "list"],
        ["account", "show"]
      ]);
    });

    it.each([
      [
        "missing Azure identity",
        { ...AZURE_ENV, AZURE_CLIENT_ID: "" },
        successfulFetch(),
        /AZURE_CLIENT_ID/
      ],
      [
        "missing GitHub OIDC request state",
        { ...AZURE_ENV, ACTIONS_ID_TOKEN_REQUEST_URL: "" },
        successfulFetch(),
        /OIDC request URL and token/
      ],
      [
        "a rejected assertion request",
        AZURE_ENV,
        vi.fn(() => Promise.reject(new Error("request unavailable"))),
        /request unavailable/
      ],
      [
        "an unsuccessful assertion response",
        AZURE_ENV,
        vi.fn(() => Promise.resolve(new Response("", { status: 503 }))),
        /HTTP 503/
      ],
      [
        "invalid assertion JSON",
        AZURE_ENV,
        vi.fn(() => Promise.resolve(new Response("{", { status: 200 }))),
        /JSON/
      ],
      [
        "a malformed assertion response",
        AZURE_ENV,
        vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))),
        /did not contain a token/
      ]
    ])(
      "fails closed without running the requested command for %s",
      async (_label, env, fetchImpl, expected) => {
        let now = 0;
        const runCommand = vi.fn(() => Promise.resolve(result({})));
        const run = createRefreshingAzureCommandRunner({
          env,
          now: () => now,
          refreshIntervalMs: 100,
          fetch: fetchImpl,
          runCommand
        });

        now = 100;
        const outcome = await run(["group", "list"]);

        expect(outcome.code).toBe(1);
        expect(outcome.stderr).toMatch(expected);
        expect(runCommand).not.toHaveBeenCalled();
      }
    );

    it("stops before the requested command when login or subscription selection fails", async () => {
      let now = 0;
      const runCommand = vi
        .fn((_: readonly string[]) => Promise.resolve(result({})))
        .mockResolvedValueOnce(result({}))
        .mockResolvedValueOnce(
          result({ code: 1, stderr: "subscription denied" })
        );
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: successfulFetch(),
        runCommand
      });

      now = 100;
      await expect(run(["group", "list"])).resolves.toMatchObject({
        code: 1,
        stderr: "subscription denied"
      });
      expect(runCommand).toHaveBeenCalledTimes(2);
    });

    it("stops immediately when renewed Azure login fails", async () => {
      let now = 0;
      const runCommand = vi.fn((_: readonly string[]) =>
        Promise.resolve(result({ code: 1, stderr: "login denied" }))
      );
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: successfulFetch(),
        runCommand
      });

      now = 100;
      await expect(run(["group", "list"])).resolves.toMatchObject({
        code: 1,
        stderr: "login denied"
      });
      expect(runCommand).toHaveBeenCalledOnce();
    });

    it("retries renewal after a failed attempt", async () => {
      let now = 0;
      const fetchImpl = successfulFetch();
      const runCommand = vi
        .fn((_: readonly string[]) => Promise.resolve(result({})))
        .mockResolvedValueOnce(
          result({ code: 1, stderr: "temporary failure" })
        );
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: fetchImpl,
        runCommand
      });

      now = 100;
      await expect(run(["group", "list"])).resolves.toMatchObject({ code: 1 });
      await expect(run(["group", "list"])).resolves.toMatchObject({ code: 0 });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(runCommand).toHaveBeenCalledTimes(4);
    });

    it("redacts OIDC request credentials from refresh failures", async () => {
      let now = 0;
      const fetchImpl = vi.fn(() =>
        Promise.reject(
          new Error(
            `request rejected for ${AZURE_ENV.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
          )
        )
      );
      const run = createRefreshingAzureCommandRunner({
        env: AZURE_ENV,
        now: () => now,
        refreshIntervalMs: 100,
        fetch: fetchImpl,
        runCommand: () => Promise.resolve(result({}))
      });

      now = 100;
      const outcome = await run(["group", "list"]);

      expect(outcome.stderr).toContain("[REDACTED]");
      expect(outcome.stderr).not.toContain("request-token");
    });

    it("rejects a non-positive or non-finite refresh interval", () => {
      for (const refreshIntervalMs of [0, -1, Number.POSITIVE_INFINITY])
        expect(() =>
          createRefreshingAzureCommandRunner({ refreshIntervalMs })
        ).toThrow("must be positive and finite");
    });
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

  it("redacts Azure output through the real runAz port wiring", async () => {
    const token = "fake-azure-token-for-port-test";
    const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "fake-az-"));
    const originalPath = process.env.PATH;
    const originalPathExt = process.env.PATHEXT;
    const originalToken = process.env.AZURE_FEDERATED_TOKEN;

    await fs.writeFile(
      path.join(fakeBin, "az"),
      [
        "#!/bin/sh",
        'printf "accessToken=%s\\n" "$AZURE_FEDERATED_TOKEN"',
        'printf "failure: %s\\n" "$AZURE_FEDERATED_TOKEN" >&2',
        "exit 7",
        ""
      ].join("\n")
    );
    await fs.chmod(path.join(fakeBin, "az"), 0o755);
    await fs.writeFile(
      path.join(fakeBin, "az.cmd"),
      [
        "@echo off",
        "echo accessToken=%AZURE_FEDERATED_TOKEN%",
        "echo failure: %AZURE_FEDERATED_TOKEN% 1>&2",
        "exit /b 7",
        ""
      ].join("\r\n")
    );

    try {
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      process.env.AZURE_FEDERATED_TOKEN = token;

      const result = await createNodeCloudFixturePorts().commands.runAz([
        "--version"
      ]);

      expect(result.code).toBe(7);
      expect(result.stdout).toContain("accessToken=[REDACTED]");
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).toContain("failure: [REDACTED]");
      expect(result.stderr).not.toContain(token);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathExt;
      if (originalToken === undefined) delete process.env.AZURE_FEDERATED_TOKEN;
      else process.env.AZURE_FEDERATED_TOKEN = originalToken;
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  });
});
