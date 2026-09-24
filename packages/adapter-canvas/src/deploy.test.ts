import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  explainNoSubscriptions,
  cloudCredentialsComplete,
  explainRepoAccessForEnvSetup,
  isRepoNotFoundError,
  findWorkflowRun,
  fetchRunLog,
  getRunDetail,
  isSelectedGhAuthorizationError,
  selectWorkflowRunId
} from "./deploy.js";
import * as gh from "./gh.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "./repository-access-guidance.js";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";

describe("ambient workflow callback binding", () => {
  beforeEach(() => {
    vi.spyOn(gh, "cliExec").mockImplementation(() => {
      throw new Error("Unexpected ambient CLI invocation");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const detailArgs = [
    "run",
    "view",
    "41",
    "--json",
    "status,conclusion,jobs",
    "--repo",
    "contoso/store"
  ];
  const statusArgs = [
    "run",
    "view",
    "41",
    "--json",
    "status,conclusion",
    "--repo",
    "contoso/store"
  ];

  it("reads and normalizes ambient run details from callback stdout", async () => {
    const steps = [
      { name: "Deploy", status: "completed", conclusion: "failure" }
    ];
    const jobs = [{ steps }];
    vi.mocked(gh.cliExec).mockImplementationOnce((_cmd, _args, _opts, cb) => {
      queueMicrotask(() =>
        cb(
          null,
          JSON.stringify({ status: "completed", conclusion: "failure", jobs }),
          "diagnostic stderr is not run JSON"
        )
      );
      return new ChildProcess();
    });

    await expect(getRunDetail("contoso/store", 41)).resolves.toEqual({
      status: "completed",
      conclusion: "failure",
      jobs,
      steps
    });
    expect(gh.cliExec).toHaveBeenCalledExactlyOnceWith(
      "gh",
      detailArgs,
      { timeout: 15000 },
      expect.any(Function)
    );
  });

  it("ignores partial stdout on callback failure and reads status-only fallback", async () => {
    vi.mocked(gh.cliExec)
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        queueMicrotask(() =>
          cb(
            new Error("detail read failed"),
            '{"status":"completed","conclusion":"success"}',
            "gh: Forbidden (HTTP 403)"
          )
        );
        return new ChildProcess();
      })
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        queueMicrotask(() =>
          cb(null, '{"status":"in_progress","conclusion":null}', "")
        );
        return new ChildProcess();
      });

    await expect(getRunDetail("contoso/store", "41")).resolves.toEqual({
      status: "in_progress",
      conclusion: null,
      jobs: [],
      steps: []
    });
    expect(
      vi.mocked(gh.cliExec).mock.calls.map((call) => call.slice(0, 3))
    ).toEqual([
      ["gh", detailArgs, { timeout: 15000 }],
      ["gh", statusArgs, { timeout: 15000 }]
    ]);
  });

  it("returns unavailable detail when both callbacks fail without a selected-account probe", async () => {
    const fail: typeof gh.cliExec = (_cmd, _args, _opts, cb) => {
      queueMicrotask(() =>
        cb(
          new Error("run unavailable"),
          '{"status":"completed","conclusion":"success"}',
          "gh: Not Found (HTTP 404)"
        )
      );
      return new ChildProcess();
    };
    vi.mocked(gh.cliExec)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail);

    await expect(getRunDetail("contoso/store", "41")).resolves.toBeNull();
    expect(
      vi.mocked(gh.cliExec).mock.calls.map((call) => call.slice(0, 3))
    ).toEqual([
      ["gh", detailArgs, { timeout: 15000 }],
      ["gh", statusArgs, { timeout: 15000 }]
    ]);
  });

  it.each([
    {
      name: "preserves successful log stdout",
      error: null,
      stdout: "  workflow output: HTTP 401\n",
      stderr: "CLI warning",
      expected: "  workflow output: HTTP 401\n"
    },
    {
      name: "returns unavailable for empty stdout",
      error: null,
      stdout: "",
      stderr: "stderr is not workflow output",
      expected: null
    },
    {
      name: "discards partial stdout on callback error",
      error: new Error("log read failed"),
      stdout: "partial workflow output",
      stderr: "gh: Not Found (HTTP 404)",
      expected: null
    }
  ])(
    "$name without a selected-account probe",
    async ({ error, stdout, stderr, expected }) => {
      vi.mocked(gh.cliExec).mockImplementationOnce((_cmd, _args, _opts, cb) => {
        queueMicrotask(() => cb(error, stdout, stderr));
        return new ChildProcess();
      });

      await expect(fetchRunLog("contoso/store", 41)).resolves.toBe(expected);
      expect(gh.cliExec).toHaveBeenCalledExactlyOnceWith(
        "gh",
        ["run", "view", "41", "--log", "--repo", "contoso/store"],
        { timeout: 30000, maxBuffer: 20 * 1024 * 1024 },
        expect.any(Function)
      );
    }
  );
});

