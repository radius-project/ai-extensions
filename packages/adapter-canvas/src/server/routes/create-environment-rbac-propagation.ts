import type { CreateEnvironmentOperation } from "./create-environment-types.js";

export const AZURE_RBAC_PROPAGATION_WINDOW_MS = 30 * 60 * 1000;

const TERMINAL_STATES = new Set([
  "succeeded",
  "succeeded_with_warnings",
  "action_required",
  "failed",
  "failed_partial",
  "cancelled"
]);

interface NormalizedAzureScope {
  subscriptionId: string;
  resourceGroup: string | null;
}

export interface AzureRbacPropagationInput {
  operation: CreateEnvironmentOperation;
  clientId: string;
  subscriptionId: string;
  resourceGroup: string;
  now: number;
  propagationWindowMs?: number;
}

function normalizeIdentifier(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function parseAzureScope(scope: string): NormalizedAzureScope | null {
  const segments = scope.trim().replace(/\/+$/, "").split("/").filter(Boolean);
  const subscriptionIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === "subscriptions"
  );
  if (subscriptionIndex < 0 || !segments[subscriptionIndex + 1]) return null;
  const resourceGroupIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === "resourcegroups"
  );
  return {
    subscriptionId: normalizeIdentifier(segments[subscriptionIndex + 1]),
    resourceGroup:
      resourceGroupIndex >= 0 && segments[resourceGroupIndex + 1] ?
        normalizeIdentifier(segments[resourceGroupIndex + 1])
      : null
  };
}

function isPropagationWindow(
  createdAt: string | null | undefined,
  now: number,
  propagationWindowMs: number
): boolean {
  if (!createdAt) return false;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  return createdAtMs <= now && now - createdAtMs <= propagationWindowMs;
}

function isSubscriptionVisibleRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === "contributor" || normalized === "owner";
}

function scopeMatches(
  assignmentScope: string,
  subscriptionId: string,
  resourceGroup: string
): boolean {
  const normalizedAssignment = parseAzureScope(assignmentScope);
  const expectedSubscription = normalizeIdentifier(subscriptionId);
  const expectedResourceGroup = normalizeIdentifier(resourceGroup);
  if (!normalizedAssignment || !expectedSubscription) return false;
  if (normalizedAssignment.subscriptionId !== expectedSubscription)
    return false;
  if (!expectedResourceGroup)
    return normalizedAssignment.resourceGroup === null;
  return (
    normalizedAssignment.resourceGroup === null ||
    normalizedAssignment.resourceGroup === expectedResourceGroup
  );
}

export function shouldDeferAzureCredentialVerificationForRbacPropagation({
  operation,
  clientId,
  subscriptionId,
  resourceGroup,
  now,
  propagationWindowMs = AZURE_RBAC_PROPAGATION_WINDOW_MS
}: AzureRbacPropagationInput): boolean {
  if (operation.provider !== "azure") return false;
  if (operation.state && TERMINAL_STATES.has(operation.state)) return false;
  const servicePrincipal = operation.setupArtifacts?.servicePrincipal;
  const servicePrincipalClientId = normalizeIdentifier(servicePrincipal?.appId);
  const servicePrincipalObjectId = normalizeIdentifier(
    servicePrincipal?.objectId
  );
  if (
    !servicePrincipalClientId ||
    servicePrincipalClientId !== normalizeIdentifier(clientId) ||
    !servicePrincipalObjectId
  ) {
    return false;
  }

  return (
    operation.setupArtifacts?.roleAssignments?.some(
      (assignment) =>
        isSubscriptionVisibleRole(assignment.role) &&
        normalizeIdentifier(assignment.principalObjectId) ===
          servicePrincipalObjectId &&
        scopeMatches(assignment.scope, subscriptionId, resourceGroup) &&
        isPropagationWindow(assignment.createdAt, now, propagationWindowMs)
    ) ?? false
  );
}
