import {
  buildStages,
  createOperation,
  enterStage,
  finish,
  recordAzureApp,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordServicePrincipal,
  requestStop,
  stopAtBoundary,
  STAGE_VERIFY,
  type OperationControlRecord
} from "../../../src/operations.js";
import type { OperationRecord } from "../../../src/server/routes/operations-status.js";

// The saved records the control routes decide over, built with the real model
// functions so eligibility, ownership, and provenance are the production
// verdicts rather than a hand-shaped literal.
//
// `OperationRecord` stays a broad pass-through type (see operations-status.ts),
// but every record here is built by `createOperation`/`finish`, so `control`,
// `journey`, and `failure` are genuinely present at runtime. Widening the type
// here — rather than reaching for `as any`/`as unknown as` at each call site —
// keeps the access typed without loosening the shared route contract.

export const FIXTURE_REPO = "contoso/store";
export const FIXTURE_PULL_REQUEST = "https://github.com/contoso/store/pull/7";

export type OperationFixture = OperationRecord & {
  control: OperationControlRecord;
  journey: { notifiedAt: string | null; [key: string]: unknown };
  failure: { code: string | null; [key: string]: unknown } | null;
};

/** A running Azure setup with the identity stages planned. */
export function newOperation(repo = FIXTURE_REPO): OperationFixture {
  return createOperation({
    provider: "azure",
    repo,
    environment: "dev",
    stages: buildStages({ includeIdentity: true })
  }) as OperationFixture;
}

function resumable(repo: string): OperationFixture {
  const op = newOperation(repo);
  op.resumeRequest = {
    needsAzureCredentials: true,
    azure: {},
    environment: { repo, environment: "dev", provider: "azure" }
  };
  return op;
}

/** A setup that failed partway, holding an App Registration it proved it created. */
export function retryableSetup(repo = FIXTURE_REPO): OperationFixture {
  const op = resumable(repo);
  recordAzureApp(op, {
    state: "created",
    appId: "app-1",
    displayName: "radius-app"
  });
  finish(op, "failed_partial", {
    failure: { code: "operation-stalled", message: "lost contact" }
  });
  return op;
}

/**
 * A setup the customer deliberately stopped, holding resources this attempt
 * created and can prove it owns. `includeEnvironment` chooses the boundary the
 * stop was honored at: after the GitHub environment was created, or before it.
 */
export function stoppedSetup({
  repo = FIXTURE_REPO,
  includeEnvironment = false
}: { repo?: string; includeEnvironment?: boolean } = {}): OperationFixture {
  const op = resumable(repo);
  recordAzureApp(op, {
    state: "created",
    appId: "app-1",
    displayName: "radius-deploy"
  });
  recordServicePrincipal(op, {
    state: "created",
    appId: "app-1",
    objectId: "sp-1"
  });
  if (includeEnvironment)
    recordGitHubEnvironment(op, { state: "created", repo, name: "dev" });
  requestStop(op);
  stopAtBoundary(
    op,
    includeEnvironment ? "after_environment" : "after_service_principal"
  );
  return op;
}

/** Verification handed back to the customer to merge the setup pull request. */
export function mergeHandoff({
  repo = FIXTURE_REPO,
  pullRequestUrl = FIXTURE_PULL_REQUEST
}: { repo?: string; pullRequestUrl?: string | null } = {}): OperationFixture {
  const op = newOperation(repo);
  recordAzureApp(op, { state: "created", appId: "app-1" });
  recordServicePrincipal(op, { state: "created", appId: "app-1" });
  recordCommittedWorkflowFile(op, {
    path: ".github/workflows/radius-verify-credentials.yml",
    mode: "pull_request",
    branch: "radius-setup"
  });
  recordCommitState(op, {
    mode: "pull_request",
    branch: "radius-setup",
    baseBranch: "main",
    pullRequestUrl
  });
  enterStage(op, STAGE_VERIFY);
  op.verification = {
    dispatchedAt: Date.now(),
    workflow: "radius-verify-credentials.yml",
    ref: "main",
    environment: "dev",
    runId: null,
    runUrl: null
  };
  finish(op, "action_required", {
    terminal: { reason: "pr-merge-required", pullRequestUrl }
  });
  return op;
}

// The reported failure shape: setup reused an App Registration and a Service
// Principal that already existed, then failed. Nothing is Radius's to remove.
export function reusedOnlyFailure(repo = FIXTURE_REPO): OperationFixture {
  const op = newOperation(repo);
  recordAzureApp(op, {
    state: "reused",
    appId: "app-1",
    displayName: "radius-deploy"
  });
  recordServicePrincipal(op, {
    state: "reused",
    appId: "app-1",
    objectId: "sp-1"
  });
  finish(op, "failed_partial", {
    failure: {
      code: "github-environment-failed",
      message: "GitHub returned 403."
    }
  });
  return op;
}
