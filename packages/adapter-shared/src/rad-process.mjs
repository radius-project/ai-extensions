// @ts-check

// The process-handling core shared by every managed rad/bicep invocation.
//
// This lives in plain `.mjs` rather than TypeScript because the application-
// modeling skill script runs as a bare `node <script>` process from the
// installed plugin, where the TypeScript sources and workspace package
// resolution are both unavailable. `packages/adapter-canvas/build.mjs` bundles
// it into the shipped standalone script, while the TypeScript packages consume
// it directly through `rad-process.d.mts`.
//
// `allowJs` is off and adapter-shared/tsconfig.json only includes `src/**/*.ts`,
// so `tsc` never checks this file against its hand-written declaration. The
// `// @ts-check` above keeps editors verifying it, but any signature change here
// must be mirrored in `rad-process.d.mts` by hand.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_LAUNCHER_NAMES = {
  x64: "windows-radius-launcher-x64.exe",
  arm64: "windows-radius-launcher-arm64.exe"
};

export function windowsLauncherFilename(architecture) {
  const filename = WINDOWS_LAUNCHER_NAMES[architecture];
  if (!filename) {
    throw new Error(
      `Managed Radius does not support Windows architecture "${architecture}".`
    );
  }
  return filename;
}

export function resolveWindowsLauncherPath(
  architecture = process.arch,
  moduleUrl = import.meta.url
) {
  const filename = windowsLauncherFilename(architecture);
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    join(moduleDirectory, "..", "native", "windows-launcher", "bin", filename)
  ];
  let ancestor = moduleDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(ancestor, "bin", filename));
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const launcher = candidates.find((candidate) => existsSync(candidate));
  if (!launcher) {
    throw new Error(
      `The packaged Windows Radius launcher "${filename}" is missing.`
    );
  }
  return launcher;
}

export function radSpawnCommand(
  radPath,
  args,
  {
    platform = process.platform,
    architecture = process.arch,
    moduleUrl = import.meta.url
  } = {}
) {
  if (platform !== "win32") {
    return { executable: radPath, args };
  }
  return {
    executable: resolveWindowsLauncherPath(architecture, moduleUrl),
    args: [String(process.pid), radPath, ...args]
  };
}

export function spawnRadChild(radPath, args, { cwd, env = {} } = {}) {
  const command = radSpawnCommand(radPath, args);
  return spawn(command.executable, command.args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true
  });
}

export function managedBicepEnv(env = {}, bicepPath) {
  return { ...env, BICEP: bicepPath };
}

/**
 * Thrown by a managed rad/bicep process invocation, carrying the captured
 * stdout/stderr so callers can surface rad's actual diagnostic output (rad
 * prints Bicep compile errors like BCP* to stdout, not stderr).
 */
export class RadProcessError extends Error {
  constructor(message, stdout, stderr) {
    super(message);
    this.name = "RadProcessError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// Terminates rad and any bicep child it spawned. On Windows, the PID belongs to
// the GUI launcher; terminating it closes its kill-on-close Job Object. `taskkill
// /t` is retained as a second tree-cleanup layer. On POSIX, rad is a detached
// process-group leader, so signalling the group stops rad and its children.
// Best-effort -- any failure is swallowed.
export function killChildTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * spawnRad - the process-handling core every managed-rad invocation needs:
 * spawn `radPath args`, capture stdout/stderr (capped at 32MB), and resolve
 * { stdout, stderr } on a zero exit or reject (with both streams attached) on a
 * non-zero exit, timeout, cancellation, or spawn error. On Windows, a detached
 * GUI-subsystem launcher creates rad inside a headless pseudoconsole and a
 * kill-on-close Job Object; on POSIX, rad leads a detached process group. Both
 * arrangements prevent visible console windows and allow complete tree cleanup.
 * `label` only names the command in timeout/exit error messages; `env` is merged
 * over process.env.
 */
export function spawnRad(
  radPath,
  args,
  { cwd, env = {}, timeout = 120000, label = "rad", signal } = {}
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RadProcessError(`${label} aborted`, "", ""));
      return;
    }
    const child = spawnRadChild(radPath, args, { cwd, env });

    const maxOutput = 32 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let graceTimer = null;
    let exited = null;
    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killChildTree(child);
      reject(new RadProcessError(`${label} aborted`, stdout, stderr));
    };
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      killChildTree(child);
      reject(
        new RadProcessError(
          `${label} timed out after ${timeout}ms`,
          stdout,
          stderr
        )
      );
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    function finalize(code, signal) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.stdout?.destroy();
      } catch {
        // Best-effort cleanup.
      }
      try {
        child.stderr?.destroy();
      } catch {
        // Best-effort cleanup.
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // rad prints Bicep compile errors (BCP*) to stdout, not stderr, so keep
        // both streams on the error for callers to surface.
        reject(
          new RadProcessError(
            `${label} exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
            stdout,
            stderr
          )
        );
      }
    }

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new RadProcessError(error.message, stdout, stderr));
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => finalize(code, signal), 2000);
    });
    child.on("close", (code, signal) => {
      if (exited) finalize(exited.code, exited.signal);
      else finalize(code, signal);
    });
  });
}
