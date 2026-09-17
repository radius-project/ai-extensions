import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  commitSchema,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  validateSourcePath,
  type AuthorizedScope,
  type IdPort,
  type PortResult,
  type RequestControl,
  type Source,
  type SourceOperation
} from "@radius-project/core/lifecycle";
import {
  createSourceReadAdapter,
  type AuthorizedRemoteSource
} from "./source-access.js";
import {
  nodeSourceFileSystem,
  writeSourceFile,
  SourceAccessFault,
  checkSourceCancellation
} from "./source-access-files.js";
import { readObject, type GitHubDiscoveryRead } from "./environment-read.js";

export function createGitHubSourceHost(
  deps: GitHubDiscoveryRead & { ids: IdPort; storageRoot: string }
) {
  if (
    [deps?.get, deps?.clock?.now, deps?.ids?.next].some(
      (method) => typeof method !== "function"
    )
  )
    throw new Error(
      "GitHub source requires authenticated reads, clock and IDs."
    );
  const exactCommit = new RegExp(commitSchema.pattern);
  let scopes = new WeakMap<
    RequestControl,
    { accessRef: string; scope: AuthorizedScope<SourceOperation> }
  >();
  let roots = new WeakMap<RequestControl, { commit: string; root: string }>();
  let closed = false;
  const limitation =
    "GitHub source materialization requires a complete tree of at most 256 regular files, 1 MiB each and 16 MiB total.";
  const unavailable = () =>
    portUnavailable(
      "SOURCE_UNAVAILABLE",
      {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "source",
        limitation
      },
      { diagnostics: [{ message: limitation, truncated: false }] }
    );
  async function commitInfo(
    scope: AuthorizedScope,
    ref: string,
    control: RequestControl
  ) {
    const result = await deps.get(
      `/repos/${scope.target.repo}/commits/${encodeURIComponent(ref)}`,
      control,
      scope
    );
    if (result.status !== "ok") return result;
    const value = result.value;
    if (
      !readObject(value) ||
      typeof value.sha !== "string" ||
      !exactCommit.test(value.sha) ||
      !readObject(value.commit) ||
      !readObject(value.commit.tree) ||
      typeof value.commit.tree.sha !== "string" ||
      !exactCommit.test(value.commit.tree.sha)
    )
      return portFailure("EVIDENCE_MISMATCH");
    return portSuccess({ commit: value.sha, tree: value.commit.tree.sha });
  }
  function scopeFor(source: AuthorizedRemoteSource, control: RequestControl) {
    const bound = scopes.get(control);
    if (
      !bound ||
      bound.accessRef !== source.accessRef ||
      bound.scope.target.repo !== source.repo
    )
      throw new SourceAccessFault(portForbidden());
    return bound.scope;
  }
  const adapter = createSourceReadAdapter({
    ...deps,
    files: nodeSourceFileSystem,
    limits: {
      maxFiles: 256,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024
    },
    authority: {
      resolve: async (scope, selection, control) => {
        if (
          selection.source.kind !== "git" ||
          selection.repo !== scope.target.repo
        )
          return portForbidden();
        const accessRef = deps.ids.next("revision");
        scopes.set(control, { accessRef, scope });
        return portSuccess({ kind: "git", repo: selection.repo, accessRef });
      }
    },
    git: {
      workspaceState: async () => unavailable(),
      resolveCommit: async (source, ref, control) => {
        const result = await commitInfo(
          scopeFor(source, control),
          ref,
          control
        );
        return result.status === "ok" ?
            portSuccess(result.value.commit)
          : result;
      },
      materializeCommit: async (source, commit, destination, control) => {
        const scope = scopeFor(source, control);
        const info = await commitInfo(scope, commit, control);
        if (info.status !== "ok") return info;
        if (info.value.commit !== commit) return portFailure("SOURCE_CHANGED");
        const result = await deps.get(
          `/repos/${source.repo}/git/trees/${info.value.tree}?recursive=1`,
          control,
          scope
        );
        if (result.status !== "ok") return result;
        const tree = result.value;
        if (
          !readObject(tree) ||
          tree.sha !== info.value.tree ||
          typeof tree.truncated !== "boolean" ||
          !Array.isArray(tree.tree)
        )
          return portFailure("EVIDENCE_MISMATCH");
        if (tree.truncated) return unavailable();
        const files: { path: string; sha: string; size: number }[] = [];
        const paths = new Set<string>();
        let total = 0;
        for (const entry of tree.tree) {
          if (
            !readObject(entry) ||
            typeof entry.path !== "string" ||
            validateSourcePath(entry.path).status !== "ok"
          )
            return portFailure("EVIDENCE_MISMATCH");
          const normalized = entry.path.normalize("NFC").toLowerCase();
          if (paths.has(normalized)) return portFailure("EVIDENCE_MISMATCH");
          paths.add(normalized);
          if (entry.type === "tree") continue;
          if (entry.type !== "blob") return unavailable();
          if (typeof entry.mode !== "string")
            return portFailure("EVIDENCE_MISMATCH");
          if (!["100644", "100755"].includes(entry.mode)) return unavailable();
          if (
            typeof entry.sha !== "string" ||
            !exactCommit.test(entry.sha) ||
            typeof entry.size !== "number" ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0
          )
            return portFailure("EVIDENCE_MISMATCH");
          total += entry.size;
          if (
            files.length >= 256 ||
            entry.size > 1024 * 1024 ||
            total > 16 * 1024 * 1024
          )
            return unavailable();
          files.push({ path: entry.path, sha: entry.sha, size: entry.size });
        }
        for (const file of files) {
          checkSourceCancellation(control.cancellation);
          const content = await deps.get(
            `/repos/${source.repo}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`,
            control,
            scope
          );
          if (content.status !== "ok") return content;
          const value = content.value;
          if (
            !readObject(value) ||
            value.sha !== file.sha ||
            value.encoding !== "base64" ||
            typeof value.content !== "string"
          )
            return portFailure("EVIDENCE_MISMATCH");
          if (value.content.length > 2 * 1024 * 1024)
            return portFailure("EVIDENCE_MISMATCH");
          const encoded = value.content.replace(/\s/g, "");
          const bytes = Buffer.from(encoded, "base64");
          if (
            bytes.length !== file.size ||
            bytes.toString("base64") !== encoded ||
            createHash(file.sha.length === 40 ? "sha1" : "sha256")
              .update(`blob ${bytes.length}\0`)
              .update(bytes)
              .digest("hex") !== file.sha
          )
            return portFailure("EVIDENCE_MISMATCH");
          checkSourceCancellation(control.cancellation);
          await writeSourceFile(
            nodeSourceFileSystem,
            destination,
            file.path,
            bytes
          );
        }
        roots.set(control, { commit, root: destination });
        return portSuccess(undefined);
      },
      readCommit: async (root, control) => {
        const value = roots.get(control);
        return value?.root === root ?
            portSuccess(value.commit)
          : portFailure("EVIDENCE_MISMATCH");
      }
    }
  });
  return {
    source: {
      ...adapter,
      async capture(...args: Parameters<typeof adapter.capture>) {
        if (closed || args[2].cancellation.aborted)
          return portCancelled("request_cancelled");
        try {
          await mkdir(deps.storageRoot, { recursive: true, mode: 0o700 });
          return await adapter.capture(...args);
        } catch {
          return portFailure("PRECONDITION_FAILED");
        }
      }
    },
    async resolveSource(
      scope: AuthorizedScope<SourceOperation>,
      ref: string,
      control: RequestControl
    ): Promise<PortResult<Source>> {
      if (closed || control.cancellation.aborted)
        return portCancelled("request_cancelled");
      const result = await commitInfo(scope, ref, control);
      return result.status === "ok" ?
          portSuccess({ kind: "git", ref, expectedCommit: result.value.commit })
        : result;
    },
    async close() {
      closed = true;
      const result = await adapter.close();
      scopes = new WeakMap();
      roots = new WeakMap();
      return result;
    }
  };
}
