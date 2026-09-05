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

// Terminates rad and any bicep child it spawned. On Windows, `taskkill /t` kills
// the whole process tree; on POSIX, rad is a process-group leader, so signalling
// the group (-pid) stops rad and its children together.
// Best-effort — any failure is swallowed.
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
 * Keep Windows rad processes attached to the caller's Job Object so cancellation
 * reaches their full process tree. POSIX still uses a detached process group,
 * which killChildTree signals by its negative process ID.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {{
 *   stdio: ["ignore", "pipe", "pipe"],
 *   windowsHide: true,
 *   detached: boolean
 * }}
 */
export function radSpawnOptions(platform = process.platform) {
  return {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: platform !== "win32"
  };
}

/**
 * spawnRad - the process-handling core every managed-rad invocation needs:
 * spawn `radPath args`, capture stdout/stderr (capped at 32MB), and resolve
 * { stdout, stderr } on a zero exit or reject (with both streams attached) on a
 * non-zero exit, timeout, or spawn error. rad shells out to bicep as a
 * grandchild, so it stays in the caller's Job Object on Windows and leads a
 * process group on POSIX. It kills the whole tree on timeout and uses an
 * exit/close grace window because that grandchild can inherit and hold the stdio
 * pipes open. `label` only names the command in timeout/exit error messages;
 * `env` is merged over process.env.
 */
export function spawnRad(
  radPath,
  args,
  { cwd, env = {}, timeout = 120000, label = "rad" } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(radPath, args, {
      cwd,
      env: { ...process.env, ...env },
      ...radSpawnOptions()
    });

    const maxOutput = 32 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let graceTimer = null;
    let exited = null;
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      killChildTree(child);
      reject(
        new RadProcessError(
          `${label} timed out after ${timeout}ms`,
          stdout,
          stderr
        )
      );
    }, timeout);

    function finalize(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
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
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
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
