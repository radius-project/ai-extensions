import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  encodeWorkflowContent,
  setupValueDigest,
  workflowBlobSha,
  workflowContentDigest,
  workflowTempFile
} from "./setup-workflow-content.js";

describe("setup workflow contents", () => {
  it("preserves exact Git blob and SHA-256 identities", () => {
    const encoded = encodeWorkflowContent("on: push");
    expect(encoded).toBe("b246IHB1c2g=");
    expect(workflowContentDigest(encoded)).toBe(
      "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a"
    );
    expect(setupValueDigest("on: push")).toBe(workflowContentDigest(encoded));
    expect(workflowBlobSha(encodeWorkflowContent(""))).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
    expect(workflowContentDigest(encodeWorkflowContent(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it("writes exactly one request-local body and makes removal idempotent", () => {
    const body = '{"content":"workflow","branch":"feature/selected"}';
    const path = workflowTempFile.write(body);
    try {
      expect(readFileSync(path, "utf8")).toBe(body);
      expect(path).toContain("radius-wf-commit-");
    } finally {
      workflowTempFile.remove(path);
    }
    expect(existsSync(path)).toBe(false);
    expect(() => workflowTempFile.remove(path)).not.toThrow();
  });
});
