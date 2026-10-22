import { describe, expect, it, vi } from "vitest";
import { workflowBlobSha } from "@radius-project/adapter-shared";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import { writeSelectedRepositoryFile } from "./selected-repository-write.js";

const INPUT = {
  repo: "fixture/app",
  path: ".github/workflows/run-rad-commands.yml",
  branch: "feature/model & validation",
  content: "synthetic workflow\n",
  message: "Update workflow"
};

function fixture(
  read: { code: number; stdout: string; stderr: string },
  writeError = ""
) {
  const run = vi.fn(async (args: string[]) => {
    if (!args.includes("--method")) return read;
    return {
      code: writeError ? 1 : 0,
      stdout: "",
      stderr: writeError
    };
  });
  const executor = successfulSelectedGhExecutor({ login: "fixture-user", run });
  return { executor, run };
}

describe("selected repository file writes", () => {
  it.each([
    {
      label: "create",
      code: 1,
      stdout: '{"message":"Not Found"}',
      stderr: "HTTP 404",
      sha: undefined
    },
    {
      label: "update",
      code: 0,
      stdout: JSON.stringify({ sha: "a".repeat(40) }),
      stderr: "",
      sha: "a".repeat(40)
    }
  ])(
    "uses one selected executor to $label with the exact branch and stdin-only payload",
    async ({ code, stdout, stderr, sha }) => {
      const { executor, run } = fixture({ code, stdout, stderr });
      expect(await writeSelectedRepositoryFile(executor, INPUT)).toBe(true);
      expect(run).toHaveBeenNthCalledWith(
        1,
        [
          "api",
          `/repos/${INPUT.repo}/contents/${INPUT.path}?ref=feature%2Fmodel%20%26%20validation`
        ],
        { timeout: 15000 }
      );
      expect(run).toHaveBeenNthCalledWith(
        2,
        [
          "api",
          "--method",
          "PUT",
          `/repos/${INPUT.repo}/contents/${INPUT.path}`,
          "--input",
          "-"
        ],
        {
          timeout: 30000,
          stdin: JSON.stringify({
            message: INPUT.message,
            content: Buffer.from(INPUT.content).toString("base64"),
            branch: INPUT.branch,
            ...(sha ? { sha } : {})
          })
        }
      );
      expect(run).toHaveBeenCalledTimes(2);
    }
  );

  it("does not commit identical UTF-8 content", async () => {
    const sha = workflowBlobSha(Buffer.from(INPUT.content).toString("base64"));
    const { executor, run } = fixture({
      code: 0,
      stdout: JSON.stringify({ sha }),
      stderr: ""
    });
    expect(await writeSelectedRepositoryFile(executor, INPUT)).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    "null",
    "[]",
    "false",
    "{}",
    '{"sha":42}',
    '{"sha":""}',
    '{"sha":"invalid"}'
  ])(
    "refuses malformed existing-file identity %s before mutation",
    async (stdout) => {
      const { executor, run } = fixture({ code: 0, stdout, stderr: "" });
      await expect(
        writeSelectedRepositoryFile(executor, INPUT)
      ).rejects.toThrow("invalid repository file identity");
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { code: 1, stdout: "", stderr: "HTTP 403: denied", message: "denied" },
    { code: 1, stdout: "", stderr: "", message: "Could not verify" },
    { code: 1, stdout: "", stderr: "command timed out", message: "timed out" },
    { code: 0, stdout: "not JSON", stderr: "", message: "invalid JSON" }
  ])(
    "refuses an unverifiable read: $message",
    async ({ code, stdout, stderr, message }) => {
      const { executor, run } = fixture({ code, stdout, stderr });
      await expect(
        writeSelectedRepositoryFile(executor, INPUT)
      ).rejects.toThrow(message);
      expect(run).toHaveBeenCalledOnce();
    }
  );

  it("redacts read failures through the authorized executor", async () => {
    const { executor } = fixture({
      code: 1,
      stdout: "",
      stderr: "private fixture detail"
    });
    executor.redact = () => "redacted read failure";
    await expect(writeSelectedRepositoryFile(executor, INPUT)).rejects.toThrow(
      "redacted read failure"
    );
  });

  it("propagates a rejected write without retrying or changing credentials", async () => {
    const { executor, run } = fixture(
      { code: 1, stdout: '{"message":"Not Found"}', stderr: "HTTP 404" },
      "protected branch"
    );
    await expect(writeSelectedRepositoryFile(executor, INPUT)).rejects.toThrow(
      "protected branch"
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("refuses a missing branch before any command", async () => {
    const { executor, run } = fixture({ code: 0, stdout: "{}", stderr: "" });
    await expect(
      writeSelectedRepositoryFile(executor, { ...INPUT, branch: " " })
    ).rejects.toThrow("explicit repository branch");
    expect(run).not.toHaveBeenCalled();
  });
});
