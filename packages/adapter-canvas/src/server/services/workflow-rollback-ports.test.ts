import { describe, expect, it } from "vitest";
import {
  createWorkflowRollbackPorts,
  createWorkflowScopeApiCommand,
  decodeContentDigest,
  type WorkflowRollbackCommandResult
} from "./workflow-rollback-ports.js";

// The wire half of a post-commit rollback: what Radius asks `gh` for, and how
// it reads the answers. `gh` is a scripted fake keyed on the exact argv, so an
// unexpected request fails the test instead of silently resolving.

interface Script {
  [key: string]: Partial<WorkflowRollbackCommandResult>;
}

function harness(script: Script) {
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const ports = createWorkflowRollbackPorts((input) => {
    calls.push(input);
    const key = input.args.join(" ");
    const scripted = script[key];
    if (!scripted) throw new Error(`unscripted gh call: ${key}`);
    return Promise.resolve({
      ok: scripted.ok ?? true,
      status: scripted.status ?? (scripted.ok === false ? null : 200),
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? ""
    });
  });
  return { ports, calls };
}

const REPO = "contoso/store";
const WORKFLOW_PATH = ".github/workflows/verify.yml";
const CONTENTS_PATH = `api /repos/${REPO}/contents/${WORKFLOW_PATH}?ref=main`;

// Every read in this suite asks about the same workflow file on the same
// branch, so only the scripted answer differs from scenario to scenario.
function readVerify(ports: ReturnType<typeof harness>["ports"]) {
  return ports.readFile({ repo: REPO, path: WORKFLOW_PATH, ref: "main" });
}

describe("decodeContentDigest", () => {
  it("digests the bytes a base64 payload carries, ignoring line wrapping", () => {
    const wrapped = "b246IHB1\nc2g=";
    expect(decodeContentDigest(wrapped)).toBe(
      "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a"
    );
  });

  it.each([
    ["a missing value", undefined],
    ["a non-string value", 7],
    ["an empty string", "   "]
  ])("reports no digest for %s", (_label, value) => {
    expect(decodeContentDigest(value)).toBeNull();
  });
});

describe("reading a workflow file", () => {
  it("reports the blob id and content digest GitHub returned", async () => {
    const { ports } = harness({
      [CONTENTS_PATH]: {
        stdout: JSON.stringify({ sha: "blob-1", content: "b246IHB1c2g=" })
      }
    });

    await expect(readVerify(ports)).resolves.toEqual({
      status: "present",
      blobSha: "blob-1",
      contentSha256:
        "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a"
    });
  });

  it("reports a 404 as absent", async () => {
    const { ports } = harness({
      [CONTENTS_PATH]: { ok: false, status: 404, stderr: "Not Found" }
    });

    await expect(readVerify(ports)).resolves.toEqual({ status: "absent" });
  });

  it.each([
    [
      "a failure with no status",
      { ok: false, status: null, stderr: "network down" },
      "network down"
    ],
    [
      "a permission failure",
      { ok: false, status: 403, stderr: "" },
      "GitHub answered HTTP 403."
    ]
  ])("reports %s as unreadable", async (_label, result, detail) => {
    const { ports } = harness({ [CONTENTS_PATH]: result });

    await expect(readVerify(ports)).resolves.toEqual({
      status: "unreadable",
      detail
    });
  });

  it.each([
    ["unparseable output", "not json"],
    ["an empty response", ""],
    ["a JSON null", "null"],
    ["a JSON array", "[]"]
  ])(
    "reports %s as unreadable rather than as a match",
    async (_label, stdout) => {
      const { ports } = harness({ [CONTENTS_PATH]: { stdout } });

      await expect(readVerify(ports)).resolves.toMatchObject({
        status: "unreadable"
      });
    }
  );

  it("falls back to stdout when a failure carried no stderr", async () => {
    const { ports } = harness({
      [CONTENTS_PATH]: {
        ok: false,
        status: 500,
        stderr: "",
        stdout: "upstream unavailable"
      }
    });

    await expect(readVerify(ports)).resolves.toEqual({
      status: "unreadable",
      detail: "upstream unavailable"
    });
  });

  it("says the request failed when GitHub named neither a status nor a reason", async () => {
    const { ports } = harness({
      [CONTENTS_PATH]: { ok: false, status: null, stderr: "", stdout: "" }
    });

    await expect(readVerify(ports)).resolves.toEqual({
      status: "unreadable",
      detail: "The GitHub API request failed."
    });
  });
});

