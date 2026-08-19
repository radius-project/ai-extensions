import { describe, expect, it } from "vitest";
import {
  createGitHubAccountReadinessService,
  createGitHubSelectionHandleStore,
  probeGhcrPackageWriteAccess
} from "./github-account-readiness.js";
import type {
  GitHubAccountCoordinator,
  GitHubAccountLeaseResult
} from "./github-account-coordinator.js";
import type { SelectedGhCommandResult, SelectedGhExecutor } from "../../gh.js";

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
      token: "synthetic-package-credential"
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
    prepare: async () => ({ state: "none", guidance: null }),
    createReadOnlyExecutor: async () => executor,
    async withSelectedAccount(_login, _metadata, work) {
      const result: GitHubAccountLeaseResult<Awaited<ReturnType<typeof work>>> =
        {
          value: await work(executor),
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
  packageAccess = {
    ok: true,
    detail: "GitHub Packages granted pull and push access."
  }
) {
  return createGitHubAccountReadinessService(accountCoordinator, {
    probePackageAccess: async () => packageAccess
  });
}

describe("GitHub account readiness", () => {
  it("reports one ready result when every selected-account capability passes", async () => {
    const service = readinessService(coordinator(selectedExecutor({})));

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
  });

  it("refuses readiness when the original keyring account was not restored", async () => {
    const selected = selectedExecutor({});
    const failedRestoreCoordinator: GitHubAccountCoordinator = {
      prepare: async () => ({ state: "none", guidance: null }),
      createReadOnlyExecutor: async () => selected,
      async withSelectedAccount(_login, _metadata, work) {
        return {
          value: await work(selected),
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
  });

  it("reports missing workflow and package access without using another account", async () => {
    const service = readinessService(
      coordinator(selectedExecutor({ scopes: ["repo"] })),
      { ok: false, detail: "GitHub Packages push access is missing." }
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
    expect(result.repair).toContain(
      "gh auth switch --hostname github.com --user octocat"
    );
    expect(result.repair).toContain(
      "gh auth refresh --hostname github.com --scopes workflow,read:packages,write:packages"
    );
    expect(result.repair).toContain(
      "gh auth switch --hostname github.com --user original"
    );
    expect(result.repair).not.toContain(
      "auth refresh --hostname github.com --user"
    );
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
      prepare: async () => ({ state: "none", guidance: null }),
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
      prepare: async () => ({ state: "none", guidance: null }),
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
  it("verifies push with a cancellable upload session for the exact state package", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization: string;
    }> = [];

    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "Octo/App",
      "dev",
      async (url, init) => {
        requests.push({
          url,
          method: init.method || "GET",
          authorization: init.headers.Authorization
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
      ok: true,
      detail:
        "GitHub Packages accepted push authorization for the state package."
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
      ok: false,
      detail: "The GHCR package owner is invalid."
    });
  });

  it.each([
    [
      "a token endpoint network failure",
      async () => {
        throw new Error("offline");
      },
      "GitHub Packages authorization could not be verified."
    ],
    [
      "a rejected credential",
      async () => ({ ok: false, json: async () => ({}) }),
      "GitHub Packages rejected the selected account."
    ],
    [
      "a missing registry token",
      async () => ({ ok: true, json: async () => ({}) }),
      "GitHub Packages returned an invalid authorization response."
    ]
  ] as const)("fails safely for %s", async (_label, fetcher, detail) => {
    const result = await probeGhcrPackageWriteAccess(
      selectedExecutor({}),
      "octo/app",
      "dev",
      fetcher
    );
    expect(result).toEqual({ ok: false, detail });
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
      ok: false,
      detail:
        "GitHub Packages did not grant push access to the selected account."
    });
  });

  it.each(["", "https://example.test/upload"])(
    "rejects an unsafe upload cleanup location %s",
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
        ok: false,
        detail:
          "GitHub Packages granted an upload session that Radius could not safely clean up."
      });
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
    "fails readiness when upload cleanup %s",
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
        ok: false,
        detail:
          "GitHub Packages push access was verified, but the temporary upload session could not be removed."
      });
    }
  );

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
      ok: false,
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
    ).toEqual({ ok: false, error: "stale" });
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
    ).toEqual({ ok: false, error: "stale" });
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
