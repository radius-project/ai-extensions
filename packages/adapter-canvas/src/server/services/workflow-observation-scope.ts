import {
  WORKFLOW_READ_LIMITS,
  type WorkflowReadClock
} from "@radius-project/core";
import {
  createWorkflowReadSession,
  type WorkflowReadRequest,
  type WorkflowArtifactReaderOptions
} from "@radius-project/adapter-shared";
import type { createDeployStatusReader } from "../../deploy-artifacts.js";

type Reader = ReturnType<typeof createDeployStatusReader>;

/** View lifetime only; deployment identity and mutation ownership stay elsewhere. */
export function createWorkflowObservationScope(
  createReader: (options: WorkflowArtifactReaderOptions) => Reader,
  clock?: WorkflowReadClock
) {
  const controller = new AbortController();
  const session = createWorkflowReadSession(clock);
  const readers = new Map<string, Reader>();
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;

  const identity = (executor?: object): string => {
    if (!executor) return "ambient";
    let id = identities.get(executor);
    if (id === undefined) {
      id = ++nextIdentity;
      identities.set(executor, id);
    }
    return `selected:${id}`;
  };

  return {
    get stopped() {
      return controller.signal.aborted;
    },
    async delay(milliseconds: number): Promise<void> {
      const context = session.observe(milliseconds + 1, controller.signal);
      await context.clock.sleep(milliseconds, {
        stopped: () => controller.signal.aborted,
        onStop: context.onStop
      });
    },
    observe(
      executor?: object,
      timeout: number = WORKFLOW_READ_LIMITS.observationMs
    ): WorkflowReadRequest {
      return {
        context: session.observe(timeout, controller.signal),
        identity: identity(executor)
      };
    },
    reader(options: WorkflowArtifactReaderOptions): Reader {
      if (controller.signal.aborted)
        throw new Error("Workflow observation stopped.");
      const key = JSON.stringify([
        options.identity ?? "ambient",
        options.repo,
        options.environment ?? "",
        options.application ?? "",
        options.runId ?? ""
      ]);
      const cached = readers.get(key);
      if (cached) {
        readers.delete(key);
        readers.set(key, cached);
        return cached;
      }
      const reader = createReader({
        ...options,
        identity: options.identity ?? "ambient",
        session,
        signal: controller.signal
      });
      readers.set(key, reader);
      if (readers.size > 32) {
        const oldest = readers.keys().next().value;
        if (oldest !== undefined) readers.delete(oldest);
      }
      return reader;
    },
    stop(): void {
      controller.abort();
      readers.clear();
    }
  };
}

export type WorkflowObservationScope = ReturnType<
  typeof createWorkflowObservationScope
>;
