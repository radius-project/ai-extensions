import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { createRequestContext } from "../../../src/server/request-context.js";
import { handleListApplications } from "../../../src/server/routes/deployments.js";
import { handleListEnvironments } from "../../../src/server/routes/environments.js";
import { createLegacyDiscoveryReader } from "../../../src/server/services/discovery-reader.js";
import { createEnvironmentListingCache } from "../../../src/server/services/environment-listing-cache.js";

async function harness(
  mode:
    | "ok"
    | "missing"
    | "forbidden"
    | "network"
    | "malformed"
    | "variables"
    | "partial"
    | "both"
    | "listing-forbidden"
    | "listing-network"
    | "listing-malformed"
    | "pending"
) {
  const root = await mkdtemp(resolve(".test-discovery-http-"));
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const bytes = Buffer.from(
    "resource app 'Radius.Core/applications@2025-08-01-preview' = { name: 'app' }\n"
  );
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const nestedBytes = Buffer.from(
    "resource app 'Radius.Core/applications@2025-08-01-preview' = { name: 'nested-app' }\n"
  );
  const nestedSha = createHash("sha1")
    .update(`blob ${nestedBytes.length}\0`)
    .update(nestedBytes)
    .digest("hex");
  let sequence = 0;
  let login = "reader";
  let visible = true;
  let syncs = 0;
  const calls: string[][] = [];
  const pending = new Set<Promise<void>>();
  let markEntered: () => void = () => {
    throw new Error("Read signal not initialized");
  };
  let markStopped: () => void = () => {
    throw new Error("Stop signal not initialized");
  };
  const entered = new Promise<void>((done) => {
    markEntered = done;
  });
  const stopped = new Promise<void>((done) => {
    markStopped = done;
  });
  const discovery = createLegacyDiscoveryReader({
    storageRoot: join(root, "snapshots"),
    clock: { now: () => "2026-09-15T00:00:00Z" },
    ids: { next: () => `id-${++sequence}` },
    identity: async () => ({ actingLogin: login }),
    workspace: async () => ({
      repo: "owner/repo",
      branch: "feature",
      workspacePath: root
    }),
    git: async () => {
      throw new Error("HTTP branch reads must use the explicit GitHub commit");
    },
    executor: async (selected) => ({
      login: selected,
      run: async (args, options) => {
        calls.push(args);
        const path = args.find((arg) => arg.startsWith("/repos/"));
        let value: unknown;
        if (path === "/repos/owner/repo") {
          if (!visible) return { code: 1, stdout: "", stderr: "HTTP 403" };
          value = { full_name: "owner/repo" };
        } else if (path?.includes("/commits/"))
          value = { sha: commit, commit: { tree: { sha: tree } } };
        else if (path?.includes("/git/trees/"))
          value = {
            sha: tree,
            truncated: false,
            tree:
              mode === "missing" ?
                []
              : [
                  ...(mode === "both" ?
                    [
                      {
                        path: ".radius",
                        type: "tree",
                        mode: "040000",
                        sha: tree
                      },
                      {
                        path: ".radius/app.bicep",
                        type: "blob",
                        mode: "100644",
                        sha: nestedSha,
                        size: nestedBytes.length
                      }
                    ]
                  : []),
                  {
                    path: "app.bicep",
                    type: "blob",
                    mode: "100644",
                    sha,
                    size: bytes.length
                  }
                ]
          };
        else if (path?.includes("/contents/")) {
          const nested = mode === "both" && path.includes("/contents/.radius/");
          const selectedBytes = nested ? nestedBytes : bytes;
          const selectedSha = nested ? nestedSha : sha;
          expect(path).toBe(
            `/repos/owner/repo/contents/${nested ? ".radius/" : ""}app.bicep?ref=${commit}`
          );
          if (mode === "forbidden" || mode === "network")
            return {
              code: 1,
              stdout: "",
              stderr: mode === "forbidden" ? "HTTP 403" : "Connection failed"
            };
          if (mode === "pending") {
            markEntered();
            return new Promise((done) =>
              options?.signal?.addEventListener(
                "abort",
                () => {
                  markStopped();
                  done({ code: 1, stdout: "", stderr: "Cancelled read" });
                },
                { once: true }
              )
            );
          }
          value =
            mode === "malformed" ?
              { content: 3 }
            : {
                sha: selectedSha,
                encoding: "base64",
                content: selectedBytes.toString("base64")
              };
        } else if (args.includes("--jq")) {
          return { code: 0, stdout: "", stderr: "" };
        } else if (path?.includes("/environments?")) {
          if (mode === "listing-forbidden" || mode === "listing-network")
            return {
              code: 1,
              stdout: "",
              stderr:
                mode === "listing-forbidden" ? "HTTP 403" : "Connection failed"
            };
          value = {
            environments:
              mode === "listing-malformed" ? null
              : mode === "partial" ? [{ name: "dev" }, { name: "other" }]
              : [{ name: "dev" }]
          };
        } else if (path?.includes("/variables")) {
          if (
            mode === "variables" ||
            (mode === "partial" && path.includes("/dev/"))
          )
            return { code: 1, stdout: "", stderr: "HTTP 403" };
          value = {
            variables: [
              { name: "RADIUS_MANAGED", value: "true" },
              { name: "AZURE_CLIENT_ID", value: "client" }
            ]
          };
        } else if (path?.endsWith("/environments/dev"))
          value = { name: "dev", id: 1, protection_rules: [] };
        else if (path?.endsWith("/environments/other"))
          value = { name: "other", id: 2, protection_rules: [] };
        else throw new Error(`Unmodeled command ${args.join(" ")}`);
        return { code: 0, stdout: JSON.stringify(value), stderr: "" };
      }
    })
  });
  const cache = createEnvironmentListingCache();
  const server = createServer((request, response) => {
    const context = createRequestContext(request, response, "panel", new Map());
    const promise =
      context.pathname === "/api/list-applications" ?
        handleListApplications(context, {
          discovery,
          readInstanceEntry: () => ({ state: { contextBranch: "feature" } })
        })
      : handleListEnvironments(context, {
          discovery,
          activeDeleteEnvironment: () => "",
          envListCacheGet: cache.get,
          envListCacheGeneration: cache.generation,
          envListCacheSet: cache.set,
          envListTtlMs: 1000,
          now: () => 0,
          redactDiagnostic: (value) => value,
          errorMessage: (error) => String(error),
          readInstanceEntry: () => undefined,
          repoMatchesWorkspace: () => false,
          kickoffWorkflowSync: () => {
            syncs++;
          }
        });
    const task = promise
      .catch(() => {
        response.destroy();
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  return {
    base: `http://127.0.0.1:${address.port}`,
    calls,
    entered,
    stopped,
    cache,
    setLogin: (next: string) => {
      login = next;
    },
    setVisible: (next: boolean) => {
      visible = next;
    },
    syncs: () => syncs,
    async close() {
      server.closeAllConnections();
      await Promise.allSettled(pending);
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done()))
      );
      await rm(root, { recursive: true, force: true });
    }
  };
}

it.each([
  "ok",
  "both",
  "missing",
  "forbidden",
  "network",
  "malformed"
] as const)(
  "projects %s application evidence from real composition and controlled GitHub commands",
  async (mode) => {
    const h = await harness(mode);
    try {
      const response = await fetch(
        `${h.base}/api/list-applications?repo=owner/repo`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const value: unknown = await response.json();
      if (mode === "ok")
        expect(value).toEqual({ applications: [{ name: "app" }] });
      else if (mode === "both")
        expect(value).toEqual({
          applications: [{ name: "nested-app" }],
          error:
            "Multiple authored definitions are available through radius_lifecycle; this legacy picker displays the first canonical application only."
        });
      else if (mode === "missing") expect(value).toEqual({ applications: [] });
      else
        expect(value).toMatchObject({
          applications: [{ name: "repo" }],
          error: expect.stringContaining(
            mode === "forbidden" ? "FORBIDDEN"
            : mode === "malformed" ? "EVIDENCE_MISMATCH"
            : "RESULT_UNAVAILABLE"
          )
        });
      expect(h.calls.every((args) => args.includes("GET"))).toBe(true);
    } finally {
      await h.close();
    }
  }
);
it.each(["listing-forbidden", "listing-network", "listing-malformed"] as const)(
  "maps %s from the real repository-environment listing boundary",
  async (mode) => {
    const h = await harness(mode);
    try {
      const response = await fetch(
        `${h.base}/api/list-environments?repo=owner/repo`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        environments: [],
        error: expect.stringContaining(
          mode === "listing-forbidden" ? "FORBIDDEN"
          : mode === "listing-network" ? "RESULT_UNAVAILABLE"
          : "EVIDENCE_MISMATCH"
        )
      });
      expect(h.cache.get("owner/repo")).toBeUndefined();
      expect(h.syncs()).toBe(0);
    } finally {
      await h.close();
    }
  }
);
it.each(["variables", "partial"] as const)(
  "projects %s metadata unavailability without hiding it or caching incomplete rows",
  async (mode) => {
    const h = await harness(mode);
    try {
      const response = await fetch(
        `${h.base}/api/list-environments?repo=owner/repo`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        environments:
          mode === "variables" ?
            []
          : [{ name: "other", provider: "azure", status: "pending" }],
        error: expect.stringContaining("FORBIDDEN")
      });
      expect(h.cache.get("owner/repo")).toBeUndefined();
      expect(h.syncs()).toBe(0);
    } finally {
      await h.close();
    }
  }
);
it("returns an error-bearing legacy application label when repository visibility is denied", async () => {
  const h = await harness("ok");
  h.setVisible(false);
  try {
    const response = await fetch(
      `${h.base}/api/list-applications?repo=owner/repo`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      applications: [{ name: "repo" }],
      error: expect.stringContaining("FORBIDDEN")
    });
    expect(
      h.calls.map((args) => args.find((arg) => arg.startsWith("/repos/")))
    ).toEqual(["/repos/owner/repo"]);
  } finally {
    await h.close();
  }
});
it("cancels private source work when the loopback client disconnects", async () => {
  const h = await harness("pending");
  const abort = new AbortController();
  try {
    const request = fetch(`${h.base}/api/list-applications?repo=owner/repo`, {
      signal: abort.signal
    });
    const rejected = expect(request).rejects.toMatchObject({
      name: "AbortError"
    });
    await h.entered;
    abort.abort();
    await rejected;
    await h.stopped;
  } finally {
    abort.abort();
    await h.close();
  }
});
it("revalidates repository visibility before cache hits and isolates cached rows by reader identity", async () => {
  const h = await harness("ok");
  try {
    const url = `${h.base}/api/list-environments?repo=owner/repo`;
    expect(await (await fetch(url)).json()).toMatchObject({
      environments: [{ name: "dev", provider: "azure" }]
    });
    const first = h.calls.length;
    await fetch(url);
    expect(h.calls.length).toBe(first + 1);
    h.setVisible(false);
    expect(await (await fetch(url)).json()).toMatchObject({
      environments: [],
      error: expect.stringContaining("FORBIDDEN")
    });
    expect(h.calls.length).toBe(first + 2);
    h.setVisible(true);
    h.setLogin("other");
    await fetch(url);
    expect(h.calls.length).toBeGreaterThan(first + 3);
    h.cache.invalidate("owner/repo");
    expect(h.cache.get("owner/repo")).toBeUndefined();
  } finally {
    await h.close();
  }
});
