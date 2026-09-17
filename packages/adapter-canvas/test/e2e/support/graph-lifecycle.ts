import { randomUUID } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createGraphCompilationAdapter,
  nodeSourceFileSystem,
  readObject,
  acquireManagedGraphBinaries,
  runRadAppGraph
} from "@radius-project/adapter-shared";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createCanvasDiscoveryContext } from "../../../src/runtime/create-discovery-context.js";
import {
  createCanvasLifecycleAuthority,
  unavailableCanvasLifecyclePrerequisite
} from "../../../src/runtime/lifecycle-authorization.js";
import { createLifecycleBinding } from "../../../src/runtime/create-lifecycle-binding.js";
import {
  createSelectedGhExecutor,
  getGitHubIdentity,
  runCommand
} from "../../../src/gh.js";
import type { CanvasState } from "../../../src/shared.js";

export async function readHarnessWorkspace(state: CanvasState) {
  const workspacePath = state.workspacePath || "";
  const branch = (
    await runCommand(
      "git",
      ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 5000 }
    )
  ).trim();
  return { workspacePath, repo: state.workspaceRepo || "", branch };
}

export async function createHarnessGraphLifecycle(input: {
  root: string;
  state: CanvasState;
  fake: boolean;
  scenarioPath: string;
  cliLogPath: string;
}) {
  const ids = { next: () => randomUUID() };
  const clock = { now: () => new Date().toISOString() };
  const hostBinding = () => ({
    bindingRef: "chromium-host",
    sessionRef: "chromium-session"
  });
  const workspace = () => readHarnessWorkspace(input.state);
  const authority = createCanvasLifecycleAuthority({
    binding: hostBinding,
    identity: getGitHubIdentity,
    workspace,
    ...(input.fake ? {} : { executor: createSelectedGhExecutor }),
    responseAuthority: async () => unavailableCanvasLifecyclePrerequisite()
  });
  const context = createCanvasDiscoveryContext({
    ids,
    clock,
    authority,
    hostBinding,
    workspace,
    storageRoot: join(input.root, "source-snapshots"),
    executor: createSelectedGhExecutor,
    git: (root, args, control) => {
      const abort = new AbortController();
      const unsubscribe = control.cancellation.onAbort(() => abort.abort());
      return runCommand("git", ["-C", root, ...args], {
        timeout: 5000,
        signal: abort.signal
      }).finally(unsubscribe);
    }
  });
  const storageRoot = join(input.root, "graph-compilations");
  await mkdir(storageRoot, { recursive: true });
  const compile = createGraphCompilationAdapter({
    source: context.source,
    files: nodeSourceFileSystem,
    storageRoot,
    ids,
    trustedPath: [],
    ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
    timeoutMs: 5000,
    acquireBinaries:
      input.fake ?
        async () =>
          portSuccess({
            radPath: process.execPath,
            bicepPath: process.execPath
          })
      : acquireManagedGraphBinaries,
    runGraph:
      input.fake ?
        async (file, options) => {
          if (!options?.isolation || options.saveGraphJsonTo)
            throw new Error(
              "Expected an isolated non-publishing graph compile"
            );
          const scenario: unknown = JSON.parse(
            await readFile(input.scenarioPath, "utf8")
          );
          if (!readObject(scenario) || !Array.isArray(scenario.commands))
            throw new Error("Invalid graph scenario");
          const command = scenario.commands.find(
            (candidate: unknown) =>
              readObject(candidate) &&
              candidate.tool === "rad" &&
              Array.isArray(candidate.argsPrefix) &&
              JSON.stringify(candidate.argsPrefix) === '["app","graph"]'
          );
          if (!readObject(command))
            throw new Error("Unmodeled canonical compiler invocation");
          await appendFile(
            input.cliLogPath,
            JSON.stringify({
              tool: "rad",
              args: ["app", "graph", file, "--include-icons"],
              cwd: options.isolation.cwd
            }) + "\n"
          );
          if (command.exitCode && command.exitCode !== 0)
            throw new Error("Scripted compiler failure");
          if (!Array.isArray(command.writeFiles))
            throw new Error("Unmodeled compiler output");
          const artifact = command.writeFiles.find(
            (candidate: unknown) =>
              readObject(candidate) && candidate.path === "app-graph.json"
          );
          if (!readObject(artifact) || typeof artifact.content !== "string")
            throw new Error("Unmodeled compiler artifact");
          return JSON.parse(artifact.content);
        }
      : runRadAppGraph
  });
  return createLifecycleBinding({
    ...context,
    ids,
    clock,
    authority,
    hostBinding,
    knownLegacyOperations: () => [],
    graphs: {
      source: context.source,
      graph: { ...compile, observeDeployed: context.observeDeployed },
      environment: context.environments
    }
  });
}
