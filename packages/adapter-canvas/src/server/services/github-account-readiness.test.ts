import { describe, expect, it, vi } from "vitest";
import { assertSetupExecutionActive } from "@radius-project/core";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  createGitHubAccountReadinessService,
  createGitHubSelectionHandleStore,
  probeGhcrPackageWriteAccess,
  type GitHubPackageAccessProbeResult
} from "./github-account-readiness.js";
import { createGitHubAccountCoordinator } from "./github-account-coordinator.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "../../repository-access-guidance.js";
import { gitHubAppAccessProbePaths } from "../../github-app-installation.js";
import type {
  GitHubAccountCoordinator,
  GitHubAccountLeaseResult
} from "./github-account-coordinator.js";
import type { SelectedGhCommandResult, SelectedGhExecutor } from "../../gh.js";
import { createDeploymentAccountResolver } from "../../runtime/deployment-account.js";

function selectedExecutor(input: {
  login?: string;
  scopes?: string[];
  command?: SelectedGhCommandResult;
}): SelectedGhExecutor {
  const login = input.login || "octocat";
  const run = async () =>
    input.command || {
      code: 0,
      stdout: JSON.stringify({ permissions: { admin: true } }),
      stderr: ""
    };
  return {
    login,
    credentialSource: "keyring",
    requiresKeyringSwitch: true,
    scopes: input.scopes || ["workflow", "write:packages"],
    run,
    runOrThrow: run,
    verifyIdentity: async () => {},
    packageCredentials: () => ({
      username: login,
      token: "synthetic-package-credential",
      source: "keyring"
    }),
    redact: (value) => value,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
}

function coordinator(
  executor: SelectedGhExecutor,
  restorationState: "not_required" | "restored" = "not_required"
): GitHubAccountCoordinator {
  return {
    createReadOnlyExecutor: async () => executor,
    async withSelectedAccount(_login, _metadata, work) {
      const result: GitHubAccountLeaseResult<Awaited<ReturnType<typeof work>>> =
        {
          value: await work(executor, {
            release: async () => {},
            retake: async () => {}
          }),
          selectedLogin: executor.login,
          credentialSource: executor.credentialSource,
          switched: restorationState === "restored",
          restoration: {
            state: restorationState,
            originalLogin: "original",
            currentLogin: "original",
            guidance: null
          }
        };
      return result;
    }
  };
}

function readinessService(
  accountCoordinator: GitHubAccountCoordinator,
  packageAccess: GitHubPackageAccessProbeResult = {
    state: "allowed",
    detail: "GitHub Packages granted pull and push access."
  }
) {
  return createGitHubAccountReadinessService(accountCoordinator, {
    ownerKey: "runtime",
    ports: {
      probePackageAccess: async () => packageAccess
    }
  });
}

describe("GitHub account readiness", () => {
  it.each(
    ["repos/octo/app", ...gitHubAppAccessProbePaths("octo/app")].flatMap(
      (path) =>
        ["ok", "malformed", "denied", "rejected", "identity"].map(
          (outcome) => ({ path, outcome })
        )
    )
  )(
    "fences subsequent App probes after $path settles $outcome",
    async ({ path, outcome }) => {
      let stopped = false;
      const calls: string[] = [];
      const selected = successfulSelectedGhExecutor({
        login: "fixture[bot]",
        requiresKeyringSwitch: false,
        run: async (args, options) => {
          if (args[1] === path && outcome === "identity") {
            stopped = true;
            options?.beforeExecute?.();
          }
          calls.push(args[1]);
          if (args[1] === path) {
            stopped = true;
            if (outcome === "rejected") throw new Error("failed read");
          }
          return {
            code: args[1] === path && outcome === "denied" ? 1 : 0,
            stdout:
              outcome === "malformed" && args[1] === path ?
                "invalid"
              : '{"permissions":{"admin":true}}',
            stderr: ""
          };
        }
      });
      const account = createGitHubAccountCoordinator({
        createExecutor: async () => selected,
        getActiveKeyringLogin: async () => selected.login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected switch");
        },
        resetIdentityCache() {}
      });
      const probe = vi.fn(async () => ({
        state: "allowed" as const,
        detail: "ready"
      }));
      const service = createGitHubAccountReadinessService(account, {
        ownerKey: "runtime",
        ports: { probePackageAccess: probe }
      });
      await expect(
        service.check({
          repo: "octo/app",
          environment: "dev",
          login: selected.login,
          assertActive: () => assertSetupExecutionActive(() => stopped)
        })
      ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
      expect(probe).not.toHaveBeenCalled();
      expect(calls.at(-1)).toBe(
        outcome === "identity" ?
          ["repos/octo/app", ...gitHubAppAccessProbePaths("octo/app")][
            [
              "repos/octo/app",
              ...gitHubAppAccessProbePaths("octo/app")
            ].indexOf(path) - 1
          ]
        : path
      );
    }
  );

  it.each(["success", "interrupted", "error"] as const)(
    "reports failed/external restoration before suppressing %s work, even with throwing diagnostics",
    async (workOutcome) => {
      for (const restoration of ["failed", "changed_externally"] as const) {
        let stopped = false;
        let active = "original";
        const selected = successfulSelectedGhExecutor({
          login: "selected",
          run: async () => ({
            code: 0,
            stdout: '{"permissions":{"admin":true}}',
            stderr: ""
          })
        });
        const account = createGitHubAccountCoordinator({
          createExecutor: async () => selected,
          getActiveKeyringLogin: async () => active,
          switchKeyringAccount: async (login) => {
            if (login === "original")
              return { ok: false, error: "restore unavailable" };
            active = login;
            return { ok: true };
          },
          resetIdentityCache() {}
        });
        const diagnostic = vi.fn(() => {
          throw new Error("diagnostic unavailable");
        });
        const service = createGitHubAccountReadinessService(account, {
          ownerKey: "runtime",
          ports: {
            probePackageAccess: async () => {
              if (restoration === "changed_externally") active = "external";
              if (workOutcome === "interrupted") {
                stopped = true;
                assertSetupExecutionActive(() => stopped);
              }
              if (workOutcome === "error") throw new Error("ordinary failure");
              return { state: "allowed", detail: "ready" };
            }
          }
        });
        const pending = service.check({
          repo: "octo/app",
          environment: "dev",
          login: "selected",
          assertActive: () => assertSetupExecutionActive(() => stopped),
          reportRestoration: diagnostic
        });
        if (workOutcome === "interrupted")
          await expect(pending).rejects.toMatchObject({
            code: "setup-execution-interrupted"
          });
        else
          await expect(pending).resolves.toMatchObject({
            ready: false,
            restoration: { state: restoration }
          });
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ state: restoration })
        );
        // A new lease can run once manual restoration has resolved any block.
        active = "original";
        await expect(
          account.withSelectedAccount(
            "selected",
            { ownerKey: "next" },
            async () => "next"
          )
        ).resolves.toMatchObject({ value: "next" });
      }
    }
  );

  it.each(
    (["allowed", "denied", "unavailable"] as const).flatMap((outcome) =>
      (["discovery", "saved", "stale"] as const).map((mode) => ({
        outcome,
        mode
      }))
    )
  )(
    "preserves $outcome package access through real $mode account selection",
    async ({ outcome, mode }) => {
      const calls: string[] = [];
      let current = true;
      const choose = vi.fn(async () => "second");
      const createExecutor = vi.fn(async (login: string) =>
        selectedExecutor({ login })
      );
      const accountCoordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => ({
          ...selectedExecutor({ login }),
          requiresKeyringSwitch: false
        }),
        getActiveKeyringLogin: async () => "first",
        switchKeyringAccount: async () => {
          throw new Error("Unexpected account switch");
        },
        resetIdentityCache() {}
      });
      const readiness = createGitHubAccountReadinessService(
        accountCoordinator,
        {
          ownerKey: "runtime",
          ports: {
            probePackageAccess: (executor, repo, environment) =>
              probeGhcrPackageWriteAccess(
                executor,
                repo,
                environment,
                async () => {
                  calls.push(executor.login);
                  if (mode === "stale") current = false;
                  if (executor.login === "first" && outcome === "unavailable")
                    throw new Error(
                      "network unavailable; client_secret=fixture-value"
                    );
                  if (executor.login === "first" && outcome === "denied")
                    return { ok: false, status: 403, json: async () => ({}) };
                  return {
                    ok: true,
                    status: 202,
                    headers: { get: () => "/upload" },
                    json: async () => ({ token: "opaque" })
                  };
                }
              )
          }
        }
      );
      const resolve = createDeploymentAccountResolver({
        readinessOwner: createEnvironmentExecutionOwner(),
        logDiagnostic: vi.fn(),
        readIdentity: async () => ({
          accounts: ["first", "second"].map((login) => ({
            login,
            hasWorkflow: true,
            hasPackages: true,
            switchable: true,
            acting: false
          }))
        }),
        readiness,
        choose,
        createExecutor,
        redactDiagnostic: (value) => value
      });
      const result = await resolve({
        target: { repo: "octo/app", environment: "dev" },
        ...(mode === "saved" ? { savedLogin: "first" } : {}),
        isCurrent: () => current
      });
      if (mode === "stale") {
        expect(result).toEqual({ state: "stopped" });
      } else if (outcome === "unavailable") {
        expect(result).toEqual({
          state: "unavailable",
          message: "GitHub Packages authorization could not be verified."
        });
      } else if (mode === "saved" && outcome === "denied") {
        expect(result).toMatchObject({
          state: "reauthorization-required",
          login: "first",
          message: "GitHub Packages rejected the selected account."
        });
      } else {
        expect(result).toMatchObject({
          state: "selected",
          login: mode === "saved" ? "first" : "second"
        });
        expect(createExecutor).toHaveBeenCalledExactlyOnceWith(
          mode === "saved" ? "first" : "second"
        );
      }
      if (mode === "discovery" && outcome === "allowed")
        expect(choose).toHaveBeenCalledExactlyOnceWith({
          target: { repo: "octo/app", environment: "dev" },
          logins: ["first", "second"]
        });
      else expect(choose).not.toHaveBeenCalled();
      if (result.state !== "selected") {
        expect(createExecutor).not.toHaveBeenCalled();
        expect(calls.every((login) => login === "first")).toBe(true);
      }
    }
  );

  it("presents an inconclusive package check as an error with retry guidance, not a scope repair", async () => {
    const service = readinessService(coordinator(selectedExecutor({})), {
      state: "unavailable",
      detail: "GitHub Packages authorization could not be verified."
    });
    expect(
      await service.check({
        repo: "octo/app",
        environment: "dev",
        login: "octocat"
      })
    ).toMatchObject({
      ready: false,
      summary: "GitHub access could not be verified",
      checks: {
        packages: {
          state: "error",
          detail: "GitHub Packages authorization could not be verified."
        }
      },
      repair:
        "GitHub Packages access could not be verified. Check connectivity and GitHub service availability, then retry with the same account.",
      repairRemediation: null
    });
  });

  it("reports one ready result when every selected-account capability passes", async () => {
    const accountCoordinator = coordinator(selectedExecutor({}));
    const lease = vi.spyOn(accountCoordinator, "withSelectedAccount");
    const service = readinessService(accountCoordinator);

    await expect(
      service.check({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        login: "octocat"
      })
    ).resolves.toMatchObject({
      ready: true,
      login: "octocat",
      credentialSource: "keyring",
      summary: "Ready to configure deployments",
      checks: {
        identity: { state: "ready" },
        repository: { state: "ready" },
        workflow: { state: "ready" },
        environment: { state: "ready" },
        packages: { state: "ready" }
      }
    });
    expect(lease).toHaveBeenCalledExactlyOnceWith(
      "octocat",
      { ownerKey: "runtime" },
      expect.any(Function),
      3000
    );
  });

  it("accepts a GitHub App installation with setup permissions and a separate package credential", async () => {
    const login = "radius-cloud-e2e[bot]";
    const probed: string[] = [];
    const run = async (args: string[]): Promise<SelectedGhCommandResult> => {
      if (args[1] === "repos/octo/app") {
        return {
          code: 0,
          stdout: JSON.stringify({ permissions: { admin: false } }),
          stderr: ""
        };
      }
      if (gitHubAppAccessProbePaths("octo/app").includes(args[1] ?? "")) {
        probed.push(args[1] ?? "");
        return { code: 0, stdout: "[]", stderr: "" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };
    const executor: SelectedGhExecutor = {
      login,
      credentialSource: "injected",
      requiresKeyringSwitch: false,
      scopes: [],
      run,
      runOrThrow: run,
      verifyIdentity: async () => {},
      packageCredentials: () => ({
        username: "package-publisher",
        token: "synthetic-package-credential",
        source: "injected-token",
        scopes: ["read:packages", "write:packages"]
      }),
      redact: (value) => value,
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error)
    };
    const service = readinessService(coordinator(executor));

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login
    });

    expect(result).toMatchObject({
      ready: true,
      checks: {
        identity: { state: "ready" },
        repository: { state: "ready" },
        workflow: { state: "ready" },
        environment: { state: "ready" },
        packages: { state: "ready" }
      }
    });
    expect(probed).toEqual(gitHubAppAccessProbePaths("octo/app"));
  });

  it("does not infer GitHub App repository access when the token cannot read the repository", async () => {
    const login = "radius-cloud-e2e[bot]";
    const run = async (): Promise<SelectedGhCommandResult> => ({
      code: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)"
    });
    const executor: SelectedGhExecutor = {
      ...selectedExecutor({ login }),
      credentialSource: "injected",
      requiresKeyringSwitch: false,
      scopes: [],
      run,
      runOrThrow: run,
      packageCredentials: () => ({
        username: "package-publisher",
        token: "synthetic-package-credential",
        source: "injected-token",
        scopes: ["write:packages"]
      })
    };
    const service = readinessService(coordinator(executor));

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login
    });

    expect(result.ready).toBe(false);
    expect(result.checks.repository).toEqual({
      state: "error",
      detail: "gh: Not Found (HTTP 404)"
    });
  });

  it("rejects a GitHub App installation granted only the permission the first probe reads", async () => {
    const login = "radius-cloud-e2e[bot]";
    // Exactly the misconfiguration a single environments probe would pass: the
    // installation can read Actions resources but was never granted Secrets.
    const run = async (args: string[]): Promise<SelectedGhCommandResult> => {
      if (args[1] === "repos/octo/app") {
        return {
          code: 0,
          stdout: JSON.stringify({ permissions: { admin: false } }),
          stderr: ""
        };
      }
      if (args[1] === "repos/octo/app/actions/secrets") {
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Resource not accessible by integration (HTTP 403)"
        };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };
    const executor: SelectedGhExecutor = {
      ...selectedExecutor({ login }),
      credentialSource: "injected",
      requiresKeyringSwitch: false,
      scopes: [],
      run,
      runOrThrow: run,
      packageCredentials: () => ({
        username: "package-publisher",
        token: "synthetic-package-credential",
        source: "injected-token",
        scopes: ["write:packages"]
      })
    };
    const service = readinessService(coordinator(executor));

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login
    });

    expect(result.ready).toBe(false);
    expect(result.checks.environment.state).toBe("error");
    expect(result.checks.environment.detail).toContain(
      "cannot exercise its Secrets permission on octo/app"
    );
    // The login still looks like a bot, so an unverified installation must not
    // keep claiming workflow access on the strength of its name alone.
    expect(result.checks.workflow.state).toBe("missing");
  });

  it("verifies and restores a mocked inactive keyring account", async () => {
    let activeLogin = "original";
    const switches: string[] = [];
    const selected = selectedExecutor({ login: "selected" });
    const service = readinessService(
      createGitHubAccountCoordinator({
        createExecutor: async () => selected,
        getActiveKeyringLogin: async () => activeLogin,
        switchKeyringAccount: async (login) => {
          switches.push(login);
          activeLogin = login;
          return { ok: true };
        },
        resetIdentityCache: () => {}
      })
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "selected"
    });

    expect(result).toMatchObject({
      ready: true,
      login: "selected",
      restoration: {
        state: "restored",
        originalLogin: "original",
        currentLogin: "original"
      }
    });
    expect(switches).toEqual(["selected", "original"]);
    expect(activeLogin).toBe("original");
  });

  it("refuses readiness when the original keyring account was not restored", async () => {
    const selected = selectedExecutor({});
    const failedRestoreCoordinator: GitHubAccountCoordinator = {
      createReadOnlyExecutor: async () => selected,
      async withSelectedAccount(_login, _metadata, work) {
        return {
          value: await work(selected, {
            release: async () => {},
            retake: async () => {}
          }),
          selectedLogin: selected.login,
          credentialSource: selected.credentialSource,
          switched: true,
          restoration: {
            state: "failed",
            originalLogin: "original",
            currentLogin: "selected",
            guidance: "Restore @original manually."
          }
        };
      }
    };
    const service = readinessService(failedRestoreCoordinator);

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result).toMatchObject({
      ready: false,
      summary: "Additional GitHub access is required",
      repair: "Restore @original manually.",
      checks: {
        identity: {
          state: "error",
          detail: "Restore @original manually."
        }
      }
    });
    // A failed restoration is not a scope gap, so there is no command to run.
    expect(result.repairRemediation).toBeNull();
  });

  it("reports missing workflow and package access without using another account", async () => {
    const probePackageAccess = vi.fn(() =>
      Promise.resolve({
        state: "denied" as const,
        detail: "GitHub Packages push access is missing."
      })
    );
    const service = createGitHubAccountReadinessService(
      coordinator(selectedExecutor({ scopes: ["repo"] })),
      { ownerKey: "runtime", ports: { probePackageAccess } }
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result).toMatchObject({
      ready: false,
      summary: "Additional GitHub access is required",
      checks: {
        workflow: { state: "missing" },
        packages: { state: "missing" }
      }
    });
    expect(result.repair).toBe(
      "The account @octocat needs the workflow and write:packages permissions to proceed. In the terminal, run:\ngh auth switch -h github.com -u octocat\ngh auth refresh -h github.com -s workflow -s read:packages -s write:packages\nThis will make @octocat the active GitHub CLI account if it is not already active."
    );
    expect(probePackageAccess).not.toHaveBeenCalled();
    expect(result.repairRemediation).toEqual({
      id: "github-account-scopes",
      params: { login: "octocat", workflow: "true", packages: "true" }
    });
  });

  it("uses the bundled GitHub CLI path in repair guidance", async () => {
    const service = createGitHubAccountReadinessService(
      coordinator(selectedExecutor({ scopes: ["repo"] })),
      {
        ownerKey: "runtime",
        ports: {
          probePackageAccess: () =>
            Promise.resolve({ state: "denied", detail: "not checked" })
        },
        ghCommandPresentation: {
          kind: "absolute",
          shell: "posix",
          executablePath: "/opt/Copilot Tools/gh",
          installationNote: "Install GitHub CLI system-wide."
        }
      }
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.repair).toContain(
      "'/opt/Copilot Tools/gh' auth switch -h github.com -u octocat"
    );
    expect(result.repair).toContain("Install GitHub CLI system-wide.");
  });

  it("falls back to prose when the login is one the registry will not run", async () => {
    const service = readinessService(
      coordinator(
        selectedExecutor({ login: "octo cat; rm -rf /", scopes: ["workflow"] })
      )
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octo cat; rm -rf /"
    });

    // A login the registry refuses must never be spliced into a command.
    expect(result.repair).not.toContain("gh auth switch");
    expect(result.repair).toContain("Grant the missing scopes with GitHub CLI");
    expect(result.repairRemediation).toBeNull();
  });

  it("names only the selected account when package permission is missing", async () => {
    const service = readinessService(
      coordinator(selectedExecutor({ scopes: ["workflow"] }))
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.repair).toBe(
      "The account @octocat needs the write:packages permission to proceed. In the terminal, run:\ngh auth switch -h github.com -u octocat\ngh auth refresh -h github.com -s read:packages -s write:packages\nThis will make @octocat the active GitHub CLI account if it is not already active."
    );
    expect(result.repair).not.toContain("original");
    expect(result.repairRemediation).toEqual({
      id: "github-account-scopes",
      params: { login: "octocat", packages: "true" }
    });
  });

  it("skips package probing until repository administration is ready", async () => {
    const probePackageAccess = vi.fn(() =>
      Promise.resolve({
        state: "allowed" as const,
        detail: "GitHub Packages push access is available."
      })
    );
    const service = createGitHubAccountReadinessService(
      coordinator(
        selectedExecutor({
          command: {
            code: 0,
            stdout: JSON.stringify({ permissions: { push: true } }),
            stderr: ""
          }
        })
      ),
      { ownerKey: "runtime", ports: { probePackageAccess } }
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.checks.packages).toEqual({
      state: "missing",
      detail:
        "GitHub Packages access was not checked because repository administration is not ready."
    });
    expect(probePackageAccess).not.toHaveBeenCalled();
  });

  it("skips package probing until workflow access is ready", async () => {
    const probePackageAccess = vi.fn(() =>
      Promise.resolve({
        state: "allowed" as const,
        detail: "GitHub Packages push access is available."
      })
    );
    const service = createGitHubAccountReadinessService(
      coordinator(selectedExecutor({ scopes: ["write:packages"] })),
      { ownerKey: "runtime", ports: { probePackageAccess } }
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.checks.packages).toEqual({
      state: "missing",
      detail:
        "GitHub Packages access was not checked because workflow access is not ready."
    });
    expect(result.repair).toContain("-s workflow");
    expect(result.repair).not.toContain("write:packages");
    expect(result.repair).not.toContain("original");
    expect(probePackageAccess).not.toHaveBeenCalled();
  });

  it("requires repository administration for environment configuration", async () => {
    const service = readinessService(
      coordinator(
        selectedExecutor({
          command: {
            code: 0,
            stdout: JSON.stringify({ permissions: { push: true } }),
            stderr: ""
          }
        })
      )
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.ready).toBe(false);
    expect(result.checks.repository.state).toBe("missing");
    expect(result.checks.environment.state).toBe("missing");
    expect(result.repair).toContain("repository administrator access");
    expect(result.repair).toContain(FORK_REPOSITORY_SETUP_GUIDANCE);
    // A repository grant is not something a command can fix, so the wizard
    // must keep showing prose rather than an actionable callout.
    expect(result.repairRemediation).toBeNull();
  });

  it.each([
    [
      {
        code: 1,
        stdout: "",
        stderr: "repository denied"
      },
      "repository denied"
    ],
    [
      {
        code: 1,
        stdout: "",
        stderr: ""
      },
      "@octocat could not access octo/app."
    ],
    [
      {
        code: 0,
        stdout: "not-json",
        stderr: ""
      },
      "GitHub returned an invalid repository permission response."
    ]
  ])("fails repository readiness safely for %#", async (command, detail) => {
    const service = readinessService(
      coordinator(selectedExecutor({ command }))
    );

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.ready).toBe(false);
    expect(result.checks.repository).toEqual({
      state: "error",
      detail
    });
  });

  it("surfaces selected-account execution failures as a failed readiness result", async () => {
    const failingCoordinator: GitHubAccountCoordinator = {
      createReadOnlyExecutor: async () => {
        throw new Error("not used");
      },
      withSelectedAccount: async () => {
        throw new Error("account lease busy");
      }
    };
    const service = readinessService(failingCoordinator);

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.ready).toBe(false);
    expect(result.checks.identity).toEqual({
      state: "error",
      detail: "account lease busy"
    });
  });

  it("normalizes a non-Error coordinator rejection", async () => {
    const failingCoordinator: GitHubAccountCoordinator = {
      createReadOnlyExecutor: async () => {
        throw new Error("not used");
      },
      withSelectedAccount: () => Promise.reject("lease rejected")
    };
    const service = readinessService(failingCoordinator);

    const result = await service.check({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat"
    });

    expect(result.checks.identity.detail).toBe("lease rejected");
  });
});

