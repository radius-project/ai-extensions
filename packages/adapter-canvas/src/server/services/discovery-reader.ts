import {
  createApplicationDiscovery,
  createEnvironmentDiscovery,
  lifecycleError,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type ApplicationPage,
  type AuthorizedScope,
  type CallerContext,
  type EnvironmentReadResult,
  type LifecycleError,
  type PortResult,
  type LifecycleOperation,
  type AuthorizationRequest,
  type CancellationSignal,
  portCancelled,
  repositorySchema
} from "@radius-project/core/lifecycle";
import { isAbsolute } from "node:path";
import {
  readObject,
  type EnvironmentReadMetadata
} from "@radius-project/adapter-shared";
import {
  createCanvasDiscoveryContext,
  type CanvasDiscoveryDependencies
} from "../../runtime/create-discovery-context.js";
import { createDiscoveryGitHubRead } from "../../runtime/discovery-github-read.js";
import { unavailableCanvasLifecyclePrerequisite } from "../../runtime/lifecycle-authorization.js";
import { discoveryControl } from "./discovery-cancellation.js";

export interface LegacyEnvironmentEvidence {
  inspection: EnvironmentReadResult;
  metadata: EnvironmentReadMetadata;
}
export interface LegacyDiscoverySession {
  cacheKey: string;
  applications(branch: string): Promise<PortResult<ApplicationPage>>;
  environments(): Promise<
    PortResult<{ entries: LegacyEnvironmentEvidence[]; error?: LifecycleError }>
  >;
  run(args: string[]): Promise<{ ok: boolean; stdout: string }>;
  close(): Promise<void>;
}
export interface LegacyDiscoveryReader {
  open(
    repo: string,
    instanceId: string,
    cancellation?: CancellationSignal
  ): Promise<PortResult<LegacyDiscoverySession>>;
}
export interface LegacyDiscoveryDependencies extends Pick<
  CanvasDiscoveryDependencies,
  "storageRoot" | "clock" | "ids" | "git" | "executor"
