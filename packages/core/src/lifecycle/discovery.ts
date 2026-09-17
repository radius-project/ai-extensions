import type {
  LifecycleRequestFor,
  LifecycleResponseFor
} from "./contracts/catalog.js";
import type {
  AuthorizedScope,
  CallerContext,
  ClockPort,
  IdPort,
  RequestControl
} from "./ports.js";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  type PortResult,
  type ReadResult
} from "./errors.js";
import { sameLifecycleData } from "./operations.js";

export type ApplicationInspection =
  LifecycleResponseFor<"application.inspect">["result"];
export type ApplicationPage =
  LifecycleResponseFor<"application.list">["result"];
export type ApplicationListInput =
  LifecycleRequestFor<"application.list">["input"];
export interface ApplicationReadPort {
  list(
    scope: AuthorizedScope<"application.list">,
    input: ApplicationListInput,
    control: RequestControl
  ): Promise<PortResult<ApplicationPage>>;
  inspect(
    scope: AuthorizedScope<"application.inspect">,
    control: RequestControl
  ): Promise<ReadResult<ApplicationInspection>>;
}

/** Cursors retain immutable observations in their owning session, never an execution or history store. */
export function createDiscoveryPager<
  T extends {
    target: { repo: string; environment?: string };
    items: unknown[];
    continuationToken?: string;
  }
>(
  deps: { ids: IdPort; clock: Pick<ClockPort, "now"> },
  read: (
    scope: AuthorizedScope,
    input: ApplicationListInput,
    control: RequestControl
  ) => Promise<PortResult<T>>
) {
  const pages = new Map<
    string,
    { key: unknown; value: T; offset: number; expires: number }
  >();
  let closed = false;
  return {
    async list(
      scope: AuthorizedScope,
      input: ApplicationListInput,
      caller: CallerContext,
      control: RequestControl
    ): Promise<PortResult<T>> {
      if (closed || control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (scope.principalRef !== caller.principalRef) return portForbidden();
      const size = input.pageSize ?? 100;
      if (!Number.isInteger(size) || size < 1 || size > 100)
        return portFailure("INVALID_REQUEST");
      const { continuationToken, ...filters } = input;
      const key = {
        target: scope.target,
        operation: scope.operation,
        caller,
        filters: { ...filters, pageSize: size }
      };
      const now = Date.parse(deps.clock.now());
      if (!Number.isFinite(now)) return portFailure("PRECONDITION_FAILED");
      for (const [token, entry] of pages)
        if (entry.expires <= now) pages.delete(token);
      const saved =
        continuationToken ? pages.get(continuationToken) : undefined;
      if (continuationToken && (!saved || !sameLifecycleData(saved.key, key)))
        return portFailure("PRECONDITION_FAILED");
      const result =
        saved ? portSuccess(saved.value) : await read(scope, input, control);
      if (result.status !== "ok") return result;
      if (!sameLifecycleData(result.value.target, scope.target))
        return portFailure("EVIDENCE_MISMATCH");
      if (closed || control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const value = structuredClone(result.value);
      const offset = saved?.offset ?? 0;
      const next = offset + size;
      const page = { ...value, items: value.items.slice(offset, next) };
      delete page.continuationToken;
      if (next < value.items.length) {
        if (pages.size >= 100) return portFailure("PRECONDITION_FAILED");
        const token = deps.ids.next("request");
        if (pages.has(token)) return portFailure("PRECONDITION_FAILED");
        pages.set(token, {
          key: structuredClone(key),
          value,
          offset: next,
          expires: saved?.expires ?? now + 60_000
        });
        page.continuationToken = token;
      }
      return portSuccess(structuredClone(page));
    },
    close() {
      closed = true;
      pages.clear();
    }
  };
}

export function createApplicationDiscovery(deps: {
  read: ApplicationReadPort;
  ids: IdPort;
  clock: Pick<ClockPort, "now">;
}) {
  if (
    typeof deps?.read?.list !== "function" ||
    typeof deps.read.inspect !== "function" ||
    typeof deps.ids?.next !== "function" ||
    typeof deps.clock?.now !== "function"
  )
    throw new Error(
      "Application discovery requires complete read, clock and ID ports."
    );
  const pages = createDiscoveryPager<ApplicationPage>(
    deps,
    (scope, input, control) => {
      if (scope.operation !== "application.list")
        return Promise.resolve(portFailure("INVALID_REQUEST"));
      return deps.read.list(scope, input, control);
    }
  );
  let closed = false;
  return {
    list: pages.list,
    async inspect(
      scope: AuthorizedScope<"application.inspect">,
      control: RequestControl
    ): Promise<ReadResult<ApplicationInspection>> {
      if (closed || control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (
        !("environment" in scope.target) &&
        !("source" in scope.target && "definition" in scope.target)
      )
        return portFailure("INVALID_REQUEST");
      const result = await deps.read.inspect(scope, control);
      if (
        result.status === "ok" &&
        (result.value.target.repo !== scope.target.repo ||
          result.value.target.application !== scope.target.application)
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
