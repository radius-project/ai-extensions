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

type AmbiguousWrite =
  | "none"
  | "commit-then-throw"
  | "fail-then-succeed"
  | "always-fail"
  | "conflict-after-failure"
  | "conflict-before-write";
type SuccessIdentity = "exact" | "missing" | "wrong";

interface HarnessOptions {
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

interface FetchCall {
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

const wrongDigest = `sha256:${"f".repeat(64)}`;

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function json(body: unknown, init: ResponseInit = {}): Response {
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

function createHarness({
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

const baseOptions = {
  targetRepository: "acme/app",
  registry: "ghcr.io/acme/app-radius-state-dev-123456789abc",
  credentials: { username: "octocat", token: "keyring-token" },
  registryOrigin: "https://registry.test",
  apiBaseUrl: "https://api.test",
  sleep: async () => {}
};

test("pushes one deterministic linked bootstrap artifact across repeated bootstraps", async () => {
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
  assert.equal(harness.manifestPushes, 1);
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
  const manifestPut = harness.calls.find(
    (call) =>
      call.method === "PUT" &&
      new URL(call.url).pathname.endsWith("/manifests/bootstrap")
  );
  assert.equal(manifestPut?.headers["If-None-Match"], "*");
});

test("treats repository casing as the same deterministic bootstrap identity", async () => {
  const harness = createHarness();

  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });

  await bootstrapGHCRStatePackage({
    ...baseOptions,
    targetRepository: "Acme/App",
    fetchImpl: harness.fetchImpl
  });

  assert.equal(harness.manifestPushes, 1);
  assert.equal(
    harness.manifest?.annotations?.["org.opencontainers.image.source"],
    "https://github.com/acme/app"
  );
});

test("accepts a legacy casing-equivalent bootstrap manifest", async () => {
  const harness = createHarness();
  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });
  const existing = structuredClone(harness.manifest);
  assert.ok(existing?.annotations);
  existing.annotations["org.opencontainers.image.source"] =
    "https://github.com/Acme/App";
  harness.setManifest(existing);

  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.equal(harness.manifestPushes, 1);
});

test("refuses a bootstrap manifest published concurrently", async () => {
  const harness = createHarness({
    manifestAmbiguity: "conflict-before-write"
  });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /published concurrently with a different manifest/
  );
  assert.equal(harness.manifestPushes, 1);
});

test("passes a timeout signal to every request and enforces the bootstrap budget", async () => {
  const harness = createHarness({ metadataDelay: 2 });
  let now = 10_000;
  const sleeps: number[] = [];

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl,
      requestTimeoutMs: 25,
      bootstrapTimeoutMs: 600,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    }),
    /overall elapsed-time budget/
  );

  assert.ok(harness.calls.every((call) => call.signal instanceof AbortSignal));
  assert.deepEqual(sleeps, [500]);
});

test.each([0, Number.NaN])(
  "rejects invalid request timeout %s before contacting GHCR",
  async (requestTimeoutMs) => {
    const harness = createHarness();
    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: harness.fetchImpl,
        requestTimeoutMs
      }),
      /timeout values must be positive finite numbers/
    );
    assert.equal(harness.calls.length, 0);
  }
);

test("aborts an unresponsive request at the configured request timeout", async () => {
  const signals: AbortSignal[] = [];
  const fetchImpl: FetchImplementation = async (_input, options = {}) => {
    assert.ok(options.signal);
    signals.push(options.signal);
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason),
        {
          once: true
        }
      );
    });
  };

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl,
      requestTimeoutMs: 1,
      now: () => 0
    }),
    /timeout/i
  );

  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal.aborted));
});

test("rejects a response that completes after the overall budget", async () => {
  const harness = createHarness();
  let now = 0;
  const fetchImpl: FetchImplementation = async (input, options) => {
    const response = await harness.fetchImpl(input, options);
    now = 101;
    return response;
  };

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl,
      bootstrapTimeoutMs: 100,
      now: () => now
    }),
    /overall elapsed-time budget/
  );
  assert.equal(harness.calls.length, 1);
});

test.each([
  { retryAfter: "2", expectedDelay: 2000 },
  {
    retryAfter: new Date(1_800_000_003_000).toUTCString(),
    expectedDelay: 3000
  }
])(
  "honors Retry-After $retryAfter for an idempotent 429",
  async ({ retryAfter, expectedDelay }) => {
    let now = 1_800_000_000_000;
    const sleeps: number[] = [];
    const harness = createHarness({
      ownerFailures: [{ status: 429, retryAfter }]
    });

    await bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl,
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      }
    });

    assert.equal(sleeps[0], expectedDelay);
    assert.equal(
      harness.calls.filter(
        (call) => new URL(call.url).pathname === "/users/acme"
      ).length,
      2
    );
  }
);

