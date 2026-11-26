import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnRad } from "@radius-project/adapter-shared";
import { describe, expect, it, vi } from "vitest";
import { createFakeDependencies } from "../../test/support/runtime/fakes.js";
import type { CanvasState } from "../shared.js";
import {
  captureSourceRefSelection,
  prepareSourceRefResources
} from "../source-refs.js";
import { createCanvasModelAuthoring } from "./canvas-model-authoring.js";

const REPO = "octo/app";
const BRANCH = "main";
const TOKEN = "attempt";
const REVISION = "workspace:saved";
const WORKSPACE = resolve("fixture-worktree");
const SKILL = resolve("fixture-skill");
const NODE = resolve("fixture-node");
const BOOTSTRAP = JSON.stringify({ nodeCommand: NODE, skillBase: SKILL });

async function fixture(workspacePath = WORKSPACE) {
  const { deps, servers } = createFakeDependencies();
  const entry = await deps.getOrCreateServer("panel", "graph");
  const workspace: CanvasState = {
    workspaceRepo: REPO,
    workspaceBranch: BRANCH,
    workspacePath
  };
  Object.assign(entry.state, workspace, {
    canvasInstanceId: "panel",
    appModelAttemptTokens: { "octo/app::main": TOKEN }
  });
  const runDir = join(workspacePath, ".radius", ".staging-managed-fixture");
  const cancel = vi.fn();
  const promote = vi.fn(async () => ({
    published: ["app.bicep"],
    gitError: ""
  }));
  vi.mocked(deps.beginManagedModel).mockReturnValue({
    stagingDir: runDir,
    assertBaseline() {},
    cancel,
    validate: (check) => check(runDir),
    promote
  });
  vi.mocked(deps.appModel.workspaceSourceRevision).mockResolvedValue(REVISION);
  const workspaceState = vi.fn(async () => workspace);
  const authoring = createCanvasModelAuthoring(deps, workspaceState);
  const settled = vi.fn<(promoted: boolean) => void>();
  const begin = (bootstrap = BOOTSTRAP, current = () => true) =>
    authoring.begin(
      entry.state,
      REPO,
      BRANCH,
      TOKEN,
      REVISION,
      bootstrap,
      current,
      settled
    );
  return {
    deps,
    servers,
    entry,
    workspaceState,
    authoring,
    begin,
    settled,
    runDir,
    promote,
    cancel
  };
}

