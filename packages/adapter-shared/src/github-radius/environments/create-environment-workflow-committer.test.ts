import { describe, expect, it } from "vitest";
import {
  createWorkflowFileCommitter,
  workflowContentDigest
} from "./create-environment-workflow-committer.js";
import { operationDomain } from "../../../../core/test/support/environment-operation-domain.js";

describe("Node workflow identity adapter", () => {
  it("hashes decoded bytes rather than the base64 text", () => {
    expect(workflowContentDigest("b246IHB1c2g=")).toBe(
      "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a"
    );
    expect(workflowContentDigest("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("supplies decoded-byte hashing to the core commit sequence", async () => {
    const unexpected = (): never => {
      throw new Error("Unexpected adapter operation");
    };
    const bodies: string[] = [];
    const removed: string[] = [];
    const committer = createWorkflowFileCommitter(
      {
        operationDomain,
        runGh: async () => ({
          code: 1,
          stdout: "",
          stderr: "HTTP 404: Not Found"
        }),
        runGhWorkflow: async () => ({
          code: 0,
          stdout: '{"content":{"sha":"blob"},"commit":{"sha":"commit"}}',
          stderr: ""
        }),
        getDefaultBranch: unexpected,
        getBranchHeadSha: unexpected,
        createBranchRef: unexpected,
        tempFile: {
          write: (body) => {
            bodies.push(body);
            return "body.json";
          },
          remove: (path) => {
            removed.push(path);
          }
        },
        errorMessage: String,
        pushStep: unexpected,
        now: () => 0
      },
      { targetRepo: "octo/app", envName: "dev" }
    );
    expect(
      await committer.commitWorkflowFileSmart(
        "workflow.yml",
        "b246IHB1c2g=",
        "Add workflow"
      )
    ).toMatchObject({
      ok: true,
      contentSha256:
        "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a",
      blobSha: "blob",
      commitSha: "commit"
    });
    expect(JSON.parse(bodies[0])).toMatchObject({ content: "b246IHB1c2g=" });
    expect(removed).toEqual(["body.json"]);
  });
});
