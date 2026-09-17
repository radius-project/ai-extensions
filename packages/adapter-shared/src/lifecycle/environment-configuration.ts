import {
  lifecycleError,
  planEnvironmentConfiguration,
  portCancelled,
  portFailure,
  portSuccess,
  sameLifecycleData,
  type AuthorizedScope,
  type ConfigurationResult,
  type EnvironmentAccessPort,
  type EnvironmentConfigurationPlan,
  type EnvironmentConfigurationReceipt,
  type EnvironmentInspection,
  type Observation,
  type PortResult,
  type ReadResult,
  type RecipeRegistrationEvidence,
  type RequestControl,
  type WorkflowIntent
} from "@radius-project/core/lifecycle";
import {
  qualifiedLifecycleWorkflowAssets,
  type QualifiedWorkflowAssets
} from "./workflow-qualification.js";

type Scope = AuthorizedScope<"environment.create" | "environment.configure">;
type EnvironmentIntent = Extract<
  WorkflowIntent,
  { operation: "environment.create" | "environment.configure" }
>;
export interface EnvironmentWorkflowPreview {
  readonly intent: EnvironmentIntent;
  readonly assets: QualifiedWorkflowAssets;
}
export interface EnvironmentWorkflowPublication extends EnvironmentWorkflowPreview {
  readonly commit: string;
  readonly observation: Observation;
}
export interface EnvironmentConfigurationDependencies {
  readonly clock: { now(): string };
  authorize(
    scope: Scope,
    plan: EnvironmentConfigurationPlan,
    control: RequestControl
  ): Promise<PortResult<void>>;
  inspect(
    scope: Scope,
    control: RequestControl
  ): Promise<ReadResult<EnvironmentInspection>>;
  prepare(
    scope: Scope,
    plan: EnvironmentConfigurationPlan,
    control: RequestControl
  ): Promise<PortResult<EnvironmentWorkflowPreview>>;
  write(
    scope: Scope,
    plan: EnvironmentConfigurationPlan,
    control: RequestControl
  ): Promise<PortResult<void>>;
  publish(
    scope: Scope,
    preview: EnvironmentWorkflowPreview,
    control: RequestControl
  ): Promise<PortResult<EnvironmentWorkflowPublication>>;
  registerRecipes(
    scope: Scope,
    intent: EnvironmentIntent,
    publication: EnvironmentWorkflowPublication,
    control: RequestControl
  ): Promise<ReadResult<RecipeRegistrationEvidence>>;
}

function baseline(value: EnvironmentInspection | null) {
  return (
    value && {
      target: value.target,
      configuration: value.configuration,
      protections: value.protections
    }
  );
}
function metadataMatches(
  plan: EnvironmentConfigurationPlan,
  actual: EnvironmentInspection
): boolean {
  return (
    sameLifecycleData(actual.target, plan.target) &&
    actual.observation.quality === "current" &&
    actual.configuration?.provider === plan.configuration.provider &&
    actual.configuration.identityRef === plan.configuration.identityRef &&
    sameLifecycleData(
      actual.configuration.settings,
      plan.configuration.settings
    ) &&
    (!plan.expected ||
      sameLifecycleData(actual.protections, plan.expected.protections))
  );
}

