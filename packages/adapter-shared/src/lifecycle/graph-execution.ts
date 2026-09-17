import { createHash } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import {
  buildEffectiveInputManifest,
  enrichGraphWithRegistrations,
  portCancelled,
  portFailure,
  portSuccess,
  portUnavailable,
  projectRadiusGraph,
  type GraphExecutionPort,
  type IdPort,
  type PortResult,
  type RequestControl,
  type SourceAccessPort,
  type SourceSnapshot
} from "@radius-project/core/lifecycle";
import {
  ensureManagedBicep,
  GraphIsolationError,
  RadProcessError,
  resolveRadForGraph,
  runRadAppGraph
} from "../rad.js";
import {
  canonicalSourceRoot,
  checkSourceCancellation,
  SourceAccessFault,
  writeSourceFile,
  type SourceFileSystem
} from "./source-access-files.js";
import { collectSourceInputs } from "./source-access-closure.js";

export interface GraphCompilationDependencies {
  source: Pick<SourceAccessPort, "readBytes">;
  files: SourceFileSystem;
  storageRoot: string;
  ids: Pick<IdPort, "next">;
  acquireBinaries(
    control: RequestControl
  ): Promise<PortResult<{ radPath: string; bicepPath: string }>>;
  runGraph: typeof runRadAppGraph;
  trustedPath: readonly string[];
  systemRoot?: string;
  timeoutMs: number;
}

function unavailable() {
  return portUnavailable("RESULT_UNAVAILABLE", {
    quality: "unknown",
    evidence: "radius",
    completeness: "unavailable"
  });
}

/** Acquire trusted tooling before any captured source reaches a compiler. */
export async function acquireManagedGraphBinaries(
  control: RequestControl,
  binaries: {
    resolve: typeof resolveRadForGraph;
    ensureBicep: typeof ensureManagedBicep;
  } = { resolve: resolveRadForGraph, ensureBicep: ensureManagedBicep }
): ReturnType<GraphCompilationDependencies["acquireBinaries"]> {
  if (control.cancellation.aborted) return portCancelled("request_cancelled");
  try {
    const radPath = await binaries.resolve();
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    const bicepPath = await binaries.ensureBicep(radPath);
    if (control.cancellation.aborted) return portCancelled("request_cancelled");
    return portSuccess({ radPath, bicepPath });
  } catch {
    return control.cancellation.aborted ?
        portCancelled("request_cancelled")
      : portUnavailable("CAPABILITY_UNAVAILABLE", {
          quality: "unknown",
          evidence: "radius",
          completeness: "unavailable"
        });
  }
}

function hash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function createGraphCompilationAdapter(
  deps: GraphCompilationDependencies
): Pick<GraphExecutionPort, "compile"> {
  if (typeof deps?.runGraph !== "function")
    throw new TypeError("Graph compilation requires an explicit graph runner.");
  const executor = createCapturedSourceExecutor(deps);
  return {
    compile(input, control) {
      return executor.execute(input.snapshot, control, async (context) => {
        const raw = await deps.runGraph(context.definition, {
          radPath: context.binaries.radPath,
          isolation: context.isolation,
          signal: context.signal,
          timeout: deps.timeoutMs
        });
        let graph = projectRadiusGraph(
          raw,
          input.snapshot.manifest.definition,
          context.content
        );
        if (graph.status === "ok" && input.kind === "planned")
          graph = enrichGraphWithRegistrations(
            graph.value,
            input.registrations
          );
        return graph.status === "ok" ?
            portSuccess({ graph: graph.value, diagnostics: [] })
          : graph;
      });
    }
  };
}

export interface CapturedExecutionContext {
  readonly definition: string;
  readonly content: string;
  readonly binaries: { radPath: string; bicepPath: string };
  readonly isolation: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    bicepPath: string;
  };
  readonly signal: AbortSignal;
}

