import type { IncomingMessage } from "node:http";

// Type surface for the `POST /api/create-environment` slice. Declarations only —
// erased at compile time — so the four behavioral seams (refusal ladder, gh
// runner, workflow committer, use case) each stay well under the decomposition
// review line budget. Nothing here carries behavior.

// The gh/az command shape every runner in this slice resolves to. `code` is
// `string | number` because the legacy route compared it against both `0` and
// `"0"` depending on which helper produced it. `timedOut` is set when the
// runner's own timeout killed the child, so the command's outcome is unknown
// and no credential fallback may re-run it.
export interface CreateEnvironmentCommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
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
      // `killed`/`signal` are how execFile reports a child it terminated when
      // the timeout elapsed; the runner turns them into `timedOut`.
      error:
        | (Error & {
            code?: string | number | null;
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          })
        | null,
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
  // Provenance of the write, captured from the contents API response so a later
  // rollback can prove the file on GitHub is still exactly what Radius wrote.
  // Absent when the commit failed or GitHub answered with something this code
  // could not read, which fails a post-commit rollback closed.
  commitSha?: string | null;
  blobSha?: string | null;
  contentSha256?: string | null;
  // The blob the path held before this write, or null when Radius created the
  // file. A revert restores the former and deletes the latter.
  previousBlobSha?: string | null;
  // True only when the pre-write lookup proved either the previous blob or that
  // the path was absent. A failed lookup remains unknown and blocks rollback.
  previousBlobKnown?: boolean;
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
  // The terminal verdict, or the running/input state. Read by the continuation
  // guard so a closed record cannot be adopted, and by the stop boundary.
  state?: unknown;
  // Walked by the operation model when a stop or a failure closes the record.
  stages?: unknown;
  steps?: unknown;
  // The real record stores a prompt object here (or `null`), not a flag; the
  // refusal only tests it for truthiness, so `unknown` keeps this declaration
  // from being narrower than what `operations.ts` actually writes.
  inputRequired?: unknown;
  verification?: unknown;
  context?: Record<string, unknown>;
  request?: unknown;
  resumeRequest?: unknown;
  setupArtifacts?: {
    githubEnvironment?: {
      state?: unknown;
      repo?: unknown;
      name?: unknown;
    };
  };
  // Set by the stop route and read by `guardStopBoundary` at each safe
  // checkpoint between remote mutations. Optional because a fixture that never
  // exercises cancellation has no reason to set it.
  stopRequested?: boolean;
}

export interface OperationStartConflict {
  ok: false;
  reason?: "operation-in-progress" | "previous-cleanup-required";
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
  timedOut?: boolean;
}

export interface CredentialVerificationPlanResult {
  shouldDispatch: boolean;
  ref: string;
  defaultBranch: string;
  pullRequestUrl: string;
  skipReason: string;
  supportsOperationMarker?: boolean;
}
