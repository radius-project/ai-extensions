import { describe, it, expect } from "vitest";
import {
  verifyWorkflowFilesMatchSource,
  type ExpectedWorkflowFile,
  type WorkflowReadbackPorts
} from "./delete-environment-workflow-verification.js";

const files: ExpectedWorkflowFile[] = [
  {
    file: "delete-environment.yml",
    path: ".github/workflows/delete-environment.yml",
    expected: "dispatcher-source"
  },
  {
    file: "delete-environment-azure.yml",
    path: ".github/workflows/delete-environment-azure.yml",
    expected: "provider-source"
  }
];

function ports(
  overrides: Partial<WorkflowReadbackPorts>
): WorkflowReadbackPorts {
  return {
    defaultBranch: async () => "main",
    readFile: async (path) =>
      path.endsWith("azure.yml") ? "provider-source" : "dispatcher-source",
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

describe("verifyWorkflowFilesMatchSource", () => {
  it("passes when both files are present and match the packaged source", async () => {
    const result = await verifyWorkflowFilesMatchSource(files, ports({}));
    expect(result).toEqual({ ok: true, branch: "main" });
  });

  it("reads back from the resolved default branch, not a fixed guess", async () => {
    const seen: string[] = [];
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        defaultBranch: async () => "trunk",
        readFile: async (path, branch) => {
          seen.push(branch);
          return path.endsWith("azure.yml") ? "provider-source" : (
              "dispatcher-source"
            );
        }
      })
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["trunk", "trunk"]);
  });

  it("fails when the default branch cannot be read", async () => {
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        defaultBranch: async () => {
          throw new Error("boom");
        }
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch-unreadable");
    expect(result.detail).toContain("boom");
  });

  it("fails when the default branch is empty", async () => {
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({ defaultBranch: async () => "" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch-unreadable");
  });

  it("fails when a file is missing on the branch", async () => {
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        readFile: async (path) =>
          path.endsWith("azure.yml") ? null : "dispatcher-source"
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.file).toBe("delete-environment-azure.yml");
    expect(result.branch).toBe("main");
  });

  it("treats an empty-string file as missing", async () => {
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        readFile: async (path) =>
          path.endsWith("azure.yml") ? "" : "dispatcher-source"
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing");
    expect(result.file).toBe("delete-environment-azure.yml");
  });

  it("fails when a file drifts from the packaged source (stale provider guard)", async () => {
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        readFile: async (path) =>
          path.endsWith("azure.yml") ? "stale-provider" : "dispatcher-source"
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("mismatch");
    expect(result.file).toBe("delete-environment-azure.yml");
  });

  it("fails when a file cannot be read", async () => {
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        readFile: async (path) => {
          if (path.endsWith("azure.yml")) throw new Error("network down");
          return "dispatcher-source";
        }
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("file-unreadable");
    expect(result.detail).toContain("network down");
  });

  it("stops at the first offending file", async () => {
    const reads: string[] = [];
    const result = await verifyWorkflowFilesMatchSource(
      files,
      ports({
        readFile: async (path) => {
          reads.push(path);
          return null;
        }
      })
    );
    expect(result.ok).toBe(false);
    // Only the first (dispatcher) file was read before stopping.
    expect(reads).toEqual([".github/workflows/delete-environment.yml"]);
  });
});