describe("GHCR package access probe", () => {
  it.each([
    "before",
    "token-ok",
    "token-denied",
    "token-rejected",
    "body-ok",
    "body-malformed",
    "body-rejected"
  ] as const)(
    "does not admit a POST after shutdown at %s",
    async (boundary) => {
      let stopped = boundary === "before";
      const calls: string[] = [];
      const pending = probeGhcrPackageWriteAccess(
        selectedExecutor({}),
        "octo/app",
        "dev",
        async (_url, init) => {
          calls.push(init.method ?? "GET");
          if (boundary.startsWith("token")) stopped = true;
          if (boundary === "token-rejected")
            throw new Error("read unavailable");
          return {
            ok: boundary !== "token-denied",
            status: 403,
            json: async () => {
              stopped = true;
              if (boundary === "body-rejected")
                throw new Error("body unavailable");
              return boundary === "body-malformed" ? null : { token: "opaque" };
            }
          };
        },
        15000,
        () => assertSetupExecutionActive(() => stopped)
      );
      await expect(pending).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      expect(calls).toEqual(boundary === "before" ? [] : ["GET"]);
    }
  );

  it.each([
    "accepted",
    "denied",
    "rejected",
    "cleanup-rejected",
    "unsafe-location"
  ] as const)(
    "preserves an issued POST's %s result and cleanup after shutdown",
    async (outcome) => {
      let stopped = false;
      const calls: string[] = [];
      const result = await probeGhcrPackageWriteAccess(
        selectedExecutor({}),
        "octo/app",
        "dev",
        async (_url, init) => {
          const method = init.method ?? "GET";
          calls.push(method);
          if (method === "POST") {
            stopped = true;
            if (outcome === "rejected") throw new Error("upload unavailable");
            return {
              ok: outcome !== "denied",
              status: outcome === "denied" ? 403 : 202,
              headers: {
                get: () =>
                  outcome === "unsafe-location" ?
                    "https://other.invalid/upload"
                  : "/upload"
              },
              json: async () => ({})
            };
          }
          if (method === "DELETE" && outcome === "cleanup-rejected")
            throw new Error("cleanup unavailable");
          return { ok: true, json: async () => ({ token: "opaque" }) };
        },
        15000,
        () => assertSetupExecutionActive(() => stopped)
      );
      expect(result.state).toBe(
        outcome === "denied" ? "denied"
        : outcome === "rejected" ? "unavailable"
        : "allowed"
      );
      expect(calls).toEqual([
        "GET",
        "POST",
        ...(["accepted", "cleanup-rejected"].includes(outcome) ?
          ["DELETE"]
        : [])
      ]);
    }
  );

  it.each(
    (["token", "upload"] as const).flatMap((endpoint) =>
      [undefined, 200, 400, 401, 403, 404, 408, 429, 500, 503].map(
        (status) => ({
          endpoint,
          status
        })
      )
    )
  )(
    "distinguishes confirmed denial from unavailable $endpoint response $status",
    async ({ endpoint, status }) => {
      let calls = 0;
      const result = await probeGhcrPackageWriteAccess(
        selectedExecutor({}),
        "octo/app",
        "dev",
        async () => {
          calls++;
          if (endpoint === "upload" && calls === 1)
            return { ok: true, json: async () => ({ token: "opaque" }) };
          return {
            ok: status === 200,
            status,
            json: async () => {
              throw new Error("client_secret=fixture-value");
            }
          };
        }
      );
      const denied = status === 401 || status === 403;
      expect(result.state).toBe(denied ? "denied" : "unavailable");
      expect(result.detail).not.toContain("fixture-value");
      expect(calls).toBe(endpoint === "token" ? 1 : 2);
    }
  );

  it.each([null, "unexpected", {}, { token: 42 }, { token: " " }])(
    "treats a malformed authorization body as unavailable: %j",
    async (body) => {
      const fetcher = vi.fn(async () => ({ ok: true, json: async () => body }));
      expect(
        await probeGhcrPackageWriteAccess(
          selectedExecutor({}),
          "octo/app",
          "dev",
          fetcher
        )
      ).toEqual({
        state: "unavailable",
        detail: "GitHub Packages returned an invalid authorization response."
      });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  );

  it("keeps confirmed push access when a malformed cleanup URL cannot be parsed", async () => {
    let calls = 0;
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      async () => {
        calls++;
        return calls === 1 ?
            { ok: true, json: async () => ({ token: "opaque" }) }
          : {
              ok: true,
              status: 202,
              headers: { get: () => "https://[" },
              json: async () => ({})
            };
      }
    );
    expect(result.state).toBe("allowed");
    expect(result.detail).toContain(
      "empty upload session could not be cancelled"
    );
    expect(calls).toBe(2);
  });

  it("verifies push with a cancellable upload session for the exact state package", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string;
      signal?: AbortSignal;
    }> = [];

    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "Octo/App",
      "dev",
      async (url, init) => {
        requests.push({
          url,
          method: init.method || "GET",
          authorization: init.headers.Authorization,
          signal: init.signal
        });
        if (requests.length === 1) {
          return {
            ok: true,
            json: async () => ({ token: "opaque-registry-token" })
          };
        }
        if (requests.length === 2) {
          return {
            ok: true,
            status: 202,
            headers: {
              get: (name) =>
                name.toLowerCase() === "location" ?
                  "/v2/octo/app-radius-state-dev-fixture/blobs/uploads/upload-1"
                : null
            },
            json: async () => ({})
          };
        }
        return { ok: true, status: 204, json: async () => ({}) };
      }
    );

    expect(result).toEqual({
      state: "allowed",
      detail:
        "GitHub Packages accepted push authorization for the state package from @octocat. The deploy workflow's own token is checked separately when credentials are verified."
    });
    expect(requests[0]?.url).toContain(
      "repository%3Aocto%2Fapp-radius-state-dev-"
    );
    expect(requests[1]?.url).toContain(
      "https://ghcr.io/v2/octo/app-radius-state-dev-"
    );
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
      "DELETE"
    ]);
    expect(requests[0]?.authorization).toMatch(/^Basic /);
    expect(requests[1]?.authorization).toMatch(/^Bearer /);
    expect(requests[2]?.authorization).toMatch(/^Bearer /);
    expect(new Set(requests.map((request) => request.signal)).size).toBe(1);
    expect(JSON.stringify(result)).not.toContain(
      "synthetic-package-credential"
    );
  });

  it.each([
    ["", "dev"],
    ["octo/app", ""]
  ])("rejects an invalid package target %#", async (repo, environment) => {
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      repo,
      environment,
      async () => ({ ok: true, json: async () => ({}) })
    );
    expect(result).toEqual({
      state: "denied",
      detail: "The GHCR package owner is invalid."
    });
  });

  it.each([
    [
      "a token endpoint network failure",
      async () => {
        throw new Error("offline");
      },
      "GitHub Packages authorization could not be verified.",
      "unavailable"
    ],
    [
      "a rejected credential",
      async () => ({ ok: false, status: 401, json: async () => ({}) }),
      "GitHub Packages rejected the selected account.",
      "denied"
    ],
    [
      "a missing registry token",
      async () => ({ ok: true, json: async () => ({}) }),
      "GitHub Packages returned an invalid authorization response.",
      "unavailable"
    ]
  ] as const)("fails safely for %s", async (_label, fetcher, detail, state) => {
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      fetcher
    );
    expect(result).toEqual({ state, detail });
  });

  it("rejects an upload session when push is not authorized", async () => {
    let call = 0;
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      async () => {
        call += 1;
        return call === 1 ?
            { ok: true, json: async () => ({ access_token: "opaque" }) }
          : { ok: false, status: 401, json: async () => ({}) };
      }
    );
    expect(result).toEqual({
      state: "denied",
      detail:
        "GitHub Packages did not grant push access to the selected account."
    });
  });

  it.each(["", "https://example.test/upload"])(
    "retains confirmed authorization without following an unsafe cleanup location %s",
    async (location) => {
      let call = 0;
      const result = await probeGhcrPackageWriteAccess(
        selectedExecutor({}),
        "octo/app",
        "dev",
        async () => {
          call += 1;
          return call === 1 ?
              { ok: true, json: async () => ({ token: "opaque" }) }
            : {
                ok: true,
                status: 202,
                headers: { get: () => location },
                json: async () => ({})
              };
        }
      );
      expect(result).toEqual({
        state: "allowed",
        detail:
          "GitHub Packages granted an upload session that Radius could not safely clean up."
      });
      expect(call).toBe(2);
    }
  );

  it.each([
    [
      "is rejected",
      async () => ({ ok: false, status: 500, json: async () => ({}) })
    ],
    [
      "throws",
      async () => {
        throw new Error("cleanup failed");
      }
    ]
  ] as const)(
    "keeps readiness after push authorization when upload cleanup %s",
    async (_label, cleanup) => {
      let call = 0;
      const result = await probeGhcrPackageWriteAccess(
        selectedExecutor({}),
        "octo/app",
        "dev",
        async () => {
          call += 1;
          if (call === 1) {
            return { ok: true, json: async () => ({ token: "opaque" }) };
          }
          if (call === 2) {
            return {
              ok: true,
              status: 202,
              headers: {
                get: () => "/v2/octo/app/blobs/uploads/upload-1"
              },
              json: async () => ({})
            };
          }
          return await cleanup();
        }
      );
      expect(result).toEqual({
        state: "allowed",
        detail:
          "GitHub Packages accepted push authorization from @octocat. The empty upload session could not be cancelled and will expire without creating a package artifact."
      });
    }
  );

  it("accepts GHCR's unsupported upload cancellation response", async () => {
    let call = 0;
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      async () => {
        call += 1;
        if (call === 1) {
          return { ok: true, json: async () => ({ token: "opaque" }) };
        }
        if (call === 2) {
          return {
            ok: true,
            status: 202,
            headers: {
              get: () => "/v2/octo/app/blobs/uploads/upload-1"
            },
            json: async () => ({})
          };
        }
        return { ok: false, status: 405, json: async () => ({}) };
      }
    );
    expect(result).toEqual({
      state: "allowed",
      detail:
        "GitHub Packages accepted push authorization for the state package from @octocat. The deploy workflow's own token is checked separately when credentials are verified."
    });
  });

  it("fails safely when the upload authorization check cannot run", async () => {
    let call = 0;
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      async () => {
        call += 1;
        if (call === 1) {
          return {
            ok: true,
            json: async () => ({ token: "v1:opaque" })
          };
        }
        throw new Error("registry offline");
      }
    );
    expect(result).toEqual({
      state: "unavailable",
      detail: "GitHub Packages authorization could not be verified."
    });
  });

  it("bounds the complete GHCR probe with one abort signal", async () => {
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      async (_url, init) =>
        await new Promise((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        }),
      1
    );
    expect(result).toEqual({
      state: "unavailable",
      detail: "GitHub Packages authorization could not be verified."
    });
  });
});

