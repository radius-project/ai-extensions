import type {
  BranchHeadState,
  RepositoryFileState
} from "./workflow-provenance.js";
import type {
  MutationResult,
  PullRequestState,
  WorkflowRollbackPorts
} from "./workflow-rollback.js";
import { createHash } from "node:crypto";
import { shouldRetryWithKeyringCredential } from "./workflow-credential-fallback.js";

// The GitHub half of a post-commit rollback, expressed once over a single
// command seam.
//
// The rollback service decides; this module only knows how to ask GitHub. It is
// separated so the decision can be tested against fakes and the wire format can
// be tested without a decision, and so the composition root injects one `gh`
// runner rather than eight.
//
// Every read fails closed. A response this code cannot parse is `unreadable`
// rather than "absent" or "matching", because a rollback that treats an
// unreadable answer as proof is exactly the failure the provenance check exists
// to prevent.

export interface WorkflowRollbackCommandResult {
  ok: boolean;
  // HTTP status when `gh` reported one, so a 404 is distinguishable from a
  // credential or transport failure.
  status: number | null;
  stdout: string;
  stderr: string;
}

/** One `gh api` invocation, with an optional JSON body on stdin. */
export type WorkflowRollbackCommand = (input: {
  args: string[];
  stdin?: string;
}) => Promise<WorkflowRollbackCommandResult>;

/** One `gh api` attempt, optionally under a modified environment. */
export type WorkflowRollbackAttempt = (input: {
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}) => Promise<WorkflowRollbackCommandResult & { timedOut: boolean }>;

export interface WorkflowScopeApiCommandPorts {
  attempt: WorkflowRollbackAttempt;
  readProcessEnv(): NodeJS.ProcessEnv;
}

/**
 * A `gh api` seam that can fall back to the stored credential exactly once.
 *
 * Writes under `.github/workflows/` need the `workflow` token scope, and the
 * host-injected token often lacks it. Stripping that token silently changes
 * which account acts, so the retry is gated by the same fail-closed rule the
 * workflow commit path uses: only a positively identified missing-scope
 * refusal, and never a command that was killed rather than answered.
 */
export function createWorkflowScopeApiCommand(
  ports: WorkflowScopeApiCommandPorts
): WorkflowRollbackCommand {
  return async ({ args, stdin }) => {
    const first = await ports.attempt({ args, stdin });
    if (first.ok) return first;
    const env = ports.readProcessEnv();
    if (
      !shouldRetryWithKeyringCredential({
        stderr: first.stderr,
        timedOut: first.timedOut,
        hasInjectedToken: Boolean(env.GH_TOKEN || env.GITHUB_TOKEN)
      })
    )
      return first;
    const fallbackEnv = { ...env };
    delete fallbackEnv.GH_TOKEN;
    delete fallbackEnv.GITHUB_TOKEN;
    const retry = await ports.attempt({ args, stdin, env: fallbackEnv });
    // The original failure is usually the more meaningful one, so a retry that
    // fails too is discarded rather than reported in its place.
    return retry.ok ? retry : first;
  };
}

const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)$/;

