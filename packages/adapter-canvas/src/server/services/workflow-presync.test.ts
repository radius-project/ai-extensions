import { describe, expect, it, vi } from "vitest";
import type { syncRepoWorkflows, SyncWorkflowResult } from "../../infra.js";
import { createWorkflowPresync } from "./workflow-presync.js";

function fixture(result: Partial<SyncWorkflowResult> = {}) {
  const synchronize = vi.fn<typeof syncRepoWorkflows>().mockResolvedValue({
    created: [],
    updated: [],
    failed: [],
    generationFailures: [],
    branches: ["main", "feature/model&review=1"],
    synchronized: ["main", "feature/model&review=1"].flatMap((branch) =>
      ["run-rad-commands.yml", "run-rad-commands-azure.yml"].map((file) => ({
        path: `.github/workflows/${file}`,
        branch
      }))
    ),
    skipped: false,
    ...result
  });
  const log = vi.fn<(message: string) => void>();
  return {
    synchronize,
    log,
    service: createWorkflowPresync({
      synchronize,
      log,
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error)
    })
  };
}

const target = [
  "fixture/app",
  "Preview East",
  "aws",
  ["run-rad-commands.yml", "run-rad-commands-azure.yml"],
  "feature/model&review=1"
] satisfies Parameters<ReturnType<typeof createWorkflowPresync>["bestEffort"]>;

describe("workflow presynchronization caller policies", () => {
  it.each([
    {
      generationFailures: [
        {
          path: ".github/workflows/run-rad-commands.yml",
          environment: "Preview East",
          reason: "generation-error" as const
        }
      ]
    },
    { synchronized: [] },
    { branches: undefined },
    { skipped: true }
  ])(
    "keeps internal synchronization evidence out of best effort: %j",
    async (result) => {
      const { service } = fixture(result);
      expect(await service.bestEffort(...target)).toEqual({
        created: [],
        updated: [],
        failed: []
      });
    }
  );

  it("preserves delete's independent failure evidence", async () => {
    const failed = [
      { path: ".github/workflows/run-rad-commands.yml", branch: "main" },
      {
        path: ".github/workflows/run-rad-commands-azure.yml",
        branch: target[4]
      }
    ];
    const { service } = fixture({ failed });
    expect(await service.bestEffort(...target)).toEqual({
      created: [],
      updated: [],
      failed
    });
  });

  it("reports legacy synchronization exceptions without throwing", async () => {
    const { service, synchronize, log } = fixture();
    const error = new Error("Workflow state unavailable");
    synchronize.mockRejectedValue(error);
    expect(await service.bestEffort(...target)).toEqual({
      created: [],
      updated: [],
      failed: []
    });
    expect(log).toHaveBeenCalledWith(
      "[radius workflow-presync] fixture/app: Workflow state unavailable"
    );
  });

  it("accepts a no-op without changing ambient target or adding template generation", async () => {
    const { service, synchronize, log } = fixture();
    expect(await service.bestEffort(...target)).toEqual({
      created: [],
      updated: [],
      failed: []
    });
    expect(synchronize).toHaveBeenCalledExactlyOnceWith(
      "fixture/app",
      [{ name: "Preview East", provider: "aws" }],
      {
        workingBranch: target[4],
        only: target[3],
        create: true,
        log: expect.any(Function)
      }
    );
    expect(log).not.toHaveBeenCalled();
    synchronize.mock.calls[0][2]?.log?.("sync diagnostic");
    expect(log).toHaveBeenCalledWith(
      "[radius workflow-presync] fixture/app: sync diagnostic"
    );
  });

  it("retains successful updates and registration-pending evidence, including concurrent creation", async () => {
    const { service, log } = fixture({
      created: ["new.yml"],
      updated: ["existing.yml"],
      registrationPending: ["new.yml", "concurrent.yml"]
    });
    expect(await service.bestEffort(...target)).toEqual({
      created: ["new.yml", "concurrent.yml"],
      updated: ["existing.yml"],
      failed: []
    });
    expect(log).toHaveBeenCalledWith(
      "[radius workflow-presync] fixture/app: existing.yml, new.yml before dispatch"
    );
  });

  it("retains successful legacy synchronization and unspecified provider/branch defaults", async () => {
    const { service, synchronize } = fixture({ updated: ["delete.yml"] });
    expect(
      await service.bestEffort("fixture/app", "dev", "", ["delete.yml"])
    ).toEqual({ created: [], updated: ["delete.yml"], failed: [] });
    expect(synchronize).toHaveBeenCalledWith(
      "fixture/app",
      [{ name: "dev", provider: "" }],
      expect.objectContaining({
        workingBranch: "",
        only: ["delete.yml"],
        create: true
      })
    );
  });

  it.each([
    ["", "dev", ["delete.yml"]],
    ["fixture/app", "", ["delete.yml"]],
    ["fixture/app", "dev", []]
  ])(
    "keeps legacy empty selection a no-op (%s, %s, %j)",
    async (repo, environment, only) => {
      const { service, synchronize } = fixture();
      expect(await service.bestEffort(repo, environment, "", only)).toEqual({
        created: [],
        updated: [],
        failed: []
      });
      expect(synchronize).not.toHaveBeenCalled();
    }
  );
});
