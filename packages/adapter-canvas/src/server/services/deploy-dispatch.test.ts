import { describe, expect, it } from "vitest";
import {
  buildFederatedCredentialListArgs,
  createDeployDispatchService,
  type DeployCommandOptions,
  type DeployCommandResult,
  type DeployDispatchDependencies
} from "./deploy-dispatch.js";
import type { BicepParam } from "../../bicep.js";
import type { CanvasState } from "../../shared.js";
import type { GitHubJsonResponse, GitHubJsonRunner } from "../../azure-oidc.js";

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
    oidcSubjectMissingKind: "oidc-subject-missing",
    oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
    getBranchHeadSha: () => Promise.resolve("sha-1"),
    getDefaultBranch: () => {
      throw new Error("getDefaultBranch not stubbed");
    },
    runGh: () => Promise.resolve(OK),
    runGhWithStdin: () => {
      throw new Error("runGhWithStdin not stubbed");
    },
    runAz: () => {
      throw new Error("runAz not stubbed");
    },
    runGitHubJson: () => {
      throw new Error("runGitHubJson not stubbed");
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
    latestWorkflowRunId: () => Promise.resolve(null),
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
      provider: "aws",
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

const DEFAULT_OIDC_CUSTOMIZATION: GitHubJsonResponse = {
  ok: false,
  status: 404
};

function oidcGitHubRunner(
  customization: GitHubJsonResponse = DEFAULT_OIDC_CUSTOMIZATION
): GitHubJsonRunner {
  return (path) => {
    if (path === "/repos/acme/widgets") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: {
          full_name: "acme/widgets",
          id: 202,
          owner: { id: 101 }
        }
      });
    }
    if (path === "/repos/acme/widgets/actions/oidc/customization/sub") {
      return Promise.resolve(customization);
    }
    throw new Error(`unexpected GitHub JSON path: ${path}`);
  };
}

interface AzurePreflightOptions {
  customization?: GitHubJsonResponse;
  environmentLookup?: GitHubJsonResponse;
  environmentVariable?: GitHubJsonResponse;
  oidcError?: Error;
  repositoryVariable?: GitHubJsonResponse;
  runAz?: (args: string[]) => Promise<DeployCommandResult>;
  subjects?: unknown;
  variableError?: Error;
}

const ABSENT: GitHubJsonResponse = { ok: false, status: 404 };

function azurePreflight(options: AzurePreflightOptions = {}) {
  const azCalls: string[][] = [];
  const githubJsonCalls: string[] = [];
  return {
    azCalls,
    githubJsonCalls,
    runGitHubJson: (path: string) => {
      githubJsonCalls.push(path);
      if (
        path.startsWith("/repos/acme/widgets/environments/") &&
        path.endsWith("/variables/AZURE_CLIENT_ID")
      ) {
        if (options.variableError) throw options.variableError;
        return Promise.resolve(
          options.environmentVariable ?? {
            ok: true,
            status: 200,
            json: { value: "client-123" }
          }
        );
      }
      if (path === "/repos/acme/widgets/actions/variables/AZURE_CLIENT_ID") {
        return Promise.resolve(options.repositoryVariable ?? ABSENT);
      }
      if (path.startsWith("/repos/acme/widgets/environments/")) {
        // GitHub echoes the environment's stored name, which is what the
        // subject must be built from.
        const requested = decodeURIComponent(
          path.slice("/repos/acme/widgets/environments/".length)
        );
        return Promise.resolve(
          options.environmentLookup ?? {
            ok: true,
            status: 200,
            json: { name: requested }
          }
        );
      }
      if (options.oidcError) throw options.oidcError;
      return oidcGitHubRunner(
        options.customization ?? DEFAULT_OIDC_CUSTOMIZATION
      )(path);
    },
    runAz:
      options.runAz ??
      ((args: string[]) => {
        azCalls.push(args);
        return Promise.resolve({
          ...OK,
          stdout: JSON.stringify(
            options.subjects ?? [
              "repo:acme/widgets:environment:production",
              "repo:acme@101/widgets@202:environment:production"
            ]
          )
        });
      })
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
    "runAz",
    "runGitHubJson",
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
    "latestWorkflowRunId",
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

  it("refuses to construct without the OIDC-subject-missing error kind", () => {
    const missing: Partial<DeployDispatchDependencies> = dependencies();
    delete missing.oidcSubjectMissingKind;
    expect(() =>
      createDeployDispatchService(missing as DeployDispatchDependencies)
    ).toThrow(
      "createDeployDispatchService is missing required dependencies: oidcSubjectMissingKind"
    );
    const empty = dependencies();
    Object.defineProperty(empty, "oidcSubjectMissingKind", { value: "" });
    expect(() => createDeployDispatchService(empty)).toThrow(
      "createDeployDispatchService is missing required dependencies: oidcSubjectMissingKind"
    );
  });

  it("refuses to construct without the OIDC-subject-case-mismatch error kind", () => {
    const missing: Partial<DeployDispatchDependencies> = dependencies();
    delete missing.oidcSubjectCaseMismatchKind;
    expect(() =>
      createDeployDispatchService(missing as DeployDispatchDependencies)
    ).toThrow(
      "createDeployDispatchService is missing required dependencies: oidcSubjectCaseMismatchKind"
    );
    const empty = dependencies();
    Object.defineProperty(empty, "oidcSubjectCaseMismatchKind", { value: "" });
    expect(() => createDeployDispatchService(empty)).toThrow(
      "createDeployDispatchService is missing required dependencies: oidcSubjectCaseMismatchKind"
    );
  });
});

