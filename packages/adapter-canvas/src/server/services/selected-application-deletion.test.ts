import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SelectedGhExecutor } from "../../gh.js";
import { generateDeleteWorkflow } from "../../infra.js";
import { createApplicationDeletionTool } from "../../runtime/application-deletion-tool.js";
import type { ApplicationDeletionDependencies } from "./application-deletion.js";
import { createSelectedApplicationDeletion } from "./selected-application-deletion.js";

const request = {
  repo: "octo/app",
  environment: "dev",
  application: "demo",
  runUrl: "https://github.com/octo/app/actions/runs/17",
  deploymentId: "42",
  force: false
};
const files = ["delete-application.yml", "delete-azure.yml"];
const sha = "a".repeat(40);
const historyPath = "/repos/octo/app/deployments?environment=dev&per_page=10";
const statusPath = "/repos/octo/app/deployments/42/statuses?per_page=1";
const refused = () => {
  throw new Error("Unexpected ambient dependency");
};
const readTemplate = (file: string) =>
  readFileSync(
    new URL(`../../../../../.github/extension/${file}`, import.meta.url),
    "utf8"
  );
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

async function fixture({
  force = false,
  dispatcherEnvironment = "dev",
  lookupCommand = "gh"
} = {}) {
  const templates = await generateDeleteWorkflow(dispatcherEnvironment, {
    readTemplate: async (_repo, path) =>
      readTemplate(path.slice(path.lastIndexOf("/") + 1))
  });
  let branchChanged = false;
  let credentialChanged = false;
  let isCurrent = true;
  let deploymentId = request.deploymentId;
  let active = false;
  let statusId = 100;
  let headId = 42;
  const run = vi.fn<SelectedGhExecutor["run"]>(async (args, options) => {
    options?.beforeExecute?.();
    if (args[0] === "workflow") return ok();
    if (args[0] === "run") return ok("[]");
    const path = args[1];
    if (path === historyPath) return ok(JSON.stringify([{ id: headId }]));
    if (path === statusPath)
      return ok(
        JSON.stringify([
          { id: statusId, state: "success", log_url: request.runUrl }
        ])
      );
    if (path === "/repos/octo/app") return ok("main");
    if (path === "/repos/octo/app/git/ref/heads/main")
      return ok(branchChanged ? "b".repeat(40) : sha);
    if (force && path.startsWith("/repos/octo/app/actions/runs/17/artifacts?"))
      return ok(
        'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"total_count":0,"artifacts":[]}'
      );
    const ref = path.split("?ref=")[1];
    const file = path.split("?")[0].split("/").pop() ?? "";
    if (path.includes("/repos/radius-project/ai-extensions/contents/"))
      return ok(Buffer.from(readTemplate(file)).toString("base64"));
    if (path.includes("/repos/octo/app/contents/.github/workflows/")) {
      expect(ref).toBe(sha);
      return ok(Buffer.from(templates[file] ?? "").toString("base64"));
    }
    if (path === "selected-lookup-test") return ok("selected");
    throw new Error(`Unexpected selected command: ${args.join(" ")}`);
  });
  const verifyIdentity = vi.fn(async () => {});
  const executor: SelectedGhExecutor = {
    login: "fixture-owner",
    requiresKeyringSwitch: false,
    credentialSource: "injected",
    scopes: ["workflow"],
    run,
    verifyIdentity,
    runOrThrow: refused,
    packageCredentials: refused,
    redact: (value) => value,
    errorMessage: String
  };
  const createExecutor = vi.fn(async () => ({
    ...executor,
    credentialSource:
      credentialChanged ? ("keyring" as const) : executor.credentialSource
  }));
  const release = vi.fn();
  const deletion: ApplicationDeletionDependencies = {
    id: () => "fixture",
    isValidRepoSlug: () => true,
    readInstanceEntry: refused,
    activeDeploymentMutation: () => undefined,
    localDeploymentBlocksMutation: () => false,
    reserveDeploymentMutation: () => ({
      repo: request.repo,
      environment: request.environment,
      kind: "delete",
      expiresAt: 30000
    }),
    releaseDeploymentMutation: release,
    captureDeletedDeployment: () => () => {},
    resolveEnvDeployment: refused,
    deploymentStatusBlocksMutation: (status) => status === "in_progress",
    probeDeleteConflict: refused,
    deployListCache: new Map(),
    deployListTtlMs: 15000,
    ensureWorkflowsCurrent: refused,
    deleteApplicationWorkflowFiles: files,
    findWorkflowRun: refused,
    runGh: refused,
    readProcessEnv: refused,
    setTimer: () => ({}),
    logError: refused
  };
  const prepare = createSelectedApplicationDeletion({
    createExecutor,
    awsEnabled: false,
    deletion,
    createLookup: (execute) => ({
      async resolveEnvDeployment() {
        const read = await new Promise<string>((resolve, reject) =>
          execute(
            lookupCommand,
            ["api", "selected-lookup-test"],
            { timeout: 1000 },
            (error, stdout) => (error ? reject(error) : resolve(stdout))
          )
        );
        expect(read).toBe("selected");
        return {
          app: request.application,
          environment: request.environment,
          deploymentId,
          runUrl: request.runUrl,
          provider: "azure",
          status:
            active ? "in_progress"
            : force ? "delete-failed"
            : "success",
          identity: { state: "known", application: request.application }
        };
      }
    })
  });
  return {
    run,
    verifyIdentity,
    release,
    createExecutor,
    changeHistoryHead: () => {
      headId = 43;
    },
    changeHistoryStatus: () => {
      statusId++;
    },
    prepare: (
      input: {
        login?: string;
        target?: Partial<typeof request>;
      } = {}
    ) =>
      prepare({
        login: input.login ?? executor.login,
        request: { ...request, force, ...input.target },
        isCurrent: () => isCurrent
      }),
    expire: () => {
      isCurrent = false;
    },
    changeCredential: () => {
      credentialChanged = true;
    },
    changeBranch: () => {
      branchChanged = true;
    },
    replaceDeployment: () => {
      deploymentId = "43";
    },
    activateDeployment: () => {
      active = true;
    }
  };
}

