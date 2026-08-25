import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ArtifactRegistrationSnapshot {
  joinCount: number;
  canvases: Array<{
    id: string;
    displayName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    actions: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      handlerCallable: boolean;
    }>;
    hasOpen: boolean;
    hasOnClose: boolean;
  }>;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handlerCallable: boolean;
  }>;
  hooks: Array<{ name: string; callable: boolean }>;
  bootstrap: {
    compact: boolean;
    skill: string;
    hasSkillBase: boolean;
    hasSkillVersion: boolean;
  };
}

interface ChildMessage {
  type:
    "registered" | "ready" | "shutdown" | "blocked" | "page" | "render-error";
  snapshot?: ArtifactRegistrationSnapshot;
  closeCount?: number;
  kind?: string;
  detail?: string;
  html?: string;
}

export interface ArtifactSmokeResult {
  registration: ArtifactRegistrationSnapshot;
  closeCount: number;
  stderr: string;
  renderedPage: string;
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code));
  });
}

export async function runArtifactSmoke(
  artifactPath: string,
  timeoutMs = 20_000
): Promise<ArtifactSmokeResult> {
  const root = mkdtempSync(join(tmpdir(), "radius-artifact-smoke-"));
  const fakeRad = join(root, process.platform === "win32" ? "rad.exe" : "rad");
  const fakeBicep = join(
    root,
    ".radius",
    "ai-extensions",
    "bin",
    process.platform === "win32" ? "bicep.exe" : "bicep"
  );
  mkdirSync(dirname(fakeBicep), { recursive: true });
  writeFileSync(fakeRad, "artifact smoke rad sentinel\n");
  writeFileSync(fakeBicep, "artifact smoke bicep sentinel\n");
  if (process.platform !== "win32") {
    chmodSync(fakeRad, 0o755);
    chmodSync(fakeBicep, 0o755);
  }

  const supportDir = dirname(fileURLToPath(import.meta.url));
  const loader = pathToFileURL(join(supportDir, "sdk-loader.mjs")).href;
  const runner = join(supportDir, "subprocess.mjs");
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--experimental-loader", loader, runner],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        RADIUS_ARTIFACT_PATH: resolve(artifactPath),
        RADIUS_ARTIFACT_WORKSPACE: root,
        RADIUS_RAD_BINARY: fakeRad,
        RADIUS_RAD_SKIP_VERSION_CHECK: "1",
        RADIUS_CANVAS_DEV: "0"
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true
    }
  );
  const exitPromise = waitForExit(child);
  // The first consumer is the shutdown race far below, so claim the rejection
  // now: a spawn failure would otherwise surface as an unhandled rejection that
  // kills the worker instead of this harness's own diagnostic.
  exitPromise.catch(() => undefined);

  let stderr = "";
  let registration: ArtifactRegistrationSnapshot | undefined;
  let ready = false;
  let closeCount = 0;
  let renderedPage: string | undefined;
  let failure: Error | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString();
  });
  child.on("message", (raw: ChildMessage) => {
    if (raw.type === "registered") registration = raw.snapshot;
    else if (raw.type === "ready") ready = true;
    else if (raw.type === "shutdown") closeCount += raw.closeCount ?? 0;
    else if (raw.type === "blocked") {
      failure = new Error(
        `Artifact attempted ${raw.kind}: ${raw.detail ?? "unknown target"}`
      );
    } else if (raw.type === "page") {
      renderedPage = raw.html;
    } else if (raw.type === "render-error") {
      failure = new Error(
        `Artifact page render failed: ${raw.detail ?? "unknown error"}`
      );
    }
  });

  const deadline = Date.now() + timeoutMs;
  try {
    while (!failure && (!registration || !ready) && Date.now() < deadline) {
      if (child.exitCode !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    if (failure) throw failure;
    if (!registration || !ready) {
      throw new Error(
        `Artifact did not register within ${timeoutMs}ms. stderr: ${stderr.slice(-2000)}`
      );
    }

    child.send({ type: "render-page" });
    const renderDeadline = Date.now() + timeoutMs;
    while (
      !failure &&
      renderedPage === undefined &&
      Date.now() < renderDeadline
    ) {
      if (child.exitCode !== null) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    if (failure) throw failure;
    if (renderedPage === undefined) {
      throw new Error(
        `Artifact did not render a page within ${timeoutMs}ms. stderr: ${stderr.slice(-2000)}`
      );
    }

    child.send({ type: "shutdown" });
    const exitDeadline = Date.now() + 5_000;
    while (
      child.exitCode === null &&
      closeCount === 0 &&
      Date.now() < exitDeadline
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const exitCode = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("Artifact did not shut down within 5 seconds")),
          Math.max(0, exitDeadline - Date.now())
        )
      )
    ]);
    if (failure) throw failure;
    if (exitCode !== 0) {
      throw new Error(
        `Artifact subprocess exited with ${exitCode}. stderr: ${stderr.slice(-2000)}`
      );
    }
    return { registration, closeCount, stderr, renderedPage };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exitPromise.catch(() => null),
        new Promise<null>((resolveWait) =>
          setTimeout(() => resolveWait(null), 2_000)
        )
      ]);
    }
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
}
