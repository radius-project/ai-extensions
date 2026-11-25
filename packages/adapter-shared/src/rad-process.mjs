// @ts-check

// The process-handling core shared by every managed rad/bicep invocation.
//
// This lives in plain `.mjs` because both the application-modeling resolver and
// the TypeScript packages execute it directly. The resolver's direct source
// imports, including TypeScript helpers, run only in the repository-supported
// Node/test environment. `packages/adapter-canvas/build.mjs` bundles this module
// and those source dependencies into the shipped standalone resolver, so the
// installed plugin needs neither TypeScript sources nor workspace resolution.
// The TypeScript packages consume it through `rad-process.d.mts`.
//
// `allowJs` is off and adapter-shared/tsconfig.json only includes `src/**/*.ts`,
// so `tsc` never checks this file against its hand-written declaration. The
// `// @ts-check` above keeps editors verifying it, but any signature change here
// must be mirrored in `rad-process.d.mts` by hand.

import { spawn } from "node:child_process";
import { win32 as pathWin32 } from "node:path";

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

const CLEANUP_TIMEOUT_MS = 2000;

export class RadProcessExitUnconfirmedError extends RadProcessError {
  constructor(message, stdout, stderr, platform = "win32") {
    super(
      `${message}. ${platform === "win32" ? "Windows process-tree" : "Process-tree"} exit could not be confirmed; do not use the affected target.`,
      stdout,
      stderr
    );
    this.name = "RadProcessExitUnconfirmedError";
  }
}

/** @param {unknown} error */
export function isRadProcessExitUnconfirmed(error) {
  const seen = new Set();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof RadProcessExitUnconfirmedError) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

export function windowsTaskkillPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.WINDIR;
  return systemRoot ?
      pathWin32.join(systemRoot, "System32", "taskkill.exe")
    : "taskkill";
}

// Terminates rad and any bicep child it spawned. On Windows, `taskkill /t` kills
// the whole process tree while leaving rad in the caller's Job Object; on POSIX,
// rad is a process-group leader (spawned detached), so signalling the group
// (-pid) stops rad and its children together. On Windows the result indicates
// whether taskkill reported success; falling back to SIGKILL only targets rad.
export function killChildTree(child, platform = process.platform) {
  if (!child || child.pid == null) return;
  const killChild = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best-effort cleanup.
    }
  };
  try {
    if (platform === "win32") {
      const taskkill = spawn(
        windowsTaskkillPath(),
        ["/pid", String(child.pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true
        }
      );
      return new Promise((resolve) => {
        let failed = false;
        let finished = false;
        const timer = setTimeout(() => {
          finish(false);
          try {
            taskkill.kill();
          } catch {
            // Timing out only reports uncertainty; it does not prove exit.
          }
        }, CLEANUP_TIMEOUT_MS);
        function finish(terminated) {
          finished = true;
          clearTimeout(timer);
          taskkill.removeListener("close", onClose);
          resolve(terminated);
        }
        function onError() {
          if (finished) return;
          failed = true;
          killChild();
        }
        function onClose(code) {
          taskkill.removeListener("error", onError);
          if (!failed && code !== 0) killChild();
          finish(!failed && code === 0);
        }
        taskkill.once("error", onError);
        taskkill.once("close", onClose);
      });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    killChild();
    if (platform === "win32") return Promise.resolve(false);
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
 * grandchild, so POSIX runs rad as a detached process-group leader while
 * Windows keeps rad in the caller's Job Object and relies on taskkill /t for
 * tree cleanup. `label` only names the command in timeout/exit error messages;
 * `env` is merged over process.env. An invocation with `drainOnTimeout` or
 * `signal` waits for process cleanup before rejecting on timeout. A draining
 * Windows invocation rejects with RadProcessExitUnconfirmedError when cleanup
 * cannot confirm tree termination, even if the direct child has not closed.
 */
export function spawnRad(
  radPath,
  args,
  {
    cwd,
    env = {},
    timeout = 120000,
    label = "rad",
    signal: abortSignal,
    drainOnTimeout = false
  } = {}
) {
  return new Promise((resolve, reject) => {
    abortSignal?.throwIfAborted();
    const drainOnStop = Boolean(abortSignal || drainOnTimeout);
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
    let stopTimer = null;
    let exited = null;
    let stopReason;
    let childClosed = false;
    let treeDrained = false;
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      const message = `${label} timed out after ${timeout}ms`;
      if (drainOnStop) {
        stop(message);
        return;
      }
      complete();
      void killChildTree(child);
      reject(new RadProcessError(message, stdout, stderr));
    }, timeout);

    function stop(message) {
      if (settled || stopReason) return;
      stopReason = message;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // An exited Windows root cannot identify its former descendants, and
      // its PID could already belong to an unrelated process.
      const treeCleanup =
        exited && process.platform === "win32" ?
          Promise.resolve(false)
        : killChildTree(child);
      function rejectUnconfirmed() {
        if (settled) return;
        complete();
        reject(
          new RadProcessExitUnconfirmedError(
            message,
            stdout,
            stderr,
            process.platform
          )
        );
      }
      stopTimer = setTimeout(rejectUnconfirmed, CLEANUP_TIMEOUT_MS);
      void Promise.resolve(treeCleanup).then((terminated) => {
        if (settled) return;
        if (terminated === false) {
          rejectUnconfirmed();
        } else {
          treeDrained = true;
          if (childClosed) {
            complete();
            reject(new RadProcessError(message, stdout, stderr));
          }
        }
      });
    }

    const abort = () => stop(`${label} was cancelled`);
    abortSignal?.addEventListener("abort", abort, { once: true });

    function complete() {
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", abort);
      if (graceTimer) clearTimeout(graceTimer);
      if (stopTimer) clearTimeout(stopTimer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      // Keep the one-shot error listener for a late process error.
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
    }

    function finalize(code, signal) {
      if (settled) return;
      if (stopReason) {
        if (!treeDrained) return;
        complete();
        reject(new RadProcessError(stopReason, stdout, stderr));
        return;
      }
      complete();
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

    function onError(error) {
      if (settled || stopReason) return;
      complete();
      reject(new RadProcessError(error.message, stdout, stderr));
    }
    function onExit(code, signal) {
      exited = { code, signal };
      if (settled || graceTimer || stopReason) return;
      // The exit grace period can truncate inherited stdio while a descendant
      // is still running. Draining Windows callers must wait for close instead.
      if (drainOnStop && process.platform === "win32") return;
      graceTimer = setTimeout(() => finalize(code, signal), 2000);
    }
    function onClose(code, signal) {
      childClosed = true;
      if (exited) finalize(exited.code, exited.signal);
      else finalize(code, signal);
    }
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}
