import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  buildEffectiveInputManifest,
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type AuthorizedScope,
  type ClockPort,
  type IdPort,
  type PortResult,
  type ReadResult,
  type RequestControl,
  type SourceOperation,
  type SourceSelection
} from "@radius-project/core/lifecycle";
import { collectSourceInputs } from "./source-access-closure.js";
import {
  canonicalSourceRoot,
  SourceAccessFault
} from "./source-access-files.js";
import {
  createSourceReadAdapter,
  nodeSourceFileSystem,
  type SourceGitPort
} from "./source-access.js";
import type { SourceFileSystem } from "./source-access.js";

export interface WorkspaceSourceDependencies {
  files?: SourceFileSystem;
  storageRoot: string;
  workspace(): Promise<{ repo: string; workspacePath: string; branch: string }>;
  authorize(
    scope: AuthorizedScope<SourceOperation>,
    control: RequestControl
  ): Promise<PortResult<void>>;
  git(root: string, args: string[], control: RequestControl): Promise<string>;
  clock: Pick<ClockPort, "now">;
  ids: IdPort;
}
const remoteUnavailable = () =>
  portUnavailable(
    "SOURCE_UNAVAILABLE",
    {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "source",
      limitation:
        "This discovery context supports the attached worktree only; remote materialization is unavailable."
    },
    {
      diagnostics: [
        {
          message:
            "Remote source discovery is not supported by this workspace context.",
          truncated: false
        }
      ]
    }
  );

export function createWorkspaceGitPort(
  git: WorkspaceSourceDependencies["git"]
): SourceGitPort {
  return {
    async workspaceState(root, control) {
      const branch = (
        await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], control)
      ).trim();
      const commit = (await git(root, ["rev-parse", "HEAD"], control)).trim();
      return portSuccess({ branch, commit });
    },
    resolveCommit: async () => remoteUnavailable(),
    materializeCommit: async () => remoteUnavailable(),
    readCommit: async (root, control) =>
      portSuccess((await git(root, ["rev-parse", "HEAD"], control)).trim())
  };
}

export function createWorkspaceSourceHost(deps: WorkspaceSourceDependencies) {
  if (
    [
      deps?.workspace,
      deps?.authorize,
      deps?.git,
      deps?.clock?.now,
      deps?.ids?.next
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Workspace source reads require trusted context, authorization, Git, clock and IDs."
    );
  const workspaceRef = deps.ids.next("revision");
  const files = deps.files ?? nodeSourceFileSystem;
  const limits = {
    maxFiles: 256,
    maxFileBytes: 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024
  };
  let closed = false;
  const source = createSourceReadAdapter({
    ...deps,
    files,
    limits,
    git: createWorkspaceGitPort(deps.git),
    authority: {
      async resolve(scope, selection, control) {
        if (closed || control.cancellation.aborted)
          return portCancelled("request_cancelled");
        const authorized = await deps.authorize(scope, control);
        if (authorized.status !== "ok") return authorized;
        if (selection.source.kind !== "workspace") return remoteUnavailable();
        const workspace = await deps.workspace();
        if (
          selection.repo.toLowerCase() !== workspace.repo.toLowerCase() ||
          selection.source.workspaceRef !== workspaceRef
        )
          return portForbidden();
        return portSuccess({
          kind: "workspace",
          repo: workspace.repo,
          workspaceRef,
          rootPath: workspace.workspacePath
        });
      }
    }
  });
  async function resolveSelection(
    scope: AuthorizedScope<SourceOperation>,
    definition: string | undefined,
    control: RequestControl
  ): Promise<ReadResult<SourceSelection>> {
    const cancellation = {
      get aborted() {
        return closed || control.cancellation.aborted;
      }
    };
    if (closed || control.cancellation.aborted)
      return portCancelled("request_cancelled");
    try {
      const authorized = await deps.authorize(scope, control);
      if (authorized.status !== "ok") return authorized;
      const workspace = await deps.workspace();
      if (scope.target.repo.toLowerCase() !== workspace.repo.toLowerCase())
        return portForbidden();
      const root = await canonicalSourceRoot(files, workspace.workspacePath);
      for (const path of definition ?
        [definition]
      : [".radius/app.bicep", "app.bicep"]) {
        const collected = await collectSourceInputs(
          files,
          root,
          path,
          limits,
          cancellation
        );
        if (closed || control.cancellation.aborted)
          return portCancelled("request_cancelled");
        if (!collected.definitionPresent) continue;
        const manifest = buildEffectiveInputManifest(
          {
            definition: path,
            inputs: collected.inputs,
            closure: collected.complete ? "complete" : "incomplete"
          },
          (bytes) =>
            `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          cancellation
        );
        if (manifest.status !== "ok") return manifest;
        if (manifest.value.completeness !== "complete")
          return portUnavailable(
            "SOURCE_UNAVAILABLE",
            {
              quality: "unknown",
              completeness: "partial",
              evidence: "source",
              limitation: "The static effective-input closure is incomplete."
            },
            { diagnostics: manifest.value.diagnostics }
          );
        return portSuccess({
          repo: workspace.repo,
          definition: path,
          source: {
            kind: "workspace",
            workspaceRef,
            branch: workspace.branch,
            expectedFingerprint: manifest.value.fingerprint
          }
        });
      }
      return portAbsent({
        quality: "current",
        completeness: "complete",
        evidence: "source",
        observedAt: deps.clock.now()
      });
    } catch (error) {
      return error instanceof SourceAccessFault ?
          error.result
        : portUnavailable("SOURCE_UNAVAILABLE", {
            quality: "unknown",
            completeness: "unavailable",
            evidence: "source"
          });
    }
  }
  return {
    resolveSelection,
    source: {
      ...source,
      async capture(...args: Parameters<typeof source.capture>) {
        if (closed || args[2].cancellation.aborted)
          return portCancelled("request_cancelled");
        try {
          await mkdir(deps.storageRoot, { recursive: true, mode: 0o700 });
          return await source.capture(...args);
        } catch {
          return portFailure("PRECONDITION_FAILED");
        }
      }
    },
    async close() {
      closed = true;
      return source.close();
    }
  };
}
