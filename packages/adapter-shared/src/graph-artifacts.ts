import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import {
  GraphSourceError,
  type GraphSourceIdentity,
  type PresentGraphSource,
  type StagedGraphArtifacts
} from "@radius-project/core";
import {
  confinedGraphPath,
  type GraphBytesRead
} from "./graph-source-bindings.js";

export interface GraphArtifactPorts {
  readBytes(
    source: GraphSourceIdentity,
    repoPath: string
  ): Promise<GraphBytesRead>;
  stagingRoot: string;
  diagnostic?(message: string): void;
  redactDiagnostic(message: string): string;
  files?: Pick<typeof fs, "mkdir" | "mkdtemp" | "writeFile" | "rm">;
}

export async function stageGraphArtifacts(
  selection: PresentGraphSource,
  ports: GraphArtifactPorts
): Promise<StagedGraphArtifacts> {
  try {
    return await stageArtifacts(selection, ports);
  } catch (error) {
    if (error instanceof GraphSourceError) throw error;
    throw new GraphSourceError(
      "unavailable",
      ports.redactDiagnostic(
        error instanceof Error ? error.message : String(error)
      ),
      selection.source,
      { cause: error }
    );
  }
}

async function stageArtifacts(
  selection: PresentGraphSource,
  ports: GraphArtifactPorts
): Promise<StagedGraphArtifacts> {
  const files = ports.files ?? fs;
  const source = selection.source;
  const definitionDir = path.posix.dirname(
    source.definitionPath.replace(/\\/g, "/")
  );
  const repoPath = (relative: string) =>
    definitionDir === "." ? relative : `${definitionDir}/${relative}`;
  function fail(message: string): never {
    throw new GraphSourceError(
      "invalid-artifact",
      ports.redactDiagnostic(message),
      source
    );
  }
  const config = await ports.readBytes(source, repoPath("bicepconfig.json"));
  const hash = createHash("sha256").update("radius-base-config");
  if (config.status === "unavailable") fail(config.diagnostic);
  const artifacts: Array<{ relative: string; bytes: Uint8Array }> = [];
  if (config.status === "present") {
    hash.update(config.bytes);
    const errors: ParseError[] = [];
    const parsed: unknown = parse(
      Buffer.from(config.bytes).toString("utf8"),
      errors,
      { allowTrailingComma: true, disallowComments: false }
    );
    if (errors.length) fail("Graph bicepconfig.json is not valid JSON.");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail("Graph bicepconfig.json must be an object.");
    const extensions = "extensions" in parsed ? parsed.extensions : {};
    if (
      !extensions ||
      typeof extensions !== "object" ||
      Array.isArray(extensions)
    )
      fail("Graph bicepconfig.json extensions must be an object.");
    for (const [alias, ref] of Object.entries(extensions).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (typeof ref !== "string" || !ref)
        fail(`Invalid extension reference for ${alias}.`);
      hash.update(alias).update(ref);
      if (/^(br|oci):/i.test(ref)) continue;
      const relative = ref.replace(/^\.\//, "");
      if (
        !relative ||
        /^[\\/]|^[a-z]:/i.test(relative) ||
        relative.includes("\\") ||
        relative
          .split("/")
          .some((part) => !part || part === ".." || part === ".") ||
        relative.includes("\0") ||
        relative === "bicepconfig.json"
      )
        fail(`Unsafe graph extension reference for ${alias}.`);
      const artifact = await ports.readBytes(source, repoPath(relative));
      if (artifact.status !== "present")
        fail(
          artifact.status === "unavailable" ?
            artifact.diagnostic
          : `Required graph extension artifact ${relative} is absent.`
        );
      hash.update(artifact.bytes);
      artifacts.push({ relative, bytes: artifact.bytes });
    }
  }
  const fingerprint = hash.digest("hex");
  if (source.kind === "workspace") {
    if (!source.workspacePath) fail("Workspace graph source has no directory.");
    const dir =
      definitionDir === "." ?
        source.workspacePath
      : await confinedGraphPath(source.workspacePath, definitionDir);
    return {
      dir,
      owned: false,
      fingerprint,
      dispose: async () => {}
    };
  }
  if (config.status === "absent")
    return {
      dir: "",
      owned: false,
      fingerprint,
      dispose: async () => {}
    };
  await files.mkdir(ports.stagingRoot, { recursive: true });
  const dir = await files.mkdtemp(path.join(ports.stagingRoot, "graph-"));
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await files.rm(dir, { recursive: true, force: true });
  };
  try {
    await files.writeFile(path.join(dir, "bicepconfig.json"), config.bytes);
    for (const artifact of artifacts) {
      const target = path.join(dir, artifact.relative);
      await files.mkdir(path.dirname(target), { recursive: true });
      await files.writeFile(target, artifact.bytes);
    }
    return { dir, owned: true, fingerprint, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      try {
        ports.diagnostic?.(
          ports.redactDiagnostic(
            `Graph staging cleanup failed: ${String(cleanupError)}`
          )
        );
      } catch {
        // Preserve the staging failure even if its diagnostic sink fails.
      }
    }
    throw error;
  }
}
