import childProcess from "node:child_process";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";

function blocked(kind, detail) {
  const boundedDetail = String(detail).slice(0, 500);
  const message = `Blocked ${kind} attempt during artifact startup: ${boundedDetail}`;
  if (typeof process.send === "function") {
    process.send({ type: "blocked", kind, detail: boundedDetail });
  }
  throw new Error(message);
}

globalThis.fetch = async (input) =>
  blocked("network", typeof input === "string" ? input : String(input?.url));
net.Server.prototype.listen = function (...args) {
  return blocked("server-bind", JSON.stringify(args));
};
net.Socket.prototype.connect = function (...args) {
  return blocked("network-socket", JSON.stringify(args));
};
childProcess.spawn = (...args) =>
  blocked("subprocess-spawn", String(args[0] ?? ""));
childProcess.execFile = (...args) =>
  blocked("subprocess-exec", String(args[0] ?? ""));
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
process.on("message", (message) => {
  if (message?.type === "shutdown") process.emit("SIGTERM");
});
if (typeof process.send === "function") process.send({ type: "ready" });
setInterval(() => void 0, 1_000);