describe("selected-account workflow discovery", () => {
  it.each([["run discovery", 401, "gh: Unauthorized (HTTP 401)", "list"]])(
    "surfaces %s HTTP %i instead of degrading to pending",
    async (_label, status, stderr, operation) => {
      const calls: string[][] = [];
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: async (args) => {
          calls.push(args);
          return { code: 1, stdout: "", stderr };
        }
      });

      const attempt =
        operation === "list" ?
          findWorkflowRun(
            "contoso/store",
            "verify.yml",
            Date.now(),
            null,
            executor
          )
        : getRunDetail("contoso/store", "41", executor);

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

  it("keeps transient selected-account run discovery pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
  });

  it.each([
    ["retry-after", "gh: Forbidden (HTTP 403)\nRetry-After: 60"],
    [
      "exhausted primary limit",
      "gh: API rate limit exceeded (HTTP 403)\nX-RateLimit-Remaining: 0"
    ],
    [
      "secondary limit",
      "gh: You have exceeded a secondary rate limit (HTTP 403)"
    ],
    [
      "reset guidance",
      "gh: rate limit reached (HTTP 403); retry when the limit resets"
    ],
    ["too many requests", "gh: Too Many Requests (HTTP 429)"]
  ])("keeps selected-account %s responses pollable", async (_label, stderr) => {
    let calls = 0;
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr };
      }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("terminalizes a masked private-repository 404 after the selected account loses repository access", async () => {
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
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 404
    });
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
    expect(calls[1]).toEqual([
      "api",
      "repos/contoso/store",
      "--jq",
      ".full_name"
    ]);
  });

  it("keeps a masked run 404 pending when its repository probe is rate-limited", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) =>
        args[0] === "api" ?
          {
            code: 1,
            stdout: "",
            stderr:
              "gh: You have exceeded a secondary rate limit (HTTP 403)\nRetry-After: 60"
          }
        : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
  });

  it.each([["run discovery", 401, "list"]])(
    "surfaces rejected selected-account %s identity check HTTP %i",
    async (_label, status, operation) => {
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: () =>
          Promise.reject(
            new Error(
              `GitHub identity verification failed for @alice: gh: access rejected (HTTP ${status})`
            )
          )
      });

      const attempt =
        operation === "list" ?
          findWorkflowRun(
            "contoso/store",
            "verify.yml",
            Date.now(),
            null,
            executor
          )
        : getRunDetail("contoso/store", "41", executor);
      const error = await attempt.catch((reason: unknown) => reason);

      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
    }
  );

  it("leaves a rejected transient selected-account identity check pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: () =>
        Promise.reject(
          new Error(
            "GitHub identity verification failed for @alice: gh: Service Unavailable (HTTP 503)"
          )
        )
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).rejects.toThrow("HTTP 503");
  });
});

