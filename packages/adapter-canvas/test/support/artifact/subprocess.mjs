import childProcess from "node:child_process";
import https from "node:https";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { renderArtifactPage } from "./sdk-stub.mjs";

function blocked(kind, detail) {
  const boundedDetail = String(detail).slice(0, 500);
  const message = `Blocked ${kind} attempt during artifact startup: ${boundedDetail}`;
  if (typeof process.send === "function") {
    process.send({ type: "blocked", kind, detail: boundedDetail });
  }
  throw new Error(message);
}

const originalFetch = globalThis.fetch;
const originalListen = net.Server.prototype.listen;
const originalConnect = net.Socket.prototype.connect;
const originalExecFile = childProcess.execFile;
let renderingPage = false;

function loopbackUrl(input) {
  try {
    const url = new URL(typeof input === "string" ? input : String(input?.url));
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function loopbackConnect(args) {
  const first = args[0];
  if (Array.isArray(first)) return loopbackConnect(first);
  if (first && typeof first === "object") {
    return first.host === "127.0.0.1" || first.hostname === "127.0.0.1";
  }
  return args[1] === "127.0.0.1";
}

globalThis.fetch = async (input, init) => {
  if (renderingPage && loopbackUrl(input)) {
    return originalFetch(input, init);
  }
  return blocked(
    "network",
    typeof input === "string" ? input : String(input?.url)
  );
};
net.Server.prototype.listen = function (...args) {
  if (renderingPage && args[1] === "127.0.0.1") {
    return originalListen.apply(this, args);
  }
  return blocked("server-bind", JSON.stringify(args));
};
net.Socket.prototype.connect = function (...args) {
  if (renderingPage && loopbackConnect(args)) {
    return originalConnect.apply(this, args);
  }
  return blocked("network-socket", JSON.stringify(args));
};
https.get = (...args) => {
  if (!renderingPage) {
    return blocked("https", String(args[0] ?? ""));
  }
  const request = {
    on(event, listener) {
      if (event === "error") {
        queueMicrotask(() =>
          listener(new Error("controlled vendor response unavailable"))
        );
      }
      return request;
    }
  };
  return request;
};
childProcess.spawn = (...args) =>
  blocked("subprocess-spawn", String(args[0] ?? ""));
childProcess.execFile = (...args) => {
  const command = String(args[0] ?? "");
  const commandArgs = args[1];
  if (
    renderingPage &&
    command === "git" &&
    Array.isArray(commandArgs) &&
    commandArgs[0] === "-C" &&
    commandArgs[1] === process.env.RADIUS_ARTIFACT_WORKSPACE
  ) {
    return originalExecFile(...args);
  }
  if (renderingPage && /(?:^|[\\/])gh(?:\.exe)?$/i.test(command)) {
    const callback = args.at(-1);
    if (typeof callback !== "function") {
      return blocked("subprocess-exec", `${command} without callback`);
    }
    queueMicrotask(() =>
      callback(new Error("controlled GitHub CLI unavailable"), "", "")
    );
    return {};
  }
  return blocked(
    "subprocess-exec",
    JSON.stringify({ command, args: commandArgs })
  );
};
// exec() routes through the execFile export above, but fork() and the *Sync
// variants are independent exports, so each needs its own guard for the
// fail-closed claim to hold.
childProcess.fork = (...args) =>
  blocked("subprocess-fork", String(args[0] ?? ""));
childProcess.spawnSync = (...args) =>
  blocked("subprocess-spawn-sync", String(args[0] ?? ""));
childProcess.execSync = (...args) =>
  blocked("subprocess-exec-sync", String(args[0] ?? ""));
childProcess.execFileSync = (...args) =>
  blocked("subprocess-exec-file-sync", String(args[0] ?? ""));
syncBuiltinESMExports();

const artifact = process.env.RADIUS_ARTIFACT_PATH;
if (!artifact) throw new Error("RADIUS_ARTIFACT_PATH is required");

await import(pathToFileURL(artifact).href);
process.on("message", async (message) => {
  if (message?.type === "shutdown") {
    process.emit("SIGTERM");
    return;
  }
  if (message?.type !== "render-page") return;
  renderingPage = true;
  try {
    const html = await renderArtifactPage();
    if (typeof process.send === "function") {
      process.send({ type: "page", html });
    }
  } catch (error) {
    if (typeof process.send === "function") {
      process.send({
        type: "render-error",
        detail:
          error instanceof Error ?
            `${error.stack ?? error.message}; cause=${String(error.cause ?? "")}`
          : String(error)
      });
    }
  } finally {
    renderingPage = false;
  }
});
if (typeof process.send === "function") process.send({ type: "ready" });
setInterval(() => void 0, 1_000);
