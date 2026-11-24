import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSetupExecutionActive,
  isSetupExecutionInterrupted
} from "@radius-project/core";
import {
  createGitHubAccountCoordinator,
  GitHubAccountRestorationError,
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
  afterEach(() => vi.useRealTimers());

  it("preserves an external-change error when the command presentation supplies no recovery guidance", async () => {
    let active = "original";
    const coordinator = createGitHubAccountCoordinator(
      {
        createExecutor: async () => executor("selected", "keyring", true, []),
        getActiveKeyringLogin: async () => active,
        switchKeyringAccount: async (login) => {
          active = login;
          return { ok: true };
        },
        resetIdentityCache() {}
      },
      {
        ghCommandPresentation: {
          kind: "unavailable",
          shell: "posix",
          installationNote: ""
        }
      }
    );
    const cause = new Error("work failed");
    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { ownerKey: "runtime" },
        async () => {
          active = "external";
          throw cause;
        }
      )
    ).rejects.toMatchObject({
      cause,
      message: "work failed The GitHub CLI account changed externally.",
      restoration: { state: "changed_externally", guidance: "" }
    });
    expect(active).toBe("external");
  });

  it.each([
    ["create", true, "original"],
    ["read", false, "original"],
    ["identity", false, "original"],
    ["read", true, "original"],
    ["identity", true, "selected"],
    ["switch", true, "original"],
    ["selected-read", true, "original"],
    ["identity", true, "original"]
  ] as const)(
    "fences forward work after %s (switch=%s, active=%s) but restores an issued switch",
    async (boundary, requiresSwitch, initial) => {
      let stopped = false;
      let active = initial as string;
      const events: string[] = [];
      const work = vi.fn(async () => "value");
      const selected = executor("selected", "keyring", requiresSwitch, events);
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => {
          events.push("create");
          if (boundary === "create") stopped = true;
          return {
            ...selected,
            verifyIdentity: async () => {
              events.push("identity");
              if (boundary === "identity") stopped = true;
            }
          };
        },
        getActiveKeyringLogin: async () => {
          events.push(`read:${active}`);
          if (
            boundary === "read" ||
            (boundary === "selected-read" && active === "selected")
          )
            stopped = true;
          return active;
        },
        switchKeyringAccount: async (login) => {
          events.push(`switch:${login}`);
          active = login;
          if (boundary === "switch") stopped = true;
          return { ok: true };
        },
        resetIdentityCache() {}
      });
      await expect(
        coordinator.withSelectedAccount(
          "selected",
          {
            ownerKey: "runtime",
            assertActive: () => assertSetupExecutionActive(() => stopped)
          },
          work
        )
      ).rejects.toMatchObject({ code: "setup-execution-interrupted" });
      expect(work).not.toHaveBeenCalled();
      expect(active).toBe(initial);
      if (events.includes("switch:selected"))
        expect(events.at(-2)).toBe("switch:original");
      else
        expect(events.some((event) => event.startsWith("switch:"))).toBe(false);
    }
  );

  it.each(["acquire", "timeout"] as const)(
    "retains the queued 3000ms lease until %s and refuses new work when stopped",
    async (end) => {
      vi.useFakeTimers();
      const events: string[] = [];
      const coordinator = createGitHubAccountCoordinator(
        ports({ activeLogin: "original", events })
      );
      let release = () => {};
      let entered = () => {};
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = coordinator.withSelectedAccount(
        "holder",
        { ownerKey: "other" },
        async () => {
          entered();
          await gate;
        }
      );
      await reached;
      let stopped = false;
      const work = vi.fn(async () => {});
      const queued = coordinator.withSelectedAccount(
        "queued",
        {
          ownerKey: "runtime",
          assertActive: () => assertSetupExecutionActive(() => stopped)
        },
        work,
        3000
      );
      const observed = queued.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      stopped = true;
      await vi.advanceTimersByTimeAsync(2999);
      expect(work).not.toHaveBeenCalled();
      if (end === "timeout") {
        await vi.advanceTimersByTimeAsync(1);
        expect(await observed).toMatchObject({
          message: expect.stringContaining("Another Environment Creation")
        });
      }
      release();
      await holder;
      if (end === "acquire")
        expect(isSetupExecutionInterrupted(await observed)).toBe(true);
      expect(events).not.toContain("switch:queued");
      expect(work).not.toHaveBeenCalled();
      await expect(
        coordinator.withSelectedAccount(
          "original",
          { ownerKey: "next" },
          async () => "next"
        )
      ).resolves.toMatchObject({ value: "next" });
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(["failed", "changed_externally"] as const)(
    "preserves interruption in an ordinary %s restoration carrier",
    async (state) => {
      const cause = new Error("interrupted");
      let active = "original";
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => executor("selected", "keyring", true, []),
        getActiveKeyringLogin: async () => active,
        switchKeyringAccount: async (login) => {
          if (login === "original")
            return { ok: false, error: "restore unavailable" };
          active = login;
          return { ok: true };
        },
        resetIdentityCache() {}
      });
      const error = await coordinator
        .withSelectedAccount("selected", { ownerKey: "runtime" }, async () => {
          if (state === "changed_externally") active = "external";
          throw cause;
        })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(GitHubAccountRestorationError);
      expect(error).toMatchObject({ cause, restoration: { state } });
      expect(isSetupExecutionInterrupted(error)).toBe(false);
      expect(active).toBe(state === "failed" ? "selected" : "external");
    }
  );

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
        { ownerKey: "runtime" },
        async (_executor, lease) => {
          await lease.release();
          events.push("released");
          await lease.retake();

          return "done";
        }
      );
      expect(result).toMatchObject({
        value: "done",
        selectedLogin: "selected",
        switched: false,
        restoration: { state: "not_required" }
      });
      expect(events).toEqual(
        scenario.requiresKeyringSwitch ?
          ["verify:selected", "released", "verify:selected"]
        : ["verify:selected", "released"]
      );
    }
  });

  it("switches for selected work and restores the original account", async () => {
    const events: string[] = [];
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events })
    );

    const result = await coordinator.withSelectedAccount(
      "selected",
      { ownerKey: "runtime", operationId: "operation-1" },
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
    const coordinator = createGitHubAccountCoordinator(
      {
        createExecutor: async (login) =>
          executor(login, "keyring", true, events),
        getActiveKeyringLogin: async () => activeLogin,
        switchKeyringAccount: async (login) => {
          activeLogin = login;
          events.push(`switch:${login}`);
          return { ok: true };
        },
        resetIdentityCache: () => events.push("reset")
      },
      {
        ghCommandPresentation: {
          kind: "absolute",
          shell: "posix",
          executablePath: "/opt/Copilot Tools/gh",
          installationNote: "Install GitHub CLI system-wide."
        }
      }
    );

    const result = await coordinator.withSelectedAccount(
      "selected",
      { ownerKey: "runtime" },
      async () => {
        activeLogin = "external";
        return "done";
      }
    );

    expect(result.restoration).toMatchObject({
      state: "changed_externally",
      originalLogin: "original",
      currentLogin: "external",
      guidance: expect.stringContaining(
        "'/opt/Copilot Tools/gh' auth switch --hostname github.com --user original"
      )
    });
    expect(events).not.toContain("switch:original");
    expect(events.at(-1)).toBe("reset");
  });

  it.each([
    [
      "before it gives up the lease",
      true,
      ["external", "selected"],
      {
        state: "changed_externally",
        originalLogin: "original",
        currentLogin: "external"
      }
    ],
    [
      "while the lease is given up",
      false,
      ["original", "selected"],
      { state: "restored", originalLogin: "external" }
    ]
  ] as const)(
    "keeps an account someone else selects %s",
    async (_when, beforeRelease, value, restoration) => {
      let activeLogin = "original";

      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => executor(login, "keyring", true, []),
        getActiveKeyringLogin: async () => activeLogin,
        switchKeyringAccount: async (login) => {
          activeLogin = login;

          return { ok: true };
        },
        resetIdentityCache() {}
      });

      const result = await coordinator.withSelectedAccount(
        "selected",
        { ownerKey: "runtime" },
        async (_executor, lease) => {
          if (beforeRelease) activeLogin = "external";
          await lease.release();
          const released = activeLogin;

          if (!beforeRelease) activeLogin = "external";
          await lease.retake();

          return [released, activeLogin];
        }
      );

      expect(result).toMatchObject({ value, switched: true, restoration });
      expect(activeLogin).toBe("external");
    }
  );

  it("reports an external change when work fails after giving up the lease", async () => {
    let activeLogin = "original";

    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => executor(login, "keyring", true, []),
      getActiveKeyringLogin: async () => activeLogin,
      switchKeyringAccount: async (login) => {
        activeLogin = login;

        return { ok: true };
      },
      resetIdentityCache() {}
    });

    const failure = new Error("AWS setup failed");

    const result = await coordinator
      .withSelectedAccount(
        "selected",
        { ownerKey: "runtime" },
        async (_executor, lease) => {
          activeLogin = "external";
          await lease.release();
          throw failure;
        }
      )
      .catch((cause: unknown) => cause);

    expect(result).toBeInstanceOf(GitHubAccountRestorationError);
    expect(result).toMatchObject({
      cause: failure,
      restoration: { state: "changed_externally", originalLogin: "original" }
    });
  });

  it("keeps an earlier external change when it cannot take the lease back", async () => {
    let activeLogin = "original";

    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => executor(login, "keyring", true, []),
      getActiveKeyringLogin: async () => activeLogin,
      switchKeyringAccount: async (login) => {
        // The switch reports success but leaves the external account active.
        if (activeLogin !== "external") activeLogin = login;

        return { ok: true };
      },
      resetIdentityCache() {}
    });

    const result = await coordinator
      .withSelectedAccount(
        "selected",
        { ownerKey: "runtime" },
        async (_executor, lease) => {
          activeLogin = "external";
          await lease.release();
          await lease.retake();
        }
      )
      .catch((cause: unknown) => cause);

    expect(result).toBeInstanceOf(GitHubAccountRestorationError);
    expect(result).toMatchObject({
      message: expect.stringContaining(
        "expected @selected, received @external"
      ),
      cause: expect.objectContaining({
        message:
          "GitHub CLI account switch failed: expected @selected, received @external."
      }),
      restoration: {
        state: "changed_externally",
        originalLogin: "original",
        currentLogin: "external",
        guidance: expect.stringContaining("--user original")
      }
    });
  });

  it("lets another run take the lease while it is given up, and waits for it with no timeout", async () => {
    vi.useFakeTimers();
    const events: string[] = [];

    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events })
    );

    let releaseOther: () => void = () => {};

    const otherGate = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });

    let other: Promise<unknown> = Promise.resolve();

    const run = coordinator.withSelectedAccount(
      "selected",
      { ownerKey: "setup" },
      async (_executor, lease) => {
        await lease.release();
        let otherEntered: () => void = () => {};

        const entered = new Promise<void>((resolve) => {
          otherEntered = resolve;
        });

        other = coordinator.withSelectedAccount(
          "other",
          { ownerKey: "readiness" },
          async () => {
            events.push("other work");
            otherEntered();
            await otherGate;
          }
        );
        await entered;
        await lease.retake(() => {
          events.push("waiting");
          setTimeout(releaseOther, 60_000);
        });
        events.push("selected work");

        return "done";
      }
    );

    await vi.advanceTimersByTimeAsync(60_000);
    const result = await run;
    await other;

    expect(result).toMatchObject({
      value: "done",
      switched: true,
      restoration: { state: "restored", originalLogin: "original" }
    });
    expect(events).toEqual([
      "switch:selected",
      "reset",
      "verify:selected",
      "switch:original",
      "reset",
      "switch:other",
      "reset",
      "verify:other",
      "other work",
      "waiting",
      "switch:original",
      "reset",
      "switch:selected",
      "reset",
      "verify:selected",
      "selected work",
      "switch:original",
      "reset"
    ]);
  });

  it.each([
    {
      resume: "rejected",
      error: Error,
      message: "switch denied"
    },
    {
      resume: "wrong account",
      error: GitHubAccountRestorationError,
      message: "expected @selected, received @original"
    }
  ])(
    "fails to take the lease back like the first switch and releases it: $resume",
    async ({ resume, error, message }) => {
      let activeLogin = "original";
      let selectedSwitches = 0;

      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => executor(login, "keyring", true, []),
        getActiveKeyringLogin: async () => activeLogin,
        switchKeyringAccount: async (login) => {
          if (login === "selected" && ++selectedSwitches === 2) {
            return resume === "rejected" ?
                { ok: false, error: "switch denied" }
              : { ok: true };
          }

          activeLogin = login;

          return { ok: true };
        },
        resetIdentityCache() {}
      });

      const result = await coordinator
        .withSelectedAccount(
          "selected",
          { ownerKey: "runtime" },
          async (_executor, lease) => {
            await lease.release();
            await lease.retake();

            return "done";
          }
        )
        .catch((cause: unknown) => cause);

      expect(result).toBeInstanceOf(error);
      expect(result).toMatchObject({
        message: expect.stringContaining(message)
      });
      expect(activeLogin).toBe("original");
      await expect(
        coordinator.withSelectedAccount(
          "selected",
          { ownerKey: "runtime" },
          async () => "next"
        )
      ).resolves.toMatchObject({ value: "next" });
    }
  );

  it("stops work when it cannot restore the original account", async () => {
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
      resetIdentityCache() {}
    });

    const outsideWork = vi.fn();

    const result = await coordinator
      .withSelectedAccount(
        "selected",
        { ownerKey: "runtime" },
        async (_executor, lease) => {
          await lease.release();
          outsideWork();
        }
      )
      .catch((cause: unknown) => cause);

    expect(result).toBeInstanceOf(GitHubAccountRestorationError);
    expect(result).toMatchObject({
      message: expect.stringContaining(
        "Radius stopped because it could not switch the GitHub CLI back to @original."
      ),
      restoration: { state: "failed" }
    });
    expect(outsideWork).not.toHaveBeenCalled();
    expect(activeLogin).toBe("selected");
  });

  it("restores after selected work fails", async () => {
    const coordinator = createGitHubAccountCoordinator(
      ports({ activeLogin: "original", events: [] })
    );
    const failure = new Error("setup failed");

    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { ownerKey: "runtime" },
        async () => {
          throw failure;
        }
      )
    ).rejects.toBe(failure);
  });

  it.each([false, true])(
    "does not take the lease back after work that gave it up ends, failed=%s",
    async (fails) => {
      const events: string[] = [];

      const coordinator = createGitHubAccountCoordinator(
        ports({ activeLogin: "original", events })
      );

      const failure = new Error("AWS setup failed");

      const result = await coordinator
        .withSelectedAccount(
          "selected",
          { ownerKey: "runtime" },
          async (_executor, lease) => {
            await lease.release();
            await lease.release();
            events.push("released");

            if (fails) throw failure;

            return "done";
          }
        )
        .catch((cause: unknown) => cause);

      expect(result).toEqual(
        fails ? failure : (
          expect.objectContaining({
            value: "done",
            switched: true,
            restoration: expect.objectContaining({ state: "restored" })
          })
        )
      );
      expect(events).toEqual([
        "switch:selected",
        "reset",
        "verify:selected",
        "switch:original",
        "reset",
        "released"
      ]);
    }
  );

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
        { ownerKey: "runtime" },
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
      { ownerKey: "one" },
      async () => "done"
    );
    expect(first.restoration.state).toBe("failed");
    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { ownerKey: "two" },
        async () => "never"
      )
    ).rejects.toThrow("cannot safely change GitHub CLI accounts");

    denyRestore = false;
    activeLogin = "original";
    await expect(
      coordinator.withSelectedAccount(
        "selected",
        { ownerKey: "three" },
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
      { ownerKey: "one" },
      async () => {
        enteredWork();
        await workGate;
        return "first";
      }
    );
    await workEntered;
    const second = coordinator.withSelectedAccount(
      "selected",
      { ownerKey: "two" },
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
        { ownerKey: "runtime" },
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
        { ownerKey: "runtime" },
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
      coordinator.withSelectedAccount("selected", { ownerKey: "one" }, work),
      coordinator.withSelectedAccount("selected", { ownerKey: "two" }, work)
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
      { ownerKey: "one" },
      async () => {
        firstEntered();
        await firstGate;
        return "done";
      }
    );
    await entered;
    const second = coordinator.withSelectedAccount(
      "selected",
      { ownerKey: "two" },
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
