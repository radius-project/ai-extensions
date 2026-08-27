import { describe, expect, it } from "vitest";
import { workflowCommitMessage } from "./workflow-commit-message.js";

describe("workflowCommitMessage", () => {
  it("suppresses push-triggered CI for automated workflow commits", () => {
    expect(workflowCommitMessage("Update Radius workflow", true)).toBe(
      "Update Radius workflow [skip ci]"
    );
  });

  it("preserves commit messages when CI must run", () => {
    expect(workflowCommitMessage("Update Radius workflow", false)).toBe(
      "Update Radius workflow"
    );
  });
});
