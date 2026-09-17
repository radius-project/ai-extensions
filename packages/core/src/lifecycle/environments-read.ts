import type { LifecycleResponseFor } from "./contracts/catalog.js";
import type {
  AuthorizedScope,
  ClockPort,
  IdPort,
  RequestControl
} from "./ports.js";
import {
  portCancelled,
  portFailure,
  type PortResult,
  type ReadResult
} from "./errors.js";
import { createDiscoveryPager } from "./discovery.js";

export type EnvironmentReadResult =
  LifecycleResponseFor<"environment.inspect">["result"];
export type EnvironmentReadPage =
  LifecycleResponseFor<"environment.list">["result"];
export interface EnvironmentReadPort {
  list(
    scope: AuthorizedScope<"environment.list">,
    control: RequestControl
  ): Promise<PortResult<EnvironmentReadPage>>;
  inspect(
    scope: AuthorizedScope<"environment.inspect">,
    control: RequestControl
  ): Promise<ReadResult<EnvironmentReadResult>>;
}
export function createEnvironmentDiscovery(deps: {
  read: EnvironmentReadPort;
  ids: IdPort;
  clock: Pick<ClockPort, "now">;
}) {
  if (
    [
      deps?.read?.list,
      deps?.read?.inspect,
      deps?.ids?.next,
      deps?.clock?.now
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Environment discovery requires complete read, clock and ID ports."
    );
  const pages = createDiscoveryPager<EnvironmentReadPage>(
    deps,
    (scope, _input, control) =>
      scope.operation === "environment.list" ?
        deps.read.list(scope, control)
      : Promise.resolve(portFailure("INVALID_REQUEST"))
  );
  let closed = false;
  return {
    list: pages.list,
    async inspect(
      scope: AuthorizedScope<"environment.inspect">,
      control: RequestControl
    ) {
      if (closed || control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const result = await deps.read.inspect(scope, control);
      if (
        result.status === "ok" &&
        (result.value.target.repo !== scope.target.repo ||
          result.value.target.environment !== scope.target.environment)
      )
        return portFailure("EVIDENCE_MISMATCH");
      return closed || control.cancellation.aborted ?
          portCancelled("request_cancelled")
        : result;
    },
    close() {
      closed = true;
      pages.close();
    }
  };
}
