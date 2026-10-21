import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import type { FetchImplementation } from "../../src/ghcr-bootstrap.js";
type AmbiguousWrite =
  | "none"
  | "commit-then-throw"
  | "fail-then-succeed"
  | "always-fail"
  | "conflict-after-failure"
  | "conflict-before-write";
type SuccessIdentity = "exact" | "missing" | "wrong";

export interface HarnessOptions {
  accountType?: string;
  initialMetadata?: unknown;
  finalVisibility?: string;
  finalRepository?: string | null;
  finalMetadata?: unknown;
  metadataDelay?: number;
  ownerFailures?: Array<Error | { status: number; retryAfter?: string }>;
  tokenStatus?: number;
  tokenBody?: unknown;
  uploadLocation?: string | null;
  blobCompletionLocation?: string | null;
  manifestCompletionLocation?: string | null;
  blobAmbiguity?: AmbiguousWrite;
  manifestAmbiguity?: AmbiguousWrite;
  blobSuccessIdentity?: SuccessIdentity;
  manifestSuccessIdentity?: SuccessIdentity;
  initialManifestDigest?: string;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
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

export const wrongDigest = `sha256:${"f".repeat(64)}`;

export function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) }
  });
}

function identityHeaders(
  identity: SuccessIdentity,
  expectedDigest: string,
  location?: string | null
): Record<string, string> {
  return {
    ...(identity === "missing" ?
      {}
    : {
        "Docker-Content-Digest":
          identity === "exact" ? expectedDigest : wrongDigest
      }),
    ...(location ? { Location: location } : {})
  };
}

