// Reads the workflow templates committed under `.github/extension/` so template
// tests can check the generated workflows that users receive rather than
// hand-written stand-ins.
import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
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

/**
 * Checks where a generated Azure deploy or delete workflow replaces the
 * kubelogin credential: right after the cluster connection, under the same
 * condition. `azure-aks-token_test.sh` runs the steps that renew the token.
 */
export function expectAksTokenStep(workflow: string, radiusRef: string): void {
  const document = parse(workflow) as WorkflowDocument;
  const steps = Object.values(document.jobs ?? {}).flatMap(
    (job) => job.steps ?? []
  );
  const connect = steps.findIndex(
    (step) => step.name === "Connect to AKS cluster"
  );
  expect(connect).toBeGreaterThanOrEqual(0);
  expect(steps[connect].if).toBe("${{ vars.AZURE_AKS_CLUSTER_NAME != '' }}");
  expect(steps[connect + 1]).toEqual({
    name: "Use a Microsoft Entra token for AKS",
    if: steps[connect].if,
    uses: `radius-project/ai-extensions/.github/extension/actions/aks-token-kubeconfig@${radiusRef}`,
    with: {
      kubeconfig: "${{ env.RADIUS_TARGET_KUBECONFIG }}",
      "client-id": "${{ vars.AZURE_CLIENT_ID }}",
      "tenant-id": "${{ vars.AZURE_TENANT_ID }}"
    }
  });
}

/** AWS workflows must not take any part of the AKS token handling. */
export function expectNoAksTokenHandling(workflow: string): void {
  expect(workflow).not.toContain("aks-token-kubeconfig");
  expect(workflow).not.toContain("RADIUS_AKS_");
}
