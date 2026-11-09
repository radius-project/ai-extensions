import { randomBytes } from "node:crypto";
import {
  resolveDeployParams as resolveParameters,
  type BicepParam
} from "@radius-project/core";

export {
  WORKFLOW_MANAGED_PARAMS,
  parseBicepParams,
  appParams,
  partitionParams,
  buildDeployRadCommand,
  buildAppGraphRadCommand,
  extractAppName,
  type BicepParam
} from "@radius-project/core";

// Keep host randomness here until the shared execution layer owns it.
export function autogenValue(type: unknown): string {
  const t = String(type || "").toLowerCase();
  if (t === "int") return String(Math.floor(Math.random() * 1e6));
  if (t === "bool") return "false";
  return randomBytes(18).toString("base64url");
}

export function resolveDeployParams(
  params: readonly BicepParam[],
  userValues: Readonly<Record<string, unknown>> = {}
): Record<string, string> {
  return resolveParameters(params, userValues, autogenValue);
}
