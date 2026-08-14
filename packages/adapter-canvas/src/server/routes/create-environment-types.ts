import type { IncomingMessage } from "node:http";

// Type surface for the `POST /api/create-environment` slice. Declarations only —
// erased at compile time — so the four behavioral seams (refusal ladder, gh
// runner, workflow committer, use case) each stay well under the decomposition
// review line budget. Nothing here carries behavior.

// The gh/az command shape every runner in this slice resolves to. `code` is
// `string | number` because the legacy route compared it against both `0` and
// `"0"` depending on which helper produced it.
export interface CreateEnvironmentCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

// Options forwarded to the CLI runner. Only `timeout` and `env` are ever set by
// this slice, but the port stays open so a real `CliOptions` is assignable.
export interface CreateEnvironmentCliOptions {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

// Just enough of a spawned child for the stdin hand-off. The real `cliExec`
// returns a `ChildProcess` whose `stdin` is a `Writable`, which is assignable
// here; declaring the narrow shape keeps the port free of `node:child_process`.
export interface CreateEnvironmentChildProcess {
  stdin?: { end(chunk: string): unknown } | null;
}

export interface CreateEnvironmentCliExec {
  (
    command: string,
    args: string[],
    options: CreateEnvironmentCliOptions,
    callback: (
      error: (Error & { code?: string | number | null }) | null,
      stdout: string,
      stderr: string
    ) => void
  ): CreateEnvironmentChildProcess;
}

// The PR-fallback branch pair. `base` is required (unlike the optional-base
// variant in `verification-plan.ts`) because this slice only ever constructs it
// after resolving a concrete base branch.
export interface PullRequestBranchState {
  branch: string;
  base: string;
}

export interface WorkflowCommitOutcome {
  ok: boolean;
  stderr?: string;
  viaPr: boolean;
}

// The operation record as this route reads and writes it. Declared with every
// field the route touches so a fixture cannot be narrower than production; the
// real record carries more, which structural typing permits.
export interface CreateEnvironmentOperation {
  operationId: string;
  repo?: string;
  environment?: string;
  provider?: string;
  currentStage?: string;
  // The real record stores a prompt object here (or `null`), not a flag; the
  // refusal only tests it for truthiness, so `unknown` keeps this declaration
  // from being narrower than what `operations.ts` actually writes.
  inputRequired?: unknown;
  verification?: unknown;
}

export interface OperationStartConflict {
  ok: false;
  conflict: { operationId: string };
}

export interface OperationStartAccepted {
  ok: true;
}

export type OperationStartResult =
  OperationStartAccepted | OperationStartConflict;

// A refusal is a status plus the exact body the legacy arm serialized. Kept as
// data rather than a write so the ladder can be asserted rung by rung without a
// live `ServerResponse`.
export interface CreateEnvironmentRefusal {
  status: number;
  body: Record<string, unknown>;
}

// The request-scoped inputs. `isServerOwned` is deliberately a per-request value
// rather than a construction-time dependency: the token is a per-instance
// `randomUUID()` compared against this request's header.
export interface CreateEnvironmentRequestInput {
  isServerOwned: boolean;
  request: IncomingMessage;
}

export interface GhcrPreflightFailure {
  ok: false;
  status: 403;
  code: string;
  error: string;
}

export interface GhcrPreflightSuccess {
  ok: true;
  credentials: unknown;
}

export type GhcrPreflightResult = GhcrPreflightFailure | GhcrPreflightSuccess;

export interface SetupFailureResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface CreateEnvironmentPullRequestResult {
  ok: boolean;
  url?: string;
  number?: number;
  stderr?: string;
}

export interface CredentialVerificationPlanResult {
  shouldDispatch: boolean;
  ref: string;
  defaultBranch: string;
  pullRequestUrl: string;
  skipReason: string;
}
