import childProcess from "node:child_process";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import {
  artifactCloseCount,
  renderArtifactPage,
  runArtifactReadiness
} from "./sdk-stub.mjs";

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
const originalSpawnSync = childProcess.spawnSync;
let renderingPage = false;
let checkingReadiness = false;
const readinessCalls = [];
const readinessMode =
  process.env.RADIUS_ARTIFACT_SHUTDOWN?.startsWith("readiness");
let activeLogin = "fixture-account";

if (readinessMode) {
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_PACKAGES_TOKEN",
    "GH_HOST"
  ])
    delete process.env[key];
}

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
  if (
    checkingReadiness &&
    String(input).startsWith("https://ghcr.io/token?") &&
    !init?.method &&
    readinessCalls.length === 0
  ) {
    readinessCalls.push("GET");
    if (process.env.RADIUS_ARTIFACT_SHUTDOWN === "readiness-external-change")
      activeLogin = "external-account";
    process.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    if (artifactCloseCount() !== 0)
      return blocked("early-sdk-teardown", "readiness still pending");
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: "opaque-registry-fixture" })
    };
  }
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
childProcess.spawn = (...args) =>
  blocked("subprocess-spawn", String(args[0] ?? ""));
childProcess.execFile = (...args) => {
  const command = String(args[0] ?? "");
  const commandArgs = args[1];
  if (
    (renderingPage || checkingReadiness) &&
    command === "git" &&
    Array.isArray(commandArgs) &&
    commandArgs[0] === "-C" &&
    commandArgs[1] === process.env.RADIUS_ARTIFACT_WORKSPACE
  ) {
    return originalExecFile(...args);
  }
  if (
    checkingReadiness &&
    command === "git" &&
    JSON.stringify(commandArgs) ===
      '["check-ref-format","--branch","feature/setup"]'
  )
    return originalExecFile(...args);
  if (checkingReadiness && /(?:^|[\\/])gh(?:\.exe)?$/i.test(command)) {
    const responses = {
      "--version": "gh version 2.87.0",
      "auth status --hostname github.com": `Logged in to github.com account ${activeLogin} (keyring)\n  - Active account: true\n  - Token scopes: 'repo', 'workflow', 'write:packages'`,
      "auth token --hostname github.com --user fixture-account":
        "opaque-artifact-fixture",
      "api user --jq .login": "fixture-account",
      "api repos/fixture/app": '{"permissions":{"admin":true}}'
    };
    const key = Array.isArray(commandArgs) ? commandArgs.join(" ") : "";
    const callback = args.at(-1);
    if (
      typeof callback === "function" &&
      key === "auth switch --hostname github.com --user fixture-account"
    ) {
      activeLogin = "fixture-account";
      queueMicrotask(() => callback(null, "", ""));
      return {};
    }
    if (
      typeof callback === "function" &&
      key === "auth switch --hostname github.com --user original-account" &&
      process.env.RADIUS_ARTIFACT_SHUTDOWN === "readiness-restoration-failed"
    ) {
      queueMicrotask(() =>
        callback(
          new Error("controlled restoration failure"),
          "",
          "Restore unavailable client_secret=fixture-value"
        )
      );
      return {};
    }
    if (!Object.hasOwn(responses, key) || typeof callback !== "function")
      return blocked("readiness-command", key);
    if (
      key === "auth token --hostname github.com --user fixture-account" &&
      process.env.RADIUS_ARTIFACT_SHUTDOWN !== "readiness"
    )
      activeLogin = "original-account";
    queueMicrotask(() => callback(null, responses[key], ""));
    return {};
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
childProcess.spawnSync = (...args) => {
  if (
    args[0] === process.execPath &&
    ['["-e","process.exit(0)"]', '["--version"]'].includes(
      JSON.stringify(args[1])
    )
  )
    return originalSpawnSync(...args);
  return blocked("subprocess-spawn-sync", String(args[0] ?? ""));
};
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
    if (readinessMode) {
      checkingReadiness = true;
      try {
        const result = await runArtifactReadiness();
        if (
          result.code !== "github-account-stopped" ||
          readinessCalls.length !== 1
        )
          return blocked("readiness-result", JSON.stringify(result));
        process.send?.({
          type: "readiness",
          code: result.code,
          calls: readinessCalls
        });
      } catch (error) {
        blocked("readiness-error", String(error));
      }
      return;
    }
    process.emit("SIGTERM");
    process.emit("SIGINT");
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
