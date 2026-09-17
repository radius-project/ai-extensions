import { createHash } from "node:crypto";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  sameLifecycleData,
  type AuthorizationRequest,
  type AuthorizedScope,
  type HostCallerBinding,
  type IdentityPort,
  type LifecycleRequestFor,
  type PortResult,
  type Provider,
  type RequestControl
} from "@radius-project/core/lifecycle";
import { readObject } from "@radius-project/adapter-shared";
import { isUuid, parseCallerIdentity } from "../azure-oidc.js";
import type { LifecycleAuthority } from "./lifecycle-authorization.js";

export interface LifecycleCredentialDependencies {
  readonly providers: readonly Provider[];
  readonly inspect: IdentityPort["inspect"];
  readonly configure?: IdentityPort["configure"];
}
export interface CanvasCredentialDependencies {
  readonly authority: LifecycleAuthority;
  hostBinding(): HostCallerBinding;
  readonly clock: { now(): string };
  runCommand(
    command: "az" | "aws",
    args: string[],
    control: RequestControl
  ): Promise<string>;
  configure?(
    scope: AuthorizedScope<"credentials.configure">,
    input: LifecycleRequestFor<"credentials.configure">["input"],
    control: RequestControl
  ): Promise<PortResult<void>>;
}

export function createCanvasLifecycleCredentials(
  deps: CanvasCredentialDependencies
): LifecycleCredentialDependencies {
  if (
    [
      deps?.authority?.resolveCaller,
      deps?.authority?.authorize,
      deps?.hostBinding,
      deps?.clock?.now,
      deps?.runCommand
    ].some((method) => typeof method !== "function") ||
    (deps.configure !== undefined && typeof deps.configure !== "function")
  )
    throw new Error(
      "Credential inspection requires current identity, scoped authority, a clock and a command runner."
    );
  async function verify(
    scope: AuthorizedScope,
    control: RequestControl
  ): Promise<PortResult<void>> {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const caller = await deps.authority.resolveCaller(
      deps.hostBinding(),
      control
    );
    if (caller.status !== "ok") return caller;
    if (caller.value.principalRef !== scope.principalRef)
      return portForbidden();
    const authorized = await deps.authority.authorize(
      { ...scope, caller: caller.value } as AuthorizationRequest,
      control
    );
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    if (authorized.status !== "ok") return authorized;
    return (
        authorized.value.authorizationRef &&
          authorized.value.principalRef === scope.principalRef &&
          authorized.value.operation === scope.operation &&
          authorized.value.operationId === scope.operationId &&
          (scope.approvalRef === undefined ||
            authorized.value.approvalRef === scope.approvalRef) &&
          sameLifecycleData(
            authorized.value.configuration,
            scope.configuration
          ) &&
          sameLifecycleData(authorized.value.target, scope.target)
      ) ?
        portSuccess(undefined)
      : portForbidden();
  }
  async function observe(
    provider: Provider,
    repo: string,
    control: RequestControl
  ) {
    const unavailable = {
      provider,
      status: "unavailable" as const,
      reason:
        "The provider identity could not be verified. No login or configuration was attempted."
    };
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await deps.runCommand(
          provider === "azure" ? "az" : "aws",
          provider === "azure" ?
            ["account", "show", "-o", "json"]
          : ["sts", "get-caller-identity", "--output", "json"],
          control
        )
      );
    } catch (error) {
      const missing =
        error instanceof Error &&
        /please run ['"]?az login|unable to locate credentials|sso session.*expired/i.test(
          error.message
        );
      return missing ?
          {
            provider,
            status: "missing" as const,
            reason:
              "Explicit authentication is required. Inspection did not start a login."
          }
        : unavailable;
    }
    if (!readObject(parsed)) return unavailable;
    let identity: readonly string[];
    if (provider === "azure") {
      if (
        !isUuid(parsed.tenantId) ||
        !isUuid(parsed.id) ||
        !readObject(parsed.user) ||
        typeof parsed.user.name !== "string" ||
        !parsed.user.name.trim() ||
        parsed.user.name.length > 1024 ||
        parseCallerIdentity(JSON.stringify(parsed.user)).kind === "unsupported"
      )
        return unavailable;
      identity = [
        String(parsed.tenantId).toLowerCase(),
        String(parsed.id).toLowerCase(),
        parsed.user.name
      ];
    } else {
      if (
        typeof parsed.Account !== "string" ||
        !/^\d{12}$/.test(parsed.Account) ||
        typeof parsed.Arn !== "string" ||
        parsed.Arn.length > 2048 ||
        !/^arn:aws(?:-cn|-us-gov)?:(?:iam|sts)::\d{12}:[^\s]+$/.test(
          parsed.Arn
        ) ||
        parsed.Arn.split(":")[4] !== parsed.Account
      )
        return unavailable;
      identity = [parsed.Account, parsed.Arn];
    }
    const identityRef = `${provider}:${createHash("sha256")
      .update(JSON.stringify([repo.toLowerCase(), provider, ...identity]))
      .digest("hex")}`;
    return {
      provider,
      status: "satisfied" as const,
      identityRef,
      reason:
        "The current provider identity was verified without authentication or configuration."
    };
  }
  const inspect: IdentityPort["inspect"] = async (scope, input, control) => {
    const authorized = await verify(scope, control);
    if (authorized.status !== "ok") return authorized;
    const providers: readonly Provider[] =
      input.provider ? [input.provider] : ["azure", "aws"];
    const prerequisites = await Promise.all(
      providers.map((provider) => observe(provider, scope.target.repo, control))
    );
    const current = await verify(scope, control);
    if (current.status !== "ok") return current;
    const unavailable = prerequisites.filter(
      (item) => item.status === "unavailable"
    ).length;
    return portSuccess({
      prerequisites,
      observation: {
        quality: unavailable ? "unknown" : "current",
        completeness:
          unavailable === prerequisites.length ? "unavailable"
          : unavailable ? "partial"
          : "complete",
        evidence: "configuration",
        observedAt: deps.clock.now()
      }
    });
  };
  const configureIdentity = deps.configure;
  return {
    providers: ["azure", "aws"],
    inspect,
    ...(configureIdentity ?
      {
        configure: async (scope, input, control) => {
          const authorized = await verify(scope, control);
          if (authorized.status !== "ok") return authorized;
          const result = await configureIdentity(scope, input, control);
          if (result.status !== "ok") return result;
          const observed = await inspect(
            { ...scope, operation: "credentials.inspect" },
            { provider: input.provider },
            control
          );
          if (observed.status !== "ok") return observed;
          const identity = observed.value.prerequisites[0];
          if (
            !identity ||
            identity.status !== "satisfied" ||
            !identity.identityRef ||
            (input.identityRef && input.identityRef !== identity.identityRef)
          )
            return portFailure("PRECONDITION_FAILED");
          return portSuccess({
            identityRef: identity.identityRef,
            observation: observed.value.observation
          });
        }
      }
    : {})
  };
}
