import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  BOOTSTRAP_ARTIFACT_TYPE,
  BOOTSTRAP_CONTENT,
  bootstrapGHCRStatePackage,
  loadGhKeyringCredentials,
  withGhcrDockerConfig
} from "./ghcr.js";
import type { FetchImplementation } from "./ghcr.js";

interface HarnessOptions {
  accountType?: string;
  initialMetadata?: {
    visibility: string;
    repository: { full_name: string } | null;
  } | null;
  finalVisibility?: string;
  finalRepository?: string | null;
  metadataDelay?: number;
  tokenStatus?: number;
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}

interface BootstrapManifest {
  artifactType?: string;
  layers?: Array<{
    digest?: string;
    mediaType?: string;
    size?: number;
    annotations?: Record<string, string>;
  }>;
  annotations?: Record<string, string>;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

function createHarness({
  accountType = "User",
  initialMetadata = null,
  finalVisibility = "private",
  finalRepository = "acme/app",
  metadataDelay = 0,
  tokenStatus = 200
}: HarnessOptions = {}) {
  const calls: FetchCall[] = [];
  const blobs = new Set<string>();
  let uploadID = 0;
  let manifest: BootstrapManifest | null = null;
  let manifestPushes = 0;
  let packageReadsAfterPush = 0;

  const fetchImpl: FetchImplementation = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || "GET";
    calls.push({
      url: url.toString(),
      method,
      headers: options.headers || {},
      body: options.body
    });

    if (url.origin === "https://api.test" && url.pathname === "/users/acme") {
      return json({ type: accountType });
    }
    if (
      url.origin === "https://api.test" &&
      url.pathname.includes("/packages/container/")
    ) {
      if (!manifestPushes) {
        return initialMetadata ?
            json(initialMetadata)
          : json({}, { status: 404 });
      }
      packageReadsAfterPush++;
      if (packageReadsAfterPush <= metadataDelay)
        return json({}, { status: 404 });
      return json({
        visibility: finalVisibility,
        repository: finalRepository ? { full_name: finalRepository } : null
      });
    }
    if (url.origin === "https://registry.test" && url.pathname === "/v2/") {
      return new Response("", {
        status: 401,
        headers: {
          "WWW-Authenticate":
            'Bearer realm="https://registry.test/token",service="ghcr.io"'
        }
      });
    }
    if (url.origin === "https://registry.test" && url.pathname === "/token") {
      if (tokenStatus !== 200)
        return json({ error: "denied" }, { status: tokenStatus });
      return json({ token: "registry-bearer" });
    }
    const blobMatch = url.pathname.match(/\/blobs\/(sha256:[a-f0-9]+)$/);
    if (
      url.origin === "https://registry.test" &&
      method === "HEAD" &&
      blobMatch
    ) {
      return new Response("", { status: blobs.has(blobMatch[1]) ? 200 : 404 });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "POST" &&
      url.pathname.endsWith("/blobs/uploads/")
    ) {
      uploadID++;
      return new Response("", {
        status: 202,
        headers: { Location: `https://registry.test/uploads/${uploadID}` }
      });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "PUT" &&
      url.pathname.startsWith("/uploads/")
    ) {
      const digest = url.searchParams.get("digest");
      const body = Buffer.from(options.body || "");
      assert.equal(
        `sha256:${createHash("sha256").update(body).digest("hex")}`,
        digest
      );
      if (digest) blobs.add(digest);
      return new Response("", { status: 201 });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "PUT" &&
      url.pathname.endsWith("/manifests/bootstrap")
    ) {
      manifest = JSON.parse(Buffer.from(options.body || "").toString("utf8"));
      manifestPushes++;
      return new Response("", { status: 201 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return {
    fetchImpl,
    calls,
    blobs,
    get manifest() {
      return manifest;
    },
    get manifestPushes() {
      return manifestPushes;
    }
  };
}

const baseOptions = {
  targetRepository: "acme/app",
  registry: "ghcr.io/acme/app-radius-state-dev-123456789abc",
  credentials: { username: "octocat", token: "keyring-token" },
  registryOrigin: "https://registry.test",
  apiBaseUrl: "https://api.test",
  sleep: async () => {}
};

test("pushes a deterministic linked bootstrap artifact and is idempotent", async () => {
  const harness = createHarness();

  const first = await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });
  const second = await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.deepEqual(first, {
    registry: baseOptions.registry,
    bootstrapTag: "bootstrap",
    visibility: "private"
  });
  assert.deepEqual(second, first);
  assert.equal(harness.blobs.size, 2);
  assert.equal(harness.manifestPushes, 2);
  assert.equal(
    harness.calls.filter((call) => call.method === "POST").length,
    2
  );
  const manifest = harness.manifest;
  assert.ok(manifest);
  assert.ok(manifest.annotations);
  assert.ok(manifest.layers);
  assert.equal(manifest.artifactType, BOOTSTRAP_ARTIFACT_TYPE);
  assert.equal(
    manifest.annotations["org.opencontainers.image.source"],
    "https://github.com/acme/app"
  );
  assert.equal(manifest.layers[0].mediaType, "text/plain");
  assert.equal(manifest.layers[0].size, Buffer.byteLength(BOOTSTRAP_CONTENT));
  const tokenCall = harness.calls.find(
    (call) => new URL(call.url).pathname === "/token"
  );
  assert.ok(tokenCall);
  assert.equal(
    tokenCall.headers.Authorization,
    `Basic ${Buffer.from("octocat:keyring-token").toString("base64")}`
  );
  assert.equal(
    new URL(tokenCall.url).searchParams.get("scope"),
    "repository:acme/app-radius-state-dev-123456789abc:pull,push"
  );
});

test("accepts an internal organization package and uses the organization endpoint", async () => {
  const harness = createHarness({
    accountType: "Organization",
    initialMetadata: {
      visibility: "internal",
      repository: { full_name: "acme/app" }
    },
    finalVisibility: "internal"
  });

  const result = await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.equal(result.visibility, "internal");
  assert.ok(
    harness.calls.some((call) =>
      new URL(call.url).pathname.startsWith("/orgs/acme/packages/")
    )
  );
});

test("retries package metadata until repository linkage is visible", async () => {
  const harness = createHarness({ metadataDelay: 2 });
  let sleeps = 0;

  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl,
    sleep: async () => {
      sleeps++;
    }
  });

  assert.equal(sleeps, 2);
});

