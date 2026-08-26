import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_VISUAL_IMAGE,
  createDockerBuildArgs,
  createDockerRunArgs,
  dockerPrerequisiteError,
  parseVisualMode,
  runCanonicalVisual
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
    expect(args).not.toContain("--platform");
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
    expect(args).not.toContain("--platform");
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
    expect(args).toContain("id=npmrc,src=C:\\Users\\developer\\.npmrc");
    expect(args).not.toContain("--platform");
    expect(args.at(-1)).toBe("C:\\src\\ai-extensions");
  });

  it("builds without an npmrc secret when the user file is absent", () => {
    const args = createDockerBuildArgs({
      root: "/src/ai-extensions",
      home: "/home/developer",
      fileExists: () => false
    });

    expect(args).not.toContain("--secret");
    expect(args).not.toContain("--platform");
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
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|windows|amd64" })
    ).toContain("Switch Docker Desktop to Linux containers");
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux" })
    ).toContain("did not report its engine architecture");
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux|ppc64le" })
    ).toContain("unsupported ppc64le architecture");
    expect(dockerPrerequisiteError({ status: 0, stdout: "29.7.2" })).toContain(
      "did not report its container engine type"
    );
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux|amd64" })
    ).toBeNull();
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux|arm64" })
    ).toBeNull();
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux|aarch64" })
    ).toBeNull();
    expect(
      dockerPrerequisiteError({ status: 0, stdout: "29.7.2|linux|x86_64" })
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
    expect(dockerfile).not.toMatch(/playwright:v[^ \n]+-(?:amd64|arm64)@/);
  });

  it("excludes ignored local credentials from the Docker build context", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const dockerignore = readFileSync(`${repoRoot}/.dockerignore`, "utf8");
    const ignoredPaths = new Set(dockerignore.split(/\r?\n/));

    for (const ignoredPath of [
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      ".radius-credentials.json",
      "**/.radius-credentials.json"
    ]) {
      expect(ignoredPaths.has(ignoredPath), ignoredPath).toBe(true);
    }
  });

  it("runs prerequisite, cleanup, build, and test steps in order", () => {
    const calls = [];
    const status = runCanonicalVisual(["check"], {
      executeDocker(args) {
        calls.push(args);
        if (args[0] === "info") {
          return { status: 0, stdout: "29.7.2|linux|arm64" };
        }
        return { status: 0 };
      },
      prepareOutputs() {
        calls.push(["prepare"]);
      },
      uid: 1000,
      gid: 1001
    });

    expect(status).toBe(0);
    expect(calls.map(([command]) => command)).toEqual([
      "info",
      "prepare",
      "build",
      "run"
    ]);
    expect(calls[3]).toContain("1000:1001");
  });

  it("stops before cleanup and build when the Docker prerequisite fails", () => {
    let prepared = false;
    const executeDocker = () => ({
      status: 1,
      stderr: "daemon unavailable"
    });

    expect(() =>
      runCanonicalVisual(["check"], {
        executeDocker,
        prepareOutputs() {
          prepared = true;
        }
      })
    ).toThrow("daemon unavailable");
    expect(prepared).toBe(false);
  });

  it("stops before the test run when the image build fails", () => {
    const commands = [];

    expect(() =>
      runCanonicalVisual(["check"], {
        executeDocker(args) {
          commands.push(args[0]);
          if (args[0] === "info") {
            return { status: 0, stdout: "29.7.2|linux|amd64" };
          }
          return { status: 1 };
        },
        prepareOutputs() {}
      })
    ).toThrow("Failed to build the canonical visual image");
    expect(commands).toEqual(["info", "build"]);
  });

  it("surfaces Docker run startup failures and missing exit statuses", () => {
    function executeDockerWithRunResult(runResult) {
      return (args) => {
        if (args[0] === "info") {
          return { status: 0, stdout: "29.7.2|linux|amd64" };
        }
        if (args[0] === "build") return { status: 0 };
        return runResult;
      };
    }

    expect(() =>
      runCanonicalVisual(["check"], {
        executeDocker: executeDockerWithRunResult({
          error: new Error("spawn failed")
        }),
        prepareOutputs() {}
      })
    ).toThrow("Failed to run the canonical visual tests: spawn failed");
    expect(
      runCanonicalVisual(["check"], {
        executeDocker: executeDockerWithRunResult({ status: null }),
        prepareOutputs() {}
      })
    ).toBe(1);
  });
});
