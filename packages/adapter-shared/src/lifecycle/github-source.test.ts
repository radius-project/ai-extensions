import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import {
  portForbidden,
  portSuccess,
  portUnavailable
} from "@radius-project/core/lifecycle";
import { createGitHubSourceHost } from "./github-source.js";

const text =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = { name: 'app' }\n";
const bytes = Buffer.from(text);
const scope = {
  operation: "application.list" as const,
  target: { repo: "owner/repo" },
  principalRef: "reader",
  authorizationRef: "auth"
};
const control = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};

it.each([
  "ok",
  "sha256",
  "absent",
  "forbidden",
  "network",
  "malformed",
  "truncated",
  "wrong-content"
] as const)(
  "captures exact GitHub source or preserves %s evidence without publication",
  async (kind) => {
    const algorithm = kind === "sha256" ? "sha256" : "sha1";
    const commit = "a".repeat(kind === "sha256" ? 64 : 40);
    const tree = "b".repeat(commit.length);
    const blob = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    const root = await mkdtemp(resolve(".test-discovery-github-source-"));
    let sequence = 0;
    const calls: string[] = [];
    const host = createGitHubSourceHost({
      storageRoot: join(root, "snapshots"),
      clock: { now: () => "2026-09-15T00:00:00Z" },
      ids: { next: () => `id-${++sequence}` },
      get: async (path) => {
        calls.push(path);
        if (path.includes("/commits/"))
          return portSuccess({ sha: commit, commit: { tree: { sha: tree } } });
        if (path.includes("/git/trees/"))
          return portSuccess({
            sha: tree,
            truncated: kind === "truncated",
            tree:
              kind === "absent" ?
                []
              : [
                  {
                    path: "app.bicep",
                    type: "blob",
                    mode: "100644",
                    sha: blob,
                    size: bytes.length
                  }
                ]
          });
        if (path.includes("/contents/")) {
          if (kind === "forbidden") return portForbidden();
          if (kind === "network")
            return portUnavailable("SOURCE_UNAVAILABLE", {
              quality: "unknown",
              completeness: "unavailable",
              evidence: "source"
            });
          if (kind === "malformed") return portSuccess({ encoding: "base64" });
          return portSuccess({
            sha: blob,
            encoding: "base64",
            content:
              kind === "wrong-content" ?
                Buffer.from("different").toString("base64")
              : bytes.toString("base64")
          });
        }
        throw new Error(`Unmodeled GitHub request: ${path}`);
      }
    });
    try {
      const source = await host.resolveSource(scope, "feature", control);
      if (source.status !== "ok") throw new Error("Expected resolved commit");
      const result = await host.source.capture(
        scope,
        {
          repo: scope.target.repo,
          definition: "app.bicep",
          source: source.value
        },
        control
      );
      if (kind === "ok" || kind === "sha256") {
        expect(result).toMatchObject({
          status: "ok",
          value: {
            status: "captured",
            snapshot: { provenance: { commit, kind: "git" } }
          }
        });
        if (result.status !== "ok" || result.value.status !== "captured")
          throw new Error("Expected snapshot");
        expect(
          await host.source.readText(
            result.value.snapshot,
            "app.bicep",
            control
          )
        ).toMatchObject({ status: "ok", value: { text } });
        expect(
          await host.source.releaseSnapshot(result.value.snapshot)
        ).toMatchObject({ status: "ok" });
      } else
        expect(result.status).toBe(
          kind === "absent" ? "absent"
          : kind === "forbidden" ? "forbidden"
          : kind === "network" || kind === "truncated" ? "unavailable"
          : "failed"
        );
      expect(
        calls
          .filter((path) => path.includes("/contents/"))
          .every((path) => path.endsWith(`?ref=${commit}`))
      ).toBe(true);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
