import {
  nameSchema,
  portCancelled,
  portFailure,
  portSuccess,
  type EnvironmentAccessPort,
  type EnvironmentReadPort,
  type EnvironmentReadPage,
  type EnvironmentReadResult,
  type ClockPort,
  type PortResult,
  type RequestControl,
  type AuthorizedScope
} from "@radius-project/core/lifecycle";
import { createRecipeEvidenceParser } from "./recipe-evidence.js";

export function readObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export interface GitHubDiscoveryRead {
  get(
    path: string,
    control: RequestControl,
    scope: AuthorizedScope
  ): Promise<PortResult<unknown>>;
  clock: Pick<ClockPort, "now">;
}
export interface EnvironmentReadMetadata {
  id: string;
  variables: Readonly<Record<string, string>>;
}
export function createEnvironmentReadAdapter(
  deps: GitHubDiscoveryRead & {
    registrations: EnvironmentAccessPort["registrations"];
    classifyProvider(variables: Record<string, string>): "azure" | "aws" | "";
    metadata?: {
      observe(
        target: { repo: string; environment: string },
        metadata: EnvironmentReadMetadata
      ): void;
    };
  }
): EnvironmentReadPort {
  if (
    [
      deps?.get,
      deps?.clock?.now,
      deps?.registrations,
      deps?.classifyProvider
    ].some((method) => typeof method !== "function") ||
    (deps.metadata !== undefined && typeof deps.metadata.observe !== "function")
  )
    throw new Error(
      "Environment reads require GitHub, registration evidence and clock ports."
    );
  const parseRecipes = createRecipeEvidenceParser();
  const validName = new RegExp(nameSchema.pattern);
  const observation = () => ({
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "configuration" as const,
    observedAt: deps.clock.now()
  });
  return {
    async list(scope, control) {
      const items: EnvironmentReadPage["items"] = [];
      let partial = false;
      for (let page = 1; page <= 10; page++) {
        if (control.cancellation.aborted)
          return portCancelled("request_cancelled");
        const result = await deps.get(
          `/repos/${scope.target.repo}/environments?per_page=100&page=${page}`,
          control,
          scope
        );
        if (result.status !== "ok") return result;
        if (
          !readObject(result.value) ||
          !Array.isArray(result.value.environments)
        )
          return portFailure("EVIDENCE_MISMATCH");
        for (const entry of result.value.environments) {
          if (
            !readObject(entry) ||
            typeof entry.name !== "string" ||
            !entry.name ||
            entry.name.length > nameSchema.maxLength ||
            !validName.test(entry.name)
          )
            return portFailure("EVIDENCE_MISMATCH");
          items.push({
            target: { repo: scope.target.repo, environment: entry.name },
            observation: {
              ...observation(),
              completeness: "partial",
              limitation:
                "Provider and recipe evidence are not included in the environment listing."
            }
          });
        }
        if (result.value.environments.length < 100) break;
        partial = page === 10;
      }
      return portSuccess({
        target: { ...scope.target },
        items,
        observation: {
          ...observation(),
          completeness: partial ? "partial" : "complete",
          ...(partial ?
            {
              limitation:
                "The environment observation is bounded to 1000 entries."
            }
          : {})
        }
      });
    },
    async inspect(scope, control) {
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const path = `/repos/${scope.target.repo}/environments/${encodeURIComponent(scope.target.environment)}`;
      const environment = await deps.get(path, control, scope);
      if (environment.status !== "ok") return environment;
      if (
        !readObject(environment.value) ||
        environment.value.name !== scope.target.environment ||
        !Array.isArray(environment.value.protection_rules)
      )
        return portFailure("EVIDENCE_MISMATCH");
      const rules = environment.value.protection_rules;
      if (
        rules.some((rule) => !readObject(rule) || typeof rule.type !== "string")
      )
        return portFailure("EVIDENCE_MISMATCH");
      const variables = await deps.get(
        `${path}/variables?per_page=100`,
        control,
        scope
      );
      if (variables.status !== "ok") return variables;
      if (
        !readObject(variables.value) ||
        !Array.isArray(variables.value.variables)
      )
        return portFailure("EVIDENCE_MISMATCH");
      const values = new Map<string, string>();
      for (const variable of variables.value.variables) {
        if (
          !readObject(variable) ||
          typeof variable.name !== "string" ||
          typeof variable.value !== "string"
        )
          return portFailure("EVIDENCE_MISMATCH");
        values.set(variable.name, variable.value);
      }
      const provider = deps.classifyProvider(Object.fromEntries(values));
      const registrations = await deps.registrations(
        scope,
        scope.target,
        control
      );
      if (
        registrations.status === "forbidden" ||
        registrations.status === "cancelled" ||
        registrations.status === "failed"
      )
        return registrations;
      const parsed =
        registrations.status === "ok" ?
          parseRecipes(scope.target, registrations.value)
        : undefined;
      if (parsed && parsed.status !== "ok") return parsed;
      const recipes = parsed?.status === "ok" ? parsed.value : undefined;
      if (
        recipes &&
        (recipes.target.repo !== scope.target.repo ||
          recipes.target.environment !== scope.target.environment ||
          (provider && recipes.provider !== provider))
      )
        return portFailure("EVIDENCE_MISMATCH");
      const observedProvider = provider || recipes?.provider;
      const result: EnvironmentReadResult = {
        target: { ...scope.target },
        ...(observedProvider === "azure" || observedProvider === "aws" ?
          {
            configuration: {
              provider: observedProvider,
              ...(recipes ?
                { recipes: recipes.recipes.map((recipe) => ({ ...recipe })) }
              : {})
            }
          }
        : {}),
        protections: {
          requiredReviewers: rules.some(
            (rule) => readObject(rule) && rule.type === "required_reviewers"
          )
        },
        observation: {
          ...observation(),
          completeness: "partial",
          limitation:
            "Read-only configuration is partial; identity references and provider settings are not inferred."
        },
        recipeObservation:
          registrations.status === "ok" ?
            { ...registrations.value.observation }
          : { ...registrations.observation },
        limitations:
          registrations.status === "unavailable" ?
            [
              registrations.observation.limitation ??
                "Actual recipe registrations are unavailable from this read context."
            ]
          : []
      };
      deps.metadata?.observe(scope.target, {
        id:
          (
            typeof environment.value.id === "number" ||
            typeof environment.value.id === "string"
          ) ?
            String(environment.value.id)
          : "",
        variables: Object.fromEntries(values)
      });
      return portSuccess(result);
    }
  };
}
