import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_VISUAL_IMAGE,
  createDockerRunArgs,
  dockerPrerequisiteError,
  parseVisualMode
} from "../../../../scripts/canvas-visual.mjs";

describe("canonical Canvas visual runner", () => {
  it("accepts only explicit check and update modes", () => {
    expect(parseVisualMode(["check"])).toBe("check");
    expect(parseVisualMode(["update"])).toBe("update");
    expect(() => parseVisualMode([])).toThrow(
      "Usage: node scripts/canvas-visual.mjs <check|update>"
    );
    expect(() => parseVisualMode(["check", "update"])).toThrow(
      "Usage: node scripts/canvas-visual.mjs <check|update>"
    );
  });

  it("makes check snapshots read-only and preserves Windows bind paths", () => {
    const args = createDockerRunArgs({
      mode: "check",
      root: "C:\\src\\ai-extensions",
      pathApi: win32
    });

    expect(args).not.toContain("--user");
    expect(args).toContain("linux/amd64");
    expect(args).toContain(
      "type=bind,source=C:\\src\\ai-extensions\\packages\\adapter-canvas\\test\\visual\\__screenshots__,target=/workspace/packages/adapter-canvas/test/visual/__screenshots__,readonly"
    );
    expect(args.slice(-4)).toEqual([
      CANONICAL_VISUAL_IMAGE,
      "pnpm",
      "run",
      "test:visual:stability"
    ]);
  });

  it("makes update snapshots writable and maps the host user on Unix", () => {
    const args = createDockerRunArgs({
      mode: "update",
      root: "/src/ai-extensions",
      uid: 1000,
      gid: 1001
    });
    const snapshotMount = args.find((argument) =>
      argument.includes("__screenshots__")
    );

    expect(args).toContain("--user");
    expect(args).toContain("1000:1001");
    expect(snapshotMount).not.toContain("readonly");
    expect(args.slice(-4)).toEqual([
      CANONICAL_VISUAL_IMAGE,
      "pnpm",
      "run",
      "test:visual:update"
    ]);
  });

  it("reports missing and unavailable Docker prerequisites", () => {
    expect(
      dockerPrerequisiteError({
        error: { code: "ENOENT", message: "not found" }
      })
    ).toContain("Install Docker Desktop or Docker Engine");
    expect(
      dockerPrerequisiteError({
        error: { code: "EACCES", message: "permission denied" }
      })
    ).toBe("Docker could not be started: permission denied");
    expect(
      dockerPrerequisiteError({
        status: 1,
        stderr: "Cannot connect to the Docker daemon"
      })
    ).toContain("Cannot connect to the Docker daemon");
    expect(dockerPrerequisiteError({ status: 0 })).toBeNull();
  });
});
