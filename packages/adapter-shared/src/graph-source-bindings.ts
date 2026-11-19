import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type GraphSourceIdentity,
  type GraphSourceRead,
  type PresentGraphSource,
  type StagedGraphArtifacts
} from "@radius-project/core";
import type { DeploymentCommandExecutor } from "./deployment-command-bindings.js";
import { createDeploymentRepository } from "./deployment-repository.js";
import {
  safeWorkspacePath,
  toSafeRepoRelPath
} from "./deployment-workspace.js";
import { stageGraphArtifacts } from "./graph-artifacts.js";

export interface GraphSourceRequest {
  repo: string;
  ref: string;
  definitionPath?: string;
  committedOnly?: boolean;
  workspace?: {
    repo: string;
    ref: string;
    path: string;
    authorized: boolean;
  };
}

export type GraphBytesRead =
  | { status: "present"; bytes: Uint8Array }
  | { status: "absent" }
  | { status: "unavailable"; diagnostic: string };

export interface GraphSourceBindings {
  assertWorkspaceSource(source: GraphSourceIdentity): Promise<void>;
  read(request: GraphSourceRequest): Promise<GraphSourceRead>;
  readFile(
    source: GraphSourceIdentity,
    repoPath: string
  ): Promise<GraphSourceRead>;
  stage(selection: PresentGraphSource): Promise<StagedGraphArtifacts>;
}

export class WorkspaceGraphBranchChanged extends Error {}

const CONTENTS_INLINE_LIMIT = 1024 * 1024;

function isTooLargeError(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "errors" in value &&
    Array.isArray(value.errors) &&
    value.errors.some(
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "too_large"
    )
  );
}

export interface GraphSourceBindingOptions {
  execute: DeploymentCommandExecutor;
  redactDiagnostic(message: string): string;
  stagingRoot: string;
  diagnostic?(message: string): void;
}

function safePath(input: string): string {
  if (/^[\\/]/.test(input)) throw new Error("Absolute graph path not allowed.");
  const normalized = toSafeRepoRelPath(input);
  if (normalized.split("/").some((part) => !part || part === "."))
    throw new Error("Graph paths must name a repository file.");
  return normalized;
}

/** Check real ancestors too: lexical confinement alone permits symlink escapes. */
export async function confinedGraphPath(
  root: string,
  repoPath: string
): Promise<string> {
  const normalized = safePath(repoPath);
  const actualRoot = await fs.realpath(root);
  const candidate = safeWorkspacePath(actualRoot, normalized);
  let ancestor = candidate;
  for (;;) {
    try {
      const actual = await fs.realpath(ancestor);
      if (actual !== actualRoot && !actual.startsWith(actualRoot + path.sep))
        throw new Error(`Graph path escapes workspace: ${repoPath}`);
      return candidate;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      try {
        await fs.lstat(ancestor);
      } catch (entryError) {
        if (
          !entryError ||
          typeof entryError !== "object" ||
          !("code" in entryError) ||
          entryError.code !== "ENOENT"
        )
          throw entryError;
        ancestor = path.dirname(ancestor);
        continue;
      }
      throw new Error(`Graph path is unreadable: ${repoPath}`, {
        cause: error
      });
    }
  }
}

