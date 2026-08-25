import type {
  BranchHeadState,
  RepositoryFileState
} from "./workflow-provenance.js";
import type {
  MutationResult,
  PullRequestState,
  WorkflowRollbackPorts
} from "./workflow-rollback.js";
import type { SelectedGhExecutor } from "../../gh.js";
import { createHash } from "node:crypto";
import {
  isMergedPullRequestBody,
  parsePullRequestUrl
} from "./pull-request-url.js";
import { parseGhHttpStatus } from "./gh-command-result.js";

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

/** Run rollback reads and writes through the account selected for this setup. */
export function createSelectedWorkflowRollbackCommand(
  executor: SelectedGhExecutor
): WorkflowRollbackCommand {
  return async ({ args, stdin }) => {
    try {
      const result = await executor.run(args, {
        timeout: 20000,
        ...(stdin === undefined ? {} : { stdin })
      });
      const stderr = result.stderr.trim();
      const ok = result.code === 0 || result.code === "0";
      return {
        ok,
        status: ok ? 200 : parseGhHttpStatus(stderr),
        stdout: result.stdout.trim(),
        stderr
      };
    } catch (error) {
      const detail = executor.errorMessage(error);
      return {
        ok: false,
        status: parseGhHttpStatus(detail),
        stdout: "",
        stderr: detail
      };
    }
  };
}

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

  const readRepository = async (input: {
    repo: string;
  }): Promise<
    { status: "readable" } | { status: "unreadable"; detail: string }
  > => {
    const result = await run({ args: ["api", `/repos/${input.repo}`] });
    return result.ok ?
        { status: "readable" }
      : { status: "unreadable", detail: failureDetail(result) };
  };

  const confirmAbsent = async (
    repo: string,
    result: WorkflowRollbackCommandResult
  ): Promise<
    { status: "absent" } | { status: "unreadable"; detail: string }
  > => {
    const repository = await readRepository({ repo });
    return repository.status === "readable" ?
        { status: "absent" }
      : {
          status: "unreadable",
          detail: `${failureDetail(result)} Radius could not confirm repository access after the 404: ${repository.detail}`
        };
  };

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
          await confirmAbsent(input.repo, result)
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
          await confirmAbsent(input.repo, result)
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
    const reference = parsePullRequestUrl(input.pullRequestUrl, input.repo);
    if (!reference) {
      return {
        status: "unknown",
        detail:
          "The saved setup pull request URL does not name a pull request in this repository."
      };
    }
    const result = await run({
      args: ["api", `/repos/${reference.repo}/pulls/${reference.number}`]
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
    if (isMergedPullRequestBody(body)) {
      return { status: "merged", number };
    }
    if (body?.state === "open" || body?.state === "closed") {
      return { status: body.state, number };
    }
    return {
      status: "unknown",
      detail: "GitHub returned an unrecognized setup pull request state."
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
    readRepository,
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
      if (result.ok) return { ok: true };
      if (result.status === 404) {
        const absent = await confirmAbsent(input.repo, result);
        return absent.status === "absent" ?
            { ok: true }
          : { ok: false, detail: absent.detail };
      }
      return { ok: false, detail: failureDetail(result) };
    }
  };
}
