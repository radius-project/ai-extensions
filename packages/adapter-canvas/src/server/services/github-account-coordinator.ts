import type { SelectedGhExecutor } from "../../gh.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "../../gh-command-display.js";

export interface GitHubAccountCoordinatorPorts {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  getActiveKeyringLogin(): Promise<string>;
  switchKeyringAccount(login: string): Promise<{ ok: boolean; error?: string }>;
  resetIdentityCache(): void;
}

export interface GitHubAccountLeaseMetadata {
  ownerKey: string;
  operationId?: string;
  assertActive?(): void;
}

export interface GitHubAccountRestoration {
  state: "not_required" | "restored" | "changed_externally" | "failed";
  originalLogin: string | null;
  currentLogin: string | null;
  guidance: string | null;
}

export class GitHubAccountRestorationError extends Error {
  constructor(
    message: string,
    readonly restoration: GitHubAccountRestoration,
    cause: unknown
  ) {
    super(message, { cause });
    this.name = "GitHubAccountRestorationError";
  }
}

export interface GitHubAccountLeaseResult<T> {
  value: T;
  selectedLogin: string;
  credentialSource: SelectedGhExecutor["credentialSource"];
  switched: boolean;
  restoration: GitHubAccountRestoration;
}

// Lets lease work give up the lease while it waits on something with no
// deadline, and take it back before it needs the selected account again.
// Call it only from that work, and await each call before the next.
export interface GitHubAccountLease {
  // Restores the original account and gives up the lease. Does nothing if the
  // lease is already given up.
  release(): Promise<void>;
  // Takes the lease back and selects the account again. Does nothing if the
  // lease is held. `onWait` runs if another holder has it.
  retake(onWait?: () => void): Promise<void>;
}

const UNLEASED: GitHubAccountLease = {
  release: async () => {},
  retake: async () => {}
};

export interface GitHubAccountCoordinatorOptions {
  ghCommandPresentation?: GhCommandPresentation;
  setTimer?(
    callback: () => void,
    milliseconds: number
  ): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}

export interface GitHubAccountCoordinator {
  createReadOnlyExecutor(login: string): Promise<SelectedGhExecutor>;
  withSelectedAccount<T>(
    login: string,
    metadata: GitHubAccountLeaseMetadata,
    work: (
      executor: SelectedGhExecutor,
      lease: GitHubAccountLease
    ) => Promise<T>,
    timeoutMs?: number
  ): Promise<GitHubAccountLeaseResult<T>>;
}

interface Waiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve(release: () => void): void;
  reject(error: Error): void;
}

interface Selection {
  release(): void;
  originalLogin: string;
  switched: boolean;
}

function manualRecoveryGuidance(
  login: string,
  presentation: GhCommandPresentation
): string {
  const command = displayGhCommand(presentation, [
    "auth",
    "switch",
    "--hostname",
    "github.com",
    "--user",
    login
  ]);
  return command ?
      `Restore the original GitHub CLI account with: ${command}. ${presentation.installationNote}`.trim()
    : presentation.installationNote;
}

// Throws `cause`, with the restoration attached if it failed or someone else
// changed the account.
function throwAfterRestoration(
  executor: SelectedGhExecutor,
  cause: unknown,
  restoration: GitHubAccountRestoration
): never {
  if (
    restoration.state !== "failed" &&
    restoration.state !== "changed_externally"
  )
    throw cause;
  throw new GitHubAccountRestorationError(
    `${executor.errorMessage(cause)} ${
      restoration.state === "failed" ?
        "GitHub account restoration also failed."
      : "The GitHub CLI account changed externally."
    } ${restoration.guidance || ""}`.trim(),
    restoration,
    cause
  );
}