test("retries a rate-limited GitHub 403 with Retry-After", async () => {
  const sleeps: number[] = [];
  const harness = createHarness({
    ownerFailures: [{ status: 403, retryAfter: "2" }]
  });

  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  });

  assert.equal(sleeps[0], 2000);
  assert.equal(
    harness.calls.filter((call) => new URL(call.url).pathname === "/users/acme")
      .length,
    2
  );
});

test("accepts the OCI access_token token response shape", async () => {
  const harness = createHarness({ tokenBody: { access_token: "bearer" } });

  const result = await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.equal(result.bootstrapTag, "bootstrap");
});

test.each([
  { name: "transport failure", failure: new Error("connection reset") },
  { name: "HTTP 500", failure: { status: 500 } }
])("retries an idempotent $name", async ({ failure }) => {
  let now = 20_000;
  const sleeps: number[] = [];
  const harness = createHarness({ ownerFailures: [failure] });

  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: harness.fetchImpl,
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    }
  });

  assert.equal(sleeps[0], 500);
  assert.equal(
    harness.calls.filter((call) => new URL(call.url).pathname === "/users/acme")
      .length,
    2
  );
});

test("does not retry a terminal 403", async () => {
  const harness = createHarness({ tokenStatus: 403 });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /rejected package access/
  );

  assert.equal(
    harness.calls.filter((call) => new URL(call.url).pathname === "/token")
      .length,
    1
  );
});

test.each([
  { tokenBody: [], message: /invalid response/ },
  { tokenBody: { token: "" }, message: /did not include an access token/ },
  { tokenBody: { token: 123 }, message: /did not include an access token/ }
])("rejects malformed token response %#", async ({ tokenBody, message }) => {
  const harness = createHarness({ tokenBody });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    message
  );
});

test("stops an ambiguous blob upload after one proven-absent retry", async () => {
  const harness = createHarness({ blobAmbiguity: "always-fail" });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /remained absent after reconciliation/
  );

  assert.equal(harness.blobPuts, 2);
  assert.equal(harness.manifestPushes, 0);
});

test.each([
  ["cross-origin", "https://pkg-containers.githubusercontent.com/v2/blob"],
  ["missing", null]
])(
  "accepts a digest-matched blob and manifest with a %s completion location",
  async (_label, location) => {
    const harness = createHarness({
      blobCompletionLocation: location,
      manifestCompletionLocation: location
    });

    await bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    });

    assert.equal(harness.blobPuts, 2);
    assert.equal(harness.manifestPushes, 1);
  }
);

test.each([
  { uploadLocation: null, message: /did not include a location/ },
  { uploadLocation: "http://[", message: /invalid location/ },
  {
    uploadLocation: "https://example.test/upload",
    message: /unexpected origin/
  }
])(
  "rejects malformed upload location %#",
  async ({ uploadLocation, message }) => {
    const harness = createHarness({ uploadLocation });

    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: harness.fetchImpl
      }),
      message
    );
  }
);

test.each([
  {
    options: { blobSuccessIdentity: "missing" as const },
    message: /invalid Docker-Content-Digest/
  },
  {
    options: { blobSuccessIdentity: "wrong" as const },
    message: /conflicting digest/
  },
  {
    options: { manifestSuccessIdentity: "missing" as const },
    message: /invalid Docker-Content-Digest/
  },
  {
    options: { manifestSuccessIdentity: "wrong" as const },
    message: /conflicting digest/
  }
])(
  "rejects malformed OCI success identity %#",
  async ({ options, message }) => {
    const harness = createHarness(options);

    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: harness.fetchImpl
      }),
      message
    );
  }
);

test.each([
  { blobAmbiguity: "commit-then-throw" as const, expectedBlobPuts: 2 },
  { blobAmbiguity: "fail-then-succeed" as const, expectedBlobPuts: 3 }
])(
  "reconciles an ambiguous blob upload ($blobAmbiguity)",
  async ({ blobAmbiguity, expectedBlobPuts }) => {
    const harness = createHarness({ blobAmbiguity });

    await bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    });

    assert.equal(harness.blobPuts, expectedBlobPuts);
    assert.equal(harness.blobs.size, 2);
    assert.equal(harness.manifestPushes, 1);
  }
);

test("reconciles a transport failure while starting a blob upload", async () => {
  const harness = createHarness();
  let startAttempts = 0;
  const fetchImpl: FetchImplementation = async (input, options = {}) => {
    const url = new URL(input);
    if (
      (options.method || "GET") === "POST" &&
      url.pathname.endsWith("/blobs/uploads/")
    ) {
      startAttempts++;
      if (startAttempts === 1) throw new Error("connection reset");
    }
    return harness.fetchImpl(input, options);
  };

  await bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl });

  assert.equal(startAttempts, 3);
  assert.equal(harness.blobs.size, 2);
});

