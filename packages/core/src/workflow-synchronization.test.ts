import { describe, expect, it, vi } from "vitest";
import {
  synchronizeWorkflowCandidates,
  type WorkflowCandidate,
  type WorkflowSynchronizationPorts,
  type WorkflowSynchronizationRequest
} from "./workflow-synchronization.js";

const provider = ".github/workflows/provider.yml";
const dispatcher = ".github/workflows/dispatch.yml";
const azure = {
  content: "current AZURE_",
  provider: "azure",
  environment: "dev"
};
const aws = { content: "current AWS_", provider: "aws", environment: "dev" };

function fixture(
  candidates: ReadonlyMap<string, readonly WorkflowCandidate[]> = new Map([
    [provider, [azure, aws]]
  ])
) {
  const files = new Map<string, string>();
  const request: WorkflowSynchronizationRequest = {
    repo: "owner/app",
    branches: ["main", "topic"],
    candidates,
    dispatcherProviders: new Map(),
    createMissing: true
  };
  const ports = {
    readFile: vi.fn(
      async (_repo: string, path: string, branch: string) =>
        files.get(`${branch}:${path}`) ?? null
    ),
    branchExists: vi.fn(async (_repo: string, branch: string) =>
      ["main", "topic"].includes(branch)
    ),
    commitFile: vi.fn(
      async (
        _repo: string,
        path: string,
        content: string,
        branch: string,
        _message: string
      ) => {
        files.set(`${branch}:${path}`, content);
        return true;
      }
    ),
    log: vi.fn(),
    errorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error)
  } satisfies WorkflowSynchronizationPorts;
  const run = (
    overrides: Partial<WorkflowSynchronizationRequest> = {},
    extraPorts: Partial<WorkflowSynchronizationPorts> = {}
  ) =>
    synchronizeWorkflowCandidates(
      { ...request, ...overrides },
      { ...ports, ...extraPorts }
    );
  return { files, request, ports, run };
}

