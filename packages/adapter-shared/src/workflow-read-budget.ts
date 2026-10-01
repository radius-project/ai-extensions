import type { WorkflowRunner } from "./workflow-reads.js";

class WorkflowReadLimitError extends Error {
  constructor(readonly reason: "timeout" | "output-limit") {
    super(`Workflow read exceeded its ${reason} limit.`);
  }
}

export function isWorkflowReadLimitError(
  error: unknown
): error is WorkflowReadLimitError {
  return error instanceof WorkflowReadLimitError;
}

export function createWorkflowReadBudget(
  run: WorkflowRunner,
  timeout = 15000,
  maxBytes = 10 * 1024 * 1024
): WorkflowRunner {
  const deadline = performance.now() + timeout;
  let remainingBytes = maxBytes;
  return async (args, options) => {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw new WorkflowReadLimitError("timeout");
    if (remainingBytes <= 0) throw new WorkflowReadLimitError("output-limit");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(args, {
          ...options,
          timeout: Math.min(remaining, options.timeout),
          maxBuffer: remainingBytes,
          signal: controller.signal
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new WorkflowReadLimitError("timeout"));
            controller.abort();
          }, remaining);
        })
      ]);
      if (performance.now() >= deadline)
        throw new WorkflowReadLimitError("timeout");
      remainingBytes -=
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (
        result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
        remainingBytes < 0 ||
        (remainingBytes === 0 && Number(result.code) !== 0)
      )
        throw new WorkflowReadLimitError("output-limit");
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}