export function createCapturedSourceExecutor(
  deps: Omit<GraphCompilationDependencies, "runGraph">
) {
  if (
    [
      deps?.source?.readBytes,
      deps?.files?.realpath,
      deps?.files?.lstat,
      deps?.files?.open,
      deps?.files?.readdir,
      deps?.files?.mkdir,
      deps?.files?.write,
      deps?.files?.remove,
      deps?.ids?.next,
      deps?.acquireBinaries
    ].some((method) => typeof method !== "function") ||
    !isAbsolute(deps.storageRoot) ||
    !Array.isArray(deps.trustedPath) ||
    !deps.trustedPath.every(
      (path) => isAbsolute(path) && !path.includes(delimiter)
    ) ||
    (deps.systemRoot !== undefined && !isAbsolute(deps.systemRoot)) ||
    !Number.isSafeInteger(deps.timeoutMs) ||
    deps.timeoutMs <= 0 ||
    deps.timeoutMs > 2_147_483_647
  ) {
    throw new TypeError(
      "Graph compilation requires explicit isolated execution dependencies."
    );
  }
  const trustedPath = deps.trustedPath.join(delimiter);
  return {
    async execute<T>(
      snapshot: SourceSnapshot,
      control: RequestControl,
      run: (context: CapturedExecutionContext) => Promise<PortResult<T>>
    ): Promise<PortResult<T>> {
      const controller = new AbortController();
      const unsubscribe = control.cancellation.onAbort(() =>
        controller.abort()
      );
      let directory: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cleanupFailed = false;
      let result: PortResult<T>;
      try {
        checkSourceCancellation(control.cancellation);
        const { manifest } = snapshot;
        if (manifest.completeness !== "complete") {
          return portUnavailable("VALIDATION_INCOMPLETE", {
            quality: "unknown",
            evidence: "source",
            completeness: "partial"
          });
        }
        const rebuilt = buildEffectiveInputManifest(
          {
            definition: manifest.definition,
            inputs: manifest.inputs,
            closure: "complete"
          },
          hash
        );
        if (
          rebuilt.status !== "ok" ||
          rebuilt.value.completeness !== "complete" ||
          rebuilt.value.fingerprint !== manifest.fingerprint ||
          snapshot.provenance.fingerprint !== manifest.fingerprint ||
          snapshot.selection.definition !== manifest.definition
        ) {
          return portFailure("EVIDENCE_MISMATCH");
        }
        const binaries = await deps.acquireBinaries(control);
        checkSourceCancellation(control.cancellation);
        if (binaries.status !== "ok") return binaries;
        for (const path of [binaries.value.radPath, binaries.value.bicepPath]) {
          if (!isAbsolute(path) || !(await deps.files.lstat(path)).isFile())
            return portUnavailable("CAPABILITY_UNAVAILABLE", {
              quality: "unknown",
              evidence: "radius",
              completeness: "unavailable"
            });
        }
        const root = await canonicalSourceRoot(deps.files, deps.storageRoot);
        const id = deps.ids.next("revision");
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
          return portFailure("PRECONDITION_FAILED");
        const candidate = join(root, `graph-${id}`);
        await deps.files.mkdir(candidate);
        directory = candidate;
        const cwd = join(directory, "source");
        const home = join(directory, "home");
        await deps.files.mkdir(cwd);
        await deps.files.mkdir(home);
        // Bicep searches ancestors, not just cwd. A trusted toolchain baseline
        // terminates discovery outside the captured subtree; no captured or
        // explicitly absent repository config is created or overridden.
        await deps.files.write(
          join(directory, "bicepconfig.json"),
          new TextEncoder().encode(
            JSON.stringify({
              cacheRootDirectory: join(home, ".bicep")
            })
          )
        );
        const runtime = join(directory, "runtime");
        await deps.files.mkdir(runtime);
        const env: NodeJS.ProcessEnv = {
          PATH: trustedPath,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          XDG_DATA_HOME: home,
          XDG_RUNTIME_DIR: runtime,
          APPDATA: home,
          LOCALAPPDATA: home,
          TMPDIR: runtime,
          TMP: runtime,
          TEMP: runtime,
          DOTNET_CLI_HOME: home,
          GH_CONFIG_DIR: join(home, "gh"),
          AZURE_CONFIG_DIR: join(home, "azure"),
          AWS_CONFIG_FILE: join(home, "aws-config"),
          AWS_SHARED_CREDENTIALS_FILE: join(home, "aws-credentials"),
          KUBECONFIG: join(home, "kubeconfig"),
          GITHUB_ACTIONS: "",
          ...(deps.systemRoot ? { SystemRoot: deps.systemRoot } : {})
        };
        let content = "";
        let totalBytes = 0;
        for (const expected of manifest.inputs) {
          checkSourceCancellation(control.cancellation);
          const captured = await deps.source.readBytes(
            snapshot,
            expected.path,
            control
          );
          checkSourceCancellation(control.cancellation);
          if (captured.status === "absent") {
            if (expected.existed)
              throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
            continue;
          }
          if (captured.status !== "ok") throw new SourceAccessFault(captured);
          const { input: actual } = captured.value;
          const bytes = new Uint8Array(captured.value.bytes);
          totalBytes += bytes.byteLength;
          if (
            !expected.existed ||
            actual.path !== expected.path ||
            actual.kind !== expected.kind ||
            actual.existed !== expected.existed ||
            actual.contentHash !== expected.contentHash ||
            hash(bytes) !== expected.contentHash ||
            expected.path.toLowerCase() === "app-graph.json"
          ) {
            throw new SourceAccessFault(portFailure("SOURCE_CHANGED"));
          }
          if (expected.path === manifest.definition)
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          await writeSourceFile(deps.files, cwd, expected.path, bytes);
        }
        // Reuse closure discovery on the owned materialization, following only
        // compilation inputs. Recipe companions and load-file bytes are data,
        // not independently compiled entrypoints or registry restore requests.
        const dependencies = await collectSourceInputs(
          deps.files,
          cwd,
          manifest.definition,
          {
            maxFiles: manifest.inputs.length,
            maxFileBytes: totalBytes,
            maxTotalBytes: totalBytes
          },
          control.cancellation,
          "compilation"
        );
        if (!dependencies.complete) {
          throw new SourceAccessFault(
            portUnavailable("CAPABILITY_UNAVAILABLE", {
              quality: "unknown",
              evidence: "source",
              completeness: "partial",
              limitation:
                "Compilation dependencies are not captured; registry restoration and unsupported dependency syntax are unavailable."
            })
          );
        }
        checkSourceCancellation(control.cancellation);
        timer = setTimeout(() => controller.abort(), deps.timeoutMs);
        result = await run({
          definition: join(cwd, manifest.definition),
          content,
          binaries: binaries.value,
          isolation: { cwd, env, bicepPath: binaries.value.bicepPath },
          signal: controller.signal
        });
        checkSourceCancellation(control.cancellation);
        if (controller.signal.aborted)
          throw new SourceAccessFault(unavailable());
      } catch (error) {
        cleanupFailed =
          error instanceof RadProcessError && error.cleanupIncomplete;
        result =
          cleanupFailed ? portFailure("PRECONDITION_FAILED")
          : error instanceof GraphIsolationError ?
            portUnavailable("CAPABILITY_UNAVAILABLE", {
              quality: "unknown",
              evidence: "radius",
              completeness: "unavailable",
              limitation: error.message
            })
          : (
            error instanceof SourceAccessFault &&
            error.result.status !== "absent"
          ) ?
            error.result
          : unavailable();
      } finally {
        clearTimeout(timer);
        unsubscribe();
        // A runner that cannot prove termination retains ownership of its
        // files. Never delete a live child's cwd, particularly on Windows.
        if (directory && !cleanupFailed) {
          try {
            await deps.files.remove(directory);
          } catch {
            cleanupFailed = true;
            result = portFailure("PRECONDITION_FAILED");
          }
        }
      }
      return control.cancellation.aborted && !cleanupFailed ?
          portCancelled("request_cancelled")
        : result;
    }
  };
}