describe("workflow candidate synchronization", () => {
  it("publishes provider dependencies first on both branches and deduplicates result paths", async () => {
    const { ports, run } = fixture(
      new Map([
        [dispatcher, [{ ...azure, content: "dispatcher" }]],
        [provider, [azure]]
      ])
    );
    const result = await run({
      dispatcherProviders: new Map([["dispatch.yml", ["provider.yml"]]])
    });
    expect(result).toEqual({
      created: [provider, dispatcher],
      updated: [],
      failed: [],
      branches: ["main", "topic"],
      skipped: false
    });
    expect(
      ports.commitFile.mock.calls.map((call) => [call[1], call[3]])
    ).toEqual([
      [provider, "main"],
      [dispatcher, "main"],
      [provider, "topic"],
      [dispatcher, "topic"]
    ]);
    expect(ports.branchExists).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["current AZURE_", null],
    ["current AWS_", null],
    ["old AZURE_", azure.content],
    ["old AWS_", aws.content],
    ["old generic", azure.content]
  ])(
    "preserves matching environments or the committed provider for %s",
    async (committed, replacement) => {
      const { files, ports, run } = fixture();
      files.set(`main:${provider}`, committed);
      const result = await run({ branches: ["main"] });
      expect(result.updated).toEqual(replacement ? [provider] : []);
      if (replacement) {
        expect(ports.commitFile).toHaveBeenCalledWith(
          "owner/app",
          provider,
          replacement,
          "main",
          "Update provider.yml to match upstream Radius workflow templates"
        );
      } else {
        expect(ports.commitFile).not.toHaveBeenCalled();
      }
    }
  );

  it("uses the first candidate when no generated candidate matches the old provider", async () => {
    const { files, ports, run } = fixture(new Map([[provider, [azure]]]));
    files.set(`main:${provider}`, "old AWS_");
    await run({ branches: ["main"] });
    expect(ports.commitFile.mock.calls[0][2]).toBe(azure.content);
  });

  it.each([true, false])(
    "keeps an accepted variant only when its matcher returns %s",
    async (matches) => {
      const { files, ports, run } = fixture();
      files.set(`main:${provider}`, "special variant");
      const matchesVariant = vi.fn(async () => matches);
      const result = await run({ branches: ["main"] }, { matchesVariant });
      expect(matchesVariant).toHaveBeenCalledWith(provider, "special variant", [
        azure,
        aws
      ]);
      expect(result.updated).toEqual(matches ? [] : [provider]);
      expect(ports.commitFile).toHaveBeenCalledTimes(matches ? 0 : 1);
    }
  );

  it("does not author missing files in a background pass", async () => {
    const { ports, run } = fixture();
    expect((await run({ createMissing: false })).created).toEqual([]);
    expect(ports.branchExists).not.toHaveBeenCalled();
    expect(ports.commitFile).not.toHaveBeenCalled();
  });

  it("repairs a missing provider required by an existing dispatcher during a background pass", async () => {
    const { files, ports, run } = fixture(
      new Map([
        [dispatcher, [{ ...azure, content: "dispatcher" }]],
        [provider, [azure]]
      ])
    );
    files.set(`main:${dispatcher}`, "dispatcher");
    const result = await run({
      branches: ["main"],
      createMissing: false,
      dispatcherProviders: new Map([["dispatch.yml", ["provider.yml"]]])
    });
    expect(result.created).toEqual([provider]);
    expect(ports.commitFile).toHaveBeenCalledTimes(1);
  });

  it("caches a missing remote branch and never authors it", async () => {
    const { ports, run } = fixture(
      new Map([
        [provider, [azure]],
        [".github/workflows/second.yml", [aws]]
      ])
    );
    const result = await run({ branches: ["unpushed"] });
    expect(result.failed).toEqual([]);
    expect(result.created).toEqual([]);
    expect(ports.branchExists).toHaveBeenCalledTimes(1);
    expect(ports.commitFile).not.toHaveBeenCalled();
    expect(ports.log).toHaveBeenCalledWith(
      `skipped creating ${provider} on "unpushed" (branch not on remote)`
    );
  });

  it.each([null, "", "present"])(
    "checks provider files outside the selected candidates: %s",
    async (content) => {
      const { files, ports, run } = fixture(new Map([[dispatcher, [azure]]]));
      if (content !== null) files.set(`main:${provider}`, content);
      const result = await run({
        branches: ["main"],
        dispatcherProviders: new Map([["dispatch.yml", ["provider.yml"]]])
      });
      expect(result.failed).toEqual(
        content ? [] : [{ path: dispatcher, branch: "main" }]
      );
      expect(ports.commitFile).toHaveBeenCalledTimes(content ? 1 : 0);
    }
  );

  it.each([
    { committed: null, createMissing: false, branch: "main" },
    { committed: azure.content, createMissing: true, branch: "main" },
    { committed: "drifted", createMissing: true, branch: "unpushed" }
  ])(
    "does not report a dispatcher write that was not eligible: %o",
    async ({ committed, createMissing, branch }) => {
      const { files, ports, run } = fixture(new Map([[dispatcher, [azure]]]));
      if (committed !== null) files.set(`${branch}:${dispatcher}`, committed);
      const result = await run({
        branches: [branch],
        createMissing,
        dispatcherProviders: new Map([["dispatch.yml", ["provider.yml"]]])
      });
      expect(result.failed).toEqual([]);
      expect(ports.commitFile).not.toHaveBeenCalled();
    }
  );

  it("reports a drifted dispatcher blocked on an absent provider", async () => {
    const { files, run } = fixture(new Map([[dispatcher, [azure]]]));
    files.set(`main:${dispatcher}`, "drifted");
    expect(
      (
        await run({
          branches: ["main"],
          dispatcherProviders: new Map([["dispatch.yml", ["provider.yml"]]])
        })
      ).failed
    ).toEqual([{ path: dispatcher, branch: "main" }]);
  });

  it.each(["create", "update"])(
    "records %s rejection and continues on the other branch",
    async (mode) => {
      const { files, ports, run } = fixture();
      if (mode === "update") files.set(`main:${provider}`, "old");
      ports.commitFile.mockRejectedValueOnce(new Error("protected branch"));
      const result = await run();
      expect(result.failed).toEqual([{ path: provider, branch: "main" }]);
      expect(result.created).toEqual([provider]);
      expect(ports.log).toHaveBeenCalledWith(
        `could not ${mode} ${provider} on "main": protected branch`
      );
    }
  );

  it.each(["create", "update"])(
    "distinguishes concurrent %s from a write made by this caller",
    async (mode) => {
      const { files, ports, run } = fixture();
      if (mode === "update") files.set(`main:${provider}`, "old");
      ports.commitFile.mockResolvedValue(false);
      const result = await run({ branches: ["main"] });
      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
      expect(result.registrationPending).toEqual(
        mode === "create" ? [provider] : undefined
      );
    }
  );

  it.each(["readFile", "branchExists"] as const)(
    "propagates an unavailable %s without a write",
    async (method) => {
      const { ports, run } = fixture();
      ports[method].mockRejectedValueOnce(new Error("lookup unavailable"));
      await expect(run()).rejects.toThrow("lookup unavailable");
      expect(ports.commitFile).not.toHaveBeenCalled();
    }
  );

  it("rejects an empty candidate set before reading or writing", async () => {
    const { ports, run } = fixture(new Map([[provider, []]]));
    await expect(run()).rejects.toThrow(
      `No generated workflow candidate exists for ${provider}`
    );
    expect(ports.readFile).not.toHaveBeenCalled();
    expect(ports.commitFile).not.toHaveBeenCalled();
  });
});
