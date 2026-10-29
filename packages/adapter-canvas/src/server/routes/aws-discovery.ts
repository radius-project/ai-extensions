import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import {
  listAwsRoles,
  type AwsRoleListDependencies
} from "../services/aws-discovery.js";

// The `aws-discovery` route family: AWS lookups the environment wizard makes.
// One seam, the trimmed-stdout CLI runner the AWS discovery service uses.
export type AwsDiscoveryRouteDependencies = AwsRoleListDependencies;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// IAM roles the signed-in AWS identity can see, for the wizard's
// `use an existing role…` picker. Each lists the GitHub subjects it trusts so
// the picker can say which repositories already use it.
export async function handleListAwsRoles(
  context: CanvasRequestContext,
  dependencies: AwsDiscoveryRouteDependencies
): Promise<void> {
  try {
    const roles = await listAwsRoles(
      {
        accountId: context.url.searchParams.get("accountId") || "",
        repo: context.url.searchParams.get("repo") || ""
      },
      dependencies
    );
    context.json(200, { roles });
  } catch (e) {
    context.json(400, {
      error: "Failed to list IAM roles: " + errorMessage(e),
      code: "aws-role-list-failed",
      roles: []
    });
  }
}

export function createAwsDiscoveryRoutes(
  dependencies: AwsDiscoveryRouteDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/list-aws-roles": (context) =>
      handleListAwsRoles(context, dependencies)
  };
}