describe("reading a branch head", () => {
  const HEAD_PATH = "api /repos/contoso/store/git/ref/heads/radius%2Fsetup";

  it("reports the head commit", async () => {
    const { ports } = harness({
      [HEAD_PATH]: { stdout: JSON.stringify({ object: { sha: "head-1" } }) }
    });

    await expect(
      ports.readBranchHead({ repo: "contoso/store", branch: "radius/setup" })
    ).resolves.toEqual({ status: "present", sha: "head-1" });
  });

  it("reports a 404 as absent", async () => {
    const { ports } = harness({
      [HEAD_PATH]: { ok: false, status: 404, stderr: "Not Found" }
    });

    await expect(
      ports.readBranchHead({ repo: "contoso/store", branch: "radius/setup" })
    ).resolves.toEqual({ status: "absent" });
  });

  it.each([
    ["an error", { ok: false, status: 500, stderr: "boom" }],
    ["a response with no head", { stdout: JSON.stringify({ object: {} }) }],
    ["a response that is not an object", { stdout: "[]" }]
  ])("reports %s as unreadable", async (_label, result) => {
    const { ports } = harness({ [HEAD_PATH]: result });

    await expect(
      ports.readBranchHead({ repo: "contoso/store", branch: "radius/setup" })
    ).resolves.toMatchObject({ status: "unreadable" });
  });
});