function failureDetail(result: WorkflowRollbackCommandResult): string {
  const detail = (result.stderr || result.stdout || "").trim();
  if (detail) return detail;
  return result.status ?
      `GitHub answered HTTP ${result.status}.`
    : "The GitHub API request failed.";
}

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim() || "null");
    // An array is JSON, but it is not a resource description, and reading one
    // as an empty object would report "present with no identity" for something
    // Radius never understood.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ?
        (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The sha256 of the bytes a base64 contents response carries.
 *
 * GitHub wraps `content` at 60 characters, so the whitespace is stripped before
 * decoding. Base64 decoding is permissive rather than throwing, so an answer
 * that is not base64 at all yields a digest that simply will not match the one
 * Radius saved — which is a mismatch, and therefore a refusal.
 */
export function decodeContentDigest(content: unknown): string | null {
  if (typeof content !== "string" || !content.trim()) return null;
  return createHash("sha256")
    .update(Buffer.from(content.replace(/\s+/g, ""), "base64"))
    .digest("hex");
}

export function createWorkflowRollbackPorts(
  run: WorkflowRollbackCommand
): WorkflowRollbackPorts {
  const encode = (value: string): string => encodeURIComponent(value);

  const readFile = async (input: {
    repo: string;
    path: string;
    ref: string;
  }): Promise<RepositoryFileState> => {
    const result = await run({
      args: [
        "api",
        `/repos/${input.repo}/contents/${input.path}?ref=${encode(input.ref)}`
      ]
    });
    if (!result.ok) {
      return result.status === 404 ?
          { status: "absent" }
        : { status: "unreadable", detail: failureDetail(result) };
    }
    const body = parseJson(result.stdout);
    if (!body) {
      return {
        status: "unreadable",
        detail: "GitHub returned a contents response Radius could not read."
      };
    }
    return {
      status: "present",
      blobSha: readString(body.sha),
      contentSha256: decodeContentDigest(body.content)
    };
  };

  const readBranchHead = async (input: {
    repo: string;
    branch: string;
  }): Promise<BranchHeadState> => {
    const result = await run({
      args: [
        "api",
        `/repos/${input.repo}/git/ref/heads/${encode(input.branch)}`
      ]
    });
    if (!result.ok) {
      return result.status === 404 ?
          { status: "absent" }
        : { status: "unreadable", detail: failureDetail(result) };
    }
    const body = parseJson(result.stdout);
    const object =
      body && typeof body.object === "object" && body.object ?
        (body.object as Record<string, unknown>)
      : null;
    const sha = readString(object?.sha);
    return sha ?
        { status: "present", sha }
      : {
          status: "unreadable",
          detail: "GitHub did not report a head commit for the branch."
        };
  };

  const readPullRequest = async (input: {
    repo: string;
    pullRequestUrl: string;
  }): Promise<PullRequestState> => {
    const match = PULL_REQUEST_URL_PATTERN.exec(
      String(input.pullRequestUrl || "").trim()
    );
    if (!match || match[1] !== input.repo) {
      return {
        status: "unknown",
        detail:
          "The saved setup pull request URL does not name a pull request in this repository."
      };
    }
    const result = await run({
      args: ["api", `/repos/${match[1]}/pulls/${match[2]}`]
    });
    if (!result.ok) {
      return { status: "unknown", detail: failureDetail(result) };
    }
    const body = parseJson(result.stdout);
    const number = Number(body?.number);
    if (!Number.isInteger(number) || number <= 0) {
      return {
        status: "unknown",
        detail: "GitHub returned a pull request Radius could not identify."
      };
    }
    if (body?.merged === true || readString(body?.merged_at)) {
      return { status: "merged", number };
    }
    return {
      status: body?.state === "closed" ? "closed" : "open",
      number
    };
  };

  const readBlob = async (input: {
    repo: string;
    sha: string;
  }): Promise<
    { ok: true; contentBase64: string } | { ok: false; detail: string }
  > => {
    const result = await run({
      args: ["api", `/repos/${input.repo}/git/blobs/${encode(input.sha)}`]
    });
    if (!result.ok) return { ok: false, detail: failureDetail(result) };
    const body = parseJson(result.stdout);
    const content = readString(body?.content);
    if (!content || body?.encoding !== "base64") {
      return {
        ok: false,
        detail: "GitHub did not return base64 content for the saved blob."
      };
    }
    return { ok: true, contentBase64: content.replace(/\s+/g, "") };
  };

  const mutate = async (
    args: string[],
    body: Record<string, unknown>
  ): Promise<MutationResult> => {
    const result = await run({ args, stdin: JSON.stringify(body) });
    return result.ok ?
        { ok: true }
      : { ok: false, detail: failureDetail(result) };
  };

  return {
    readFile,
    readBranchHead,
    readPullRequest,
    readBlob,
    deleteFile: (input) =>
      mutate(
        [
          "api",
          "--method",
          "DELETE",
          `/repos/${input.repo}/contents/${input.path}`,
          "--input",
          "-"
        ],
        {
          message: input.message,
          sha: input.blobSha,
          branch: input.branch
        }
      ),
    restoreFile: (input) =>
      mutate(
        [
          "api",
          "--method",
          "PUT",
          `/repos/${input.repo}/contents/${input.path}`,
          "--input",
          "-"
        ],
        {
          message: input.message,
          content: input.contentBase64,
          sha: input.blobSha,
          branch: input.branch
        }
      ),
    closePullRequest: (input) =>
      mutate(
        [
          "api",
          "--method",
          "PATCH",
          `/repos/${input.repo}/pulls/${input.number}`,
          "--input",
          "-"
        ],
        { state: "closed" }
      ),
    deleteBranch: async (input) => {
      const result = await run({
        args: [
          "api",
          "--method",
          "DELETE",
          `/repos/${input.repo}/git/refs/heads/${encode(input.branch)}`
        ]
      });
      // A branch that is already gone is the state the caller asked for.
      if (result.ok || result.status === 404) return { ok: true };
      return { ok: false, detail: failureDetail(result) };
    }
  };
}
