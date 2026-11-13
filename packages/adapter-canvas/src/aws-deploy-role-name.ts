// The default AWS deploy role name for a repository.
//
// Core owns the naming rule. It cannot import `node:crypto` because it is
// compiled into the browser bundle, so this adapter injects the hash. The
// browser reads the name the server rendered instead of computing it.

import { createHash } from "node:crypto";
import {
  buildAwsAppBoundary,
  buildAwsDeployRoleName,
  buildAwsEnvironmentPolicyName,
  type AwsAppBoundary
} from "@radius-project/core/platforms";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function defaultAwsDeployRoleName(repoFullName: string): string {
  return buildAwsDeployRoleName(repoFullName, sha256Hex);
}

export function awsEnvironmentPolicyName(
  repoId: number,
  environment: string
): string {
  return buildAwsEnvironmentPolicyName(repoId, environment, sha256Hex);
}

export function awsAppBoundary(
  accountId: string,
  repoId: number,
  environment: string
): AwsAppBoundary {
  return buildAwsAppBoundary(accountId, repoId, environment, sha256Hex);
}
