import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [, , mode, ...args] = process.argv;

switch (mode) {
  case "success":
    await onInputClosed(() => {
      process.stdout.write(JSON.stringify(args));
      process.stderr.write("fixture stderr");
    });
    break;
  case "failure":
    await onInputClosed(() => {
      process.stdout.write("fixture stdout");
      process.stderr.write("fixture failure");
      process.exitCode = 23;
    });
    break;
  case "process-tree": {
    const descendant = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "wait"],
      {
        stdio: "ignore",
        windowsHide: true
      }
    );
    process.stdout.write(
      `${JSON.stringify({
        parentPid: process.pid,
        descendantPid: descendant.pid
      })}\n`
    );
    keepAlive();
    break;
  }
  case "wait":
    keepAlive();
    break;
  default:
    throw new Error(`Unknown spawnRad fixture mode: ${mode}`);
}

async function onInputClosed(action) {
  await new Promise((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.resume();
  });
  action();
}

function keepAlive() {
  const interval = setInterval(() => {}, 1_000);
  setTimeout(() => {
    clearInterval(interval);
    process.exitCode = 97;
  }, 15_000);
}
