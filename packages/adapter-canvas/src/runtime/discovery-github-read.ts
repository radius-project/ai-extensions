import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type AuthorizedScope,
  type PortResult,
  type RequestControl
} from "@radius-project/core/lifecycle";
import type { GitHubDiscoveryRead } from "@radius-project/adapter-shared";
import type { SelectedGhExecutor } from "../gh.js";

export function createDiscoveryGitHubRead(deps: {
  verify(
    scope: AuthorizedScope,
    control: RequestControl
  ): Promise<PortResult<void>>;
  executor(login: string): Promise<Pick<SelectedGhExecutor, "login" | "run">>;
}): GitHubDiscoveryRead["get"] {
  if (typeof deps?.verify !== "function" || typeof deps.executor !== "function")
    throw new Error(
      "GitHub discovery requires identity verification and a selected executor."
    );
  return async (path, control, scope) => {
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const abort = new AbortController();
    let unsubscribe: (() => void) | undefined;
    try {
      const auth = await deps.verify(scope, control);
      if (auth.status !== "ok") return auth;
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (
        (path !== `/repos/${scope.target.repo}` &&
          !path.startsWith(`/repos/${scope.target.repo}/`)) ||
        !scope.principalRef.startsWith("github:")
      )
        return portForbidden();
      unsubscribe = control.cancellation.onAbort(() => abort.abort());
      const login = scope.principalRef.slice("github:".length);
      const executor = await deps.executor(login);
      if (executor.login !== login) return portForbidden();
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const result = await executor.run(
        ["api", "--hostname", "github.com", "--method", "GET", path],
        {
          timeout: 15000,
          signal: abort.signal
        }
      );
      if (control.cancellation.aborted)
        return portCancelled("request_cancelled");
      if (result.code !== 0) {
        if (/\bHTTP\s+40[13]\b/i.test(result.stderr)) return portForbidden();
        return portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "workflow"
        });
      }
      try {
        const value: unknown = JSON.parse(result.stdout);
        return portSuccess(value);
      } catch {
        return portFailure("EVIDENCE_MISMATCH");
      }
    } catch {
      return control.cancellation.aborted ?
          portCancelled("request_cancelled")
        : portUnavailable("RESULT_UNAVAILABLE", {
            quality: "unknown",
            completeness: "unavailable",
            evidence: "workflow"
          });
    } finally {
      unsubscribe?.();
    }
  };
}