test.each([
  { manifestAmbiguity: "commit-then-throw" as const, expectedPushes: 1 },
  { manifestAmbiguity: "fail-then-succeed" as const, expectedPushes: 2 }
])(
  "reconciles an ambiguous manifest upload ($manifestAmbiguity)",
  async ({ manifestAmbiguity, expectedPushes }) => {
    const harness = createHarness({ manifestAmbiguity });

    await bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    });

    assert.equal(harness.manifestPushes, expectedPushes);
  }
);

test.each([
  {
    manifestAmbiguity: "always-fail" as const,
    message: /remained absent after reconciliation/,
    expectedPushes: 2
  },
  {
    manifestAmbiguity: "conflict-after-failure" as const,
    message: /changed to a different digest/,
    expectedPushes: 1
  }
])(
  "does not blindly retry an ambiguous manifest ($manifestAmbiguity)",
  async ({ manifestAmbiguity, message, expectedPushes }) => {
    const harness = createHarness({ manifestAmbiguity });

    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: harness.fetchImpl
      }),
      message
    );

    assert.equal(harness.manifestPushes, expectedPushes);
  }
);

test("refuses to overwrite a manually changed bootstrap manifest", async () => {
  const harness = createHarness({ initialManifestDigest: wrongDigest });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /refusing to overwrite/
  );

  assert.equal(harness.manifestPushes, 0);
  assert.equal(harness.blobPuts, 0);
});

test("does not retry a non-idempotent blob upload rejected with 403", async () => {
  const harness = createHarness();
  let uploadAttempts = 0;
  const fetchImpl: FetchImplementation = async (input, options = {}) => {
    const url = new URL(input);
    if (options.method === "PUT" && url.pathname.startsWith("/uploads/")) {
      uploadAttempts++;
      return new Response("", { status: 403 });
    }
    return harness.fetchImpl(input, options);
  };

  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl }),
    /HTTP 403/
  );

  assert.equal(uploadAttempts, 1);
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

test("does not retry a non-idempotent manifest PUT rejected with 403", async () => {
  const harness = createHarness();
  let manifestAttempts = 0;
  const fetchImpl: FetchImplementation = async (input, options = {}) => {
    const url = new URL(input);
    if (
      options.method === "PUT" &&
      url.pathname.endsWith("/manifests/bootstrap")
    ) {
      manifestAttempts++;
      return new Response("", { status: 403 });
    }
    return harness.fetchImpl(input, options);
  };

  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl }),
    /HTTP 403/
  );

  assert.equal(manifestAttempts, 1);
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
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /must be private or internal/
  );
  assert.equal(
    harness.calls.some(
      (call) => new URL(call.url).origin === "https://registry.test"
    ),
    false
  );
});

test("rejects malformed successful package metadata", async () => {
  const harness = createHarness({
    initialMetadata: {
      visibility: "private",
      repository: "acme/app"
    }
  });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /invalid repository/
  );
  assert.equal(harness.manifestPushes, 0);
});

test.each([null, false, 0, ""])(
  "rejects malformed successful package metadata %#",
  async (finalMetadata) => {
    const harness = createHarness({ finalMetadata });
    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: harness.fetchImpl
      }),
      /invalid response/
    );
  }
);

test("rejects successful package metadata without visibility", async () => {
  const harness = createHarness({
    initialMetadata: { repository: { full_name: "acme/app" } }
  });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
    /valid visibility/
  );
  assert.equal(harness.manifestPushes, 0);
});

test("rejects a newly created package when GitHub reports public visibility", async () => {
  const harness = createHarness({ finalVisibility: "public" });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
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
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
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
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl
    }),
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

test("uses the bundled GitHub CLI path in package-scope guidance", async () => {
  const harness = createHarness({ tokenStatus: 403 });

  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: harness.fetchImpl,
      ghCommandPresentation: {
        kind: "absolute",
        shell: "posix",
        executablePath: "/Applications/GitHub Copilot/gh",
        installationNote: "Install GitHub CLI system-wide."
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /'\/Applications\/GitHub Copilot\/gh' auth refresh/
      );
      assert.match(error.message, /Install GitHub CLI system-wide/);
      return true;
    }
  );
});

test("requires a stored gh keyring credential", async () => {
  const calls: string[][] = [];
  await assert.rejects(
    loadGhKeyringCredentials({
      ghCommandPresentation: {
        kind: "absolute",
        shell: "posix",
        executablePath: "/Applications/GitHub Copilot/gh",
        installationNote: "Install GitHub CLI system-wide."
      },
      runKeyringCommand: async (args) => {
        calls.push(args);
        throw new Error("not logged in");
      }
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /stored GitHub CLI login/);
      assert.match(
        error.message,
        /'\/Applications\/GitHub Copilot\/gh' auth switch/
      );
      assert.match(error.message, /Install GitHub CLI system-wide/);
      return true;
    }
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
