import { describe, expect, it } from "vitest";
import {
  createDeployDispatchService,
  type DeployCommandOptions,
  type DeployCommandResult,
  type DeployDispatchDependencies
} from "./deploy-dispatch.js";
import type { BicepParam } from "../../bicep.js";
import type { CanvasState } from "../../shared.js";

const OK: DeployCommandResult = { code: 0, stdout: "", stderr: "" };

interface GhCall {
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

function dependencies(
  overrides: Partial<DeployDispatchDependencies> = {}
): DeployDispatchDependencies {
  return {
    deployWorkflowFile: "run-rad-commands.yml",
    deployWorkflowFiles: ["run-rad-commands.yml", "run-rad-commands-azure.yml"],
    branchNotPushedKind: "branch-not-pushed",
    getBranchHeadSha: () => Promise.resolve("sha-1"),
    getDefaultBranch: () => {
      throw new Error("getDefaultBranch not stubbed");
    },
    runGh: () => Promise.resolve(OK),
    runGhWithStdin: () => {
      throw new Error("runGhWithStdin not stubbed");
    },
    readProcessEnv: () => ({}),
    fetchFileForSelection: () => Promise.resolve(null),
    appParams: () => [],
    resolveDeployParams: () => ({}),
    partitionParams: () => ({ public: {}, secret: {} }),
    extractAppName: () => "",
    buildDeployRadCommand: () => "rad deploy",
    buildAppGraphRadCommand: () => "rad app graph",
    ensureDeployWorkflowsOnBranch: () => Promise.resolve(),
    ensureWorkflowsCurrent: () => Promise.resolve({ created: [], failed: [] }),
    classifyDeployDispatchFailure: () => "run-unconfirmed",
    invalidateDeployListCache: () => {},
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    now: () => 1_700_000_000_000,
    ...overrides
  };
}

function request(state: CanvasState = {}) {
  const logs: string[] = [];
  return {
    logs,
    state,
    input: {
      entry: { state },
      repo: "acme/widgets",
      branch: "feat",
      provider: "azure",
      requestedEnvironment: "production",
      log: (message: string) => logs.push(message)
    }
  };
}

function recordingGh(results: DeployCommandResult[] = []) {
  const calls: GhCall[] = [];
  let index = 0;
  const next = (): DeployCommandResult => results[index++] ?? OK;
  return {
    calls,
    runGh: (args: string[], options: DeployCommandOptions = {}) => {
      calls.push({ args, env: options.env });
      return Promise.resolve(next());
    },
    runGhWithStdin: (
      args: string[],
      stdin: string,
      options: DeployCommandOptions = {}
    ) => {
      calls.push({ args, stdin, env: options.env });
      return Promise.resolve(next());
    }
  };
}

const SECRET_PARAM: BicepParam = {
  name: "dbPassword",
  type: "string",
  secure: true,
  hasDefault: false,
  default: "",
  description: ""
};

const PUBLIC_PARAM: BicepParam = {
  name: "port",
  type: "int",
  secure: false,
  hasDefault: true,
  default: "8080",
  description: ""
};

describe("deploy dispatch construction", () => {
  it.each([
    "getBranchHeadSha",
    "getDefaultBranch",
    "runGh",
    "runGhWithStdin",
    "readProcessEnv",
    "fetchFileForSelection",
    "appParams",
    "resolveDeployParams",
    "partitionParams",
    "extractAppName",
    "buildDeployRadCommand",
    "buildAppGraphRadCommand",
    "ensureDeployWorkflowsOnBranch",
    "ensureWorkflowsCurrent",
    "classifyDeployDispatchFailure",
    "invalidateDeployListCache",
    "errorMessage",
    "now"
  ] as const)("refuses to construct without %s", (name) => {
    const incomplete = dependencies();
    delete incomplete[name];
    expect(() => createDeployDispatchService(incomplete)).toThrow(
      `createDeployDispatchService is missing required dependencies: ${name}`
    );
  });

  it("refuses to construct without the workflow file names", () => {
    expect(() =>
      createDeployDispatchService(dependencies({ deployWorkflowFile: "" }))
    ).toThrow(
      "createDeployDispatchService is missing required dependencies: deployWorkflowFile"
    );
    expect(() =>
      createDeployDispatchService(dependencies({ deployWorkflowFiles: [] }))
    ).toThrow(
      "createDeployDispatchService is missing required dependencies: deployWorkflowFiles"
    );
  });

  it("refuses to construct without the branch-not-pushed error kind", () => {
    const missing: Partial<DeployDispatchDependencies> = dependencies();
    delete missing.branchNotPushedKind;
    expect(() =>
      createDeployDispatchService(missing as DeployDispatchDependencies)
    ).toThrow(
      "createDeployDispatchService is missing required dependencies: branchNotPushedKind"
    );
    const empty = dependencies();
    Object.defineProperty(empty, "branchNotPushedKind", { value: "" });
    expect(() => createDeployDispatchService(empty)).toThrow(
      "createDeployDispatchService is missing required dependencies: branchNotPushedKind"
    );
  });
});

describe("deploy dispatch environment and branch preflight", () => {
  it("prefers the resolved instance environment over the request's", async () => {
    const { input, state } = request({ envName: "resolved-env" });
    const gh = recordingGh();
    const service = createDeployDispatchService(dependencies({ ...gh }));

    const outcome = await service.prepareAndDispatch(input);

    expect(state.deployEnvName).toBe("resolved-env");
    expect(outcome).toEqual({
      dispatched: true,
      workflowFile: "run-rad-commands.yml",
      dispatchedAt: 1_700_000_000_000,
      environment: "resolved-env"
    });
  });

  it.each([
    ["the request", { requestedEnvironment: "production" }, "production"],
    ["the dev floor", { requestedEnvironment: undefined }, "dev"],
    ["the dev floor for a non-string", { requestedEnvironment: 7 }, "dev"]
  ])(
    "falls back to %s when the instance carries no environment",
    async (_name, overrides, expected) => {
      const { input, state } = request();
      const gh = recordingGh();
      const service = createDeployDispatchService(dependencies({ ...gh }));

      await service.prepareAndDispatch({ ...input, ...overrides });

      expect(state.deployEnvName).toBe(expected);
      expect(gh.calls[0].args).toContain("environment=" + expected);
    }
  );

  it("refuses to dispatch a branch that is not on the remote", async () => {
    const { input, state, logs } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        getBranchHeadSha: () => Promise.resolve(null),
        getDefaultBranch: () => Promise.resolve("main")
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployStatus).toBe("failed");
    expect(state.deployErrorKind).toBe("branch-not-pushed");
    expect(state.deployErrorBranch).toBe("feat");
    expect(state.deployError).toContain("git push -u origin feat");
    expect(logs).toEqual([
      "━━ Deploying Radius application ━━",
      '❌ Branch "feat" has not been pushed to acme/widgets.',
      "   Push it and redeploy:  git push -u origin feat"
    ]);
    // Nothing may be dispatched, because the run would be doomed.
    expect(gh.calls).toEqual([]);
  });

  it("does not blame the branch when the repository itself is unreachable", async () => {
    const { input, state } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        getBranchHeadSha: () => Promise.resolve(null),
        getDefaultBranch: () => Promise.resolve(null)
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(state.deployErrorKind).toBeUndefined();
  });

  it("skips the branch preflight when no ref was resolved", async () => {
    const { input } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        getBranchHeadSha: () => {
          throw new Error("an empty ref must not be looked up");
        }
      })
    );

