import { randomBytes } from "node:crypto";
import {
  resolveDeployParams as resolveParameters,
  type BicepParam
} from "@radius-project/core";

export function autogenValue(type: unknown): string {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "int") return String(Math.floor(Math.random() * 1e6));
  if (normalized === "bool") return "false";
  return randomBytes(18).toString("base64url");
}

export function resolveDeployParams(
  params: readonly BicepParam[],
  userValues: Readonly<Record<string, unknown>> = {}
): Record<string, string> {
  return resolveParameters(params, userValues, autogenValue);
}