describe("GitHub selection handles", () => {
  it("binds a single-use handle to its instance, repository, and generation", () => {
    let now = 100;
    const store = createGitHubSelectionHandleStore({
      now: () => now,
      ttlMs: 50
    });
    const firstGeneration = store.begin("panel");
    const first = store.mint({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat",
      credentialSource: "keyring",
      generation: firstGeneration
    });
    if (!first) throw new Error("first selection mint failed");
    const secondGeneration = store.begin("panel");
    const second = store.mint({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "hubot",
      credentialSource: "injected",
      generation: secondGeneration
    });
    if (!second) throw new Error("second selection mint failed");
    expect(
      store.mint({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        login: "stale",
        credentialSource: "keyring",
        generation: firstGeneration
      })
    ).toBeNull();
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: ""
      })
    ).toEqual({ ok: false, error: "missing" });
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: "unknown"
      })
    ).toEqual({ ok: false, error: "unknown" });

    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: first.handle
      })
    ).toEqual({ ok: false, error: "unknown" });
    expect(
      store.claim({
        instanceId: "other",
        repo: "octo/app",
        environment: "dev",
        handle: second.handle
      })
    ).toEqual({ ok: false, error: "binding" });
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "prod",
        handle: second.handle
      })
    ).toEqual({ ok: false, error: "binding" });
    const claim = store.claim({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      handle: second.handle
    });
    expect(claim).toMatchObject({
      ok: true,
      login: "hubot",
      credentialSource: "injected"
    });
    if (!claim.ok) throw new Error("selection claim failed");
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: second.handle
      })
    ).toEqual({ ok: false, error: "claimed" });
    claim.release();
    const retried = store.claim({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      handle: second.handle
    });
    if (!retried.ok) throw new Error("selection claim retry failed");
    retried.commit();
    retried.commit();
    retried.release();
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: second.handle
      })
    ).toEqual({ ok: false, error: "unknown" });

    const expiring = store.mint({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat",
      credentialSource: "keyring",
      generation: store.begin("panel")
    });
    if (!expiring) throw new Error("expiring selection mint failed");
    now = expiring.expiresAt;
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: expiring.handle
      })
    ).toEqual({ ok: false, error: "expired" });

    const invalidated = store.mint({
      instanceId: "panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat",
      credentialSource: "keyring",
      generation: store.begin("panel")
    });
    if (!invalidated) throw new Error("invalidated selection mint failed");
    store.begin("panel");
    expect(
      store.claim({
        instanceId: "panel",
        repo: "octo/app",
        environment: "dev",
        handle: invalidated.handle
      })
    ).toEqual({ ok: false, error: "unknown" });
  });

  it("prunes expired handles while minting new readiness results", () => {
    let now = 0;
    const store = createGitHubSelectionHandleStore({
      now: () => now,
      ttlMs: 10
    });
    const generation = store.begin("panel-a");
    const expired = store.mint({
      instanceId: "panel-a",
      repo: "octo/app",
      environment: "dev",
      login: "octocat",
      credentialSource: "keyring",
      generation
    });
    if (!expired) throw new Error("selection mint failed");
    now = 11;
    const otherGeneration = store.begin("panel-b");
    expect(
      store.mint({
        instanceId: "panel-b",
        repo: "octo/app",
        environment: "dev",
        login: "hubot",
        credentialSource: "keyring",
        generation: otherGeneration
      })
    ).not.toBeNull();

    expect(
      store.claim({
        instanceId: "panel-a",
        repo: "octo/app",
        environment: "dev",
        handle: expired.handle
      })
    ).toEqual({ ok: false, error: "unknown" });
  });

  it("uses secure defaults and makes release idempotent", () => {
    const store = createGitHubSelectionHandleStore();
    const generation = store.begin("new-panel");
    const minted = store.mint({
      instanceId: "new-panel",
      repo: "octo/app",
      environment: "dev",
      login: "octocat",
      credentialSource: "keyring",
      generation
    });
    if (!minted) throw new Error("selection mint failed");
    const claim = store.claim({
      instanceId: "new-panel",
      repo: "octo/app",
      environment: "dev",
      handle: minted.handle
    });
    if (!claim.ok) throw new Error("selection claim failed");

    claim.release();
    claim.release();
    const retry = store.claim({
      instanceId: "new-panel",
      repo: "octo/app",
      environment: "dev",
      handle: minted.handle
    });
    expect(retry.ok).toBe(true);
  });
});
import { createEnvironmentExecutionOwner } from "../../runtime/environment-execution-owner.js";
