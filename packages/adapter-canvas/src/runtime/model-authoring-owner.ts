import type {
  CommittedModelIdentity,
  ManagedModelStaging,
  ObservedModelFile
} from "../app-model-staging.js";
import { isRadProcessExitUnconfirmed } from "@radius-project/adapter-shared";

// Runs the stage's check on a copy of the run in `stagingDir`.
export type AuthoringValidator = (
  stagingDir: string,
  signal: AbortSignal
) => Promise<void>;

export interface AuthoringTarget {
  repo: string;
  branch: string;
  workspace: string;
  sourceRevision: string;
}

interface AuthoringRequest {
  token: string;
  target: AuthoringTarget;
  staging: ManagedModelStaging;
  validate: AuthoringValidator;
  validation: AbortController;
  current(): boolean;
  settled?(promoted: boolean, identity?: CommittedModelIdentity): void;
  finalizing: boolean;
  promoted: boolean;
  identity?: CommittedModelIdentity;
  mode: "missing" | "refresh";
}

function sameTarget(left: AuthoringTarget, right: AuthoringTarget): boolean {
  return (
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.workspace === right.workspace &&
    left.sourceRevision === right.sourceRevision
  );
}

export function createModelAuthoringOwner(ports: {
  staging(
    workspace: string,
    observed?: readonly ObservedModelFile[]
  ): ManagedModelStaging;
  resolveTarget(): Promise<AuthoringTarget | null>;
}) {
  const requests = new Map<string, AuthoringRequest>();
  const activeWork = new Set<Promise<unknown>>();
  let closed = false;
  let unconfirmedExit = false;

  async function drainable<T>(work: Promise<T>): Promise<T> {
    activeWork.add(work);
    try {
      return await work;
    } catch (error) {
      if (isRadProcessExitUnconfirmed(error)) unconfirmedExit = true;
      throw error;
    } finally {
      activeWork.delete(work);
    }
  }

  function settle(request: AuthoringRequest) {
    if (requests.get(request.token) !== request) return;
    requests.delete(request.token);
    request.validation.abort();
    try {
      request.staging.cancel();
    } finally {
      if (request.identity)
        request.settled?.(request.promoted, request.identity);
      else request.settled?.(request.promoted);
    }
  }

  function assertCurrent(request: AuthoringRequest) {
    if (
      closed ||
      requests.get(request.token) !== request ||
      !request.current()
    ) {
      settle(request);
      throw new Error("The Radius authoring request is no longer current.");
    }
  }

  async function assertCurrentTarget(request: AuthoringRequest) {
    assertCurrent(request);
    try {
      const target = await ports.resolveTarget();
      assertCurrent(request);
      if (!target || !sameTarget(request.target, target)) {
        throw new Error("The authoring source or worktree changed.");
      }
    } catch (error) {
      settle(request);
      throw error;
    }
  }

  function assertCurrentBaseline(request: AuthoringRequest) {
    assertCurrent(request);
    try {
      request.staging.assertBaseline();
    } catch (error) {
      settle(request);
      throw error;
    }
  }

  function requestFor(token: string) {
    const request = requests.get(token);
    if (!request)
      throw new Error("Unknown or expired Radius authoring request.");
    return request;
  }

  return {
    begin(
      token: string,
      target: AuthoringTarget,
      current: () => boolean,
      validate: AuthoringValidator,
      settled?: AuthoringRequest["settled"],
      mode: AuthoringRequest["mode"] = "refresh",
      observed?: readonly ObservedModelFile[]
    ) {
      if (closed || !token || !target.sourceRevision || !current()) {
        throw new Error("Cannot establish a current Radius authoring source.");
      }
      if (requests.has(token)) throw new Error("Duplicate authoring request.");
      const staging =
        observed ?
          ports.staging(target.workspace, observed)
        : ports.staging(target.workspace);
      for (const request of requests.values()) {
        if (request.target.workspace === target.workspace && !request.promoted)
          settle(request);
      }
      requests.set(token, {
        token,
        target: { ...target },
        staging,
        validate,
        validation: new AbortController(),
        current,
        settled,
        finalizing: false,
        promoted: false,
        mode
      });
      return staging.stagingDir;
    },
    currentRun(
      repo: string,
      branches: readonly string[],
      workspace: string | null | undefined
    ) {
      if (closed || !workspace) return undefined;
      for (const request of requests.values()) {
        if (request.promoted || request.target.workspace !== workspace)
          continue;
        if (!request.current()) {
          settle(request);
          continue;
        }
        if (
          request.target.repo === repo &&
          branches.includes(request.target.branch)
        ) {
          return {
            token: request.token,
            stagingDir: request.staging.stagingDir,
            mode: request.mode,
            branch: request.target.branch
          };
        }
      }
      return undefined;
    },
    retire(token: string) {
      const request = requests.get(token);
      if (request && !request.promoted) settle(request);
    },
    retireStale(token: string) {
      const request = requests.get(token);
      if (request && !request.promoted && !request.current()) settle(request);
    },
    cancel(token: string) {
      const request = requests.get(token);
      if (!request) return false;
      if (request.promoted)
        throw new Error(
          "The model is already committed to disk; cancellation is too late."
        );
      settle(request);
      return true;
    },
    async close() {
      closed = true;
      for (const request of requests.values()) {
        if (!request.promoted) settle(request);
      }
      await Promise.allSettled(activeWork);
      return !unconfirmedExit;
    },
    assertStandalone(workspace: string | null | undefined) {
      if (closed) throw new Error("Radius publication is shutting down.");
      for (const request of requests.values()) {
        if (request.target.workspace === workspace && request.current()) {
          throw new Error(
            "This worktree has an active managed Radius authoring request. Publish after it completes or is cancelled."
          );
        }
      }
    },
    async finish(token: string) {
      const request = requestFor(token);
      assertCurrent(request);
      if (request.finalizing)
        throw new Error("The Radius authoring request is already finalizing.");
      request.finalizing = true;
      return drainable(
        (async () => {
          try {
            await assertCurrentTarget(request);
            assertCurrentBaseline(request);
            await request.staging.validate(
              (stagingDir) =>
                request.validate(stagingDir, request.validation.signal),
              isRadProcessExitUnconfirmed
            );
            return await request.staging.promote(
              () => assertCurrentTarget(request),
              () => assertCurrentBaseline(request),
              {
                onFilesystemCommitted: (identity) => {
                  request.promoted = true;
                  request.identity = identity;
                }
              }
            );
          } finally {
            settle(request);
          }
        })()
      );
    }
  };
}
