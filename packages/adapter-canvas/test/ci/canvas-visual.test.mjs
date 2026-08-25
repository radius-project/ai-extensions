import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_VISUAL_IMAGE,
  createDockerBuildArgs,
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

  it("passes a user npmrc to the image build as a secret when present", () => {
    const args = createDockerBuildArgs({
      root: "C:\\src\\ai-extensions",
      home: "C:\\Users\\developer",
      fileExists: (file) => file === "C:\\Users\\developer\\.npmrc",
      pathApi: win32
    });

    expect(args).toContain("--secret");
    expect(args).toContain(
      "id=npmrc,src=C:\\Users\\developer\\.npmrc"
    );
    expect(args.at(-1)).toBe("C:\\src\\ai-extensions");
  });

  it("builds without an npmrc secret when the user file is absent", () => {
    const args = createDockerBuildArgs({
      root: "/src/ai-extensions",
      home: "/home/developer",
      fileExists: () => false
    });

    expect(args).not.toContain("--secret");
    expect(args.at(-1)).toBe("/src/ai-extensions");
  });

  it("reports missing, unavailable, and non-Linux Docker prerequisites", () => {
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
    expect(
      dockerPrerequisiteError({
        status: 0,
        stdout: "",
        stderr: "Docker Desktop Linux engine failed"
      })
    ).toContain("Docker Desktop Linux engine failed");
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|windows" })
    ).toContain("Switch Docker Desktop to Linux containers");
    expect(dockerPrerequisiteError({ status: 0, stdout: "29.7.2" })).toContain(
      "did not report its container engine type"
    );
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux" })
    ).toBeNull();
  });

  it("keeps the canonical image aligned with the locked Playwright version", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const lockfile = readFileSync(`${repoRoot}/pnpm-lock.yaml`, "utf8");
    const dockerfile = readFileSync(
      `${repoRoot}/packages/adapter-canvas/test/visual/Dockerfile`,
      "utf8"
    );
    const lockedVersions = new Set(
      [...lockfile.matchAll(/^  '@playwright\/test@([^']+)':$/gm)].map(
        (match) => match[1]
      )
    );
    const imageVersion = dockerfile.match(
      /mcr\.microsoft\.com\/playwright:v([^-]+)-/
    )?.[1];

    expect([...lockedVersions]).toEqual([imageVersion]);
  });
});
