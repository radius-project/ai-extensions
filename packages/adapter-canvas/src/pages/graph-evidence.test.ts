import { describe, expect, it } from "vitest";
import {
  authoredResponse,
  strictGraphReader,
  scriptGraphDiff
} from "../../test/support/canonical-graphs.js";
import { renderGraphEvidence } from "./graph-evidence.js";

describe("graph page evidence", () => {
  it("labels actual recipe outputs as expectations and preserves worktree fingerprints", () => {
    const result = authoredResponse().result;
    if (result.kind !== "authored")
      throw new Error("Expected authored fixture");
    const html = renderGraphEvidence({
      unavailable: false,
      result: {
        ...result,
        kind: "planned",
        target: { ...result.target, environment: "dev" },
        provenance: {
          kind: "workspace",
          repo: "owner/repo",
          workspaceRef: "workspace-test",
          branch: "feature",
          fingerprint: `sha256:${"b".repeat(64)}`,
          resolvedAt: "2026-09-15T00:00:00Z"
        },
        enrichment: {
          recipes: [],
          observation: result.observation
        }
      }
    });
    expect(html).toContain(
      "Expected recipe outputs, not a guaranteed deployment plan"
    );
    expect(html).toContain(`feature · sha256:${"b".repeat(64)}`);
  });
  it("does not fabricate source provenance for a deployed observation", () => {
    const html = renderGraphEvidence({
      unavailable: false,
      result: {
        kind: "deployed",
        target: { repo: "owner/repo", environment: "dev", application: "app" },
        graph: { resources: [] },
        observation: {
          quality: "current",
          completeness: "complete",
          evidence: "radius"
        }
      }
    });
    expect(html).toContain("Deployed observation:");
    expect(html).not.toContain("sha256:");
  });
  it("preserves a polite accessible live region before evidence arrives", () => {
    expect(renderGraphEvidence(undefined)).toContain(
      'role="status" aria-live="polite"'
    );
  });
  it("escapes unavailable messages instead of interpolating markup", () => {
    const html = renderGraphEvidence({
      unavailable: true,
      reason: "RESULT_UNAVAILABLE",
      message: "</p><script>alert(1)</script>"
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("renders exact authored commit provenance", () => {
    expect(
      renderGraphEvidence({
        unavailable: false,
        result: authoredResponse().result
      })
    ).toContain(`Authored source: owner/repo · feature · ${"a".repeat(40)}`);
  });
  it("renders both diff sources, not a synthetic deployed observation", () => {
    const response = scriptGraphDiff(strictGraphReader()).response;
    expect(
      renderGraphEvidence({ unavailable: false, result: response.result })
    ).toContain(`main · ${"a".repeat(40)} → acme/widgets · feat`);
  });
});
