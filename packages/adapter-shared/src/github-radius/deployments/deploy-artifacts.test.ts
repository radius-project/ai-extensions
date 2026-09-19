import { describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { createArtifactExecution } from "./deploy-artifacts.js";

describe("GitHub deployment artifact execution", () => {
  it("validates construction and preserves artifact timestamps and run identity", async () => {
    expect(() =>
      createArtifactExecution({ runGh: async () => "", scratchDirectory: "" })
    ).toThrow("scratch directory");
    const execution = createArtifactExecution({
      scratchDirectory: ".",
      runGh: async () =>
        JSON.stringify({
          artifacts: [
            {
              id: 1,
              name: "artifact",
              created_at: "2026-01-01",
              workflow_run: { id: 7 }
            }
          ]
        })
    });
    expect(await execution.listWorkflowArtifacts("acme/app", 7)).toEqual([
      {
        id: 1,
        name: "artifact",
        created_at: "2026-01-01",
        workflow_run: { id: 7 }
      }
    ]);
  });
  it("pages past live slots, validates responses and stops on the matching terminal artifact", async () => {
    const runGh = vi.fn(async (args: string[]) =>
      JSON.stringify({
        artifacts:
          args[1]?.endsWith("&page=1") ?
            Array.from({ length: 100 }, (_, i) => ({
              id: i + 1,
              name: "radius-deploy-status-dev-app-live-7-slot-1"
            }))
          : [
              {
                id: 101,
                name: "radius-deploy-status-dev-app",
                expired: false,
                workflow_run: { id: 7 }
              }
            ]
      })
    );
    const execution = createArtifactExecution({ runGh, scratchDirectory: "." });
    expect(await execution.listWorkflowArtifacts("acme/app")).toHaveLength(101);
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(runGh.mock.calls[1]?.[0][1]).toContain("page=2");
  });

  it.each([
    "null",
    '{"artifacts":{}}',
    '{"artifacts":[{"name":"incomplete"}]}',
    "not JSON"
  ])(
    "rejects malformed listings %s rather than reporting absence",
    async (response) => {
      const execution = createArtifactExecution({
        runGh: async () => response,
        scratchDirectory: "."
      });
      await expect(
        execution.listWorkflowArtifacts("acme/app", 7)
      ).rejects.toThrow();
    }
  );

  it("classifies authentication failures without retrying reads", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("HTTP 403 Forbidden");
    });
    const execution = createArtifactExecution({ runGh, scratchDirectory: "." });
    await expect(
      execution.listWorkflowArtifacts("acme/app", 7)
    ).rejects.toMatchObject({ code: "GH_ARTIFACT_AUTH" });
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it("downloads through argv, reads bounded text files and cleans up on success and failure", async () => {
    const root = mkdtempSync(
      path.join(process.cwd(), ".artifact-execution-test-")
    );
    try {
      let fail = false;
      const runGh = vi.fn(async (args: string[]) => {
        if (fail) throw new Error("primary download failure");
        const directory = args[args.indexOf("--dir") + 1];
        if (!directory) throw new Error("Missing output directory");
        expect(args).toContain("7");
        writeFileSync(path.join(directory, "deploy-state.txt"), "success");
        mkdirSync(path.join(directory, "nested"));
        writeFileSync(
          path.join(directory, "oversized.txt"),
          "x".repeat(8 * 1024 * 1024 + 1)
        );
        return "";
      });
      const execution = createArtifactExecution({
        runGh,
        scratchDirectory: root
      });
      const artifact = {
        id: 1,
        name: "radius-deploy-status-dev-app",
        workflow_run: { id: 7 }
      };
      expect(
        await execution.downloadWorkflowArtifact("acme/app", artifact)
      ).toEqual({ "deploy-state.txt": "success" });
      expect(readdirSync(root)).toEqual([]);
      fail = true;
      await expect(
        execution.downloadWorkflowArtifact("acme/app", artifact)
      ).rejects.toThrow("primary download failure");
      expect(readdirSync(root)).toEqual([]);
      expect(
        await execution.downloadWorkflowArtifact("acme/app", {
          id: 2,
          name: "no-run"
        })
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