describe("explainNoSubscriptions", () => {
  // The exact failure azure/login prints when the identity has no visible
  // subscription (issue #219).
  const NO_SUBS_LOG =
    "Running Azure CLI Login.\n" +
    "Error: No subscriptions found for ***.\n" +
    "Error: Login failed with Error: The process '/usr/bin/az' failed with exit code 1.";

  it("explains the no-subscriptions Azure Login failure and points at a role assignment", () => {
    const out = explainNoSubscriptions(NO_SUBS_LOG);
    expect(out).not.toBe("");
    expect(out.toLowerCase()).toContain("no subscriptions");
    // Actionable: name the role and the subscription scope.
    expect(out).toContain("Contributor");
    expect(out.toLowerCase()).toContain("role");
    expect(out.toLowerCase()).toContain("subscription");
  });

  it("returns '' for an unrelated error", () => {
    expect(explainNoSubscriptions("some unrelated error: forbidden")).toBe("");
  });

  it("returns '' for empty / undefined / null input", () => {
    expect(explainNoSubscriptions("")).toBe("");
    expect(explainNoSubscriptions(undefined)).toBe("");
    expect(explainNoSubscriptions(null)).toBe("");
  });
});

describe("cloudCredentialsComplete", () => {
  // Regression for #219: the create-environment handler must NOT dispatch the
  // verify-credentials workflow when the identifying cloud credentials are
  // absent, because the run would only fail at the cloud-login step.
  it("requires clientId, tenantId, and subscriptionId for Azure", () => {
    expect(
      cloudCredentialsComplete("azure", {
        clientId: "c",
        tenantId: "t",
        subscriptionId: "s"
      })
    ).toBe(true);
    expect(
      cloudCredentialsComplete("azure", { clientId: "c", tenantId: "t" })
    ).toBe(false);
    expect(
      cloudCredentialsComplete("azure", {
        clientId: "c",
        tenantId: "t",
        subscriptionId: ""
      })
    ).toBe(false);
    expect(cloudCredentialsComplete("azure", {})).toBe(false);
  });

  it("ignores a role ARN when the provider is Azure", () => {
    expect(
      cloudCredentialsComplete("azure", { roleArn: "arn:aws:iam::x" })
    ).toBe(false);
  });

  it("requires the role ARN for AWS (and ignores Azure fields)", () => {
    expect(
      cloudCredentialsComplete("aws", { roleArn: "arn:aws:iam::123:role/r" })
    ).toBe(true);
    expect(cloudCredentialsComplete("aws", { roleArn: "" })).toBe(false);
    expect(cloudCredentialsComplete("aws", {})).toBe(false);
    expect(
      cloudCredentialsComplete("aws", {
        clientId: "c",
        tenantId: "t",
        subscriptionId: "s"
      })
    ).toBe(false);
  });
});

describe("explainRepoAccessForEnvSetup", () => {
  it("read failure with a known login → switch-account guidance", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: true,
      permissions: null
    });
    expect(out).not.toBe("");
    expect(out).toContain("ryanwaite");
    expect(out).toContain("azure-cto/app");
    expect(out).toContain("gh auth switch");
    expect(out).toContain(FORK_REPOSITORY_SETUP_GUIDANCE);
  });

  it("uses the bundled GitHub CLI path in switch-account guidance", () => {
    const out = explainRepoAccessForEnvSetup(
      {
        repo: "azure-cto/app",
        login: "ryanwaite",
        readFailed: true,
        permissions: null
      },
      {
        kind: "absolute",
        shell: "powershell",
        executablePath: "C:\\Copilot Tools\\gh.exe",
        installationNote: "Install GitHub CLI system-wide."
      }
    );

    expect(out).toContain(
      "& 'C:\\Copilot Tools\\gh.exe' auth switch --user <account>"
    );
    expect(out).toContain("Install GitHub CLI system-wide.");
  });

  it("read failure with unknown login → 'the active gh account'", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "",
      readFailed: true,
      permissions: null
    });
    expect(out).toContain("the active gh account");
  });

  it("admin access → '' (no error)", () => {
    expect(
      explainRepoAccessForEnvSetup({
        repo: "azure-cto/app",
        login: "ryanwaite",
        readFailed: false,
        permissions: { admin: true }
      })
    ).toBe("");
  });

  it("maintain-only → Admin-needed message naming the Maintain role, no switch guidance", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite_microsoft",
      readFailed: false,
      permissions: { admin: false, maintain: true, push: true }
    });
    expect(out).toContain("Admin");
    expect(out).toContain("Maintain");
    expect(out).toContain("grant");
    expect(out).not.toContain("gh auth switch");
    expect(out).toContain(FORK_REPOSITORY_SETUP_GUIDANCE);
  });

  it("push-only → role label Write", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: false,
      permissions: { admin: false, maintain: false, push: true }
    });
    expect(out).toContain("Write");
  });

  it("pull-only → role label Read", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: false,
      permissions: { admin: false, pull: true }
    });
    expect(out).toContain("Read");
  });

  it("null permissions with read OK (odd edge) → non-empty, role undetermined, no throw", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: false,
      permissions: null
    });
    expect(out).not.toBe("");
    expect(out).not.toContain("no direct");
    expect(out).toContain("does not have Admin");
    expect(out).toContain("could not be determined");
  });

  it("admin missing with empty login → addresses 'you'", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "",
      readFailed: false,
      permissions: { admin: false, pull: true }
    });
    expect(out).toContain("you");
  });
});