    expect(
      await service.prepareAndDispatch({ ...input, branch: "" })
    ).toMatchObject({ dispatched: true });
    expect(gh.calls[0].args).toEqual([
      "workflow",
      "run",
      "run-rad-commands.yml",
      "--ref",
      "",
      "-f",
      "environment=production",
      "--repo",
      "acme/widgets"
    ]);
  });
});

describe("deploy dispatch rad commands and secrets", () => {
  it("computes the rad commands from the branch's app.bicep and records the app name", async () => {
    const { input, state, logs } = request();
    const gh = recordingGh();
    const reads: string[] = [];
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: (_entry, _repo, _branch, repoPath) => {
          reads.push(repoPath);
          return Promise.resolve("bicep source");
        },
        appParams: () => [PUBLIC_PARAM],
        resolveDeployParams: () => ({ port: "8080" }),
        partitionParams: () => ({ public: { port: "8080" }, secret: {} }),
        extractAppName: () => "todo-app",
        buildDeployRadCommand: (appFile, environment, publicParams) =>
          `rad deploy ${appFile} -e ${environment} -p ${JSON.stringify(publicParams)}`,
        buildAppGraphRadCommand: (appName) => `rad app graph -a ${appName}`
      })
    );

    await service.prepareAndDispatch(input);

    expect(reads).toEqual([".radius/app.bicep"]);
    expect(state.deployAppName).toBe("todo-app");
    expect(gh.calls[0].args.slice(-2)).toEqual([
      "-f",
      'rad_commands=["rad deploy .radius/app.bicep -e production -p {\\"port\\":\\"8080\\"}","rad app graph -a todo-app"]'
    ]);
    expect(logs).toContain(
      'Deploying with rad commands: rad deploy .radius/app.bicep -e production -p {"port":"8080"}  |  rad app graph -a todo-app'
    );
  });

  it("falls back to a root app.bicep and omits the graph command with no app name", async () => {
    const { input, state } = request({ deployAppName: "kept" });
    const gh = recordingGh();
    const reads: string[] = [];
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: (_entry, _repo, _branch, repoPath) => {
          reads.push(repoPath);
          return Promise.resolve(
            repoPath === "app.bicep" ? "root bicep" : null
          );
        },
        buildDeployRadCommand: (appFile) => `rad deploy ${appFile}`,
        buildAppGraphRadCommand: () => {
          throw new Error("no app name means no graph command");
        }
      })
    );

    await service.prepareAndDispatch(input);

    expect(reads).toEqual([".radius/app.bicep", "app.bicep"]);
    // An unresolved name keeps whatever the state already had.
    expect(state.deployAppName).toBe("kept");
    expect(gh.calls[0].args.slice(-2)).toEqual([
      "-f",
      'rad_commands=["rad deploy app.bicep"]'
    ]);
  });

  it("dispatches without rad commands when no bicep can be read", async () => {
    const { input, logs } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(dependencies({ ...gh }));

    await service.prepareAndDispatch(input);

    expect(gh.calls[0].args).not.toContain("rad_commands");
    expect(logs).toContain(
      "⚠ Could not read app.bicep at dispatch; falling back to the environment's RADIUS_RAD_COMMANDS / default deploy."
    );
  });

  it("keeps deploying when the bicep cannot be parsed", async () => {
    const { input, logs } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => {
          throw new Error("unbalanced braces");
        }
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(logs).toContain(
      "⚠ Could not compute rad commands from bicep (unbalanced braces); falling back to the environment default."
    );
  });

  it("leaves an existing RADIUS_DEPLOY_PARAMS secret untouched", async () => {
    const { input } = request();
    const gh = recordingGh([
      { code: 0, stdout: "OTHER\nRADIUS_DEPLOY_PARAMS\n", stderr: "" }
    ]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        }),
        runGhWithStdin: () => {
          throw new Error("an existing secret must not be overwritten");
        }
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(gh.calls[0].args).toEqual([
      "api",
      "/repos/acme/widgets/environments/production/secrets",
      "--jq",
      ".secrets[].name"
    ]);
  });

  it("provisions the secret when the environment has none", async () => {
    const { input, logs } = request();
    const gh = recordingGh([
      OK,
      OK,
      { code: 0, stdout: "RADIUS_DEPLOY_PARAMS", stderr: "" }
    ]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        })
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(gh.calls[1]).toEqual({
      args: [
        "secret",
        "set",
        "RADIUS_DEPLOY_PARAMS",
        "--env",
        "production",
        "--repo",
        "acme/widgets"
      ],
      stdin: '{"dbPassword":"generated"}',
      env: undefined
    });
    expect(logs).toContain(
      'Provisioning RADIUS_DEPLOY_PARAMS for "production" (dbPassword)...'
    );
    expect(logs).toContain('✅ RADIUS_DEPLOY_PARAMS is set on "production".');
  });

  it("retries the secret write with the injected token stripped", async () => {
    const { input } = request();
    const gh = recordingGh([
      OK,
      { code: 1, stderr: "missing scope", stdout: "" },
      OK,
      { code: 0, stdout: "RADIUS_DEPLOY_PARAMS", stderr: "" }
    ]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        readProcessEnv: () => ({ GH_TOKEN: "t", PATH: "/usr/bin" }),
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        })
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(gh.calls[2].env).toEqual({ PATH: "/usr/bin" });
  });

  it("refuses to start a run whose secret write failed", async () => {
    const { input, state, logs } = request();
    const gh = recordingGh([
      OK,
      { code: 1, stderr: "  forbidden  ", stdout: "" }
    ]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        })
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toContain(
      'Could not provision RADIUS_DEPLOY_PARAMS on environment "production": forbidden'
    );
    expect(state.deployError).toContain("so it was not started");
    // The failure is recorded, but the dispatch itself never happens.
    expect(gh.calls.map((call) => call.args[0])).toEqual(["api", "secret"]);
    expect(logs.some((line) => line.startsWith("❌"))).toBe(true);
  });

  it("preserves a secret failure when later command construction throws", async () => {
    const { input, state } = request();
    const gh = recordingGh([OK, { code: 1, stderr: "forbidden", stdout: "" }]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        }),
        extractAppName: () => "invalid app",
        buildAppGraphRadCommand: () => {
          throw new Error("invalid application name");
        }
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toContain(
      'Could not provision RADIUS_DEPLOY_PARAMS on environment "production": forbidden'
    );
    expect(gh.calls.map((call) => call.args[0])).toEqual(["api", "secret"]);
  });

  it("reports an unknown error when the secret write gives no reason", async () => {
    const { input, state } = request();
    const gh = recordingGh([OK, { code: 1, stderr: "", stdout: "" }]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        })
      })
    );

    await service.prepareAndDispatch(input);

    expect(state.deployError).toContain("unknown error");
  });

  it("refuses when the accepted secret is still not present", async () => {
    const { input, state } = request();
    const gh = recordingGh([OK, OK, { code: 0, stdout: "OTHER", stderr: "" }]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        fetchFileForSelection: () => Promise.resolve("bicep source"),
        appParams: () => [SECRET_PARAM],
        partitionParams: () => ({
          public: {},
          secret: { dbPassword: "generated" }
        })
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployError).toContain(
      "RADIUS_DEPLOY_PARAMS was accepted but is not present"
    );
  });
});