export function createEnvironmentConfigurationAdapter(
  deps: EnvironmentConfigurationDependencies
): Pick<EnvironmentAccessPort, "configure"> {
  if (
    [
      deps?.clock?.now,
      deps?.authorize,
      deps?.inspect,
      deps?.prepare,
      deps?.write,
      deps?.publish,
      deps?.registerRecipes
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Environment configuration requires qualified publishers, current authority and actual recipe evidence."
    );
  return {
    async configure(scope, input, control) {
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const plan = structuredClone(input);
      if (
        !scope.operationId ||
        scope.operation !== plan.change.operation ||
        !sameLifecycleData(scope.target, plan.target) ||
        !sameLifecycleData(scope.configuration, plan.change)
      )
        return portFailure("PRECONDITION_FAILED");
      const authorized = await deps.authorize(scope, plan, control);
      if (authorized.status !== "ok") return authorized;
      const current = await deps.inspect(scope, control);
      if (current.status !== "ok" && current.status !== "absent")
        return current;
      const actual = current.status === "ok" ? current.value : null;
      const rebuilt = planEnvironmentConfiguration(
        plan.target,
        plan.change,
        actual
      );
      if (rebuilt.status !== "ok") return rebuilt;
      if (
        !sameLifecycleData(baseline(actual), baseline(plan.expected)) ||
        !sameLifecycleData(rebuilt.value.configuration, plan.configuration)
      )
        return portFailure("PRECONDITION_FAILED");
      const prepared = await deps.prepare(scope, plan, control);
      if (prepared.status !== "ok") return prepared;
      const preview = structuredClone(prepared.value);
      if (
        !sameLifecycleData(preview.intent, {
          operation: plan.change.operation,
          target: plan.target,
          change: plan.change
        }) ||
        !qualifiedLifecycleWorkflowAssets(preview.assets)
      )
        return portFailure("PRECONDITION_FAILED");
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const phases: ConfigurationResult["phases"] = [
        "environment",
        "workflows",
        "recipes"
      ].map((phase) => ({
        phase: phase as "environment" | "workflows" | "recipes",
        status: "skipped",
        reason: "A preceding configuration phase has not completed."
      }));
      let inspection: EnvironmentInspection | undefined;
      const incomplete = (
        index: number,
        result: ReadResult<unknown> | null,
        code?: "EVIDENCE_MISMATCH"
      ): PortResult<EnvironmentConfigurationReceipt> => {
        const uncertain =
          !code &&
          (!result ||
            ["unavailable", "cancelled", "absent"].includes(result.status));
        phases[index] = {
          ...phases[index],
          status: uncertain ? "unknown" : "failed",
          reason:
            uncertain ?
              "The external outcome is unconfirmed; this operation must not repeat the write."
            : "The configuration phase or its required evidence failed."
        };
        const error =
          code ? lifecycleError(code)
          : result && "error" in result ?
            lifecycleError(result.error.code, {
              diagnostics: result.error.details
            })
          : lifecycleError("RESULT_UNAVAILABLE");
        return portSuccess({
          state: uncertain ? "running" : "failed",
          phases,
          ...(inspection ? { inspection } : {}),
          error,
          observation: {
            quality: uncertain ? "unknown" : "current",
            completeness: "partial",
            evidence: "configuration",
            observedAt: deps.clock.now()
          }
        });
      };
      async function admittedPhase(
        index: number,
        execute: () => Promise<ReadResult<unknown>>
      ) {
        if (control.cancellation.aborted)
          return incomplete(index, portCancelled("request_cancelled"));
        const authority = await deps.authorize(scope, plan, control);
        if (authority.status !== "ok") return incomplete(index, authority);
        try {
          const result = await execute();
          if (result.status !== "ok") return incomplete(index, result);
          phases[index] = {
            ...phases[index],
            status: "succeeded",
            reason: "The declared configuration phase completed."
          };
          return null;
        } catch {
          return incomplete(index, null);
        }
      }
      const written = await admittedPhase(0, () =>
        deps.write(scope, plan, control)
      );
      if (written) return written;
      const observed = await deps.inspect(scope, control);
      if (observed.status !== "ok") return incomplete(0, observed);
      inspection = observed.value;
      if (!metadataMatches(plan, inspection))
        return incomplete(0, null, "EVIDENCE_MISMATCH");
      let publication: EnvironmentWorkflowPublication | undefined;
      const published = await admittedPhase(1, async () => {
        const result = await deps.publish(scope, preview, control);
        if (result.status === "ok") publication = result.value;
        return result;
      });
      if (published) return published;
      if (
        !publication ||
        !sameLifecycleData(publication.intent, preview.intent) ||
        !sameLifecycleData(publication.assets, preview.assets) ||
        !/^[a-f0-9]{40}$/.test(publication.commit) ||
        publication.observation.quality !== "current" ||
        publication.observation.completeness !== "complete"
      )
        return incomplete(1, null, "EVIDENCE_MISMATCH");
      const committed = publication;
      let registrations: RecipeRegistrationEvidence | undefined;
      const registered = await admittedPhase(2, async () => {
        const result = await deps.registerRecipes(
          scope,
          preview.intent,
          committed,
          control
        );
        if (result.status === "ok") registrations = result.value;
        return result;
      });
      if (registered) return registered;
      if (
        !registrations ||
        !sameLifecycleData(registrations.target, plan.target) ||
        registrations.provider !== plan.configuration.provider ||
        registrations.observation.evidence !== "radius" ||
        registrations.observation.quality !== "current" ||
        registrations.observation.completeness !== "complete" ||
        !sameLifecycleData(registrations.recipes, plan.configuration.recipes)
      )
        return incomplete(2, null, "EVIDENCE_MISMATCH");
      const final = await deps.inspect(scope, control);
      if (final.status !== "ok") return incomplete(2, final);
      if (!metadataMatches(plan, final.value))
        return incomplete(2, null, "EVIDENCE_MISMATCH");
      return portSuccess({
        state: "succeeded",
        inspection: {
          ...final.value,
          configuration: {
            ...plan.configuration,
            recipes: registrations.recipes
          },
          recipeObservation: registrations.observation
        },
        phases,
        observation: {
          quality: "current",
          completeness: "complete",
          evidence: "configuration",
          observedAt: deps.clock.now()
        }
      });
    }
  };
}
