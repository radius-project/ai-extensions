import { spawn } from "node:child_process";

export function managedBicepEnv(env = {}, bicepPath) {
  return { ...env, BICEP: bicepPath };
}

export class RadProcessError extends Error {
  constructor(message, stdout, stderr) {
    super(message);
    this.name = "RadProcessError";
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

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

export function spawnRad(
  radPath,
  args,
  { cwd, env = {}, timeout = 120000, label = "rad" } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(radPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: true
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