describe("selected application deletion", () => {
  it.each([
    {
      label: "a newer record ahead of the selection despite a lower ID",
      rows: '[{"id":7},{"id":42}]',
      message: "GitHub deployment 7"
    },
    { label: "missing history", rows: "[]", message: "could not be verified" },
    {
      label: "partial history",
      rows: '[{},{"id":42}]',
      message: "could not be verified"
    },
    {
      label: "malformed history",
      rows: '[{"id":42}',
      message: "could not be verified"
    }
  ])("does not ask for confirmation with $label", async ({ rows, message }) => {
    const f = await fixture();
    f.run.mockResolvedValueOnce(ok(rows));
    const confirm = vi.fn(async () => true);
    const tool = createApplicationDeletionTool({
      confirm,
      prepare: (target) => f.prepare({ target: { ...target, force: false } }),
      redact: (value) => value
    });
    const { force: _force, ...args } = request;
    await expect(
      tool.handler({ ...args, mode: "normal" })
    ).resolves.toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining(message)
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(f.run.mock.calls.map(([command]) => command[1])).toEqual([
      historyPath
    ]);
  });

  it("blocks an interleaved record before offering confirmation", async () => {
    const f = await fixture();
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing selected command fixture");
    f.run.mockImplementation(async (args, options) => {
      const result = await run(args, options);
      if (args[1] === statusPath) f.changeHistoryHead();
      return result;
    });
    await expect(f.prepare()).rejects.toThrow("GitHub deployment 43");
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual([
      historyPath,
      statusPath,
      historyPath
    ]);
  });

  it.each(["forbidden", "transport failure"])(
    "does not expose GitHub response details or prepare deletion after %s",
    async (failure) => {
      const f = await fixture();
      if (failure === "forbidden")
        f.run.mockResolvedValueOnce({
          code: 1,
          stdout: "",
          stderr: "private diagnostic"
        });
      else f.run.mockRejectedValueOnce(new Error("private diagnostic"));
      await expect(f.prepare()).rejects.toThrow(
        /^GitHub deployment history could not be verified\. No deletion was started\.$/
      );
      expect(f.run).toHaveBeenCalledOnce();
    }
  );

  it.each([
    {
      label: "the fallback job URL",
      status: {
        id: 100,
        state: "success",
        log_url: "",
        target_url: `${request.runUrl}/job/31`
      },
      allowed: true
    },
    {
      label: "an active deployment",
      status: { id: 100, state: "in_progress", log_url: request.runUrl },
      allowed: false
    },
    {
      label: "a different run",
      status: { id: 100, state: "success", log_url: `${request.runUrl}9` },
      allowed: false
    },
    {
      label: "an unversioned status",
      status: { state: "success", log_url: request.runUrl },
      allowed: false
    },
    {
      label: "a missing status state",
      status: { id: 100, log_url: request.runUrl },
      allowed: false
    }
  ])(
    "checks terminal status evidence with $label",
    async ({ status, allowed }) => {
      const f = await fixture();
      f.run
        .mockResolvedValueOnce(ok('[{"id":42},{"id":7}]'))
        .mockResolvedValueOnce(ok(JSON.stringify([status])));
      if (allowed) await expect(f.prepare()).resolves.toHaveProperty("execute");
      else await expect(f.prepare()).rejects.toThrow("could not be verified");
    }
  );

  it("will not run a non-GitHub command with the selected credential", async () => {
    const f = await fixture({ lookupCommand: "rad" });
    const scope = await f.prepare();
    f.run.mockClear();
    await expect(scope.execute()).resolves.toMatchObject({
      status: 503,
      body: { error: expect.stringContaining("current deployment state") }
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("refuses a deployment that became active while verifying the workflow", async () => {
    const f = await fixture();
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing selected command fixture");
    f.run.mockImplementation(async (args, options) => {
      if (args[1]?.startsWith("/repos/octo/app/contents/"))
        f.activateDeployment();
      return run(args, options);
    });
    const scope = await f.prepare();
    await expect(scope.execute()).resolves.toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("changed before dispatch") }
    });
    expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
      false
    );
  });

  it.each(["canonical template is missing", "dispatcher default is malformed"])(
    "refuses dispatch when the %s",
    async (failure) => {
      const f = await fixture();
      const run = f.run.getMockImplementation();
      if (!run) throw new Error("Missing selected command fixture");
      f.run.mockImplementation(async (args, options) => {
        const result = await run(args, options);
        if (
          failure === "canonical template is missing" &&
          args[1]?.includes("/repos/radius-project/ai-extensions/contents/")
        )
          return { code: 1, stdout: "", stderr: "HTTP 404" };
        if (
          failure === "dispatcher default is malformed" &&
          args[1]?.includes(
            "/repos/octo/app/contents/.github/workflows/delete-application.yml"
          )
        )
          return ok(
            Buffer.from(
              Buffer.from(result.stdout, "base64")
                .toString("utf8")
                .replace("default: 'dev'", "default: dev")
            ).toString("base64")
          );
        return result;
      });
      const scope = await f.prepare();
      await expect(scope.execute()).resolves.toMatchObject({
        status: 400,
        body: {
          error: expect.stringMatching(
            /canonical deletion template|missing or outdated/
          )
        }
      });
      expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
        false
      );
    }
  );
  it("accepts a canonical dispatcher written for another environment and explicitly targets this one", async () => {
    const f = await fixture({ dispatcherEnvironment: "production" });
    const scope = await f.prepare();
    await expect(scope.execute()).resolves.toMatchObject({ status: 200 });
    expect(
      f.run.mock.calls.find(([args]) => args[0] === "workflow")?.[0]
    ).toContain("environment=dev");
  });

  it("refuses a deployment replaced while verifying workflow files", async () => {
    const f = await fixture();
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing selected command fixture");
    f.run.mockImplementation(async (args, options) => {
      if (args[1]?.includes("/contents/.github/workflows/"))
        f.replaceDeployment();
      return run(args, options);
    });
    const scope = await f.prepare();
    await expect(scope.execute()).resolves.toMatchObject({
      status: 400,
      body: {
        error: expect.stringContaining("deployment changed before dispatch")
      }
    });
    expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
      false
    );
  });

  it.each([
    [{ login: "not an account" }, "valid GitHub login"],
    [{ target: { deploymentId: "" } }, "exact Radius deployment"],
    [{ target: { runUrl: "" } }, "exact Radius deployment"],
    [
      { target: { runUrl: "https://github.com/octo/other/actions/runs/17" } },
      "exact Radius deployment"
    ]
  ] as const)(
    "refuses unsafe preparation before accessing GitHub (%j)",
    async (input, reason) => {
      const f = await fixture();
      await expect(f.prepare(input)).rejects.toThrow(reason);
      expect(f.createExecutor).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it("confirms the same account twice and uses it for lookup, exact workflow verification, dispatch, and discovery", async () => {
    const f = await fixture();
    const scope = await f.prepare();
    expect(scope.login).toBe("fixture-owner");
    expect(f.verifyIdentity).toHaveBeenCalledOnce();
    expect(f.run.mock.calls.map(([args]) => args[1])).toEqual([
      historyPath,
      statusPath,
      historyPath
    ]);
    await expect(scope.execute()).resolves.toMatchObject({ status: 200 });
    expect(f.createExecutor.mock.calls).toEqual([
      ["fixture-owner"],
      ["fixture-owner"]
    ]);
    expect(f.verifyIdentity).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "workflow",
        "run",
        "delete-application.yml",
        "--repo",
        request.repo,
        "approved_deployment_id=42",
        "approved_run_id=17",
        "--ref",
        "main"
      ]),
      expect.objectContaining({ beforeExecute: expect.any(Function) })
    );
    expect(f.run).toHaveBeenCalledWith(
      expect.arrayContaining([
        "run",
        "list",
        "--workflow=delete-application.yml"
      ]),
      expect.any(Object)
    );
    await expect(scope.execute()).rejects.toThrow("already used");
    expect(f.release).not.toHaveBeenCalled();
  });

  it.each(["credential changed", "authorization expired"] as const)(
    "refuses to execute after %s",
    async (reason) => {
      const f = await fixture();
      const scope = await f.prepare();
      f.run.mockClear();
      if (reason === "credential changed") f.changeCredential();
      else f.expire();
      await expect(scope.execute()).rejects.toThrow(reason);
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it("refuses a different acting account after confirmation", async () => {
    const f = await fixture();
    const scope = await f.prepare();
    const executor = await f.createExecutor.mock.results[0].value;
    f.createExecutor.mockResolvedValueOnce({
      ...executor,
      login: "different-owner"
    });
    f.run.mockClear();
    await expect(scope.execute()).rejects.toThrow("does not match");
    expect(f.verifyIdentity).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["command failure", "executor rejection"] as const)(
    "cannot delete when deployment lookup encounters a selected %s",
    async (failure) => {
      const f = await fixture();
      const scope = await f.prepare();
      f.run.mockClear();
      f.run.mockImplementationOnce(async () => {
        if (failure === "executor rejection")
          throw new Error("Selected account became unavailable");
        return { code: 1, stdout: "", stderr: "Selected account denied" };
      });
      await expect(scope.execute()).resolves.toMatchObject({
        status: 503,
        body: { error: expect.stringContaining("current deployment state") }
      });
      expect(f.run).toHaveBeenCalledExactlyOnceWith(
        ["api", "selected-lookup-test"],
        expect.objectContaining({ beforeExecute: expect.any(Function) })
      );
      expect(f.release).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ["/repos/octo/app", "", "Could not determine the default branch"],
    [
      "/repos/octo/app/git/ref/heads/main",
      "unknown",
      "Could not verify the default branch revision"
    ]
  ])(
    "refuses deletion when %s cannot establish a pinned workflow revision",
    async (path, output, diagnostic) => {
      const f = await fixture();
      const run = f.run.getMockImplementation();
      if (!run) throw new Error("Missing selected command fixture");
      f.run.mockImplementation(async (args, options) => {
        if (args[1] === path) return ok(output);
        return run(args, options);
      });
      const scope = await f.prepare();
      await expect(scope.execute()).resolves.toMatchObject({
        status: 400,
        body: { error: expect.stringContaining(diagnostic) }
      });
      expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
        false
      );
      expect(f.release).toHaveBeenCalledOnce();
    }
  );

  it("checks force evidence under the selected account and refuses when the failed run has no result", async () => {
    const f = await fixture({ force: true });
    const scope = await f.prepare();
    f.run.mockClear();
    await expect(scope.execute()).resolves.toMatchObject({
      status: 409,
      body: { error: expect.stringContaining("no longer has") }
    });
    expect(f.run.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ["api", "selected-lookup-test"],
      ["api", "selected-lookup-test"],
      [
        "api",
        expect.stringContaining("/repos/octo/app/actions/runs/17/artifacts?")
      ]
    ]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["head", "status"] as const)(
    "refuses dispatch and releases the reservation when the raw %s changes after confirmation",
    async (changed) => {
      const f = await fixture();
      const scope = await f.prepare();
      if (changed === "head") f.changeHistoryHead();
      else f.changeHistoryStatus();
      await expect(scope.execute()).resolves.toMatchObject({
        status: 400,
        body: {
          error: expect.stringContaining(
            changed === "head" ?
              "GitHub deployment 43"
            : "history changed after confirmation"
          )
        }
      });
      expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
        false
      );
      expect(f.release).toHaveBeenCalledOnce();
    }
  );

  it("refuses workflow drift and does not try ambient dispatch", async () => {
    const f = await fixture();
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing selected command fixture");
    f.run.mockImplementation(async (args, options) => {
      if (
        args[1]?.startsWith(
          "/repos/octo/app/contents/.github/workflows/delete-azure.yml"
        )
      )
        return ok(Buffer.from("outdated").toString("base64"));
      return run(args, options);
    });
    const scope = await f.prepare();
    await expect(scope.execute()).resolves.toMatchObject({
      status: 400,
      body: {
        error: expect.stringContaining(
          "delete-azure.yml is missing or outdated"
        )
      }
    });
    expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
      false
    );
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("refuses to dispatch if the approved workflow branch moves after read-back", async () => {
    const f = await fixture();
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("Missing selected command fixture");
    f.run.mockImplementation(async (args, options) => {
      const result = await run(args, options);
      if (
        args[1]?.startsWith(
          "/repos/octo/app/contents/.github/workflows/delete-azure.yml"
        )
      )
        f.changeBranch();
      return result;
    });
    const scope = await f.prepare();
    await expect(scope.execute()).resolves.toMatchObject({
      status: 400,
      body: { error: expect.stringContaining("default branch changed") }
    });
    expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
      false
    );
    expect(f.release).toHaveBeenCalledOnce();
  });
});
