import type { LifecycleResponseFor } from "./contracts/catalog.js";
import type { DefinitionValidationPort } from "./definition-ports.js";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type PortResult
} from "./errors.js";
import { sameLifecycleData } from "./operations.js";
import type {
  AuthorizedScope,
  ClockPort,
  RequestControl,
  SourceAccessPort,
  SourceSelection,
  SourceSnapshot
} from "./ports.js";
import { validateSourceSelection, verifySourceExpectation } from "./source.js";
import {
  createValidationPolicy,
  verifyValidationReport
} from "./validation-policy.js";

type Result = LifecycleResponseFor<"definition.validate">["result"];
export interface DefinitionValidationDependencies {
  readonly source: Pick<SourceAccessPort, "capture" | "releaseSnapshot">;
  readonly validator: DefinitionValidationPort;
  readonly clock: Pick<ClockPort, "now">;
}
export function createDefinitionValidation(
  deps: DefinitionValidationDependencies
) {
  if (
    [
      deps?.source?.capture,
      deps?.source?.releaseSnapshot,
      deps?.validator?.validate,
      deps?.clock?.now
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Definition validation requires source, validator and clock ports."
    );
  const policy = createValidationPolicy("validation");
  let closed = false;
  const stopped = (control: RequestControl) =>
    closed || control.cancellation.aborted;
  const unavailable = () =>
    portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "source"
    });
  async function inspect(
    scope: AuthorizedScope<"definition.validate">,
    target: SourceSelection,
    control: RequestControl,
    own: (snapshot: SourceSnapshot) => void
  ): Promise<PortResult<Result>> {
    const captured = await deps.source.capture(scope, target, control);
    if (captured.status === "absent")
      return portFailure("DEFINITION_NOT_FOUND");
    if (captured.status !== "ok") return captured;
    if (captured.value.status === "incomplete")
      return portUnavailable("VALIDATION_INCOMPLETE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source"
      });
    const snapshot = captured.value.snapshot;
    own(snapshot);
    if (stopped(control)) return portCancelled("request_cancelled");
    if (!sameLifecycleData(snapshot.selection, target))
      return portFailure("EVIDENCE_MISMATCH");
    const expected = verifySourceExpectation(
      target,
      snapshot.provenance,
      snapshot.manifest,
      control.cancellation
    );
    if (expected.status !== "ok") return expected;
    const identity = { sourceFingerprint: snapshot.manifest.fingerprint };
    const validated = await deps.validator.validate(
      { snapshot, policy, ...identity },
      control
    );
    if (stopped(control)) return portCancelled("request_cancelled");
    if (validated.status !== "ok") return validated;
    const report = verifyValidationReport(policy, validated.value, identity);
    if (report.status !== "ok") return report;
    return portSuccess({
      target: structuredClone(target),
      provenance: structuredClone(snapshot.provenance),
      report: report.value,
      observation: {
        quality: "current",
        completeness:
          report.value.status === "incomplete" ? "partial" : "complete",
        evidence: "source",
        observedAt: deps.clock.now(),
        limitation:
          "Definition validation does not verify live deployment or grant promotion or deployment approval."
      }
    });
  }
  return {
    async validate(
      scope: AuthorizedScope<"definition.validate">,
      target: SourceSelection,
      control: RequestControl
    ): Promise<PortResult<Result>> {
      if (stopped(control)) return portCancelled("request_cancelled");
      if (!sameLifecycleData(scope.target, target)) return portForbidden();
      const selection = validateSourceSelection(target, control.cancellation);
      if (selection.status !== "ok") return selection;
      let owned: SourceSnapshot | undefined;
      let result: PortResult<Result>;
      try {
        result = await inspect(
          scope,
          structuredClone(target),
          control,
          (snapshot) => {
            owned = snapshot;
          }
        );
      } catch {
        result =
          stopped(control) ? portCancelled("request_cancelled") : unavailable();
      }
      if (owned) {
        try {
          const released = await deps.source.releaseSnapshot(owned);
          if (released.status !== "ok") return released;
        } catch {
          return unavailable();
        }
      }
      return result;
    },
    close() {
      closed = true;
    }
  };
}
