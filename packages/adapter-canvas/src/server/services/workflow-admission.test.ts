import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeploymentAdmissionStore } from "@radius-project/adapter-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowAdmission } from "./workflow-admission.js";

const request = {
  repo: "octo/app",
  environment: "prod",
  branch: "main",
  workflowFile: "run-rad-commands.yml",
  application: "demo",
  correlation: "dep-new",
  startedAt: 123
};
const key = { host: "github.com", repositoryId: 72, environment: "prod" };
const repository = { id: 72, full_name: "Octo/App" };
const exactDeploy = {
  id: 91,
  repository,
  run_attempt: 1,
  event: "workflow_dispatch",
  path: ".github/workflows/run-rad-commands.yml",
  display_title: "Radius - Deploy prod [radius:v1 app=demo] dep-new",
  status: "completed",
  conclusion: "success"
};

describe("workflow admission across Canvas mutation paths", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "radius-workflow-admission-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("blocks competing calls until independent terminal evidence matches", async () => {
    const store = createDeploymentAdmissionStore(root);
    let evidence: unknown = { ...exactDeploy, run_attempt: 2 };
    const read = async (args: string[]) => {
      if (args[1] === "/repos/octo/app") return repository;
      if (args[1] === "/repos/octo/app/actions/runs/91") return evidence;
      if (args[1]?.includes("/actions/workflows/"))
        return [{ workflow_runs: [] }];
      throw new Error(`Unexpected command ${args.join(" ")}`);
    };
    const port = createWorkflowAdmission(store, read);
    const first = await port.acquire(request);
    if (!first) throw new Error("Missing first lease.");
    await expect(port.acquire(request)).resolves.toBeNull();
    const hint = {
      kind: "terminal-candidate",
      runId: "91",
      conclusion: "success"
    } as const;
    await expect(first.settle(hint)).rejects.toThrow("terminal");
    expect(await store.read(key)).not.toBeNull();
    evidence = exactDeploy;
    await first.settle(hint);
    const next = await port.acquire(request);
    if (!next) throw new Error("Missing next lease.");
    await next.settle({ kind: "no-spawn" });
    expect(await store.read(key)).toBeNull();
  });

  it("reconciles an earlier guarded deletion only with its selected account", async () => {
    const store = createDeploymentAdmissionStore(root);
    await store.acquire(key, {
      account: "fixture-user",
      application: "demo",
      environment: "prod",
      correlation: "dep-delete",
      startedAt: 123,
      deploymentId: "83",
      approvedRunId: 84
    });
    const ambient = vi.fn(async () => repository);
    const withoutAccount = createWorkflowAdmission(store, ambient);
    await expect(withoutAccount.acquire(request)).resolves.toBeNull();
    expect(ambient).toHaveBeenCalledExactlyOnceWith(["api", "/repos/octo/app"]);
    const selected = vi.fn(async (args: string[]) => {
      if (args[1]?.includes("/actions/workflows/"))
        return [
          { workflow_runs: [{ id: 92, display_title: "dep-other" }] },
          { workflow_runs: [{ id: 91, display_title: "dep-delete" }] }
        ];
      if (args[1] === "/repos/octo/app/actions/runs/91")
        return {
          ...exactDeploy,
          path: ".github/workflows/delete-application.yml",
          display_title: "Radius - Delete prod [radius:v1 app=demo] dep-delete"
        };
      throw new Error(`Unexpected selected command ${args.join(" ")}`);
    });
    const selectReader = vi.fn(async () => selected);
    const port = createWorkflowAdmission(store, ambient, selectReader);
    expect(await port.acquire(request)).not.toBeNull();
    expect(selectReader).toHaveBeenCalledExactlyOnceWith("fixture-user");
    expect(await store.read(key)).toMatchObject({
      record: { correlation: "dep-new" }
    });
  });
});