export function createGraphSourceBindings(
  options: GraphSourceBindingOptions
): GraphSourceBindings {
  const repository = createDeploymentRepository(options);
  const diagnostic = (error: unknown): string =>
    options.redactDiagnostic(
      error instanceof Error ? error.message : String(error)
    );

  async function requireReadableRevision(repo: string, revision: string) {
    const proof = await repository.readJson(
      `/repos/${repo}/commits/${encodeURIComponent(revision)}`
    );
    if (
      !proof.ok ||
      !proof.json ||
      typeof proof.json !== "object" ||
      !("sha" in proof.json) ||
      proof.json.sha !== revision
    )
      throw new Error(
        proof.stderr || "GitHub graph revision is no longer readable."
      );
  }

  async function assertWorkspaceBranch(
    source: GraphSourceIdentity,
    workspacePath: string
  ) {
    const branch = await new Promise<string>((resolve, reject) => {
      options.execute(
        "git",
        ["-C", workspacePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
        { timeout: 5000 },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(stderr || "Workspace branch is unavailable."));
          else resolve(stdout.trim());
        }
      );
    });
    if (branch !== source.ref)
      throw new WorkspaceGraphBranchChanged(
        `Workspace branch changed: expected ${source.ref}, found ${branch || "no branch"}.`
      );
  }

  async function assertWorkspaceSource(source: GraphSourceIdentity) {
    if (source.kind !== "workspace") return;
    if (!source.workspacePath)
      throw new Error("Workspace path is unavailable.");
    await assertWorkspaceBranch(source, source.workspacePath);
  }

  async function readBytes(
    source: GraphSourceIdentity,
    repoPath: string,
    revisionProved: boolean
  ): Promise<GraphBytesRead> {
    try {
      const normalized = safePath(repoPath);
      if (source.kind === "workspace") {
        if (!source.workspacePath)
          throw new Error("Workspace source has no authorized directory.");
        await assertWorkspaceBranch(source, source.workspacePath);
        const file = await confinedGraphPath(source.workspacePath, normalized);
        let result: GraphBytesRead;
        try {
          result = { status: "present", bytes: await fs.readFile(file) };
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            await confinedGraphPath(source.workspacePath, normalized);
            result = { status: "absent" };
          } else throw error;
        }
        await assertWorkspaceBranch(source, source.workspacePath);
        return result;
      }
      if (!source.revision || !/^[a-f0-9]{40}$/i.test(source.revision))
        throw new Error("GitHub graph source has no resolved revision.");
      if (!revisionProved)
        await requireReadableRevision(source.repo, source.revision);
      const tooLarge = () =>
        new Error(
          `Graph file ${normalized} exceeds the GitHub Contents API inline limit (1 MiB).`
        );
      const response = await repository.readJson(
        `/repos/${source.repo}/contents/${normalized.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(source.revision)}`,
        { readErrorJson: true }
      );
      if (!response.ok) {
        if (response.status === 404) {
          // GitHub also returns 404 when access has been lost.
          await requireReadableRevision(source.repo, source.revision);
          return { status: "absent" };
        }
        if (isTooLargeError(response.json)) throw tooLarge();
        throw new Error(response.stderr || "GitHub graph file unavailable.");
      }
      const value = response.json;
      if (
        !value ||
        typeof value !== "object" ||
        !("encoding" in value) ||
        !("content" in value) ||
        typeof value.content !== "string" ||
        !("size" in value) ||
        !Number.isSafeInteger(value.size) ||
        typeof value.size !== "number" ||
        value.size < 0
      )
        throw new Error(
          "GitHub graph file metadata is invalid or unsupported."
        );
      if (
        value.encoding === "none" &&
        value.content === "" &&
        value.size > CONTENTS_INLINE_LIMIT
      )
        throw tooLarge();
      if (value.encoding !== "base64")
        throw new Error(
          "GitHub graph file metadata is invalid or unsupported."
        );
      const encoded = value.content.replace(/\s/g, "");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded || bytes.length !== value.size)
        throw new Error("GitHub graph file content is incomplete or invalid.");
      return { status: "present", bytes };
    } catch (error) {
      return { status: "unavailable", diagnostic: diagnostic(error) };
    }
  }

  async function readText(
    source: GraphSourceIdentity,
    repoPath: string,
    revisionProved: boolean
  ): Promise<GraphSourceRead> {
    const identity = { ...source, definitionPath: repoPath };
    const result = await readBytes(source, repoPath, revisionProved);
    if (result.status === "present")
      return {
        status: "present",
        source: identity,
        content: Buffer.from(result.bytes).toString("utf8")
      };
    return { ...result, source: identity };
  }

  async function read(request: GraphSourceRequest): Promise<GraphSourceRead> {
    const workspace = request.workspace;
    const local =
      !request.committedOnly &&
      workspace?.authorized === true &&
      workspace.repo.toLowerCase() === request.repo.toLowerCase() &&
      workspace.ref === request.ref;
    const source: GraphSourceIdentity = {
      kind: local ? "workspace" : "github",
      repo: request.repo,
      ref: request.ref,
      definitionPath: request.definitionPath ?? ".radius/app.bicep",
      ...(local ? { workspacePath: workspace.path } : {})
    };
    try {
      if (!request.repo || !request.ref)
        throw new Error("Graph source requires a repository and ref.");
      if (source.kind === "github") {
        // Resolve the moving ref once; supporting files use the captured SHA.
        const response = await repository.readJson(
          `/repos/${request.repo}/commits/${encodeURIComponent(request.ref)}`
        );
        const commit = response.json;
        if (
          !response.ok ||
          !commit ||
          typeof commit !== "object" ||
          !("sha" in commit) ||
          typeof commit.sha !== "string" ||
          !/^[a-f0-9]{40}$/i.test(commit.sha)
        )
          throw new Error(
            response.stderr || "GitHub graph ref is unavailable or malformed."
          );
        source.revision = commit.sha;
      }
      const paths =
        request.definitionPath ?
          [request.definitionPath]
        : [".radius/app.bicep", "app.bicep"];
      for (const candidate of paths) {
        const result = await readText(source, candidate, true);
        if (result.status !== "absent") return result;
      }
      return { status: "absent", source };
    } catch (error) {
      return {
        status: "unavailable",
        source,
        diagnostic: diagnostic(error)
      };
    }
  }

  return {
    assertWorkspaceSource,
    read,
    readFile: (source, repoPath) => readText(source, repoPath, false),
    stage: (selection) => {
      let revisionProved = false;
      return stageGraphArtifacts(selection, {
        async readBytes(source, repoPath) {
          const result = await readBytes(source, repoPath, revisionProved);
          if (result.status !== "unavailable") revisionProved = true;
          return result;
        },
        stagingRoot: options.stagingRoot,
        diagnostic: options.diagnostic,
        redactDiagnostic: options.redactDiagnostic
      });
    }
  };
}
