import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync
} from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { workspaceRadArtifactsDir } from "./workspace.js";
import type { CanvasState } from "./shared.js";

interface GitHubArtifactReader {
  getContent(apiPath: string): Promise<string | null>;
  getContentBytes(apiPath: string): Promise<Buffer | { tooLarge: true } | null>;
}

interface StageOptions {
  log?: (message: string) => void;
}

interface LocalArtifactSelection {
  isLocal: true;
  state: CanvasState;
  bicepRepoPath: string;
}

interface RemoteArtifactSelection {
  isLocal: false;
  state?: CanvasState;
  github: GitHubArtifactReader;
  repo: string;
  branch: string;
  bicepRepoPath: string;
  log?: (message: string) => void;
}

type ArtifactSelection = LocalArtifactSelection | RemoteArtifactSelection;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOciExtensionRef(ref: string): boolean {
  return /^(br|oci):/i.test(ref);
}

// A local extension artifact reference from a bicepconfig alias must be a
// repo-relative path with no traversal or absolute segment.
function safeLocalRef(ref: unknown): string {
  if (typeof ref !== "string") return "";
  const rel = ref.replace(/^\.\//, "");
  if (
    !rel ||
    path.isAbsolute(rel) ||
    rel.split(/[\\/]/).some((seg) => seg === "..")
  )
    return "";
  return rel;
}

export function radArtifactsFingerprint(dir?: string): string {
  const hash = createHash("sha256");
  hash.update("radius-base-config");
  if (!dir) return hash.digest("hex");

  const configPath = path.join(dir, "bicepconfig.json");
  if (!existsSync(configPath)) return hash.digest("hex");
  let configBytes;
  try {
    configBytes = readFileSync(configPath);
  } catch {
    hash.update("unreadable-config");
    return hash.digest("hex");
  }
  hash.update(configBytes);

  let config;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
  } catch {
    return hash.digest("hex");
  }
  const extensions =
    config && typeof config.extensions === "object" ? config.extensions : {};
  for (const [alias, ref] of Object.entries(extensions).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(alias);
    hash.update(String(ref));
    if (typeof ref !== "string" || isOciExtensionRef(ref)) continue;
    const rel = safeLocalRef(ref);
    if (!rel) continue;
    const artifactPath = path.join(dir, rel);
    if (!existsSync(artifactPath)) {
      hash.update("missing");
      continue;
    }
    try {
      hash.update(readFileSync(artifactPath));
    } catch {
      hash.update("unreadable");
    }
  }
  return hash.digest("hex");
}

/**
 * stageRemoteRadArtifacts - for a committed branch fetched from GitHub, stage
 * the branch's `.radius/bicepconfig.json` and the local extension artifacts it
 * references (e.g. custom-types.tgz) into a fresh temp directory, so a compile
 * with `buildGraphViaRad({ radArtifactsDir })` can resolve `extension
 * customTypes` for that branch (graph-diff / PR-diff of committed branches).
 *
 * The text config is fetched via `github.getContent`; binary artifacts via
 * `github.getContentBytes` (the contents API decodes to UTF-8 otherwise, which
 * would corrupt a `.tgz`). Best-effort: returns null when there is no committed
 * bicepconfig.json (the base Radius config already compiles `extension radius`)
 * or on a config fetch/parse error. A per-artifact failure (absent, or too
 * large for the contents API's ~1MB inline limit) is logged and skipped so the
 * caller surfaces the resulting unresolved-extension compile error rather than
 * silently succeeding.
 *
 * Returns the temp directory path on success (the caller, or buildGraphViaRad
 * via `cleanupRadArtifactsDir`, must remove it), else null.
 */
export async function stageRemoteRadArtifacts(
  github: GitHubArtifactReader,
  repo: string,
  branch: string,
  bicepRepoPath: string,
  { log = () => {} }: StageOptions = {}
): Promise<string | null> {
  if (!repo || !branch) return null;
  const normalized = String(bicepRepoPath || ".radius/app.bicep").replace(
    /\\/g,
    "/"
  );
  const bicepDir = path.posix.dirname(normalized);
  const radiusDir = bicepDir && bicepDir !== "." ? bicepDir : "";
  const configRepoPath =
    radiusDir ? `${radiusDir}/bicepconfig.json` : "bicepconfig.json";

  let configText;
  try {
    configText = await github.getContent(
      `/repos/${repo}/contents/${configRepoPath}?ref=${branch}`
    );
  } catch (err) {
    log(
      `Warning: could not fetch ${configRepoPath} on ${branch}: ${errorMessage(err)}`
    );
    return null;
  }
  if (!configText) return null; // no committed config: base Radius config suffices

  let config;
  try {
    config = JSON.parse(configText);
  } catch (err) {
    log(
      `Warning: ${configRepoPath} on ${branch} is not valid JSON; ignoring: ${errorMessage(err)}`
    );
    return null;
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "rad-remote-"));
  try {
    writeFileSync(path.join(dir, "bicepconfig.json"), configText);
    const extensions =
      config && typeof config.extensions === "object" ? config.extensions : {};
    for (const [alias, ref] of Object.entries(extensions)) {
      if (typeof ref !== "string" || isOciExtensionRef(ref)) continue;
      const rel = safeLocalRef(ref);
      if (!rel) {
        log(
          `Warning: skipping non-local extension artifact reference for ${alias}: ${ref}`
        );
        continue;
      }
      const artifactRepoPath = radiusDir ? `${radiusDir}/${rel}` : rel;
      let bytes;
      try {
        bytes = await github.getContentBytes(
          `/repos/${repo}/contents/${artifactRepoPath}?ref=${branch}`
        );
      } catch (err) {
        log(
          `Warning: could not fetch extension artifact ${artifactRepoPath} on ${branch}: ${errorMessage(err)}`
        );
        continue;
      }
      if (bytes && !Buffer.isBuffer(bytes) && bytes.tooLarge) {
        log(
          `Warning: extension artifact ${artifactRepoPath} on ${branch} exceeds the GitHub contents API inline limit; the ${alias} extension will not resolve for this branch.`
        );
        continue;
      }
      if (!bytes) {
        log(
          `Warning: extension artifact ${artifactRepoPath} not found on ${branch}; the ${alias} extension will not resolve for this branch.`
        );
        continue;
      }
      const dest = path.join(dir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      if (Buffer.isBuffer(bytes)) writeFileSync(dest, bytes);
    }
    return dir;
  } catch (err) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    log(
      `Warning: could not stage remote .radius artifacts for ${repo}@${branch}: ${errorMessage(err)}`
    );
    return null;
  }
}

/**
 * radArtifactsDirForSelection - pick the `.radius/` artifacts directory for a
 * graph compile of the given selection. For the local workspace branch it is
 * the workspace `.radius/` (no cleanup); for a committed branch fetched from
 * GitHub it is a staged temp dir (see stageRemoteRadArtifacts) that must be
 * removed after the compile. Returns { dir, remote }, where `remote` is true
 * when `dir` is a staged temp dir to clean up (pass as `cleanupRadArtifactsDir`).
 */
export async function radArtifactsDirForSelection(
  selection: ArtifactSelection
): Promise<{ dir: string; remote: boolean }> {
  if (selection.isLocal) {
    return {
      dir: workspaceRadArtifactsDir(selection.state, selection.bicepRepoPath),
      remote: false
    };
  }
  const dir = await stageRemoteRadArtifacts(
    selection.github,
    selection.repo,
    selection.branch,
    selection.bicepRepoPath,
    { log: selection.log }
  );
  return { dir: dir || "", remote: !!dir };
}
