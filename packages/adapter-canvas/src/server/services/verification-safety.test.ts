import { expect, it } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { createVerificationSafety } from "./verification-safety.js";

it.each(["fetchFile", "fetchFileResult"])(
  "rejects a missing %s selected-account reader during construction",
  (dependency) => {
    const deps = {
      fetchFile: async () => null,
      fetchFileResult: async () => ({ content: null, error: null, status: 404 })
    };
    Reflect.deleteProperty(deps, dependency);
    expect(() => createVerificationSafety(deps)).toThrow(
      "Verification safety requires"
    );
  }
);

it.each([
  ["safe", 0, "release", null],
  ["missing branch", 0, "", "default branch"],
  ["unavailable repository", 1, "release", "default branch"],
  ["legacy deploy", 0, "release", "legacy deploy"],
  ["chained dispatcher", 0, "release", "auto-run"],
  ["unreadable dispatcher", 0, "release", "safely inspect"]
] as const)(
  "qualifies %s using only the selected account and current default branch",
  async (scenario, code, branch, refusal) => {
    const calls: string[] = [];
    const executor = successfulSelectedGhExecutor({
      login: "fixture-user",
      run: async (args) => {
        expect(args).toEqual([
          "api",
          "/repos/owner/repo",
          "--jq",
          ".default_branch"
        ]);
        calls.push("repository");
        return { code, stdout: branch, stderr: "" };
      }
    });
    const inspect = createVerificationSafety({
      fetchFile: async (selected, repo, path, ref) => {
        expect([repo, path, ref, selected]).toEqual([
          "owner/repo",
          ".github/workflows/radius-verify-credentials.yml",
          branch,
          executor
        ]);
        calls.push("verify");
        return "on:\n  workflow_dispatch:\n";
      },
      fetchFileResult: async (selected, repo, path, ref) => {
        expect([repo, ref, selected]).toEqual(["owner/repo", branch, executor]);
        calls.push(path);
        if (scenario === "legacy deploy" && path.endsWith("radius-deploy.yml"))
          return {
            content: "on:\n  workflow_run:\n",
            status: 200,
            error: null
          };
        if (path.endsWith("run-rad-commands.yml")) {
          if (scenario === "chained dispatcher")
            return {
              content: "on:\n  workflow_run:\n",
              status: 200,
              error: null
            };
          if (scenario === "unreadable dispatcher")
            return { content: null, status: 403, error: "Controlled refusal." };
          return {
            content: "on:\n  workflow_dispatch:\n",
            status: 200,
            error: null
          };
        }
        return { content: null, status: 404, error: null };
      }
    });
    const result = await inspect(executor, "owner/repo");
    if (refusal === null) expect(result).toBeNull();
    else expect(result).toContain(refusal);
    expect(calls).toHaveLength(code !== 0 || !branch ? 1 : 4);
  }
);
