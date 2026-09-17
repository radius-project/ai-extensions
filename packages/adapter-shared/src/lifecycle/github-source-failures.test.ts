import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { portForbidden, portSuccess } from "@radius-project/core/lifecycle";
import { createGitHubSourceHost } from "./github-source.js";

it.each([
  "resolve-denied",
  "materialize-denied",
  "materialize-moved",
  "tree-denied",
  "noncanonical-content",
  "workspace-denied"
] as const)(
  "preserves %s outcomes at the real immutable source boundary",
  async (stage) => {
    const root = await mkdtemp(resolve(".test-discovery-source-failure-"));
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const bytes = Buffer.from("param value string\n");
    const sha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    let sequence = 0;
    const host = createGitHubSourceHost({
      storageRoot: join(root, "snapshots"),
      clock: { now: () => "2026-09-15T00:00:00Z" },
      ids: { next: () => `id-${++sequence}` },
      get: async (path) => {
        if (path.endsWith("/commits/feature")) {
          if (stage === "resolve-denied") return portForbidden();
          return portSuccess({ sha: commit, commit: { tree: { sha: tree } } });
        }
        if (path.endsWith(`/commits/${commit}`)) {
          if (stage === "materialize-denied") return portForbidden();
          return portSuccess({
            sha: stage === "materialize-moved" ? "c".repeat(40) : commit,
            commit: { tree: { sha: tree } }
          });
        }
        if (path.includes("/git/trees/")) {
          if (stage === "tree-denied") return portForbidden();
          return portSuccess({
            sha: tree,
            truncated: false,
            tree: [
              {
                path: "app.bicep",
                type: "blob",
                mode: "100644",
                sha,
                size: bytes.length
              }
            ]
          });
        }
        if (path.includes("/contents/"))
          return portSuccess({
            sha,
            encoding: "base64",
            content: `${bytes.toString("base64")}=`
          });
        throw new Error("Unmodeled immutable source request");
      }
    });
    try {
      const result = await host.source.capture(
        {
          operation: "application.list",
          target: { repo: "owner/repo" },
          principalRef: "reader",
          authorizationRef: "auth"
        },
        {
          repo: "owner/repo",
          definition: "app.bicep",
          source:
            stage === "workspace-denied" ?
              {
                kind: "workspace",
                workspaceRef: "workspace",
                branch: "feature",
                expectedFingerprint: `sha256:${"d".repeat(64)}`
              }
            : { kind: "git", ref: "feature", expectedCommit: commit }
        },
        {
          requestId: "read",
          cancellation: { aborted: false, onAbort: () => () => {} }
        }
      );
      expect(result).toMatchObject({
        status: stage.endsWith("denied") ? "forbidden" : "failed",
        error: {
          code:
            stage.endsWith("denied") ? "FORBIDDEN"
            : stage === "materialize-moved" ? "SOURCE_CHANGED"
            : "EVIDENCE_MISMATCH"
        }
      });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
