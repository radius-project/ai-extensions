import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GraphSourceError,
  type GraphSourceIdentity,
  type PresentGraphSource,
  type StagedGraphArtifacts
} from "@radius-project/core";
import type { GraphBytesRead } from "./graph-source-bindings.js";
import { isNonFileExtensionReference } from "./bicep-extension-reference.js";
import { readBicepConfigJsonc } from "./bicep-config-jsonc.js";

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
  const artifacts = new Map<string, Uint8Array>();
  const destinations = new Map([["bicepconfig.json", "bicepconfig.json"]]);
  // Fixed-length digests keep adjacent fields and files from sharing boundaries.
  const hashField = (field: string | Uint8Array) =>
    hash.update(createHash("sha256").update(field).digest());
  if (config.status === "present") {
    hashField(config.bytes);
    let parsed: unknown;
    try {
      parsed = readBicepConfigJsonc(Buffer.from(config.bytes).toString("utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      fail("Graph bicepconfig.json is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail("Graph bicepconfig.json must be an object.");
    const extensions = "extensions" in parsed ? parsed.extensions : {};
    if (
      !extensions ||
      typeof extensions !== "object" ||
      Array.isArray(extensions)
    )
      fail("Graph bicepconfig.json extensions must be an object.");
    for (const [alias, value] of Object.entries(extensions).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (typeof value !== "string")
        fail(`Invalid extension reference for ${alias}.`);
      if (!value.trim()) continue;
      const ref = alias === "radius" ? value.trim() : value;
      if (isNonFileExtensionReference(ref)) continue;
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
      // Staged repository inputs must be portable to case-insensitive hosts.
      const components = relative
        .split("/")
        .map((part) => part.replace(/[ .]+$/, "").toLowerCase());
      const destination = components.join("/");
      if (destination.includes(":") || components.includes(""))
        fail(`Unsafe graph extension reference for ${alias}.`);
      const previous = destinations.get(destination);
      if (previous !== undefined && previous !== relative)
        fail(`Conflicting graph extension destination for ${alias}.`);
      if (artifacts.has(relative)) continue;
      destinations.set(destination, relative);
      const artifact = await ports.readBytes(source, repoPath(relative));
      if (artifact.status !== "present")
        fail(
          artifact.status === "unavailable" ?
            artifact.diagnostic
          : `Required graph extension artifact ${relative} is absent.`
        );
      hashField(relative);
      hashField(artifact.bytes);
      artifacts.set(relative, artifact.bytes);
    }
  }
  const fingerprint = hash.digest("hex");
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
    for (const [relative, bytes] of artifacts) {
      const target = path.join(dir, relative);
      await files.mkdir(path.dirname(target), { recursive: true });
      await files.writeFile(target, bytes, { flag: "wx" });
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