describe("isRepoNotFoundError", () => {
  it("is true for gh's Not Found (HTTP 404) text", () => {
    expect(isRepoNotFoundError("gh: Not Found (HTTP 404)")).toBe(true);
  });
  it("is true for a bare HTTP 404", () => {
    expect(isRepoNotFoundError("request failed: HTTP 404")).toBe(true);
  });
  it("is true for a lowercase 'not found' phrase", () => {
    expect(isRepoNotFoundError("the repository was not found")).toBe(true);
  });
  it("is false for HTTP 403", () => {
    expect(isRepoNotFoundError("gh: Forbidden (HTTP 403)")).toBe(false);
  });
  it("is false for a timeout / transient error", () => {
    expect(isRepoNotFoundError("dial tcp: i/o timeout")).toBe(false);
  });
  it("is false for empty / undefined / null", () => {
    expect(isRepoNotFoundError("")).toBe(false);
    expect(isRepoNotFoundError(undefined)).toBe(false);
    expect(isRepoNotFoundError(null)).toBe(false);
  });
});

describe("selectWorkflowRunId", () => {
  const at = (iso: string) => Date.parse(iso);
  const since = at("2026-08-20T10:00:00Z");

  it("returns null for a non-array payload", () => {
    expect(selectWorkflowRunId(null, since)).toBeNull();
    expect(selectWorkflowRunId({}, since)).toBeNull();
  });

  it("picks the newest run created within the skew window", () => {
    const runs = [
      { databaseId: 3, createdAt: "2026-08-20T10:00:05Z" },
      { databaseId: 2, createdAt: "2026-08-20T09:59:59Z" }
    ];
    expect(selectWorkflowRunId(runs, since)).toBe(3);
  });

  it("ignores stale runs created before the ~60s cutoff", () => {
    const runs = [{ databaseId: 9, createdAt: "2026-08-20T09:58:00Z" }];
    expect(selectWorkflowRunId(runs, since)).toBeNull();
  });

  it("tolerates ~60s of clock skew before dispatch", () => {
    const runs = [{ databaseId: 7, createdAt: "2026-08-20T09:59:10Z" }];
    expect(selectWorkflowRunId(runs, since)).toBe(7);
  });

  it("matches only the run whose display title carries the correlation id", () => {
    const runs = [
      {
        databaseId: 5,
        createdAt: "2026-08-20T10:00:06Z",
        displayTitle: "Radius - Delete Environment prod other-id"
      },
      {
        databaseId: 4,
        createdAt: "2026-08-20T10:00:04Z",
        displayTitle: "Radius - Delete Environment prod del-abc-123"
      }
    ];
    expect(selectWorkflowRunId(runs, since, "del-abc-123")).toBe(4);
  });

  it("returns null when no run carries the requested correlation id", () => {
    const runs = [
      {
        databaseId: 5,
        createdAt: "2026-08-20T10:00:06Z",
        displayTitle: "Radius - Delete Environment prod other-id"
      }
    ];
    expect(selectWorkflowRunId(runs, since, "del-missing")).toBeNull();
  });

  it("skips entries missing a databaseId", () => {
    const runs = [
      { createdAt: "2026-08-20T10:00:06Z" },
      { databaseId: 8, createdAt: "2026-08-20T10:00:05Z" }
    ];
    expect(selectWorkflowRunId(runs, since)).toBe(8);
  });
});
