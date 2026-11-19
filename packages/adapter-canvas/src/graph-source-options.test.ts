import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageGraphArtifacts } from "@radius-project/adapter-shared";
import { graphSourceOptions } from "./graph-source-options.js";

afterEach(() => vi.restoreAllMocks());

describe("production graph source options", () => {
  it.each([false, true])(
    "uses temporary snapshots and forwards partial-cleanup failure (%s)",
    async (failWrite) => {
      const diagnostic = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const options = graphSourceOptions(() => {
        throw new Error("Unexpected external command");
      });
      const roots: string[] = [];
      try {
        const staged = stageGraphArtifacts(
          {
            status: "present",
            content: "model",
            source: {
              kind: "github",
              repo: "fixture/app",
              ref: "main",
              definitionPath: ".radius/app.bicep"
            }
          },
          {
            ...options,
            readBytes: async () => ({
              status: "present",
              bytes: Buffer.from("{}")
            }),
            files: {
              ...fs,
              async writeFile(file, bytes) {
                if (typeof file !== "string")
                  throw new Error("Expected a file path");
                roots.push(path.dirname(file));
                if (failWrite) throw new Error("primary write failure");
                await fs.writeFile(file, bytes);
              },
              async rm(file, settings) {
                await fs.rm(file, settings);
                if (failWrite) throw new Error("cleanup failure");
              }
            }
          }
        );
        if (failWrite) {
          await expect(staged).rejects.toThrow("primary write failure");
          expect(diagnostic).toHaveBeenCalledWith(
            expect.stringContaining("cleanup failure")
          );
        } else {
          const snapshot = await staged;
          expect(await fs.realpath(path.dirname(snapshot.dir))).toBe(
            await fs.realpath(tmpdir())
          );
          expect(
            await fs.readFile(
              path.join(snapshot.dir, "bicepconfig.json"),
              "utf8"
            )
          ).toBe("{}");
          await snapshot.dispose();
          expect(diagnostic).not.toHaveBeenCalled();
        }
      } finally {
        await Promise.all(
          roots.map((root) => fs.rm(root, { recursive: true, force: true }))
        );
      }
    }
  );
});
