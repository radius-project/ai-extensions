import { describe, expect, it } from "vitest";
import {
  createGitHubAccountCoordinator,
  type GitHubAccountCoordinatorPorts
} from "./github-account-coordinator.js";
import type {
  SelectedGhCommandResult,
  SelectedGhCredentialSource,
  SelectedGhExecutor
} from "../../gh.js";

function executor(
  login: string,
  credentialSource: SelectedGhCredentialSource,
  requiresKeyringSwitch: boolean,
  events: string[]
): SelectedGhExecutor {
  const run = async (): Promise<SelectedGhCommandResult> => ({
    code: 0,
    stdout: "",
    stderr: ""
  });
  return {
    login,
    credentialSource,
    requiresKeyringSwitch,
    scopes: ["repo", "workflow", "write:packages"],
    run,
    runOrThrow: run,
    async verifyIdentity() {
      events.push(`verify:${login}`);
    },
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

function ports(input: {
  activeLogin: string;
  events: string[];
  source?: SelectedGhCredentialSource;
  requiresKeyringSwitch?: boolean;
  switchFailure?: string;
}): GitHubAccountCoordinatorPorts {
  let activeLogin = input.activeLogin;
  return {
    createExecutor: async (login) =>
      executor(
        login,
        input.source || "keyring",
        input.requiresKeyringSwitch ?? true,
        input.events
      ),
    getActiveKeyringLogin: async () => activeLogin,
    switchKeyringAccount: async (login) => {
      input.events.push(`switch:${login}`);
      if (input.switchFailure) {
        return { ok: false, error: input.switchFailure };
      }
      activeLogin = login;
      return { ok: true };
    },
    resetIdentityCache: () => input.events.push("reset")
  };
}

describe("GitHub account coordinator", () => {
  it("verifies a read-only selected executor", async () => {
    const events: string[] = [];
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events })
    );

    await expect(
      coordinator.createReadOnlyExecutor("selected")
    ).resolves.toMatchObject({ login: "selected" });
    expect(events).toEqual(["verify:selected"]);
  });

  it("uses an injected or same-login keyring credential without switching", async () => {
    const scenarios = [
      {
        activeLogin: "original",
        source: "injected" as const,
        requiresKeyringSwitch: false
      },
      {
        activeLogin: "selected",
        source: "keyring" as const,
        requiresKeyringSwitch: true
      }
    ];
    for (const scenario of scenarios) {
      const events: string[] = [];
      const coordinator = createGitHubAccountCoordinator(
        ports({ ...scenario, events })
      );
      const result = await coordinator.withSelectedAccount(
        "selected",
        { instanceId: "panel" },
        async () => "done"
      );
      expect(result).toMatchObject({
        value: "done",
        selectedLogin: "selected",
        switched: false,
        restoration: { state: "not_required" }
      });
      expect(events).toEqual(["verify:selected"]);
    }
  });

  it("switches for selected work and restores the original account", async () => {
    const events: string[] = [];
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events })
    );

    const result = await coordinator.withSelectedAccount(
      "selected",
      { instanceId: "panel", operationId: "operation-1" },
      async () => {
        events.push("work");
        return "done";
      }
    );

    expect(result).toMatchObject({
      value: "done",
      switched: true,
      restoration: {
        state: "restored",
        originalLogin: "original",
        currentLogin: "original"
      }
    });
    expect(events).toEqual([
      "switch:selected",
      "reset",
      "verify:selected",
      "work",
      "switch:original",
      "reset"
    ]);
  });

  it("does not overwrite an account changed externally during work", async () => {
    let activeLogin = "original";
    const events: string[] = [];
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => executor(login, "keyring", true, events),
      getActiveKeyringLogin: async () => activeLogin,
      switchKeyringAccount: async (login) => {
        activeLogin = login;
        events.push(`switch:${login}`);
        return { ok: true };
      },
      resetIdentityCache: () => events.push("reset")
    });

    const result = await coordinator.withSelectedAccount(
      "selected",
      { instanceId: "panel" },
      async () => {
        activeLogin = "external";
        return "done";
      }
    );

    expect(result.restoration).toMatchObject({
      state: "changed_externally",
      originalLogin: "original",
      currentLogin: "external"
    });
    expect(events).not.toContain("switch:original");
    expect(events.at(-1)).toBe("reset");
  });

  it("restores after selected work fails", async () => {
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events: [] })
    );
    const failure = new Error("setup failed");

    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { instanceId: "panel" },
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
  });

  it("reports setup and restoration failures together", async () => {
    let activeLogin = "original";
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => executor(login, "keyring", true, []),
      getActiveKeyringLogin: async () => activeLogin,
      switchKeyringAccount: async (login) => {
        if (login === "original") {
          return { ok: false, error: "restore denied" };
        }
        activeLogin = login;
        return { ok: true };
      },
      resetIdentityCache: () => {}
    });

    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { instanceId: "panel" },
        async () => {
          throw new Error("setup failed");
        }
      )
    ).rejects.toThrow(
      "setup failed GitHub account restoration also failed. restore denied"
    );
  });

  it("blocks later leases until the original account is active after restoration fails", async () => {
    let activeLogin = "original";
    let denyRestore = true;
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => executor(login, "keyring", true, []),
      getActiveKeyringLogin: async () => activeLogin,
      switchKeyringAccount: async (login) => {
        if (login === "original" && denyRestore) {
          return { ok: false, error: "restore denied" };
        }
        activeLogin = login;
        return { ok: true };
      },
      resetIdentityCache: () => {}
    });

    const first = await coordinator.withSelectedAccount(
      "selected",
      { instanceId: "one" },
      async () => "done"
    );
    expect(first.restoration.state).toBe("failed");
    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { instanceId: "two" },
        async () => "never"
      )
    ).rejects.toThrow("cannot safely change GitHub CLI accounts");

    denyRestore = false;
    activeLogin = "original";
    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { instanceId: "three" },
        async () => "recovered"
      )
    ).resolves.toMatchObject({ value: "recovered" });
  });

  it("blocks a queued lease when the active lease fails to restore", async () => {
    let activeLogin = "original";
    let releaseWork: () => void = () => {};
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let enteredWork: () => void = () => {};
    const workEntered = new Promise<void>((resolve) => {
      enteredWork = resolve;
    });
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => executor(login, "keyring", true, []),
      getActiveKeyringLogin: async () => activeLogin,
      switchKeyringAccount: async (login) => {
        if (login === "original") {
          return { ok: false, error: "restore denied" };
        }
        activeLogin = login;
        return { ok: true };
      },
      resetIdentityCache: () => {}
    });
    const first = coordinator.withSelectedAccount(
      "selected",
      { instanceId: "one" },
      async () => {
        enteredWork();
        await workGate;
        return "first";
      }
    );
    await workEntered;
    const second = coordinator.withSelectedAccount(
      "selected",
      { instanceId: "two" },
      async () => "second"
    );

    releaseWork();

    await expect(first).resolves.toMatchObject({
      value: "first",
      restoration: { state: "failed" }
    });
    await expect(second).rejects.toThrow(
      "cannot safely change GitHub CLI accounts"
    );
  });

  it("fails closed when the original account cannot be established", async () => {
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "", events: [] })
    );

    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { instanceId: "panel" },
        async () => "never"
      )
    ).rejects.toThrow("could not determine the original");
  });

  it("surfaces switch failure without running selected work", async () => {
    let ran = false;
    const coordinator = createGitHubAccountCoordinator(
      ports({
        activeLogin: "original",
        events: [],
        switchFailure: "switch denied"
      })
    );

    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { instanceId: "panel" },
        async () => {
          ran = true;
          return "never";
        }
      )
    ).rejects.toThrow("switch denied");
    expect(ran).toBe(false);
  });

  it("serializes selected-account switches within this process", async () => {
    const events: string[] = [];
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events })
    );
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    let workCount = 0;
    const work = async (): Promise<string> => {
      workCount += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (workCount === 1) {
        firstEntered();
        await firstGate;
      }
      active -= 1;
      return "done";
    };

    const runs = [
      coordinator.withSelectedAccount("selected", { instanceId: "one" }, work),
      coordinator.withSelectedAccount("selected", { instanceId: "two" }, work)
    ];
    await entered;
    releaseFirst();
    await Promise.all(runs);

    expect(workCount).toBe(2);
    expect(maximumActive).toBe(1);
  });

  it("returns a retryable busy error after the acquisition timeout", async () => {
    type Timer = ReturnType<typeof setTimeout>;
    const callbacks: Array<() => void> = [];
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events: [] }),
      {
        setTimer: (callback) => {
          callbacks.push(callback);
          return callbacks.length as unknown as Timer;
        },
        clearTimer: () => {}
      }
    );
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = coordinator.withSelectedAccount(
      "selected",
      { instanceId: "one" },
      async () => {
        firstEntered();
        await firstGate;
        return "done";
      }
    );
    await entered;
    const second = coordinator.withSelectedAccount(
      "selected",
      { instanceId: "two" },
      async () => "never",
      100
    );
    while (callbacks.length === 0) await Promise.resolve();
    callbacks[0]?.();

    await expect(second).rejects.toThrow(
      "Another Environment Creation is using the GitHub CLI account. Re-check after it finishes."
    );
    releaseFirst();
    await first;
  });
});