describe("reading the setup pull request", () => {
  const PULL_PATH = "api /repos/contoso/store/pulls/7";
  const url = "https://github.com/contoso/store/pull/7";

  it.each([
    ["merged by flag", { merged: true, number: 7 }, "merged"],
    ["merged by timestamp", { merged_at: "2026-01-01", number: 7 }, "merged"],
    ["open", { merged: false, state: "open", number: 7 }, "open"],
    ["closed unmerged", { merged: false, state: "closed", number: 7 }, "closed"]
  ])("reports a pull request that is %s", async (_label, body, status) => {
    const { ports } = harness({
      [PULL_PATH]: { stdout: JSON.stringify(body) }
    });

    await expect(
      ports.readPullRequest({ repo: "contoso/store", pullRequestUrl: url })
    ).resolves.toEqual({ status, number: 7 });
  });

  it.each([
    ["a URL from another repository", "https://github.com/other/repo/pull/7"],
    ["a URL that is not a pull request", "https://example.com/pull/7"],
    ["an empty URL", ""]
  ])("refuses to identify %s", async (_label, pullRequestUrl) => {
    // No `gh` call is scripted: a URL Radius cannot trust must never be
    // followed.
    const { ports, calls } = harness({});

    await expect(
      ports.readPullRequest({ repo: "contoso/store", pullRequestUrl })
    ).resolves.toMatchObject({ status: "unknown" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["GitHub refused the read", { ok: false, status: 404, stderr: "gone" }],
    [
      "the response has no number",
      { stdout: JSON.stringify({ state: "open" }) }
    ]
  ])("reports %s as unknown", async (_label, result) => {
    const { ports } = harness({ [PULL_PATH]: result });

    await expect(
      ports.readPullRequest({ repo: "contoso/store", pullRequestUrl: url })
    ).resolves.toMatchObject({ status: "unknown" });
  });
});

describe("reading a saved blob", () => {
  const BLOB_PATH = "api /repos/contoso/store/git/blobs/old-blob";

  it("returns the base64 content with its wrapping removed", async () => {
    const { ports } = harness({
      [BLOB_PATH]: {
        stdout: JSON.stringify({
          content: "b246\nIHB1c2g=",
          encoding: "base64"
        })
      }
    });

    await expect(
      ports.readBlob({ repo: "contoso/store", sha: "old-blob" })
    ).resolves.toEqual({ ok: true, contentBase64: "b246IHB1c2g=" });
  });

  it.each([
    ["GitHub refused", { ok: false, status: 404, stderr: "gone" }],
    [
      "the encoding is not base64",
      { stdout: JSON.stringify({ content: "x", encoding: "utf-8" }) }
    ],
    [
      "the content is missing",
      { stdout: JSON.stringify({ encoding: "base64" }) }
    ]
  ])("fails closed when %s", async (_label, result) => {
    const { ports } = harness({ [BLOB_PATH]: result });

    await expect(
      ports.readBlob({ repo: "contoso/store", sha: "old-blob" })
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("writing the revert", () => {
  const DELETE_FILE = `api --method DELETE /repos/${REPO}/contents/${WORKFLOW_PATH} --input -`;
  const PUT_FILE = `api --method PUT /repos/${REPO}/contents/${WORKFLOW_PATH} --input -`;
  const DELETE_BRANCH = `api --method DELETE /repos/${REPO}/git/refs/heads/radius%2Fsetup`;

  function deleteVerify(ports: ReturnType<typeof harness>["ports"]) {
    return ports.deleteFile({
      repo: REPO,
      path: WORKFLOW_PATH,
      branch: "main",
      blobSha: "blob-1",
      message: "Roll back"
    });
  }

  function deleteSetupBranch(ports: ReturnType<typeof harness>["ports"]) {
    return ports.deleteBranch({ repo: REPO, branch: "radius/setup" });
  }

  it("deletes a file through the contents API with its blob id and branch", async () => {
    const { ports, calls } = harness({ [DELETE_FILE]: {} });

    await expect(deleteVerify(ports)).resolves.toEqual({ ok: true });
    expect(JSON.parse(calls[0]?.stdin ?? "{}")).toEqual({
      message: "Roll back",
      sha: "blob-1",
      branch: "main"
    });
  });

  it("restores a file by putting the previous content back", async () => {
    const { ports, calls } = harness({ [PUT_FILE]: {} });

    await ports.restoreFile({
      repo: REPO,
      path: WORKFLOW_PATH,
      branch: "main",
      blobSha: "blob-1",
      contentBase64: "cHJldmlvdXM=",
      message: "Restore"
    });

    expect(JSON.parse(calls[0]?.stdin ?? "{}")).toEqual({
      message: "Restore",
      content: "cHJldmlvdXM=",
      sha: "blob-1",
      branch: "main"
    });
  });

  it("surfaces a refused write instead of reporting success", async () => {
    const { ports } = harness({
      [DELETE_FILE]: { ok: false, status: 409, stderr: "conflict" }
    });

    await expect(deleteVerify(ports)).resolves.toEqual({
      ok: false,
      detail: "conflict"
    });
  });

  it("closes a pull request by state alone", async () => {
    const { ports, calls } = harness({
      [`api --method PATCH /repos/${REPO}/pulls/7 --input -`]: {}
    });

    await expect(
      ports.closePullRequest({ repo: REPO, number: 7 })
    ).resolves.toEqual({ ok: true });
    expect(JSON.parse(calls[0]?.stdin ?? "{}")).toEqual({ state: "closed" });
  });

  it("deletes a branch ref, treating an already absent branch as done", async () => {
    const { ports } = harness({
      [DELETE_BRANCH]: { ok: false, status: 404, stderr: "Not Found" }
    });

    await expect(deleteSetupBranch(ports)).resolves.toEqual({ ok: true });
  });

  it("surfaces a refused branch deletion", async () => {
    const { ports } = harness({
      [DELETE_BRANCH]: { ok: false, status: 422, stderr: "protected" }
    });

    await expect(deleteSetupBranch(ports)).resolves.toEqual({
      ok: false,
      detail: "protected"
    });
  });

  it("deletes a branch when GitHub accepts it", async () => {
    const { ports, calls } = harness({ [DELETE_BRANCH]: {} });

    await expect(deleteSetupBranch(ports)).resolves.toEqual({ ok: true });
    expect(calls[0]?.stdin).toBeUndefined();
  });
});

describe("createWorkflowScopeApiCommand", () => {
  const SCOPE_REFUSAL =
    "HTTP 403: refusing to allow an OAuth App to create or update workflow `.github/workflows/verify.yml` without `workflow` scope";

  function harnessFor(script: {
    results: Array<
      Partial<WorkflowRollbackCommandResult & { timedOut: boolean }>
    >;
    env?: NodeJS.ProcessEnv;
  }) {
    const attempts: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const queue = [...script.results];
    const command = createWorkflowScopeApiCommand({
      attempt: ({ args, env }) => {
        attempts.push({ args, env });
        const next = queue.shift();
        if (!next) throw new Error("unscripted gh attempt");
        return Promise.resolve({
          ok: next.ok ?? false,
          status: next.status ?? null,
          stdout: next.stdout ?? "",
          stderr: next.stderr ?? "",
          timedOut: next.timedOut ?? false
        });
      },
      readProcessEnv: () => script.env ?? {}
    });
    return { command, attempts };
  }

  it("runs the command once when it succeeds", async () => {
    const { command, attempts } = harnessFor({
      results: [{ ok: true, status: 200, stdout: "{}" }]
    });

    await expect(
      command({ args: ["api", "/repos/o/r"] })
    ).resolves.toMatchObject({ ok: true });
    expect(attempts).toHaveLength(1);
  });

  it("retries a missing workflow scope with the injected token stripped", async () => {
    const { command, attempts } = harnessFor({
      results: [
        { ok: false, status: 403, stderr: SCOPE_REFUSAL },
        { ok: true, status: 200, stdout: "{}" }
      ],
      env: { GH_TOKEN: "injected", PATH: "/usr/bin" }
    });

    await expect(
      command({
        args: ["api", "--method", "DELETE", "/repos/o/r"],
        stdin: "{}"
      })
    ).resolves.toMatchObject({ ok: true });
    expect(attempts).toHaveLength(2);
    // The retry keeps the rest of the environment and drops only the token.
    expect(attempts[1]?.env).toEqual({ PATH: "/usr/bin" });
  });

  it.each([
    ["there is no injected token to strip", { env: {} }],
    [
      "the command was killed rather than answered",
      { env: { GITHUB_TOKEN: "injected" }, timedOut: true }
    ]
  ])("does not change identity when %s", async (_label, script) => {
    const { command, attempts } = harnessFor({
      results: [
        {
          ok: false,
          status: 403,
          stderr: SCOPE_REFUSAL,
          timedOut: "timedOut" in script ? script.timedOut : false
        }
      ],
      env: script.env
    });

    await expect(
      command({ args: ["api", "/repos/o/r"] })
    ).resolves.toMatchObject({ ok: false });
    expect(attempts).toHaveLength(1);
  });

  it("keeps the original failure when the retry fails too", async () => {
    const { command } = harnessFor({
      results: [
        { ok: false, status: 403, stderr: SCOPE_REFUSAL },
        { ok: false, status: 404, stderr: "Not Found" }
      ],
      env: { GH_TOKEN: "injected" }
    });

    await expect(
      command({ args: ["api", "/repos/o/r"] })
    ).resolves.toMatchObject({ status: 403, stderr: SCOPE_REFUSAL });
  });

  it("does not retry a failure that is not a scope refusal", async () => {
    const { command, attempts } = harnessFor({
      results: [{ ok: false, status: 409, stderr: "conflict" }],
      env: { GH_TOKEN: "injected" }
    });

    await expect(
      command({ args: ["api", "/repos/o/r"] })
    ).resolves.toMatchObject({ ok: false, status: 409 });
    expect(attempts).toHaveLength(1);
  });
});
