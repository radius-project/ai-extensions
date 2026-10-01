import { describe, it, expect, beforeEach, vi } from "vitest";
import { ARTIFACT_PAGE_SIZE, MAX_ARTIFACT_PAGES } from "@radius-project/core";
import { createWorkflowArtifactReads } from "./workflow-artifacts.js";
import type { WorkflowRunner } from "./workflow-reads.js";

const run = vi.fn<WorkflowRunner>();
const { listWorkflowArtifacts } = createWorkflowArtifactReads(run);

// Build a page of artifact names as the GitHub listing endpoint returns them.
function page(names: string[]) {
  return JSON.stringify({
    artifacts: names.map((name, i) => ({
      id: i + 1,
      name,
      expired: false,
      created_at: "2026-08-06T18:00:00Z",
      workflow_run: { id: 100 }
    }))
  });
}

// Fill a page with unrelated CI artifacts, the way a busy repo does.
function noise(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => `test-report-${offset + i}`);
}

function requestedPaths(): string[] {
  return run.mock.calls.map((call) => {
    const args = call[0];
    return args[1];
  });
}

// Serve one JSON body per successive `gh api` call.
function serve(bodies: string[]) {
  let call = 0;
  run.mockImplementation(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    return { code: 0, stdout: `HTTP/2 200\n\n${body}`, stderr: "" };
  });
}

describe("listWorkflowArtifacts", () => {
  beforeEach(() => {
    run.mockReset();
  });

  it("reads a single page for a run-scoped listing", async () => {
    serve([page(["radius-deploy-status-dev-todolist"])]);
    const found = await listWorkflowArtifacts("octo/app", 12345);
    expect(found).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestedPaths()[0]).toContain("/actions/runs/12345/artifacts");
  });

  it("pages past unrelated CI artifacts to find the deploy status one", async () => {
    // A repo whose CI uploads on every push can bury the deploy-status
    // artifact well past the first page. Reading only page 1 would render
    // "Nothing deployed yet" for an application that is actually deployed.
    serve([
      page(noise(ARTIFACT_PAGE_SIZE)),
      page(noise(ARTIFACT_PAGE_SIZE, 100)),
      page([
        "radius-deploy-status-dev-todolist",
        ...noise(ARTIFACT_PAGE_SIZE - 1, 200)
      ])
    ]);
    const found = await listWorkflowArtifacts(
      "octo/app",
      null,
      "radius-deploy-status-dev-"
    );
    expect(
      found.some((a) => a.name === "radius-deploy-status-dev-todolist")
    ).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(requestedPaths()[2]).toContain("page=3");
  });

  it("stops as soon as a page contains a match, since listings are newest-first", async () => {
    serve([
      page([
        "radius-deploy-status-dev-todolist",
        ...noise(ARTIFACT_PAGE_SIZE - 1)
      ]),
      page(noise(ARTIFACT_PAGE_SIZE, 100))
    ]);
    await listWorkflowArtifacts("octo/app", null, "radius-deploy-status-dev-");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps paging past a page that only holds live-slot artifacts", async () => {
    // Live-slot names carry the deploy-status prefix but are dropped from
    // repo-wide reads (their sequences are only comparable within one run).
    // Stopping on a page that holds only live slots would hide the previous
    // deploy's terminal artifact on the next page and render "Nothing
    // deployed yet" for an application that is actually deployed.
    serve([
      page([
        "radius-deploy-status-dev-todolist-live-100-slot-0",
        "radius-deploy-status-dev-todolist-live-100-slot-1",
        ...noise(ARTIFACT_PAGE_SIZE - 2)
      ]),
      page([
        "radius-deploy-status-dev-todolist",
        ...noise(ARTIFACT_PAGE_SIZE - 1, 100)
      ])
    ]);
    const found = await listWorkflowArtifacts(
      "octo/app",
      null,
      "radius-deploy-status-dev-"
    );
    expect(
      found.some((a) => a.name === "radius-deploy-status-dev-todolist")
    ).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops at a short page rather than requesting past the end", async () => {
    serve([page(noise(3))]);
    await listWorkflowArtifacts("octo/app", null, "radius-deploy-status-dev-");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up after the page budget instead of walking the whole history", async () => {
    // A repo with no deploy-status artifact must cost a bounded number of
    // calls, not a walk of its entire artifact history.
    serve([page(noise(ARTIFACT_PAGE_SIZE))]);
    await listWorkflowArtifacts("octo/app", null, "radius-deploy-status-dev-");
    expect(run).toHaveBeenCalledTimes(MAX_ARTIFACT_PAGES);
  });

  it("falls back to the bare prefix when no environment prefix is given", async () => {
    serve([
      page([
        "radius-deploy-status-prod-other",
        ...noise(ARTIFACT_PAGE_SIZE - 1)
      ])
    ]);
    await listWorkflowArtifacts("octo/app", null);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports malformed rather than absence when the response is not a listing", async () => {
    serve(['{"message":"Not Found"}']);
    await expect(listWorkflowArtifacts("octo/app", null)).rejects.toMatchObject(
      {
        code: "GH_ARTIFACT_MALFORMED"
      }
    );
  });
});
