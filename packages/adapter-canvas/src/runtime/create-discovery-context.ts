import {
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  sameLifecycleData,
  type AuthorizedScope,
  type AuthorizationRequest,
  type HostCallerBinding,
  type RequestControl,
  type PortResult,
  type Source,
  type Target
} from "@radius-project/core/lifecycle";
import type {
  GraphExecutionPort,
  EnvironmentAccessPort
} from "@radius-project/core/lifecycle";
import {
  createApplicationReadAdapter,
  createDeployedApplicationRead,
  createEnvironmentReadAdapter,
  createWorkspaceSourceHost,
  createGitHubSourceHost,
  type EnvironmentReadMetadata,
  type WorkspaceSourceDependencies
} from "@radius-project/adapter-shared";
import type { SelectedGhExecutor } from "../gh.js";
import { extractAppName } from "../bicep.js";
import { classifyProvider } from "../provider-classification.js";
import { createDiscoveryGitHubRead } from "./discovery-github-read.js";
import type { LifecycleAuthority } from "./lifecycle-authorization.js";
import type { LifecycleDiscoveryDependencies } from "./lifecycle-discovery.js";

export interface CanvasDiscoveryDependencies extends Omit<
  WorkspaceSourceDependencies,
  "authorize"
> {
  authority: LifecycleAuthority;
  hostBinding(): HostCallerBinding;
  executor(login: string): Promise<Pick<SelectedGhExecutor, "login" | "run">>;
  environmentMetadata?: {
    observe(
      target: { repo: string; environment: string },
      metadata: EnvironmentReadMetadata
    ): void;
  };
}
export function createCanvasDiscoveryContext(
  deps: CanvasDiscoveryDependencies
) {
  if (
    [
      deps?.authority?.resolveCaller,
      deps?.authority?.authorize,
      deps?.authority?.authorizeResponse,
      deps?.hostBinding,
      deps?.executor
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Discovery requires trusted identity, session and selected GitHub executor ports."
    );
  async function verify(
    scope: AuthorizedScope,
    control: RequestControl
  ): Promise<PortResult<void>> {
    const caller = await deps.authority.resolveCaller(
      deps.hostBinding(),
      control
    );
    if (caller.status !== "ok") return caller;
    if (caller.value.principalRef !== scope.principalRef)
      return portForbidden();
    const request = {
      caller: caller.value,
      operation: scope.operation,
      target: scope.target,
      ...(scope.source ? { source: scope.source } : {})
    } as AuthorizationRequest;
    const result = await deps.authority.authorize(request, control);
    if (result.status !== "ok") return result;
    return (
        result.value.principalRef === scope.principalRef &&
          result.value.operation === scope.operation &&
          sameLifecycleData(result.value.target, scope.target)
      ) ?
        portSuccess(undefined)
      : portForbidden();
  }
  const source = createWorkspaceSourceHost({ ...deps, authorize: verify });
  const get = createDiscoveryGitHubRead({ verify, executor: deps.executor });
  const remote = createGitHubSourceHost({ ...deps, get });
  const capturedSource = {
    // Concurrent diff sides share cancellation, not host capture bookkeeping.
    capture: (
      ...[scope, selection, control]: Parameters<typeof source.source.capture>
    ) =>
      (selection.source.kind === "git" ? remote.source : source.source).capture(
        scope,
        selection,
        { ...control }
      ),
    readText: (...args: Parameters<typeof source.source.readText>) =>
      (args[0].provenance.kind === "git" ?
        remote.source
      : source.source
      ).readText(...args),
    readBytes: (...args: Parameters<typeof source.source.readBytes>) =>
      (args[0].provenance.kind === "git" ?
        remote.source
      : source.source
      ).readBytes(...args),
    releaseSnapshot: (
      ...args: Parameters<typeof source.source.releaseSnapshot>
    ) =>
      (args[0].provenance.kind === "git" ?
        remote.source
      : source.source
      ).releaseSnapshot(...args)
  };
  const registrations: EnvironmentAccessPort["registrations"] = async () =>
    portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "radius",
      limitation:
        "Actual environment recipe registrations are unavailable: the existing read-only evidence channel does not publish them."
    });
  const environments = createEnvironmentReadAdapter({
    ...deps,
    get,
    classifyProvider,
    metadata: deps.environmentMetadata,
    registrations
  });
  const applications = createApplicationReadAdapter({
    ...deps,
    source: capturedSource,
    extractAppName: (text) => extractAppName(text, { strict: true }),
    resolveSelection: source.resolveSelection,
    deployed: createDeployedApplicationRead({ ...deps, get })
  });
  const discovery: LifecycleDiscoveryDependencies = {
    applications,
    environments,
    capabilities: [
      {
        operation: "application.list",
        contexts: ["workspace", "git", "environment"],
        providers: ["azure", "aws"],
        requiresAgent: false,
        limitations: [
          "Only the two canonical definitions (.radius/app.bicep, then app.bicep) are searched; select other definitions explicitly.",
          "Uncorrelated deployment metadata is unavailable, not an empty application list."
        ]
      },
      {
        operation: "application.inspect",
        contexts: ["workspace", "git", "environment"],
        providers: ["azure", "aws"],
        requiresAgent: false,
        limitations: [
          "Source-only inspection does not compile graphs.",
          "Static naming requires one literal application declaration with name first; block comments, multiline strings and computed names are unsupported.",
          "Remote source capture is bounded to complete GitHub trees of at most 256 regular files, 1 MiB each and 16 MiB total."
        ]
      },
      {
        operation: "environment.list",
        contexts: ["environment"],
        providers: ["azure", "aws"],
        requiresAgent: false,
        limitations: [
          "GitHub environment visibility does not establish deployment authority."
        ]
      },
      {
        operation: "environment.inspect",
        contexts: ["environment"],
        providers: ["azure", "aws"],
        requiresAgent: false,
        limitations: [
          "Actual recipe registrations and planned graphs are unavailable without supported read-only evidence."
        ]
      }
    ],
    async close() {
      const results = await Promise.all([source.close(), remote.close()]);
      if (results.some((result) => result.status !== "ok"))
        throw new Error("Discovery snapshot cleanup could not be completed.");
    }
  };
  const observeDeployed: GraphExecutionPort["observeDeployed"] = async (
    scope,
    target,
    control
  ) => {
    const observed = await get(
      `/repos/${target.repo}/deployments?environment=${encodeURIComponent(target.environment)}&per_page=100`,
      control,
      scope
    );
    if (observed.status !== "ok") return observed;
    if (!Array.isArray(observed.value)) return portFailure("EVIDENCE_MISMATCH");
    return portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "workflow",
      limitation:
        "Existing GitHub deployment metadata does not provide a Radius graph with recorded source provenance. Authored topology is not a deployed observation."
    });
  };
  return {
    discovery,
    source: capturedSource,
    environments: { registrations },
    observeDeployed,
    resolveGitSource: remote.resolveSource,
    async resolveWorkspaceSource(
      target: Pick<Target, "repo" | "definition">,
      control: RequestControl
    ): Promise<PortResult<Source>> {
      const caller = await deps.authority.resolveCaller(
        deps.hostBinding(),
        control
      );
      if (caller.status !== "ok") return caller;
      const scope = await deps.authority.authorize(
        {
          caller: caller.value,
          operation: "application.list",
          target: { repo: target.repo }
        },
        control
      );
      if (scope.status !== "ok") return scope;
      const selected = await source.resolveSelection(
        scope.value,
        target.definition,
        control
      );
      return (
        selected.status === "ok" ? portSuccess(selected.value.source)
        : selected.status === "absent" ? portFailure("DEFINITION_NOT_FOUND")
        : selected
      );
    }
  };
}
