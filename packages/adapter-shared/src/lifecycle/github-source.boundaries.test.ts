import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { portSuccess, portForbidden } from "@radius-project/core/lifecycle";
import { createGitHubSourceHost } from "./github-source.js";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const body = Buffer.from("param value string\n");
const sha = createHash("sha1")
  .update(`blob ${body.length}\0`)
  .update(body)
  .digest("hex");
const entry = {
  path: "app.bicep",
  type: "blob",
  mode: "100644",
  sha,
  size: body.length
};
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
function fixture(
  root: string,
  options: {
    commit?: unknown;
    tree?: unknown;
    content?: unknown;
    denied?: boolean;
    storageRoot?: string;
  } = {}
) {
  let sequence = 0;
  return createGitHubSourceHost({
    storageRoot: options.storageRoot ?? join(root, "snapshots"),
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { next: () => `id-${++sequence}` },
    get: async (path) => {
      if (options.denied) return portForbidden();
      if (path.includes("/commits/"))
        return portSuccess(
          Object.hasOwn(options, "commit") ?
            options.commit
          : { sha: commit, commit: { tree: { sha: tree } } }
        );
      if (path.includes("/git/trees/"))
        return portSuccess(
          Object.hasOwn(options, "tree") ?
            options.tree
          : { sha: tree, truncated: false, tree: [entry] }
        );
      if (path.includes("/contents/"))
        return portSuccess(
          Object.hasOwn(options, "content") ?
            options.content
          : { sha, encoding: "base64", content: body.toString("base64") }
        );
      throw new Error(`Unmodeled read ${path}`);
    }
  });
}
it.each([
  { commit: null },
  { commit: {} },
  { commit: { sha: "invalid" } },
  { commit: { sha: commit, commit: {} } },
  { commit: { sha: commit, commit: { tree: { sha: "invalid" } } } },
  { denied: true }
])(
  "rejects unavailable or malformed commit identity before materialization",
  async (options) => {
    const root = await mkdtemp(resolve(".test-discovery-github-boundary-"));
    const host = fixture(root, options);
    try {
      expect(
        (await host.resolveSource(scope, "feature", control)).status
      ).not.toBe("ok");
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
it.each([
  { value: null, status: "failed" },
  { value: { sha: "wrong", tree: [] }, status: "failed" },
  { value: { sha: tree, truncated: false, tree: [null] }, status: "failed" },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: [{ ...entry, path: "../escape" }]
    },
    status: "failed"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: [entry, { ...entry, path: "APP.bicep" }]
    },
    status: "failed"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: [{ ...entry, type: "commit" }]
    },
    status: "unavailable"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: [{ ...entry, mode: "120000" }]
    },
    status: "unavailable"
  },
  {
    value: { sha: tree, truncated: false, tree: [{ ...entry, mode: 100644 }] },
    status: "failed"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: [{ ...entry, sha: "invalid" }]
    },
    status: "failed"
  },
  {
    value: { sha: tree, truncated: false, tree: [{ ...entry, size: -1 }] },
    status: "failed"
  },
  {
    value: { sha: tree, truncated: false, tree: [{ ...entry, size: 1.5 }] },
    status: "failed"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: [{ ...entry, size: 1024 * 1024 + 1 }]
    },
    status: "unavailable"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: Array.from({ length: 257 }, (_, i) => ({
        ...entry,
        path: `${i}.txt`
      }))
    },
    status: "unavailable"
  },
  {
    value: {
      sha: tree,
      truncated: false,
      tree: Array.from({ length: 17 }, (_, i) => ({
        ...entry,
        path: `${i}.txt`,
        size: 1024 * 1024
      }))
    },
    status: "unavailable"
  }
])(
  "confines and bounds untrusted GitHub tree evidence",
  async ({ value, status }) => {
    const root = await mkdtemp(resolve(".test-discovery-github-boundary-"));
    const host = fixture(root, { tree: value });
    try {
      expect(
        (
          await host.source.capture(
            scope,
            {
              repo: "owner/repo",
              definition: "app.bicep",
              source: { kind: "git", ref: "feature", expectedCommit: commit }
            },
            control
          )
        ).status
      ).toBe(status);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
it.each([
  null,
  { sha, encoding: "none", content: "" },
  { sha: "wrong", encoding: "base64", content: body.toString("base64") },
  { sha, encoding: "base64", content: "x".repeat(2 * 1024 * 1024 + 1) },
  { sha, encoding: "base64", content: `${body.toString("base64")}!` }
])(
  "rejects malformed, oversized and noncanonical contents without a snapshot",
  async (content) => {
    const root = await mkdtemp(resolve(".test-discovery-github-boundary-"));
    const host = fixture(root, { content });
    try {
      expect(
        await host.source.capture(
          scope,
          {
            repo: "owner/repo",
            definition: "app.bicep",
            source: { kind: "git", ref: "feature", expectedCommit: commit }
          },
          control
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  }
);
it("refuses stale commits, cancellation, unavailable storage and closed source contexts", async () => {
  const root = await mkdtemp(resolve(".test-discovery-github-boundary-"));
  const host = fixture(root);
  const selection = {
    repo: "owner/repo",
    definition: "app.bicep",
    source: {
      kind: "git" as const,
      ref: "feature",
      expectedCommit: "c".repeat(40)
    }
  };
  try {
    expect(await host.source.capture(scope, selection, control)).toMatchObject({
      error: { code: "SOURCE_CHANGED" }
    });
    await host.close();
    expect(await host.source.capture(scope, selection, control)).toMatchObject({
      status: "cancelled"
    });
    expect(await host.resolveSource(scope, "feature", control)).toMatchObject({
      status: "cancelled"
    });
    const path = join(root, "blocked");
    await writeFile(path, "");
    const blocked = fixture(root, { storageRoot: path });
    try {
      expect(
        await blocked.source.capture(scope, selection, control)
      ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    } finally {
      await blocked.close();
    }
    expect(() =>
      Reflect.apply(createGitHubSourceHost, undefined, [{}])
    ).toThrow("requires");
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