> {
  identity(): Promise<{ actingLogin: string }>;
  workspace(
    instanceId: string
  ): ReturnType<CanvasDiscoveryDependencies["workspace"]>;
}
export function createLegacyDiscoveryReader(
  deps: LegacyDiscoveryDependencies
): LegacyDiscoveryReader {
  if (
    [
      deps?.identity,
      deps?.workspace,
      deps?.git,
      deps?.executor,
      deps?.clock?.now,
      deps?.ids?.next
    ].some((fn) => typeof fn !== "function") ||
    typeof deps.storageRoot !== "string" ||
    !isAbsolute(deps.storageRoot)
  )
    throw new Error(
      "Legacy discovery requires complete trusted read dependencies."
    );
  return {
    async open(repo, instanceId, cancellation) {
      let unsubscribe: (() => void) | undefined;
      try {
        if (cancellation?.aborted) return portCancelled("request_cancelled");
        if (
          repo.length > repositorySchema.maxLength ||
          !new RegExp(repositorySchema.pattern).test(repo)
        )
          return portFailure("INVALID_REQUEST");
        const identity = await deps.identity();
        if (!identity.actingLogin)
          return unavailableCanvasLifecyclePrerequisite();
        const caller: CallerContext = {
          principalRef: `github:${identity.actingLogin}`,
          identityRef: `github:${identity.actingLogin}`,
          sessionRef: instanceId,
          responder: "user"
        };
        const binding = {
          sessionRef: instanceId,
          bindingRef: deps.ids.next("request")
        };
        const abort = new AbortController();
        unsubscribe = cancellation?.onAbort(() => abort.abort());
        if (cancellation?.aborted) abort.abort();
        const control = discoveryControl(
          deps.ids.next("request"),
          abort.signal
        );
        const verify = async () =>
          (await deps.identity()).actingLogin === identity.actingLogin ?
            portSuccess(undefined)
          : portForbidden();
        const scope: AuthorizedScope<"environment.list"> = {
          operation: "environment.list",
          target: { repo },
          principalRef: caller.principalRef,
          authorizationRef: binding.bindingRef
        };
        const get = createDiscoveryGitHubRead({
          verify,
          executor: deps.executor
        });
        const visible = await get(`/repos/${repo}`, control, scope);
        if (visible.status !== "ok") {
          unsubscribe?.();
          return visible;
        }
        if (
          !readObject(visible.value) ||
          typeof visible.value.full_name !== "string" ||
          visible.value.full_name.toLowerCase() !== repo.toLowerCase()
        ) {
          unsubscribe?.();
          return portFailure("EVIDENCE_MISMATCH");
        }
        const metadata = new Map<string, EnvironmentReadMetadata>();
        const context = createCanvasDiscoveryContext({
          ...deps,
          workspace: () => deps.workspace(instanceId),
          hostBinding: () => binding,
          authority: {
            resolveCaller: async (requested) => {
              const verified = await verify();
              if (verified.status !== "ok") return verified;
              return (
                  requested.sessionRef === binding.sessionRef &&
                    requested.bindingRef === binding.bindingRef
                ) ?
                  portSuccess(caller)
                : portForbidden();
            },
            authorize: async <O extends LifecycleOperation>(
              request: AuthorizationRequest<O>
            ) => {
              const verified = await verify();
              if (verified.status !== "ok") return verified;
              if (
                request.target.repo !== repo ||
                request.caller.principalRef !== caller.principalRef ||
                request.caller.sessionRef !== instanceId ||
                ![
                  "application.list",
                  "application.inspect",
                  "environment.list",
                  "environment.inspect"
                ].includes(request.operation)
              )
                return portForbidden();
              const approved: AuthorizedScope = {
                ...request,
                principalRef: caller.principalRef,
                authorizationRef: binding.bindingRef
              };
              return portSuccess(approved as AuthorizedScope<O>);
            },
            authorizeResponse: async () =>
              unavailableCanvasLifecyclePrerequisite()
          },
          environmentMetadata: {
            observe: (target, value) => metadata.set(target.environment, value)
          }
        });
        const applications = createApplicationDiscovery({
          ...deps,
          read: context.discovery.applications
        });
        const environments = createEnvironmentDiscovery({
          ...deps,
          read: context.discovery.environments
        });
        return portSuccess({
          cacheKey: JSON.stringify([
            instanceId,
            caller.identityRef,
            repo.toLowerCase()
          ]),
          async applications(branch) {
            const appScope: AuthorizedScope<"application.list"> = {
              ...scope,
              operation: "application.list"
            };
            const source = await context.resolveGitSource(
              appScope,
              branch,
              control
            );
            if (source.status !== "ok") return source;
            return applications.list(
              appScope,
              { source: source.value },
              caller,
              control
            );
          },
          async environments() {
            const entries: LegacyEnvironmentEvidence[] = [];
            let error: LifecycleError | undefined;
            let continuationToken: string | undefined;
            do {
              const page = await environments.list(
                scope,
                { ...(continuationToken ? { continuationToken } : {}) },
                caller,
                control
              );
              if (page.status !== "ok") return page;
              if (page.value.observation.completeness !== "complete")
                error ??= lifecycleError("RESULT_UNAVAILABLE");
              for (const item of page.value.items) {
                const inspected = await environments.inspect(
                  {
                    ...scope,
                    operation: "environment.inspect",
                    target: item.target
                  },
                  control
                );
                if (inspected.status === "cancelled") return inspected;
                if (inspected.status !== "ok") {
                  error ??=
                    "error" in inspected ?
                      inspected.error
                    : lifecycleError("RESULT_UNAVAILABLE");
                  continue;
                }
                const observed = metadata.get(item.target.environment);
                if (!observed) return portFailure("EVIDENCE_MISMATCH");
                entries.push({
                  inspection: inspected.value,
                  metadata: observed
                });
              }
              continuationToken = page.value.continuationToken;
            } while (continuationToken);
            return portSuccess({ entries, ...(error ? { error } : {}) });
          },
          async run(args) {
            try {
              if (
                abort.signal.aborted ||
                (await verify()).status !== "ok" ||
                args[0] !== "api" ||
                args.length !== 4 ||
                args[2] !== "--jq" ||
                !args[1].startsWith(`/repos/${repo}/`) ||
                /(?:^|\/)\.\.(?:\/|$)/.test(args[1])
              )
                return { ok: false, stdout: "" };
              const executor = await deps.executor(identity.actingLogin);
              if (executor.login !== identity.actingLogin)
                return { ok: false, stdout: "" };
              const result = await executor.run(
                [
                  "api",
                  "--hostname",
                  "github.com",
                  "--method",
                  "GET",
                  ...args.slice(1)
                ],
                { signal: abort.signal }
              );
              return {
                ok: result.code === 0,
                stdout: result.code === 0 ? result.stdout.trim() : ""
              };
            } catch {
              return { ok: false, stdout: "" };
            }
          },
          async close() {
            abort.abort();
            unsubscribe?.();
            applications.close();
            environments.close();
            await context.discovery.close();
            metadata.clear();
          }
        });
      } catch {
        unsubscribe?.();
        return portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "configuration"
        });
      }
    }
  };
}
