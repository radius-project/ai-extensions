import { describe, expect, it } from "vitest";
import { observeWorkflowRun } from "@radius-project/core";
import {
  readWorkflowRun,
  readWorkflowLog,
  selectedWorkflowJson,
  SelectedGhAuthorizationError,
  isGitHubRateLimitError,
  isSelectedGhAuthorizationError,
  selectedCommandAuthorizationError,
  type SelectedWorkflowExecutor
} from "./workflow-reads.js";

function successfulSelectedGhExecutor(
  overrides: Partial<SelectedWorkflowExecutor>
): SelectedWorkflowExecutor {
  return {
    login: "alice",
    run: () => {
      throw new Error("Unscripted selected workflow read");
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

function getRunDetail(
  repo: string,
  runId: number | string,
  executor: SelectedWorkflowExecutor
) {
  return observeWorkflowRun(
    { repo, runId },
    {
      readRun: (repo, runId) =>
        readWorkflowRun({ mode: "selected", executor }, repo, runId)
    }
  );
}
function fetchRunLog(
  repo: string,
  runId: number | string,
  executor: SelectedWorkflowExecutor
) {
  return readWorkflowLog({ mode: "selected", executor }, repo, runId);
}
describe("selected-account workflow reads", () => {
  it.each([
    ["gh: Forbidden (HTTP 403)", 403],
    [
      "Resource protected by organization SAML enforcement. You must grant your OAuth token access.",
      403
    ]
  ])(
    "classifies direct selected-account command authorization failure %j",
    async (stderr, status) => {
      const executor = successfulSelectedGhExecutor({ login: "alice" });

      await expect(
        selectedCommandAuthorizationError(executor, "contoso/store", {
          code: 1,
          stdout: "",
          stderr
        })
      ).resolves.toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
    }
  );
});

describe("workflow execution failure boundaries", () => {
  it("keeps returned rate-limit responses pollable and returned masked 404 authorization explicit", async () => {
    for (const stderr of ["HTTP 429", "HTTP 403 Retry-After: 60"]) {
      const executor = successfulSelectedGhExecutor({
        run: async () => ({ code: 1, stdout: "", stderr })
      });
      expect(
        await selectedWorkflowJson(executor, "org/app", ["run", "view", "41"])
      ).toEqual({ state: "fallback" });
    }
    const executor = successfulSelectedGhExecutor({
      run: async () => ({ code: 1, stdout: "", stderr: "HTTP 404" })
    });
    await expect(
      selectedWorkflowJson(executor, "org/app", ["run", "view", "41"])
    ).rejects.toMatchObject({ status: 404 });
  });
  const repo = "org/app";
  const apiArgs = ["api", "repos/org/app", "--jq", ".full_name"];
  const commandArgs = [
    "run",
    "view",
    "41",
    "--json",
    "status,conclusion,jobs",
    "--repo",
    repo
  ];
  const logArgs = ["run", "view", "41", "--log", "--repo", repo];
  type Result = { code: number; stdout: string; stderr: string };
  const failed = (stderr: string, stdout = ""): Result => ({
    code: 1,
    stderr,
    stdout
  });
  const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: "" });
  function scripted(
    responses: (Result | Error)[],
    commands: string[][]
  ): SelectedWorkflowExecutor {
    let index = 0;
    return successfulSelectedGhExecutor({
      run: async (args) => {
        expect(args).toEqual(commands[index]);
        const response = responses[index++];
        if (!response) throw new Error("Unscripted command");
        if (response instanceof Error) throw response;
        return response;
      }
    });
  }

  it.each([
    [ok(""), null],
    [failed("ordinary failure"), null],
    [failed("", "HTTP 401"), 401],
    [failed("HTTP 403\nRetry-After: 60"), null],
    [failed("HTTP 404"), 404]
  ])(
    "classifies command authorization without treating generic errors as identity loss: %j",
    async (result, status) => {
      const executor = scripted([failed("HTTP 404")], [apiArgs]);
      const error = await selectedCommandAuthorizationError(
        executor,
        repo,
        result
      );
      if (status) expect(error).toMatchObject({ login: "alice", status });
      else expect(error).toBeNull();
    }
  );

  it.each([
    "HTTP 429",
    "HTTP 403\nRetry-After: 3",
    "X-RateLimit-Remaining: 0",
    "secondary rate limit",
    "API rate limit exceeded",
    "rate limit reached; try again after reset"
  ])("recognizes rate evidence as strings and errors: %s", (text) => {
    expect(isGitHubRateLimitError(text)).toBe(true);
    expect(isGitHubRateLimitError(new Error(text))).toBe(true);
    expect(isGitHubRateLimitError("ordinary")).toBe(false);
  });

  it("retains the authorization constructor and empty-detail message", () => {
    const error = new SelectedGhAuthorizationError("alice", 401, "");
    expect(error.message).toBe(
      "GitHub rejected @alice while reading workflow state (HTTP 401)."
    );
    expect(isSelectedGhAuthorizationError(error)).toBe(true);
    expect(isSelectedGhAuthorizationError(new Error(error.message))).toBe(
      false
    );
  });

  it.each(["json", "log"] as const)(
    "preserves identity and unexpected rejection in %s reads",
    async (kind) => {
      for (const error of [
        new SelectedGhAuthorizationError("alice", 403, "denied"),
        new Error("network unavailable"),
        new Error("HTTP 403\nRetry-After: 60")
      ]) {
        const executor = scripted(
          [error],
          [kind === "json" ? commandArgs : logArgs]
        );
        const attempt =
          kind === "json" ?
            selectedWorkflowJson(executor, repo, commandArgs)
          : fetchRunLog(repo, 41, executor);
        await expect(attempt).rejects.toBe(error);
      }
      for (const detail of [
        "HTTP 401",
        "HTTP 403",
        "grant your OAuth token access"
      ]) {
        const executor = scripted(
          [new Error(detail)],
          [kind === "json" ? commandArgs : logArgs]
        );
        const attempt =
          kind === "json" ?
            selectedWorkflowJson(executor, repo, commandArgs)
          : fetchRunLog(repo, 41, executor);
        await expect(attempt).rejects.toMatchObject({
          login: "alice",
          status: detail === "HTTP 401" ? 401 : 403
        });
      }
    }
  );

  it.each(["json", "log"] as const)(
    "probes masked rejected 404s and retains best-effort repository distinctions for %s",
    async (kind) => {
      for (const response of [
        ok(repo),
        failed("ordinary"),
        failed("HTTP 429"),
        failed("HTTP 401"),
        failed("", "HTTP 403"),
        failed("HTTP 404"),
        new Error("HTTP 401"),
        new Error("HTTP 403"),
        new Error("HTTP 404"),
        new Error("HTTP 403 Retry-After: 60"),
        new Error("HTTP 429"),
        new Error("ordinary"),
        new SelectedGhAuthorizationError("alice", 404, "lost access")
      ]) {
        const executor = scripted(
          [new Error("HTTP 404"), response],
          [kind === "json" ? commandArgs : logArgs, apiArgs]
        );
        const attempt =
          kind === "json" ?
            selectedWorkflowJson(executor, repo, commandArgs)
          : fetchRunLog(repo, 41, executor);
        const detail =
          response instanceof Error ?
            response.message
          : response.stderr || response.stdout;
        if (
          /HTTP (401|403|404)/.test(detail) &&
          !detail.includes("Retry-After")
        ) {
          await expect(attempt).rejects.toBeInstanceOf(
            SelectedGhAuthorizationError
          );
        } else {
          expect(await attempt).toEqual(
            kind === "json" ? { state: "missing" } : null
          );
        }
      }
    }
  );

  it("reads authorization evidence from JSON stdout but never from log stdout", async () => {
    const json = scripted([failed("", "HTTP 401")], [commandArgs]);
    await expect(
      selectedWorkflowJson(json, repo, commandArgs)
    ).rejects.toMatchObject({ status: 401 });
    const log = scripted([failed("", "HTTP 401")], [logArgs]);
    expect(await fetchRunLog(repo, 41, log)).toBeNull();
  });

  it("does not retry status-only missing or malformed evidence", async () => {
    for (const final of ["null", "[]", "{}"]) {
      const executor = scripted(
        [ok("[]"), ok(final)],
        [
          commandArgs,
          ["run", "view", "41", "--json", "status,conclusion", "--repo", repo]
        ]
      );
      const result = await getRunDetail(repo, 41, executor);
      expect(result).toEqual(
        final === "{}" ?
          { status: undefined, conclusion: undefined, jobs: [], steps: [] }
        : null
      );
    }
  });

  it("returns null for an empty ambient log and propagates unexpected runner throws", async () => {
    expect(
      await readWorkflowLog(
        { mode: "ambient", run: async () => ok("") },
        repo,
        41
      )
    ).toBeNull();
    const error = new Error("runner unavailable");
    const execution = {
      mode: "ambient" as const,
      run: () => Promise.reject(error)
    };
    await expect(readWorkflowLog(execution, repo, 41)).rejects.toBe(error);
    await expect(readWorkflowRun(execution, repo, 41)).rejects.toBe(error);
  });
});

describe("selected-account workflow reads", () => {
  it("does not classify rate limiting as selected-account authorization failure", async () => {
    const executor = successfulSelectedGhExecutor({ login: "alice" });

    await expect(
      selectedCommandAuthorizationError(executor, "contoso/store", {
        code: 1,
        stdout: "",
        stderr: "gh: Too Many Requests (HTTP 429)"
      })
    ).resolves.toBeNull();
  });

  it.each([["run detail", 403, "gh: Forbidden (HTTP 403)", "detail"]])(
    "surfaces %s HTTP %i instead of degrading to pending",
    async (_label, status, stderr, _operation) => {
      const calls: string[][] = [];
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: async (args) => {
          calls.push(args);
          return { code: 1, stdout: "", stderr };
        }
      });

      const attempt = getRunDetail("contoso/store", "41", executor);

      const error = await attempt.catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
      expect(isSelectedGhAuthorizationError(error)).toBe(true);
      expect(calls).toHaveLength(1);
    }
  );

  it("keeps a not-yet-visible run detail pending when the selected account still reads the repository", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return args[0] === "api" ?
            { code: 0, stdout: "contoso/store", stderr: "" }
          : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
    });

    await expect(
      getRunDetail("contoso/store", "41", executor)
    ).resolves.toBeNull();
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
  });

  it.each([["run detail", 403, "detail"]])(
    "surfaces rejected selected-account %s identity check HTTP %i",
    async (_label, status, _operation) => {
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: () =>
          Promise.reject(
            new Error(
              `GitHub identity verification failed for @alice: gh: access rejected (HTTP ${status})`
            )
          )
      });

      const attempt = getRunDetail("contoso/store", "41", executor);
      const error = await attempt.catch((reason: unknown) => reason);

      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
    }
  );

  it("keeps transient selected-account run detail pollable after its fallback", async () => {
    let calls = 0;
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => {
        calls += 1;
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Service Unavailable (HTTP 503)"
        };
      }
    });

    await expect(
      getRunDetail("contoso/store", "41", executor)
    ).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it("surfaces selected-account authorization failure while reading a failed run log", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Unauthorized (HTTP 401)"
      })
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 401
    });
  });

  it("does not read workflow log stdout as a GitHub authorization failure", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "curl failed against a service endpoint (HTTP 403)",
        stderr: "gh: could not retrieve the workflow log"
      })
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).resolves.toBeNull();
  });

  it("keeps transient selected-account run log failure pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).resolves.toBeNull();
  });

  it("terminalizes a selected-account log 404 when the repository probe also loses access", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)"
        };
      }
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 404
    });
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
  });

  it("keeps a missing selected-account log ordinary when the repository probe succeeds", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return args[0] === "api" ?
            { code: 0, stdout: "contoso/store", stderr: "" }
          : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).resolves.toBeNull();
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
  });

  it.each([
    ["returns the selected-account run log", "workflow log", "workflow log"],
    ["treats an empty selected-account run log as unavailable", "", null]
  ])("%s", async (_label, stdout, expected) => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({ code: 0, stdout, stderr: "" })
    });

    await expect(fetchRunLog("contoso/store", "41", executor)).resolves.toBe(
      expected
    );
  });
});
