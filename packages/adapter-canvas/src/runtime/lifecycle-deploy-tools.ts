import {
  LIFECYCLE_API_VERSION,
  lifecycleError
} from "@radius-project/core/lifecycle";
import type { LifecycleBinding } from "./create-lifecycle-binding.js";

export async function lifecycleDeployTool(
  binding: LifecycleBinding,
  kind: "start" | "status",
  args: Record<string, unknown>
): Promise<string | undefined> {
  const known = binding.registry
    .knownOperations()
    .filter((operation) => operation.operation === "deployment.start");
  const selected =
    args.attemptId === undefined ?
      known.at(-1)
    : known.find((operation) =>
        operation.attempts.some(
          (attempt) => attempt.attemptId === args.attemptId
        )
      );
  if (!selected && binding.routing.selection("deployment").writer === "legacy")
    return undefined;
  const failure = (code: Parameters<typeof lifecycleError>[0]) =>
    JSON.stringify({
      apiVersion: LIFECYCLE_API_VERSION,
      error: lifecycleError(code)
    });
  if (!selected) return failure("OPERATION_UNAVAILABLE");
  if (kind === "status") {
    return JSON.stringify(
      await binding.execute({
        operation: "operation.get",
        target: {
          repo: selected.target.repo,
          environment: selected.target.environment,
          application: selected.target.application
        },
        input: { operationId: selected.operationId }
      })
    );
  }
  if (args.attemptId !== undefined) return failure("CAPABILITY_UNAVAILABLE");
  if (
    (args.repo !== undefined && args.repo !== selected.target.repo) ||
    (args.environment !== undefined &&
      args.environment !== selected.target.environment) ||
    (args.appFile !== undefined &&
      args.appFile !== selected.target.definition) ||
    (args.branch !== undefined &&
      (selected.source?.kind !== "git" ||
        args.branch !== selected.source.ref)) ||
    args.provider !== undefined ||
    binding.routing.selection("deployment").writer !== "lifecycle"
  )
    return failure("PRECONDITION_FAILED");
  if (selected.state === "queued" || selected.state === "running")
    return failure("DISPATCH_UNCONFIRMED");
  return JSON.stringify(
    await binding.execute({
      operation: "deployment.start",
      target: selected.target,
      input: { repairPolicy: { mode: "manual", maxAttempts: 0 } }
    })
  );
}
