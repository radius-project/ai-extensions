import type { WorkflowRunner } from "./workflow-reads.js";
import {
  createWorkflowReadContext,
  createWorkflowReadCooldowns,
  type WorkflowReadClock,
  type WorkflowReadContext
} from "@radius-project/core";

class WorkflowReadLimitError extends Error {
  constructor(readonly reason: "timeout" | "output-limit" | "cancelled") {
    super(`Workflow read exceeded its ${reason} limit.`);
  }
}

export function isWorkflowReadLimitError(
  error: unknown
): error is WorkflowReadLimitError {
  return error instanceof WorkflowReadLimitError;
}

export function createWorkflowReadSession(
  clock: WorkflowReadClock = {
    monotonic: () => performance.now(),
    wall: () => Date.now(),
    sleep: (milliseconds, cancellation) =>
      new Promise((resolve) => {
        const timer = setTimeout(done, milliseconds);
        let detach = () => {};
        function done() {
          clearTimeout(timer);
          detach();
          resolve();
        }
        detach = cancellation?.onStop?.(done) ?? (() => {});
        if (cancellation?.stopped()) done();
      }),
    jitter: () => Math.floor(Math.random() * 251)
  }
) {
  const cooldowns = createWorkflowReadCooldowns(clock.monotonic);
  return {
    observe(timeout: number, signal?: AbortSignal): WorkflowReadContext {
      const onStop = (listener: () => void) => {
        signal?.addEventListener("abort", listener, { once: true });
        return () => signal?.removeEventListener("abort", listener);
      };
      return createWorkflowReadContext({
        clock,
        cooldowns,
        timeout,
        stopped: () => signal?.aborted === true,
        onStop
      });
    }
  };
}

export function createWorkflowReadBudget(
  run: WorkflowRunner,
  timeout = 15000,
  maxBytes = 10 * 1024 * 1024,
  context?: WorkflowReadContext
): WorkflowRunner {
  const now = context?.clock.monotonic ?? (() => performance.now());
  const deadline = Math.min(now() + timeout, context?.deadline ?? Infinity);
  let remainingBytes = maxBytes;
  return async (args, options) => {
    const remaining = Math.min(Math.ceil(deadline - now()), options.timeout);
    if (options.signal?.aborted || context?.check().state === "stopped")
      throw new WorkflowReadLimitError("cancelled");
    if (remaining <= 0) throw new WorkflowReadLimitError("timeout");
    if (remainingBytes <= 0) throw new WorkflowReadLimitError("output-limit");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Promise executors run synchronously, before any stop listener is attached.
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const stop = () => {
      rejectStopped(new WorkflowReadLimitError("cancelled"));
      controller.abort();
    };
    const detach = context?.onStop?.(stop);
    options.signal?.addEventListener("abort", stop, { once: true });
    const checkInterrupted = () => {
      if (options.signal?.aborted || context?.check().state === "stopped")
        throw new WorkflowReadLimitError("cancelled");
      if (now() >= deadline) throw new WorkflowReadLimitError("timeout");
    };
    try {
      const result = await Promise.race([
        run(args, {
          ...options,
          timeout: Math.min(remaining, options.timeout),
          maxBuffer: Math.min(
            remainingBytes,
            options.maxBuffer ?? remainingBytes
          ),
          signal: controller.signal
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new WorkflowReadLimitError("timeout"));
            controller.abort();
          }, remaining);
        }),
        stopped
      ]);
      checkInterrupted();
      remainingBytes -=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (
        result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        remainingBytes < 0 ||
        (remainingBytes === 0 && Number(result.code) !== 0)
      )
        throw new WorkflowReadLimitError("output-limit");
      return result;
    } catch (error) {
      checkInterrupted();
      throw error;
    } finally {
      clearTimeout(timer);
      detach?.();
      options.signal?.removeEventListener("abort", stop);
    }
  };
}
