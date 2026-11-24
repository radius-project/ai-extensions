import { describe, expect, it, vi } from "vitest";
import { reconcileDeploymentAdmission } from "./deployment-admission-reconciliation.js";

const input = {
  key: { host: "github.com", repositoryId: 42, environment: "prod" },
  repo: "octo/app",
  account: "fixture-user",
  workflow: "delete-application.yml",
  pending: {
    nonce: "fixture-nonce",
    record: {
      correlation: "dep-fixture",
      account: "fixture-user",
      application: "fixture-app",
      environment: "prod",
      deploymentId: "7",
      approvedRunId: 17,
      startedAt: 123
    }
  }
};

const evidence = {
  id: 21,
  repository: { full_name: "Octo/App", id: 42 },
  run_attempt: 1,
  event: "workflow_dispatch",
  path: ".github/workflows/delete-application.yml",
  display_title: "Radius - Delete prod [radius:v1 app=fixture-app] dep-fixture",
  status: "completed",
  conclusion: "failure"
};

function fixture(run: unknown = evidence) {
  return {
    discover: vi.fn(async (): Promise<number | null> => 21),
    readRun: vi.fn(async (_id: number) => run),
    release: vi.fn(async () => true)
  };
}

describe("reconciling a durable deployment admission", () => {
  it("releases only the exact persisted nonce after terminal proof", async () => {
    const ports = fixture();
    await expect(reconcileDeploymentAdmission(input, ports)).resolves.toBe(
      true
    );
    expect(ports.discover).toHaveBeenCalledWith(
      "dep-fixture",
      123,
      "delete-application.yml"
    );
    expect(ports.readRun).toHaveBeenCalledWith(21);
    expect(ports.release).toHaveBeenCalledWith(input.key, input.pending.nonce);
  });

  it.each([
    { id: 17 },
    { run_attempt: 2 },
    { event: "push" },
    { path: ".github/workflows/deploy.yml" },
    { repository: { full_name: "octo/app", id: 91 } },
    { repository: { full_name: "octo/other", id: 42 } },
    { display_title: evidence.display_title + "-different" },
    { status: "waiting", conclusion: null },
    { conclusion: "unrecognized" }
  ])("retains the admission on nonmatching evidence %o", async (change) => {
    const ports = fixture({ ...evidence, ...change });
    await expect(reconcileDeploymentAdmission(input, ports)).resolves.toBe(
      false
    );
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("does not read or release when the selected account or discovered run is unavailable", async () => {
    const ports = fixture();
    await expect(
      reconcileDeploymentAdmission({ ...input, account: "other" }, ports)
    ).resolves.toBe(false);
    expect(ports.discover).not.toHaveBeenCalled();
    ports.discover.mockResolvedValue(null);
    await expect(reconcileDeploymentAdmission(input, ports)).resolves.toBe(
      false
    );
    expect(ports.readRun).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("surfaces observation errors without releasing the admission", async () => {
    const ports = fixture();
    ports.readRun.mockRejectedValue(new Error("Unavailable"));
    await expect(reconcileDeploymentAdmission(input, ports)).rejects.toThrow(
      "Unavailable"
    );
    expect(ports.release).not.toHaveBeenCalled();
  });
});
