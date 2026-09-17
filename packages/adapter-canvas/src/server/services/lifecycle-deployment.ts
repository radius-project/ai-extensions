import type { LifecycleBinding } from "../../runtime/create-lifecycle-binding.js";
import type { CanvasState } from "../../shared.js";

export function createLifecycleDeploymentHttp(deps: {
  readonly binding: LifecycleBinding;
  readonly state: CanvasState;
  resolveApplication(repo: string, branch: string): Promise<string>;
}) {
  return {
    async start(body: string) {
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        return { status: 400, body: { error: "Invalid deployment request." } };
      }
      if (
        typeof input !== "object" ||
        input === null ||
        typeof (
          Reflect.get(input, "targetRepo") ?? Reflect.get(input, "repo")
        ) !== "string" ||
        typeof Reflect.get(input, "environment") !== "string" ||
        typeof Reflect.get(input, "branch") !== "string"
      )
        return {
          status: 400,
          body: {
            error: "Explicit repository, environment and branch required."
          }
        };
      const repo: string =
        Reflect.get(input, "targetRepo") ?? Reflect.get(input, "repo");
      if (
        Reflect.get(input, "repo") !== undefined &&
        Reflect.get(input, "repo") !== repo
      )
        return {
          status: 400,
          body: { error: "Conflicting repository targets." }
        };
      const environment: string = Reflect.get(input, "environment");
      const branch: string = Reflect.get(input, "branch");
      const appFile: unknown = Reflect.get(input, "appFile");
      const approvalRef: unknown = Reflect.get(input, "approvalRef");
      if (appFile !== undefined && typeof appFile !== "string")
        return { status: 400, body: { error: "Invalid definition path." } };
      if (approvalRef !== undefined && typeof approvalRef !== "string")
        return { status: 400, body: { error: "Invalid approval reference." } };
      const source = await deps.binding.resolveCommittedSource(repo, branch);
      if (source.status !== "ok")
        return {
          status: 400,
          body: { error: "Published source unavailable." }
        };
      const application = await deps.resolveApplication(repo, branch);
      const result = await deps.binding.execute({
        operation: "deployment.start",
        target: {
          repo,
          environment,
          application,
          definition: appFile ?? ".radius/app.bicep",
          source: source.value
        },
        input: {
          ...(typeof approvalRef === "string" ? { approvalRef } : {}),
          repairPolicy: { mode: "manual", maxAttempts: 0 }
        }
      });
      if ("error" in result)
        return {
          status: 400,
          body: { error: result.error.message, errorKind: result.error.code }
        };
      if (result.operation !== "deployment.start")
        throw new Error("Unexpected lifecycle deployment response");
      deps.state.lifecycleDeploymentId = result.result.operationId;
      deps.state.deployingRepo = repo;
      deps.state.deployEnvName = environment;
      deps.state.deployAppName = application;
      return {
        status: 200,
        body: {
          ok: true,
          operationId: result.result.operationId,
          status: "unconfirmed"
        }
      };
    },
    async status() {
      const result = await deps.binding.execute({
        operation: "operation.get",
        target: {
          repo: deps.state.deployingRepo,
          environment: deps.state.deployEnvName,
          application: deps.state.deployAppName
        },
        input: { operationId: deps.state.lifecycleDeploymentId }
      });
      if ("error" in result)
        return {
          status: "unconfirmed",
          error: result.error.message,
          errorKind: result.error.code,
          repairing: false
        };
      if (result.operation !== "operation.get")
        throw new Error("Unexpected lifecycle observation response");
      const record = result.result;
      const status =
        record.state === "failed" || record.state === "cancelled" ? record.state
        : (
          record.observation.quality !== "current" ||
          record.observation.completeness !== "complete"
        ) ?
          "unconfirmed"
        : record.state === "succeeded" ? "success"
        : "in_progress";
      return {
        status,
        operationId: record.operationId,
        operation: record,
        observation: record.observation,
        phases: record.result?.kind === "execution" ? record.result.phases : [],
        error: record.error?.message ?? record.observation.limitation ?? null,
        errorKind: record.error?.code ?? null,
        repairing: false,
        logs: [],
        logBase: 0,
        logTotal: 0,
        resources: [],
        active: status === "in_progress",
        handoff: { state: "idle", attempts: 0, maxAttempts: 0, pending: false }
      };
    }
  };
}