describe("createCanvasModelAuthoring", () => {
  it("keeps the owner across a reload but retires it before an A-to-B-to-A return", async () => {
    const h = await fixture();
    const original = { repo: REPO, branch: BRANCH };
    prepareSourceRefResources(h.entry, "graph", original);
    h.begin(BOOTSTRAP, captureSourceRefSelection(h.entry.state, "graph"));
    prepareSourceRefResources(h.entry, "graph", original);
    h.authoring.selectionChanged(h.entry.state);
    expect(h.cancel).not.toHaveBeenCalled();

    prepareSourceRefResources(h.entry, "graph", {
      repo: REPO,
      branch: "other"
    });
    h.authoring.selectionChanged(h.entry.state);
    prepareSourceRefResources(h.entry, "graph", original);
    h.authoring.selectionChanged(h.entry.state);
    expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow("expired");
    expect(h.cancel).toHaveBeenCalledOnce();
  });

  it("reports diagnostics from a real validator process without promoting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "radius-validator-"));
    try {
      const skillBase = join(workspace, "skill");
      const scripts = join(skillBase, "scripts");
      const h = await fixture(workspace);
      h.deps.process.runValidator = spawnRad;
      await mkdir(scripts, { recursive: true });
      await mkdir(h.runDir, { recursive: true });
      await writeFile(
        join(scripts, "model.mjs"),
        `import { realpathSync } from "node:fs";
         import { join } from "node:path";
         const [, , command, dir] = process.argv;
         if (command !== "check" ||
             realpathSync(dir) !== realpathSync(join(process.cwd(), ".radius", ".staging-managed-fixture"))) {
           throw new Error("Unexpected check inputs");
         }
         console.log("Resources:\\n  none\\nProblems:\\n  1. Fixture model rejected");
         process.exitCode = 1;`
      );
      h.begin(JSON.stringify({ nodeCommand: process.execPath, skillBase }));

      await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
        "The Radius model check failed: Problems:\n  1. Fixture model rejected"
      );
      expect(h.promote).not.toHaveBeenCalled();
      expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid JSON", "{"],
    ["null bootstrap", "null"],
    ["missing Node", JSON.stringify({ skillBase: SKILL })],
    [
      "relative Node",
      JSON.stringify({ nodeCommand: "node", skillBase: SKILL })
    ],
    ["missing skill directory", JSON.stringify({ nodeCommand: NODE })],
    [
      "relative skill directory",
      JSON.stringify({ nodeCommand: NODE, skillBase: "skill" })
    ]
  ])("rejects a %s before staging", async (_label, bootstrap) => {
    const h = await fixture();

    expect(() => h.begin(bootstrap)).toThrow();
    expect(h.deps.beginManagedModel).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it("returns the Node installation bootstrap without owning a request", async () => {
    const h = await fixture();
    const bootstrap = JSON.stringify({
      nodeCommand: null,
      instruction: "Install Node.js first."
    });

    expect(h.begin(bootstrap)).toBe(bootstrap);
    expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.deps.beginManagedModel).not.toHaveBeenCalled();
    await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
      "Unknown or expired"
    );
  });

  it("refuses a request whose canvas state was replaced", async () => {
    const h = await fixture();
    h.servers.set("panel", { ...h.entry, state: { ...h.entry.state } });

    expect(() => h.begin()).toThrow(
      "Cannot establish a current Radius authoring source"
    );
    expect(h.deps.beginManagedModel).not.toHaveBeenCalled();
    expect(h.promote).not.toHaveBeenCalled();
  });

  it.each(["workspacePath", "workspaceRepo", "workspaceBranch"] as const)(
    "does not validate or promote when workspace context is missing %s",
    async (key) => {
      const h = await fixture();
      h.workspaceState.mockResolvedValueOnce({
        ...h.entry.state,
        [key]: undefined
      });
      h.begin();

      await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
        "source or worktree changed"
      );
      expect(h.deps.appModel.workspaceSourceRevision).not.toHaveBeenCalled();
      expect(h.deps.process.runValidator).not.toHaveBeenCalled();
      expect(h.promote).not.toHaveBeenCalled();
      expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    }
  );

  it.each(["workspacePath", "workspaceRepo", "workspaceBranch"] as const)(
    "does not validate or promote when %s changes during the revision read",
    async (key) => {
      const h = await fixture();
      h.workspaceState
        .mockResolvedValueOnce({ ...h.entry.state })
        .mockResolvedValueOnce({ ...h.entry.state, [key]: "different" });
      h.begin();

      await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
        "source or worktree changed"
      );
      expect(
        h.deps.appModel.workspaceSourceRevision
      ).toHaveBeenCalledExactlyOnceWith(WORKSPACE);
      expect(h.deps.process.runValidator).not.toHaveBeenCalled();
      expect(h.promote).not.toHaveBeenCalled();
      expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    }
  );

  it("redacts, trims and bounds the check's output and refuses promotion", async () => {
    const h = await fixture();
    const diagnostic = `{"clientSecret":"fixture-value"} ${"x".repeat(4_000)}`;
    vi.mocked(h.deps.process.runValidator).mockRejectedValue(
      Object.assign(new Error("not the actionable diagnostic"), {
        stdout: `  ${diagnostic}\n`,
        stderr: "not the problems"
      })
    );
    h.begin();

    const prefix = "The Radius model check failed: ";
    const expected = '{"clientSecret":"[REDACTED]"} ';
    await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
      new Error(prefix + expected + "x".repeat(4_000 - expected.length))
    );
    expect(h.deps.process.runValidator).toHaveBeenCalledExactlyOnceWith(
      NODE,
      [join(SKILL, "scripts", "model.mjs"), "check", h.runDir],
      {
        cwd: WORKSPACE,
        timeout: 300_000,
        signal: expect.any(AbortSignal),
        label: "Radius model check"
      }
    );
    expect(h.promote).not.toHaveBeenCalled();
    expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it.each([
    [
      Object.assign(new Error("validator failed"), { stderr: "  \n" }),
      "validator failed"
    ],
    [
      Object.assign(new Error("validator failed"), { stderr: " no rad \n" }),
      "no rad"
    ],
    ["validator unavailable", "validator unavailable"]
  ])(
    "falls back to stderr, then to the failure message, without check output",
    async (failure, message) => {
      const h = await fixture();
      vi.mocked(h.deps.process.runValidator).mockRejectedValue(failure);
      h.begin();

      await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
        `The Radius model check failed: ${message}`
      );
      expect(h.promote).not.toHaveBeenCalled();
    }
  );

  it("retires the closed panel's tokens and never revives its captured selection", async () => {
    const h = await fixture();
    const first = h.authoring.capturePanel(h.entry.state);
    h.begin(BOOTSTRAP, first);
    expect(first()).toBe(true);

    h.authoring.closePanel(h.entry.state);
    h.authoring.closePanel(h.entry.state);
    expect(h.cancel).toHaveBeenCalledOnce();
    expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.authoring.capturePanel(h.entry.state)()).toBe(false);
    h.authoring.openPanel(h.entry.state);
    expect(first()).toBe(false);
    expect(h.authoring.capturePanel(h.entry.state)()).toBe(true);
    await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
      "Unknown or expired"
    );
    expect(h.promote).not.toHaveBeenCalled();
  });

  it("settles the request and surfaces the cleanup diagnostic when staging cancellation throws", async () => {
    const h = await fixture();
    h.cancel.mockImplementation(() => {
      throw new Error("stage unavailable");
    });
    h.begin();

    h.authoring.closePanel(h.entry.state);

    expect(h.settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.deps.logError).toHaveBeenCalledExactlyOnceWith(
      "Could not cancel Radius canvas authoring: stage unavailable"
    );
    await expect(h.authoring.owner.finish(TOKEN)).rejects.toThrow(
      "Unknown or expired"
    );
  });
});