export function createGitHubAccountCoordinator(
  ports: GitHubAccountCoordinatorPorts,
  options: GitHubAccountCoordinatorOptions = {}
): GitHubAccountCoordinator {
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const ghCommandPresentation =
    options.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
  const waiters: Waiter[] = [];
  let held = false;
  let blockedRestoration: GitHubAccountRestoration | null = null;

  const releaseNext = (): void => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (!waiter || waiter.settled) continue;
      waiter.settled = true;

      if (waiter.timer) clearTimer(waiter.timer);
      waiter.resolve(releaseNext);
      return;
    }
    held = false;
  };

  const acquire = (
    timeoutMs: number | null,
    onWait?: () => void
  ): Promise<() => void> => {
    if (!held) {
      held = true;
      return Promise.resolve(releaseNext);
    }

    onWait?.();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        timer: null,
        resolve,
        reject
      };

      if (timeoutMs !== null) {
        waiter.timer = setTimer(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              "Another Environment Creation is using the GitHub CLI account. Re-check after it finishes."
            )
          );
        }, timeoutMs);
      }
      waiters.push(waiter);
    });
  };

  const assertRestorationReady = async (): Promise<void> => {
    if (!blockedRestoration) return;
    const currentLogin = await ports.getActiveKeyringLogin();
    if (currentLogin === blockedRestoration.originalLogin) {
      ports.resetIdentityCache();
      blockedRestoration = null;
      return;
    }
    throw new Error(
      `Radius cannot safely change GitHub CLI accounts because the previous account restoration failed. ${
        blockedRestoration.guidance || "Restore the original account and retry."
      }`
    );
  };

  const restore = async (
    selectedLogin: string,
    originalLogin: string
  ): Promise<GitHubAccountRestoration> => {
    let currentLogin = "";
    try {
      currentLogin = await ports.getActiveKeyringLogin();
      if (currentLogin !== selectedLogin) {
        ports.resetIdentityCache();
        return {
          state: "changed_externally",
          originalLogin,
          currentLogin,
          guidance: manualRecoveryGuidance(originalLogin, ghCommandPresentation)
        };
      }
      const switched = await ports.switchKeyringAccount(originalLogin);
      ports.resetIdentityCache();
      if (!switched.ok) {
        return {
          state: "failed",
          originalLogin,
          currentLogin,
          guidance: `${switched.error || "GitHub account restoration failed."} ${manualRecoveryGuidance(
            originalLogin,
            ghCommandPresentation
          )}`
        };
      }
      currentLogin = await ports.getActiveKeyringLogin();
      if (currentLogin !== originalLogin) {
        return {
          state: "failed",
          originalLogin,
          currentLogin,
          guidance: manualRecoveryGuidance(originalLogin, ghCommandPresentation)
        };
      }
      return {
        state: "restored",
        originalLogin,
        currentLogin,
        guidance: null
      };
    } catch (error) {
      return {
        state: "failed",
        originalLogin,
        currentLogin: currentLogin || null,
        guidance: `${
          error instanceof Error ? error.message : String(error)
        } ${manualRecoveryGuidance(originalLogin, ghCommandPresentation)}`
      };
    }
  };

  const unchanged = (login: string): GitHubAccountRestoration => ({
    state: "not_required",
    originalLogin: login,
    currentLogin: login,
    guidance: null
  });

  // Restores the original account if this lease switched it, then releases
  // the lease.
  const deselect = async (
    selection: Selection,
    selectedLogin: string
  ): Promise<GitHubAccountRestoration> => {
    try {
      if (!selection.switched) return unchanged(selection.originalLogin);
      const restoration = await restore(selectedLogin, selection.originalLogin);

      if (restoration.state === "failed") blockedRestoration = restoration;

      return restoration;
    } finally {
      selection.release();
    }
  };

  // Takes the lease and makes the selected account the active gh account.
  const select = async (
    executor: SelectedGhExecutor,
    timeoutMs: number | null,
    active: () => void,
    onWait?: () => void
  ): Promise<Selection> => {
    const selection: Selection = {
      release: await acquire(timeoutMs, onWait),
      originalLogin: "",
      switched: false
    };

    try {
      active();
      await assertRestorationReady();
      active();
      selection.originalLogin = await ports.getActiveKeyringLogin();
      active();

      if (!selection.originalLogin) {
        throw new Error(
          "Radius could not determine the original GitHub CLI account and did not switch accounts."
        );
      }

      if (selection.originalLogin !== executor.login) {
        const switched = await ports.switchKeyringAccount(executor.login);

        if (!switched.ok) {
          throw new Error(
            switched.error ||
              `Could not switch the GitHub CLI account to @${executor.login}.`
          );
        }

        selection.switched = true;
        ports.resetIdentityCache();
        active();
        const selectedActiveLogin = await ports.getActiveKeyringLogin();
        active();

        if (selectedActiveLogin !== executor.login) {
          throw new Error(
            `GitHub CLI account switch failed: expected @${executor.login}, received @${
              selectedActiveLogin || "unknown"
            }.`
          );
        }
      }

      await executor.verifyIdentity();
      active();

      return selection;
    } catch (error) {
      throwAfterRestoration(
        executor,
        error,
        await deselect(selection, executor.login)
      );
    }
  };

  const createReadOnlyExecutor = async (
    login: string
  ): Promise<SelectedGhExecutor> => {
    const executor = await ports.createExecutor(login);
    await executor.verifyIdentity();
    return executor;
  };

  const withSelectedAccount = async <T>(
    login: string,
    metadata: GitHubAccountLeaseMetadata,
    work: (
      executor: SelectedGhExecutor,
      lease: GitHubAccountLease
    ) => Promise<T>,
    timeoutMs = 5000
  ): Promise<GitHubAccountLeaseResult<T>> => {
    const active = () => metadata.assertActive?.();
    active();
    await assertRestorationReady();
    active();
    const executor = await ports.createExecutor(login);
    active();
    if (!executor.requiresKeyringSwitch) {
      const activeLogin = await ports.getActiveKeyringLogin();
      active();
      await executor.verifyIdentity();
      active();
      return {
        value: await work(executor, UNLEASED),
        selectedLogin: executor.login,
        credentialSource: executor.credentialSource,
        switched: false,
        restoration: {
          state: "not_required",
          originalLogin: activeLogin || null,
          currentLogin: activeLogin || null,
          guidance: null
        }
      };
    }

    let selection: Selection | null = await select(executor, timeoutMs, active);
    let switched = selection.switched;
    let restoration = unchanged(selection.originalLogin);

    // A failed restoration is always reported. Otherwise an external change
    // stays reported, because each restoration after it names the account
    // someone else selected as the original.
    const report = (next: GitHubAccountRestoration) => {
      if (next.state === "failed" || restoration.state !== "changed_externally")
        restoration = next;
    };

    const endSelection = async (held: Selection): Promise<void> => {
      selection = null;
      report(await deselect(held, executor.login));
    };

    const lease: GitHubAccountLease = {
      async release() {
        if (!selection) return;
        // An account someone else selected stays active, as at the end of a
        // lease, and the next restoration returns to it.
        await endSelection(selection);

        if (restoration.state === "failed") {
          throw new Error(
            `Radius stopped because it could not switch the GitHub CLI back to @${restoration.originalLogin}.`
          );
        }
      },
      async retake(onWait) {
        if (selection) return;

        // No timeout: work that gave up the lease has already made changes,
        // and every holder releases the lease when its own work finishes.
        try {
          selection = await select(executor, null, active, onWait);
        } catch (error) {
          if (!(error instanceof GitHubAccountRestorationError)) throw error;
          // Reported with the restoration from giving up the lease, which
          // names the account that was active before this lease.
          report(error.restoration);
          throw error.cause;
        }

        switched ||= selection.switched;
      }
    };

    let value: T;

    try {
      value = await work(executor, lease);
    } catch (error) {
      if (selection) await endSelection(selection);
      throwAfterRestoration(executor, error, restoration);
    }

    if (selection) await endSelection(selection);

    return {
      value,
      selectedLogin: executor.login,
      credentialSource: executor.credentialSource,
      switched,
      restoration
    };
  };

  return { createReadOnlyExecutor, withSelectedAccount };
}
