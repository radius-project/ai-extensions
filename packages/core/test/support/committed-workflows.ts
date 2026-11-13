// Reads the workflow templates committed under `.github/extension/` and finds
// their steps, so template tests can check the generated workflows that users
// receive rather than hand-written stand-ins.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { parse } from "yaml";

export interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}

interface WorkflowDocument {
  readonly jobs?: Record<string, { readonly steps?: readonly WorkflowStep[] }>;
}

export function readCommittedTemplate(file: string): string {
  return readFileSync(
    new URL(`../../../../.github/extension/${file}`, import.meta.url),
    "utf8"
  );
}

export function workflowSteps(workflow: string): readonly WorkflowStep[] {
  const document = parse(workflow) as WorkflowDocument;
  return Object.values(document.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

export function stepNamed(
  steps: readonly WorkflowStep[],
  name: string
): WorkflowStep {
  const matches = steps.filter((step) => step.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one step named "${name}", found ${matches.length}.`
    );
  }
  return matches[0];
}

export const AKS_TOKEN_STEP = "Use a Microsoft Entra token for AKS";
export const AKS_TOKEN_INPUTS = {
  kubeconfig: "${{ env.RADIUS_TARGET_KUBECONFIG }}",
  "client-id": "${{ vars.AZURE_CLIENT_ID }}",
  "tenant-id": "${{ vars.AZURE_TENANT_ID }}"
};

/**
 * Checks where the generated Azure deploy and delete workflows replace the
 * kubelogin credential: right after the cluster connection, under the same
 * condition. `azure-aks-token_test.sh` runs the steps that renew the token.
 */
export function expectAksTokenStep(workflow: string, radiusRef: string): void {
  const steps = workflowSteps(workflow);
  const connect = steps.findIndex(
    (step) => step.name === "Connect to AKS cluster"
  );
  expect(connect).toBeGreaterThanOrEqual(0);
  expect(steps[connect].if).toBe("${{ vars.AZURE_AKS_CLUSTER_NAME != '' }}");
  expect(steps[connect + 1]).toEqual({
    name: AKS_TOKEN_STEP,
    if: steps[connect].if,
    uses: aksTokenAction(radiusRef),
    with: AKS_TOKEN_INPUTS
  });
}

export function aksTokenAction(radiusRef: string): string {
  return `radius-project/ai-extensions/.github/extension/actions/aks-token-kubeconfig@${radiusRef}`;
}

/** AWS workflows must not take any part of the AKS token handling. */
export function expectNoAksTokenHandling(workflow: string): void {
  expect(workflow).not.toContain("aks-token-kubeconfig");
  expect(workflow).not.toContain("RADIUS_AKS_");
  expect(workflow).not.toContain("kubelogin");
}
