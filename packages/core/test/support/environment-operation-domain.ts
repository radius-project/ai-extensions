import { createHash } from "node:crypto";
import {
  createEnvironmentOperationDomain,
  createEnvironmentArtifactLedger,
  createEnvironmentOperationControl
} from "../../src/github-radius/environments/operation-domain.js";
export * from "../../src/github-radius/operations.js";

const NOW = "2026-08-22T00:00:00.000Z";
export const OPERATION_KIND_DELETE = "delete_environment";
export const operationDomain = createEnvironmentOperationDomain({
  nowIso: () => NOW,
  sha256: (value) => createHash("sha256").update(value).digest("hex"),
  redactDiagnostic: (value) => value,
  announceTerminal: () => false
});

export function createOperation(
  input: {
    operationId?: string;
    provider?: string;
    repo?: string;
    environment?: string;
    kind?: string;
    stages?: Array<{ id: string; state: string }>;
  } = {}
) {
  return {
    operationId: "op_fixture",
    provider: "azure",
    repo: "octo/app",
    environment: "dev",
    ...input,
    state: "running",
    updatedAt: NOW,
    lastActivityAt: NOW,
    endedAt: null as string | null,
    stopRequested: false,
    recoveryState: null as string | null,
    request: {} as Record<string, unknown>,
    stages: input.stages ?? [],
    steps: [] as Array<{
      stage?: string;
      kind?: string;
      label: string;
      state?: string;
      warning?: Record<string, string | undefined>;
    }>,
    verification: {} as Record<string, unknown>,
    setupArtifacts: createEnvironmentArtifactLedger(),
    control: createEnvironmentOperationControl(),
    journey: { notifiedAt: null as string | null },
    terminal: null as Record<string, unknown> | null,
    failure: null as Record<string, unknown> | null,
    providerRecovery: operationDomain.readProviderRecovery(undefined)
  };
}
type FixtureOperation = ReturnType<typeof createOperation>;

export const {
  prepareProviderMutation,
  settleProviderMutation,
  requestStop,
  terminalizeProviderManualRequired
} = operationDomain;

export function recordCommittedWorkflowFile(
  operation: FixtureOperation,
  file: object
) {
  operation.setupArtifacts.commit.workflowFiles.push({
    ...file,
    state: "committed"
  });
}

export function recordGitHubEnvironmentVariable(
  operation: FixtureOperation,
  entry: {
    repo: string;
    environment: string;
    name: string;
    providerId?: string;
    valueSha256?: string;
    previousValue?: string | null;
    previousValueKnown?: boolean;
    environmentProviderId?: string;
    origin?: string;
  }
) {
  operation.setupArtifacts.githubEnvironmentVariables.push({
    ...entry,
    state: "created"
  });
}