export function createHarness({
  accountType = "User",
  initialMetadata = null,
  finalVisibility = "private",
  finalRepository = "acme/app",
  finalMetadata,
  metadataDelay = 0,
  ownerFailures = [],
  tokenStatus = 200,
  tokenBody = { token: "registry-bearer" },
  uploadLocation = "https://registry.test/uploads/{id}",
  blobCompletionLocation,
  manifestCompletionLocation,
  blobAmbiguity = "none",
  manifestAmbiguity = "none",
  blobSuccessIdentity = "exact",
  manifestSuccessIdentity = "exact",
  initialManifestDigest
}: HarnessOptions = {}) {
  const calls: FetchCall[] = [];
  const blobs = new Set<string>();
  const pendingOwnerFailures = [...ownerFailures];
  let uploadID = 0;
  let blobPuts = 0;
  let manifest: BootstrapManifest | null = null;
  let manifestDigest = initialManifestDigest;
  let manifestPushes = 0;
  let packageReadsAfterPush = 0;

  const fetchImpl: FetchImplementation = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || "GET";
    calls.push({
      url: url.toString(),
      method,
      headers: options.headers || {},
      body: options.body,
      signal: options.signal
    });

    if (url.origin === "https://api.test" && url.pathname === "/users/acme") {
      const failure = pendingOwnerFailures.shift();
      if (failure) {
        if (failure instanceof Error) throw failure;
        return new Response("", {
          status: failure.status,
          headers:
            failure.retryAfter ? { "Retry-After": failure.retryAfter } : {}
        });
      }
      return json({ type: accountType });
    }
    if (
      url.origin === "https://api.test" &&
      url.pathname.includes("/packages/container/")
    ) {
      if (!manifestDigest && !manifestPushes) {
        return initialMetadata ?
            json(initialMetadata)
          : json({}, { status: 404 });
      }
      packageReadsAfterPush++;
      if (packageReadsAfterPush <= metadataDelay) {
        return json({}, { status: 404 });
      }
      return finalMetadata !== undefined ?
          json(finalMetadata)
        : json({
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
      if (tokenStatus !== 200) {
        return json({ error: "denied" }, { status: tokenStatus });
      }
      return json(tokenBody);
    }
    const blobMatch = url.pathname.match(/\/blobs\/(sha256:[a-f0-9]+)$/);
    if (
      url.origin === "https://registry.test" &&
      method === "HEAD" &&
      blobMatch
    ) {
      const blobDigest = blobMatch[1];
      return new Response("", {
        status: blobs.has(blobDigest) ? 200 : 404,
        headers:
          blobs.has(blobDigest) ? { "Docker-Content-Digest": blobDigest } : {}
      });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "GET" &&
      url.pathname.endsWith("/manifests/bootstrap")
    ) {
      return manifest ? json(manifest) : json({}, { status: 404 });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "POST" &&
      url.pathname.endsWith("/blobs/uploads/")
    ) {
      uploadID++;
      const location =
        uploadLocation === null ? undefined : (
          (uploadLocation || "").replace("{id}", String(uploadID))
        );

      return new Response("", {
        status: 202,
        headers: location ? { Location: location } : {}
      });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "PUT" &&
      url.pathname.startsWith("/uploads/")
    ) {
      blobPuts++;
      const expectedDigest = url.searchParams.get("digest");
      const body = Buffer.from(options.body || "");
      assert.equal(digest(body), expectedDigest);
      assert.ok(expectedDigest);
      if (blobPuts === 1 && blobAmbiguity === "commit-then-throw") {
        blobs.add(expectedDigest);
        throw new Error("connection reset after upload");
      }
      if (
        blobAmbiguity === "always-fail" ||
        (blobPuts === 1 && blobAmbiguity === "fail-then-succeed")
      ) {
        return new Response("", { status: 503 });
      }
      blobs.add(expectedDigest);
      return new Response("", {
        status: 201,
        headers: identityHeaders(
          blobSuccessIdentity,
          expectedDigest,
          blobCompletionLocation === undefined ?
            url.toString()
          : blobCompletionLocation
        )
      });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "HEAD" &&
      url.pathname.endsWith("/manifests/bootstrap")
    ) {
      return new Response("", {
        status: manifestDigest ? 200 : 404,
        headers:
          manifestDigest ? { "Docker-Content-Digest": manifestDigest } : {}
      });
    }
    if (
      url.origin === "https://registry.test" &&
      method === "PUT" &&
      url.pathname.endsWith("/manifests/bootstrap")
    ) {
      manifestPushes++;
      const body = Buffer.from(options.body || "");
      const expectedDigest = digest(body);
      const parsedManifest: BootstrapManifest = JSON.parse(
        body.toString("utf8")
      );

      if (
        manifestPushes === 1 &&
        manifestAmbiguity === "conflict-before-write"
      ) {
        manifest = {
          ...parsedManifest,
          annotations: {
            "org.opencontainers.image.source":
              "https://github.com/other/repository"
          }
        };
        manifestDigest = wrongDigest;
        return new Response("", { status: 412 });
      }
      if (manifestPushes === 1 && manifestAmbiguity === "commit-then-throw") {
        manifest = parsedManifest;
        manifestDigest = expectedDigest;
        throw new Error("connection reset after manifest");
      }
      if (manifestPushes === 1 && manifestAmbiguity === "fail-then-succeed") {
        return new Response("", { status: 503 });
      }
      if (manifestAmbiguity === "always-fail") {
        return new Response("", { status: 503 });
      }
      if (
        manifestPushes === 1 &&
        manifestAmbiguity === "conflict-after-failure"
      ) {
        manifestDigest = wrongDigest;
        return new Response("", { status: 503 });
      }
      manifest = parsedManifest;
      manifestDigest = expectedDigest;
      return new Response("", {
        status: 201,
        headers: identityHeaders(
          manifestSuccessIdentity,
          expectedDigest,
          manifestCompletionLocation === undefined ?
            url.toString()
          : manifestCompletionLocation
        )
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  return {
    fetchImpl,
    calls,
    blobs,
    get blobPuts() {
      return blobPuts;
    },
    get manifest() {
      return manifest;
    },
    get manifestPushes() {
      return manifestPushes;
    },
    setManifest(next: BootstrapManifest) {
      manifest = next;
      manifestDigest = digest(Buffer.from(JSON.stringify(next)));
    }
  };
}

export const baseOptions = {
  targetRepository: "acme/app",
  registry: "ghcr.io/acme/app-radius-state-dev-123456789abc",
  credentials: { username: "octocat", token: "keyring-token" },
  registryOrigin: "https://registry.test",
  apiBaseUrl: "https://api.test",
  sleep: async () => {}
};
