import type {
  SetupAutomaticVerificationPolicy,
  SetupWorkflowRead as WorkflowFileReadResult
} from "./setup-environment-contracts.js";
export function setupAutomaticBranchVerificationPolicy(
  input: {
    verify: WorkflowFileReadResult;
    dispatcher: WorkflowFileReadResult;
    legacyDeploy: WorkflowFileReadResult;
  },
  parseYaml: (content: string) => unknown
): SetupAutomaticVerificationPolicy {
  const fileState = (
    result: WorkflowFileReadResult
  ):
    | { state: "present"; content: string }
    | { state: "absent" | "unreadable" } => {
    if (typeof result.content === "string" && result.content.trim())
      return { state: "present", content: result.content };
    return { state: result.status === 404 ? "absent" : "unreadable" };
  };
  const legacyDeployState = fileState(input.legacyDeploy);
  if (legacyDeployState.state === "present") {
    return { state: "disabled", reason: "legacy-deploy-present" };
  }
  if (legacyDeployState.state === "unreadable") {
    return { state: "disabled", reason: "legacy-deploy-unreadable" };
  }
  const verifyState = fileState(input.verify);
  if (verifyState.state === "unreadable") {
    return { state: "disabled", reason: "verify-unreadable" };
  }
  const dispatcherState = fileState(input.dispatcher);
  if (dispatcherState.state === "unreadable") {
    return { state: "disabled", reason: "dispatcher-unreadable" };
  }
  if (dispatcherState.state === "present") {
    try {
      const parsed: unknown = parseYaml(dispatcherState.content);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        !("on" in parsed) ||
        !parsed.on ||
        typeof parsed.on !== "object" ||
        Array.isArray(parsed.on)
      ) {
        return { state: "disabled", reason: "dispatcher-unreadable" };
      }
      if (Object.prototype.hasOwnProperty.call(parsed.on, "workflow_run")) {
        return { state: "disabled", reason: "dispatcher-legacy-chain" };
      }
    } catch {
      return { state: "disabled", reason: "dispatcher-unreadable" };
    }
  }
  if (verifyState.state === "present") {
    return { state: "disabled", reason: "verify-present" };
  }
  return { state: "enabled" };
}
