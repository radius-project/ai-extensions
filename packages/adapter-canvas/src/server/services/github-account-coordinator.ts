import type { SelectedGhExecutor } from "../../gh.js";

export interface GitHubAccountCoordinatorPorts {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  getActiveKeyringLogin(): Promise<string>;
  switchKeyringAccount(login: string): Promise<{ ok: boolean; error?: string }>;
  resetIdentityCache(): void;
}

export interface GitHubAccountLeaseMetadata {
  instanceId: string;
  operationId?: string;
}

export interface GitHubAccountRestoration {
  state: "not_required" | "restored" | "changed_externally" | "failed";
  originalLogin: string | null;
  currentLogin: string | null;
  guidance: string | null;
}

export interface GitHubAccountLeaseResult<T> {
  value: T;
  selectedLogin: string;
  credentialSource: SelectedGhExecutor["credentialSource"];
  switched: boolean;
  restoration: GitHubAccountRestoration;
}

export interface GitHubAccountRecoveryResult {
  state: "none";
  guidance: null;
}

export interface GitHubAccountCoordinatorOptions {
  setTimer?(
    callback: () => void,
    milliseconds: number
  ): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}

export interface GitHubAccountCoordinator {
  prepare(): Promise<GitHubAccountRecoveryResult>;
  createReadOnlyExecutor(login: string): Promise<SelectedGhExecutor>;
  withSelectedAccount<T>(
    login: string,
    metadata: GitHubAccountLeaseMetadata,
    work: (executor: SelectedGhExecutor) => Promise<T>,
    timeoutMs?: number
  ): Promise<GitHubAccountLeaseResult<T>>;
}

interface Waiter {
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(release: () => void): void;
  reject(error: Error): void;
}

function manualRecoveryGuidance(login: string): string {
  return `Restore the original GitHub CLI account with: gh auth switch --hostname github.com --user ${login}`;
}

export function createGitHubAccountCoordinator(
  ports: GitHubAccountCoordinatorPorts,
  options: GitHubAccountCoordinatorOptions = {}
): GitHubAccountCoordinator {
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const waiters: Waiter[] = [];
  let held = false;

  const releaseNext = (): void => {
    const waiter = waiters.shift();
    if (!waiter) {
      held = false;
      return;
    }
    if (waiter.settled) {
      releaseNext();
      return;
    }
    waiter.settled = true;
    clearTimer(waiter.timer);
    waiter.resolve(releaseNext);
  };

  const acquire = (timeoutMs: number): Promise<() => void> => {
    if (!held) {
      held = true;
      return Promise.resolve(releaseNext);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        timer: setTimer(() => {
          if (waiter.settled) return;
          waiter.settled = true;
          reject(
            new Error(
              "Another Radius operation is temporarily using the GitHub CLI account. Retry in a moment."
            )
          );
        }, timeoutMs),
        resolve,
        reject
      };
      waiters.push(waiter);
    });
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
          guidance: manualRecoveryGuidance(originalLogin)
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
            originalLogin
          )}`
        };
      }
      currentLogin = await ports.getActiveKeyringLogin();
      if (currentLogin !== originalLogin) {
        return {
          state: "failed",
          originalLogin,
          currentLogin,
          guidance: manualRecoveryGuidance(originalLogin)
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
        } ${manualRecoveryGuidance(originalLogin)}`
      };
    }
  };

  const prepare = (): Promise<GitHubAccountRecoveryResult> =>
    Promise.resolve({ state: "none", guidance: null });

  const createReadOnlyExecutor = async (
    login: string
  ): Promise<SelectedGhExecutor> => {
    const executor = await ports.createExecutor(login);
    await executor.verifyIdentity();
    return executor;
  };

  const withSelectedAccount = async <T>(
    login: string,
    _metadata: GitHubAccountLeaseMetadata,
    work: (executor: SelectedGhExecutor) => Promise<T>,
    timeoutMs = 5000
  ): Promise<GitHubAccountLeaseResult<T>> => {
    const executor = await ports.createExecutor(login);
    if (!executor.requiresKeyringSwitch) {
      const activeLogin = await ports.getActiveKeyringLogin();
      await executor.verifyIdentity();
      return {
        value: await work(executor),
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
    const release = await acquire(timeoutMs);
    try {
      const originalLogin = await ports.getActiveKeyringLogin();
      if (!originalLogin) {
        throw new Error(
          "Radius could not determine the original GitHub CLI account and did not switch accounts."
        );
      }
      if (originalLogin === executor.login) {
        await executor.verifyIdentity();
        return {
          value: await work(executor),
          selectedLogin: executor.login,
          credentialSource: executor.credentialSource,
          switched: false,
          restoration: {
            state: "not_required",
            originalLogin,
            currentLogin: originalLogin,
            guidance: null
          }
        };
      }

      const switched = await ports.switchKeyringAccount(executor.login);
      if (!switched.ok) {
        throw new Error(
          switched.error ||
            `Could not switch the GitHub CLI account to @${executor.login}.`
        );
      }

      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        ports.resetIdentityCache();
        const selectedActiveLogin = await ports.getActiveKeyringLogin();
        if (selectedActiveLogin !== executor.login) {
          throw new Error(
            `GitHub CLI account switch failed: expected @${executor.login}, received @${
              selectedActiveLogin || "unknown"
            }.`
          );
        }
        await executor.verifyIdentity();
        outcome = { ok: true, value: await work(executor) };
      } catch (error) {
        outcome = { ok: false, error };
      }

      const restoration = await restore(executor.login, originalLogin);
      if (!outcome.ok) {
        if (restoration.state === "restored") throw outcome.error;
        throw new Error(
          `${executor.errorMessage(outcome.error)} GitHub account restoration also failed. ${
            restoration.guidance || ""
          }`.trim(),
          { cause: outcome.error }
        );
      }
      return {
        value: outcome.value,
        selectedLogin: executor.login,
        credentialSource: executor.credentialSource,
        switched: true,
        restoration
      };
    } finally {
      release();
    }
  };

  return { prepare, createReadOnlyExecutor, withSelectedAccount };
}