describe("deploy dispatch workflow publication and dispatch", () => {
  it("publishes and synchronizes the workflow files before dispatching", async () => {
    const { input } = request();
    const gh = recordingGh();
    const order: string[] = [];
    const service = createDeployDispatchService(
      dependencies({
        runGh: (args, options) => {
          order.push("dispatch");
          return gh.runGh(args, options);
        },
        runGhWithStdin: gh.runGhWithStdin,
        ensureDeployWorkflowsOnBranch: (repo, branch, environment) => {
          order.push(`publish:${repo}:${branch}:${environment}`);
          return Promise.resolve();
        },
        ensureWorkflowsCurrent: (
          repo,
          environment,
          provider,
          only,
          workingBranch
        ) => {
          order.push(
            `sync:${repo}:${environment}:${provider}:${only.join("+")}:${workingBranch}`
          );
          return Promise.resolve({ created: [], failed: [] });
        }
      })
    );

    await service.prepareAndDispatch(input);

    expect(order).toEqual([
      "publish:acme/widgets:feat:production",
      "sync:acme/widgets:production:azure:run-rad-commands.yml+run-rad-commands-azure.yml:feat",
      "dispatch"
    ]);
  });

  it("warns but still dispatches when publication fails", async () => {
    const { input, logs } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        ensureDeployWorkflowsOnBranch: () =>
          Promise.reject(new Error("branch protected"))
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(logs).toContain(
      '⚠ Could not publish deploy workflows to branch "feat": branch protected. The dispatch below will fail if the branch has no run-rad-commands workflow.'
    );
  });

  it("invalidates the deployments listing only after a successful dispatch", async () => {
    const { input, logs } = request();
    const evictions: string[] = [];
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        invalidateDeployListCache: (repo) => evictions.push(repo)
      })
    );

    await service.prepareAndDispatch(input);

    expect(evictions).toEqual(["acme/widgets"]);
    expect(logs).toContain("✅ Run rad commands workflow dispatched.");
  });

  it("retries the dispatch with the injected token stripped", async () => {
    const { input } = request();
    const gh = recordingGh([
      { code: 1, stderr: "workflow scope", stdout: "" },
      OK
    ]);
    const evictions: string[] = [];
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        readProcessEnv: () => ({ GITHUB_TOKEN: "t", HOME: "/home/dev" }),
        invalidateDeployListCache: (repo) => evictions.push(repo)
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls[1].env).toEqual({ HOME: "/home/dev" });
    expect(evictions).toEqual(["acme/widgets"]);
  });

  it("keeps the first failure when the stripped-token retry also fails", async () => {
    const { input, state } = request();
    const gh = recordingGh([
      { code: 1, stderr: "first failure", stdout: "" },
      { code: 1, stderr: "second failure", stdout: "" }
    ]);
    const service = createDeployDispatchService(
      dependencies({ ...gh, readProcessEnv: () => ({ GH_TOKEN: "t" }) })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployError).toContain("first failure");
  });

  it("does not retry when no token is injected", async () => {
    const { input } = request();
    const gh = recordingGh([{ code: 1, stderr: "boom", stdout: "" }]);
    const service = createDeployDispatchService(dependencies({ ...gh }));

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(gh.calls).toHaveLength(1);
  });

  it("reports an unresolvable ref as a branch that was never pushed", async () => {
    const { input, state, logs } = request();
    const gh = recordingGh([
      { code: 1, stderr: "no ref found for: feat", stdout: "" }
    ]);
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        classifyDeployDispatchFailure: () => "branch-not-pushed"
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployErrorKind).toBe("branch-not-pushed");
    expect(state.deployErrorBranch).toBe("feat");
    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toContain("git push -u origin feat");
    expect(logs).toContain("   Push it and redeploy:  git push -u origin feat");
  });

  it("hints at the missing workflow scope for a scope failure", async () => {
    const { input, state } = request();
    const gh = recordingGh([
      { code: 1, stderr: "the token is missing the workflow scope", stdout: "" }
    ]);
    const service = createDeployDispatchService(dependencies({ ...gh }));

    await service.prepareAndDispatch(input);

    expect(state.deployErrorKind).toBe("run-unconfirmed");
    expect(state.deployError).toContain(
      "gh auth refresh -h github.com -s workflow"
    );
  });

  it("hints at the workflow file and Actions for any other failure", async () => {
    const { input, state } = request();
    const gh = recordingGh([{ code: 1, stderr: "", stdout: "" }]);
    const service = createDeployDispatchService(dependencies({ ...gh }));

    await service.prepareAndDispatch(input);

    expect(state.deployError).toContain("The dispatch request failed.");
    expect(state.deployError).toContain(
      'Ensure run-rad-commands.yml exists on branch "feat"'
    );
    expect(state.deployError).toContain(
      "GitHub Actions are enabled for acme/widgets"
    );
  });
});