test("rejects an existing public package before uploading", async () => {
  const harness = createHarness({
    initialMetadata: {
      visibility: "public",
      repository: { full_name: "acme/app" }
    }
  });

  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl: harness.fetchImpl }),
    /must be private or internal/
  );
  assert.equal(
    harness.calls.some(
      (call) => new URL(call.url).origin === "https://registry.test"
    ),
    false
  );
});

test("rejects a newly created package when GitHub reports public visibility", async () => {
  const harness = createHarness({ finalVisibility: "public" });

  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl: harness.fetchImpl }),
    /must be private or internal/
  );
  assert.equal(harness.manifestPushes, 1);
});

test("rejects a package linked to another repository before uploading", async () => {
  const harness = createHarness({
    initialMetadata: {
      visibility: "private",
      repository: { full_name: "acme/other" }
    }
  });

  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl: harness.fetchImpl }),
    /linked to "acme\/other"/
  );
  assert.equal(
    harness.calls.some(
      (call) => new URL(call.url).origin === "https://registry.test"
    ),
    false
  );
});

test("rejects a package whose source annotation never creates repository linkage", async () => {
  const harness = createHarness({ finalRepository: null });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl,
      metadataAttempts: 2
    }),
    /not linked to "acme\/app"/
  );
});

test("reports package-scope guidance when GHCR rejects token exchange", async () => {
  const harness = createHarness({ tokenStatus: 403 });

  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl: harness.fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /gh auth refresh --hostname github\.com --scopes read:packages,write:packages/
      );
      assert.doesNotMatch(error.message, /restore the previous/i);
      return true;
    }
  );
});

test("requires a stored gh keyring credential", async () => {
  const calls = [];
  await assert.rejects(
    loadGhKeyringCredentials({
      runKeyringCommand: async (args) => {
        calls.push(args);
        throw new Error("not logged in");
      }
    }),
    /stored GitHub CLI login/
  );
  assert.equal(calls.length, 2);
});

test("pins keyring credential lookup to github.com", async () => {
  const calls: string[][] = [];
  const credentials = await loadGhKeyringCredentials({
    runKeyringCommand: async (args) => {
      calls.push(args);
      return args[0] === "auth" ? "token" : "octocat";
    }
  });

  assert.deepEqual(credentials, { token: "token", username: "octocat" });
  assert.deepEqual(calls, [
    ["auth", "token", "--hostname", "github.com"],
    ["api", "--hostname", "github.com", "user", "--jq", ".login"]
  ]);
});

test("withGhcrDockerConfig hands rad a ghcr.io docker auth then removes it", async () => {
  const loadCredentials = async () => ({
    token: "ghp_secret",
    username: "octocat"
  });
  let seenDir = "";
  const result = await withGhcrDockerConfig(
    async (env) => {
      seenDir = env.DOCKER_CONFIG;
      const config = JSON.parse(
        readFileSync(path.join(seenDir, "config.json"), "utf8")
      );
      assert.equal(
        config.auths["ghcr.io"].auth,
        Buffer.from("octocat:ghp_secret").toString("base64")
      );
      return "published";
    },
    { loadCredentials }
  );

  assert.equal(result, "published");
  assert.ok(seenDir, "fn should receive a DOCKER_CONFIG directory");
  assert.equal(
    existsSync(seenDir),
    false,
    "temp docker config should be removed"
  );
});

test("withGhcrDockerConfig removes the temp docker config even when publish fails", async () => {
  const loadCredentials = async () => ({
    token: "ghp_secret",
    username: "octocat"
  });
  let seenDir = "";
  await assert.rejects(
    withGhcrDockerConfig(
      async (env) => {
        seenDir = env.DOCKER_CONFIG;
        throw new Error("publish denied");
      },
      { loadCredentials }
    ),
    /publish denied/
  );

  assert.ok(seenDir);
  assert.equal(
    existsSync(seenDir),
    false,
    "temp docker config should be removed on failure"
  );
});