describe("federated credential list arguments", () => {
  it("passes only --id and global arguments az accepts", () => {
    const args = buildFederatedCredentialListArgs("client-123");

    expect(args).toEqual([
      "ad",
      "app",
      "federated-credential",
      "list",
      "--id",
      "client-123",
      "--query",
      "[].subject",
      "-o",
      "json"
    ]);
    // `az ad app federated-credential list` rejects any scoping flag with
    // "unrecognized arguments", which would make the preflight a no-op.
    expect(args).not.toContain("--tenant");
    expect(args).not.toContain("--subscription");
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
      environment: "resolved-env",
      baselineRunId: null
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

  it("fails fast when no Azure federated credential covers the target environment and truncates near matches", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const gh = recordingGh();
    const preflight = azurePreflight({
      subjects: ["dev", "test", "staging", "preview"].map(
        (environment) => `repo:acme/widgets:environment:${environment}`
      )
    });
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        ...preflight
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployStatus).toBe("failed");
    // Marked so the repair loop stays shut: no model edit can add a federated
    // credential in Azure.
    expect(state.deployErrorKind).toBe("oidc-subject-missing");
    expect(state.deployError).toContain(
      '"repo:acme/widgets:environment:production" or "repo:acme@101/widgets@202:environment:production"'
    );
    expect(state.deployError).toContain("expected one of");
    expect(state.deployError).toContain(
      "repo:acme/widgets:environment:dev, repo:acme/widgets:environment:test, repo:acme/widgets:environment:staging, ..."
    );
    expect(state.deployError).not.toContain(
      "repo:acme/widgets:environment:preview"
    );
    expect(gh.calls.some(({ args }) => args[0] === "workflow")).toBe(false);
    expect(preflight.azCalls).toEqual([
      [
        "ad",
        "app",
        "federated-credential",
        "list",
        "--id",
        "client-123",
        "--query",
        "[].subject",
        "-o",
        "json"
      ]
    ]);
  });

  it("names every mis-cased subject, marks the rejection as predicted, and carries the az fix", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const gh = recordingGh();
    const preflight = azurePreflight({
      subjects: [
        "repo:Acme/Widgets:environment:Production",
        "repo:acme@101/Widgets@202:environment:PRODUCTION"
      ]
    });
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        ...preflight
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployStatus).toBe("failed");
    expect(state.deployErrorKind).toBe("oidc-subject-case-mismatch");
    // Both halves of the mutable/immutable pair are reported, so one pass of
    // the fix below clears the block rather than leaving the second spelling
    // to trip the partial-coverage warning on the next attempt.
    expect(state.deployError).toContain(
      'expected "repo:acme/widgets:environment:production" but the app has "repo:Acme/Widgets:environment:Production"'
    );
    expect(state.deployError).toContain(
      'expected "repo:acme@101/widgets@202:environment:production" but the app has "repo:acme@101/Widgets@202:environment:PRODUCTION"'
    );
    // Predicted rather than quoted: no run exists to search for the code in.
    expect(state.deployError).toContain("would be rejected");
    expect(state.deployError).toContain("No workflow run was started");
    expect(state.deployError).toContain("AADSTS700213");
    expect(state.deployError).toContain("AADSTS7002138");
    expect(state.deployError).toContain(
      'az ad app federated-credential list --id client-123 --query "[].{id:id,subject:subject}" -o table'
    );
    expect(state.deployError).toContain(
      "az ad app federated-credential update --id client-123 --federated-credential-id <id> --parameters"
    );
    expect(state.deployError).not.toContain("Create Environment with");
    expect(gh.calls.some(({ args }) => args[0] === "workflow")).toBe(false);
  });

  it("identifies a case-only mismatch against the immutable subject candidate", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        ...azurePreflight({
          subjects: ["repo:Acme@101/Widgets@202:environment:Production"]
        })
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployErrorKind).toBe("oidc-subject-case-mismatch");
    expect(state.deployError).toContain(
      'expected "repo:acme@101/widgets@202:environment:production" but the app has "repo:Acme@101/Widgets@202:environment:Production"'
    );
  });

  it("never passes a scoping flag az would reject", async () => {
    const { input } = request();
    input.provider = "azure";
    const preflight = azurePreflight();
    const service = createDeployDispatchService(
      dependencies({ ...recordingGh(), ...preflight })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    // `az ad app federated-credential list` exits with "unrecognized
    // arguments" for --tenant, which would make every check unverified and the
    // whole preflight a no-op.
    expect(preflight.azCalls[0]).toEqual([
      "ad",
      "app",
      "federated-credential",
      "list",
      "--id",
      "client-123",
      "--query",
      "[].subject",
      "-o",
      "json"
    ]);
  });

  it("skips the check when the environment deliberately disables Azure login", async () => {
    const { input, state, logs } = request();
    input.provider = "azure";
    const gh = recordingGh();
    const preflight = azurePreflight({
      environmentVariable: { ok: true, status: 200, json: { value: "  " } }
    });
    const service = createDeployDispatchService(
      dependencies({ ...gh, ...preflight })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(state.deployStatus).not.toBe("failed");
    // The upstream workflow gates azure/login on `vars.AZURE_CLIENT_ID != ''`,
    // so a blank value means there is no login to fail — not broken config.
    expect(
      logs.some(
        (line) =>
          line.startsWith("• ") && line.includes("Azure login is disabled")
      )
    ).toBe(true);
    expect(
      logs.some((line) => line.includes("federated credential coverage"))
    ).toBe(false);
    expect(preflight.azCalls).toEqual([]);
  });

  it("builds the subject from the environment name GitHub reports, not the requested spelling", async () => {
    const { input } = request();
    input.provider = "azure";
    input.requestedEnvironment = "dev";
    const preflight = azurePreflight({
      environmentLookup: { ok: true, status: 200, json: { name: "Dev" } },
      subjects: [
        "repo:acme/widgets:environment:Dev",
        "repo:acme@101/widgets@202:environment:Dev"
      ]
    });
    const service = createDeployDispatchService(
      dependencies({ ...recordingGh(), ...preflight })
    );

    // GitHub resolves the environment case-insensitively but Entra compares the
    // subject case-sensitively, so the requested spelling would wrongly block a
    // deploy that works today.
    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
  });

  it("ignores credentials that report no subject instead of disabling the check", async () => {
    const { input } = request();
    input.provider = "azure";
    const preflight = azurePreflight({
      // Entra flexible federated credentials match on claimsMatchingExpression
      // and report a null subject.
      subjects: [
        null,
        "repo:acme/widgets:environment:production",
        "repo:acme@101/widgets@202:environment:production"
      ]
    });
    const service = createDeployDispatchService(
      dependencies({ ...recordingGh(), ...preflight })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
  });

  it("lists immutable-form subjects as near matches when the credential is missing", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const service = createDeployDispatchService(
      dependencies({
        ...recordingGh(),
        ...azurePreflight({
          subjects: ["repo:acme@101/widgets@202:environment:staging"]
        })
      })
    );

    await service.prepareAndDispatch(input);

    // A prefix filter built from the mutable spelling would hide these exactly
    // when the user most needs to see how close the credential was.
    expect(state.deployError).toContain(
      "Existing credential subjects on the app: repo:acme@101/widgets@202:environment:staging."
    );
  });

  it("reports an unpushed branch before spending the Azure preflight", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const preflight = azurePreflight();
    const service = createDeployDispatchService(
      dependencies({
        ...recordingGh(),
        ...preflight,
        getBranchHeadSha: () => Promise.resolve(null),
        getDefaultBranch: () => Promise.resolve("main")
      })
    );

    expect(await service.prepareAndDispatch(input)).toEqual({
      dispatched: false
    });
    expect(state.deployErrorKind).toBe("branch-not-pushed");
    expect(preflight.azCalls).toEqual([]);
    expect(preflight.githubJsonCalls).toEqual([]);
  });

  it.each([
    {
      name: "default compatibility pair",
      environment: "production",
      customization: DEFAULT_OIDC_CUSTOMIZATION,
      subjects: [
        "repo:acme/widgets:environment:production",
        "repo:acme@101/widgets@202:environment:production"
      ]
    },
    {
      name: "immutable-only subject",
      environment: "production",
      customization: {
        ok: true,
        status: 200,
        json: { use_default: true, use_immutable_subject: true }
      },
      subjects: ["repo:acme@101/widgets@202:environment:production"]
    },
    {
      name: "custom subject",
      environment: "production",
      customization: {
        ok: true,
        status: 200,
        json: {
          use_default: false,
          include_claim_keys: ["repository_owner", "repository", "environment"],
          use_immutable_subject: false
        }
      },
      subjects: [
        "repository_owner:acme:repository:acme/widgets:environment:production"
      ]
    },
    {
      name: "colon-escaped environment subjects",
      environment: "prod:west",
      customization: DEFAULT_OIDC_CUSTOMIZATION,
      subjects: [
        "repo:acme/widgets:environment:prod%3Awest",
        "repo:acme@101/widgets@202:environment:prod%3Awest"
      ]
    }
  ])("continues with a covered $name", async (scenario) => {
    const { input } = request();
    input.provider = "azure";
    input.requestedEnvironment = scenario.environment;
    const gh = recordingGh();
    const preflight = azurePreflight({
      customization: scenario.customization,
      subjects: scenario.subjects.map((subject) => `  ${subject}  `)
    });
    const service = createDeployDispatchService(
      dependencies({ ...gh, ...preflight })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(gh.calls.some(({ args }) => args[0] === "workflow")).toBe(true);
  });

  it.each([
    {
      name: "only the mutable form",
      present: "repo:acme/widgets:environment:production",
      missing: "repo:acme@101/widgets@202:environment:production"
    },
    {
      name: "only the immutable form",
      present: "repo:acme@101/widgets@202:environment:production",
      missing: "repo:acme/widgets:environment:production"
    }
  ])(
    "warns but still deploys when the default compatibility pair has $name",
    async (scenario) => {
      const { input, state, logs } = request();
      input.provider = "azure";
      const gh = recordingGh();
      const service = createDeployDispatchService(
        dependencies({
          ...gh,
          ...azurePreflight({ subjects: [scenario.present] })
        })
      );

      // Only one of the pair is ever presented and the resolver could not tell
      // which, so holding the other half is not proof the deploy is doomed.
      expect(await service.prepareAndDispatch(input)).toMatchObject({
        dispatched: true
      });
      expect(state.deployStatus).not.toBe("failed");
      const warning = logs.find((line) => line.startsWith("⚠ "));
      expect(warning).toContain(`"${scenario.missing}"`);
      expect(warning).not.toContain(`"${scenario.present}"`);
      expect(gh.calls.some(({ args }) => args[0] === "workflow")).toBe(true);
    }
  );

  it("lists near matches without an ellipsis when three or fewer exist", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const service = createDeployDispatchService(
      dependencies({
        ...recordingGh(),
        ...azurePreflight({
          subjects: ["dev", "test"].map(
            (environment) => `repo:acme/widgets:environment:${environment}`
          )
        })
      })
    );

    await service.prepareAndDispatch(input);

    expect(state.deployError).toContain(
      "Existing credential subjects on the app: repo:acme/widgets:environment:dev, repo:acme/widgets:environment:test."
    );
    expect(state.deployError).not.toContain("...");
  });

  it("reports a missing subject without inventing near matches", async () => {
    const { input, state } = request();
    input.provider = "azure";
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        ...azurePreflight({
          subjects: []
        })
      })
    );

    await service.prepareAndDispatch(input);

    expect(state.deployError).not.toContain("Existing credential subjects");
  });

  it("uses a repository-scoped client id when the environment variable is absent", async () => {
    const { input } = request();
    input.provider = "azure";
    const gh = recordingGh();
    const preflight = azurePreflight({
      environmentVariable: { ok: false, status: 404 },
      repositoryVariable: {
        ok: true,
        status: 200,
        json: { value: "repo-client-456" }
      }
    });
    const service = createDeployDispatchService(
      dependencies({ ...gh, ...preflight })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
    expect(preflight.githubJsonCalls.slice(0, 2)).toEqual([
      "/repos/acme/widgets/environments/production/variables/AZURE_CLIENT_ID",
      "/repos/acme/widgets/actions/variables/AZURE_CLIENT_ID"
    ]);
    expect(preflight.azCalls[0]).toContain("repo-client-456");
  });

  it.each([
    {
      name: "GitHub environment lookup failure",
      options: {
        environmentVariable: {
          ok: false,
          status: 403,
          stderr: "environment unavailable"
        }
      },
      message:
        'GitHub environment "production" AZURE_CLIENT_ID lookup failed (environment unavailable)'
    },
    {
      name: "GitHub lookup rejection",
      options: { variableError: new Error("GitHub process failed") },
      message: "GitHub variable lookup failed (GitHub process failed)"
    },
    {
      name: "GitHub environment lookup failure without diagnostics",
      options: {
        environmentVariable: { ok: false, status: 503 }
      },
      message:
        'GitHub environment "production" AZURE_CLIENT_ID lookup failed (HTTP 503)'
    },
    {
      name: "GitHub environment lookup failure without status",
      options: {
        environmentVariable: { ok: false }
      },
      message:
        'GitHub environment "production" AZURE_CLIENT_ID lookup failed (HTTP unknown)'
    },
    {
      name: "invalid environment client id",
      options: {
        environmentVariable: {
          ok: true,
          status: 200,
          json: { value: 42 }
        }
      },
      message: 'GitHub environment "production" has an invalid AZURE_CLIENT_ID'
    },
    {
      name: "environment name lookup failure",
      options: {
        environmentLookup: {
          ok: false,
          status: 403,
          stderr: "environment unavailable"
        }
      },
      message:
        'GitHub environment "production" lookup failed (environment unavailable)'
    },
    {
      name: "environment name lookup failure without diagnostics",
      options: {
        environmentLookup: { ok: false, status: 503 }
      },
      message: 'GitHub environment "production" lookup failed (HTTP 503)'
    },
    {
      name: "environment name lookup failure without a status",
      options: {
        environmentLookup: { ok: false }
      },
      message: 'GitHub environment "production" lookup failed (HTTP unknown)'
    },
    {
      name: "environment name missing from the lookup",
      options: {
        environmentLookup: { ok: true, status: 200, json: { name: "  " } }
      },
      message: 'GitHub did not report a name for environment "production"'
    },
    {
      name: "missing environment and repository client id",
      options: {
        environmentVariable: { ok: false, status: 404 },
        repositoryVariable: { ok: false, status: 404 }
      },
      message:
        'neither GitHub environment "production" nor repository "acme/widgets" defines AZURE_CLIENT_ID'
    },
    {
      name: "GitHub repository lookup failure",
      options: {
        environmentVariable: { ok: false, status: 404 },
        repositoryVariable: {
          ok: false,
          status: 403,
          stderr: "repository unavailable"
        }
      },
      message:
        'GitHub repository "acme/widgets" AZURE_CLIENT_ID lookup failed (repository unavailable)'
    },
    {
      name: "GitHub repository lookup failure without diagnostics",
      options: {
        environmentVariable: { ok: false, status: 404 },
        repositoryVariable: { ok: false }
      },
      message:
        'GitHub repository "acme/widgets" AZURE_CLIENT_ID lookup failed (HTTP unknown)'
    },
    {
      name: "invalid repository client id",
      options: {
        environmentVariable: { ok: false, status: 404 },
        repositoryVariable: {
          ok: true,
          status: 200,
          json: { value: 42 }
        }
      },
      message: 'GitHub repository "acme/widgets" has an invalid AZURE_CLIENT_ID'
    },
    {
      name: "GitHub OIDC resolution failure",
      options: { oidcError: new Error("GitHub timed out") },
      message: "GitHub OIDC subject resolution failed (GitHub timed out)"
    },
    {
      name: "Azure CLI timeout",
      options: {
        runAz: () =>
          Promise.resolve({
            code: "ETIMEDOUT",
            stdout: "",
            stderr: "command timed out"
          })
      },
      message: "Azure federated credential lookup failed (command timed out)"
    },
    {
      name: "Azure CLI failure without diagnostics",
      options: {
        runAz: () => Promise.resolve({ code: 1, stdout: "", stderr: "" })
      },
      message: "Azure federated credential lookup failed (unknown error)"
    },
    {
      name: "Azure CLI cancellation",
      options: {
        runAz: () => Promise.reject(new Error("command cancelled"))
      },
      message: "Azure federated credential lookup failed (command cancelled)"
    },
    {
      name: "malformed Azure JSON",
      options: {
        runAz: () => Promise.resolve({ ...OK, stdout: "not json" })
      },
      message: "returned malformed JSON"
    },
    {
      name: "empty Azure output",
      options: {
        runAz: () => Promise.resolve({ ...OK, stdout: "" })
      },
      message: "returned malformed JSON"
    },
    {
      name: "non-array Azure JSON",
      options: {
        runAz: () => Promise.resolve({ ...OK, stdout: '{"subject":"value"}' })
      },
      message: "returned an invalid subject list"
    },
    {
      name: "partially covered subject pair",
      options: {
        runAz: () =>
          Promise.resolve({
            ...OK,
            stdout: JSON.stringify([
              "repo:acme/widgets:environment:production",
              null
            ])
          })
      },
      // Null subjects come from flexible credentials and are skipped, leaving
      // only the mutable half of the pair — indeterminate, so a warning.
      message:
        'covers only part of the subject pair GitHub may mint (no credential for "repo:acme@101/widgets@202:environment:production")'
    }
  ])(
    "warns and still deploys when coverage cannot be verified: $name",
    async (scenario) => {
      const { input, state, logs } = request();
      input.provider = "azure";
      const gh = recordingGh();
      const service = createDeployDispatchService(
        dependencies({
          ...gh,
          ...azurePreflight(scenario.options)
        })
      );

      // `az` and Graph access are not otherwise required to deploy — the
      // workflow authenticates in Actions — so an unusable local check must not
      // become a deploy blocker.
      expect(await service.prepareAndDispatch(input)).toMatchObject({
        dispatched: true
      });
      expect(state.deployStatus).not.toBe("failed");
      const warning = logs.find((line) => line.startsWith("⚠ "));
      expect(warning).toContain(scenario.message);
      expect(warning).toContain("AADSTS700213");
      expect(gh.calls.some(({ args }) => args[0] === "workflow")).toBe(true);
    }
  );

  it("does not run Azure validation for another provider", async () => {
    const { input } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        runAz: () => {
          throw new Error("non-Azure deploy must not call az");
        },
        runGitHubJson: () => {
          throw new Error("non-Azure deploy must not query OIDC settings");
        }
      })
    );

    expect(await service.prepareAndDispatch(input)).toMatchObject({
      dispatched: true
    });
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
      "sync:acme/widgets:production:aws:run-rad-commands.yml+run-rad-commands-azure.yml:feat",
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

  it("captures the newest run id before dispatch and returns it as the baseline", async () => {
    const { input } = request();
    const order: string[] = [];
    const baselineCalls: [string, string][] = [];
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        runGh: (args: string[], options: DeployCommandOptions = {}) => {
          order.push("dispatch");
          return gh.runGh(args, options);
        },
        runGhWithStdin: gh.runGhWithStdin,
        latestWorkflowRunId: (repo: string, workflowFile: string) => {
          order.push("baseline");
          baselineCalls.push([repo, workflowFile]);
          return Promise.resolve(88);
        }
      })
    );

    const outcome = await service.prepareAndDispatch(input);

    expect(outcome).toMatchObject({ dispatched: true, baselineRunId: 88 });
    expect(baselineCalls).toEqual([["acme/widgets", "run-rad-commands.yml"]]);
    expect(order).toEqual(["baseline", "dispatch"]);
  });

  it("falls back to a null baseline and warns when the run id read fails", async () => {
    const { input, logs } = request();
    const gh = recordingGh();
    const service = createDeployDispatchService(
      dependencies({
        ...gh,
        latestWorkflowRunId: () =>
          Promise.reject(new Error("run list unavailable"))
      })
    );

    const outcome = await service.prepareAndDispatch(input);

    expect(outcome).toMatchObject({ dispatched: true, baselineRunId: null });
    expect(logs).toContain(
      "⚠ Could not read the latest run id before dispatch (run list unavailable); run discovery will fall back to a time window."
    );
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
      {
        code: 1,
        stderr: "the token is missing the workflow scope",
        stdout: ""
      }
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
