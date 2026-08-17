import { describe, it, expect, beforeEach, vi } from "vitest";

const childProcess = {
  execFile: vi.fn(),
  execFileSync: vi.fn()
};
vi.mock("node:child_process", () => childProcess);

const { listWorkflowArtifacts, ARTIFACT_PAGE_SIZE, MAX_ARTIFACT_PAGES } =
  await import("./deploy-artifacts.js");

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
  return childProcess.execFile.mock.calls.map((call) => {
    const args = call[1] as string[];
    return args[args.length - 1];
  });
}

// Serve one JSON body per successive `gh api` call.
function serve(bodies: string[]) {
  let call = 0;
  childProcess.execFile.mockImplementation((_file, _args, _opts, cb) => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    cb(null, body, "");
    return { stdin: { end() {} } };
  });
}

describe("listWorkflowArtifacts", () => {
  beforeEach(() => {
    childProcess.execFile.mockReset();
  });

  it("reads a single page for a run-scoped listing", async () => {
    serve([page(["radius-deploy-status-dev-todolist"])]);
    const found = await listWorkflowArtifacts("octo/app", 12345);
    expect(found).toHaveLength(1);
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
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
    expect(childProcess.execFile).toHaveBeenCalledTimes(3);
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
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });

  it("stops at a short page rather than requesting past the end", async () => {
    serve([page(noise(3))]);
    await listWorkflowArtifacts("octo/app", null, "radius-deploy-status-dev-");
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });

  it("gives up after the page budget instead of walking the whole history", async () => {
    // A repo with no deploy-status artifact must cost a bounded number of
    // calls, not a walk of its entire artifact history.
    serve([page(noise(ARTIFACT_PAGE_SIZE))]);
    await listWorkflowArtifacts("octo/app", null, "radius-deploy-status-dev-");
    expect(childProcess.execFile).toHaveBeenCalledTimes(MAX_ARTIFACT_PAGES);
  });

  it("falls back to the bare prefix when no environment prefix is given", async () => {
    serve([
      page([
        "radius-deploy-status-prod-other",
        ...noise(ARTIFACT_PAGE_SIZE - 1)
      ])
    ]);
    await listWorkflowArtifacts("octo/app", null);
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when the response is not a listing", async () => {
    serve(['{"message":"Not Found"}']);
    expect(await listWorkflowArtifacts("octo/app", null)).toEqual([]);
  });
});
