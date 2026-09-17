import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createGitHubSourceHost } from "./github-source.js";

it.each([
  { count: 256, size: 0 },
  { count: 1, size: 1024 * 1024 },
  { count: 16, size: 1024 * 1024 }
])(
  "accepts the documented file-count and exact-byte upper bounds",
  async ({ count, size }) => {
    const root = await mkdtemp(resolve(".test-discovery-github-limits-"));
    const commit = "a".repeat(40);
    const tree = "b".repeat(40);
    const bytes = Buffer.alloc(size, " ");
    const sha = createHash("sha1")
      .update(`blob ${size}\0`)
      .update(bytes)
      .digest("hex");
    let sequence = 0;
    const host = createGitHubSourceHost({
      storageRoot: join(root, "snapshots"),
      clock: { now: () => "2026-09-15T00:00:00Z" },
      ids: { next: () => `id-${++sequence}` },
      get: async (path) => {
        if (path.includes("/commits/"))
          return portSuccess({ sha: commit, commit: { tree: { sha: tree } } });
        if (path.includes("/git/trees/"))
          return portSuccess({
            sha: tree,
            truncated: false,
            tree: Array.from({ length: count }, (_, index) => ({
              path: index === 0 ? "app.bicep" : `${index}.txt`,
              type: "blob",
              mode: "100644",
              sha,
              size
            }))
          });
        if (path.includes("/contents/"))
          return portSuccess({
            sha,
            encoding: "base64",
            content: bytes.toString("base64")
          });
        throw new Error(`Unmodeled read ${path}`);
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
          source: { kind: "git", ref: commit, expectedCommit: commit }
        },
        {
          requestId: "read",
          cancellation: { aborted: false, onAbort: () => () => {} }
        }
      );
      expect(result).toMatchObject({
        status: "ok",
        value: { status: "captured" }
      });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
it("keeps concurrent capture authority separate even when callers reuse a request ID", async () => {
  const root = await mkdtemp(resolve(".test-discovery-github-concurrency-"));
  let sequence = 0;
  const host = createGitHubSourceHost({
    storageRoot: join(root, "snapshots"),
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { next: () => `id-${++sequence}` },
    get: async (path, _control, scope) => {
      const marker = path.includes("a".repeat(40)) ? "a" : "b";
      expect(scope.principalRef).toBe(`reader-${marker}`);
      const bytes = Buffer.from(`param value string = '${marker}'\n`);
      const sha = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (path.includes("/commits/"))
        return portSuccess({
          sha: marker.repeat(40),
          commit: { tree: { sha: marker.repeat(40) } }
        });
      if (path.includes("/git/trees/"))
        return portSuccess({
          sha: marker.repeat(40),
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
      if (path.includes("/contents/"))
        return portSuccess({
          sha,
          encoding: "base64",
          content: bytes.toString("base64")
        });
      throw new Error(`Unmodeled read ${path}`);
    }
  });
  const control = {
    requestId: "same",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  try {
    const captured = await Promise.all(
      ["a", "b"].map((marker) =>
        host.source.capture(
          {
            operation: "application.list",
            target: { repo: "owner/repo" },
            principalRef: `reader-${marker}`,
            authorizationRef: `auth-${marker}`
          },
          {
            repo: "owner/repo",
            definition: "app.bicep",
            source: {
              kind: "git",
              ref: marker.repeat(40),
              expectedCommit: marker.repeat(40)
            }
          },
          control
        )
      )
    );
    for (const [index, result] of captured.entries()) {
      expect(result).toMatchObject({
        status: "ok",
        value: { status: "captured" }
      });
      if (result.status !== "ok" || result.value.status !== "captured")
        throw new Error("Expected isolated capture");
      expect(
        await host.source.readText(result.value.snapshot, "app.bicep", control)
      ).toMatchObject({
        status: "ok",
        value: { text: `param value string = '${index === 0 ? "a" : "b"}'\n` }
      });
    }
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
