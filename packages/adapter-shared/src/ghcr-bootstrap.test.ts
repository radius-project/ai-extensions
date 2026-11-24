import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ghcrBootstrap } from "@radius-project/adapter-shared";
import {
  bootstrapGHCRStatePackage,
  BOOTSTRAP_ARTIFACT_TYPE,
  BOOTSTRAP_CONTENT,
  type FetchImplementation
} from "./ghcr-bootstrap.js";
import {
  createHarness,
  json,
  wrongDigest,
  baseOptions as fixtureOptions
} from "../test/support/ghcr-bootstrap.js";
const baseOptions = {
  ...fixtureOptions,
  loadCredentials: async () => fixtureOptions.credentials,
  authGuidance: () => "test package guidance"
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each([
  "credentials",
  "metadata",
  "token",
  "manifest-head",
  "blob-head",
  "blob-post",
  "blob-post-rejection",
  "blob-put",
  "blob-put-rejection",
  "manifest-put",
  "manifest-put-rejection",
  "retry-sleep",
  "poll-sleep"
])(
  "starts no fresh GHCR request after shutdown during %s",
  async (boundary) => {
    const h = createHarness({
      ownerFailures:
        boundary === "retry-sleep" ? [new Error("Transport failed")] : [],
      metadataDelay: boundary === "poll-sleep" ? 1 : 0
    });
    const entered = deferred();
    const gate = deferred();
    const interruption = new Error("Execution interrupted");
    let stopped = false;
    let held = false;
    const hold = async () => {
      held = true;
      entered.resolve();
      await gate.promise;
    };
    const pending = bootstrapGHCRStatePackage({
      ...baseOptions,
      assertActive: () => {
        if (stopped) throw interruption;
      },
      loadCredentials: async () => {
        if (boundary === "credentials") await hold();
        return baseOptions.loadCredentials();
      },
      sleep: async () => {
        if (boundary.endsWith("sleep")) await hold();
        else assert.fail("Unexpected retry");
      },
      fetchImpl: async (url, options) => {
        const pathname = new URL(url).pathname;
        const method = options?.method || "GET";
        const match =
          boundary === "metadata" ? pathname.includes("/packages/")
          : boundary === "token" ? pathname === "/token"
          : boundary === "manifest-head" ?
            method === "HEAD" && pathname.includes("/manifests/")
          : boundary === "blob-head" ?
            method === "HEAD" && pathname.includes("/blobs/")
          : boundary.startsWith("blob-post") ? method === "POST"
          : boundary.startsWith("blob-put") ?
            method === "PUT" && pathname.startsWith("/uploads/")
          : boundary.startsWith("manifest-put") ?
            method === "PUT" && pathname.includes("/manifests/")
          : false;
        const response = await h.fetchImpl(url, options);
        if (match && !held) {
          await hold();
          if (boundary.endsWith("rejection"))
            throw new Error("Lost write response");
        }
        return response;
      }
    });
    await entered.promise;
    const calls = h.calls.length;
    stopped = true;
    gate.resolve();
    await assert.rejects(pending, (error) => error === interruption);
    assert.equal(h.calls.length, calls);
  }
);

test("exposes reusable request and metadata types through the package entry", async () => {
  const coordinates: ghcrBootstrap.RegistryCoordinates =
    ghcrBootstrap.parseRegistry("ghcr.io/acme/app-radius-state");
  const metadata: ghcrBootstrap.GitHubPackageMetadata =
    ghcrBootstrap.parsePackageMetadata({
      visibility: "private",
      repository: { full_name: "acme/app" }
    });
  assert.equal(coordinates.repositoryPath, "acme/app-radius-state");
  assert.equal(ghcrBootstrap.validatePackage(metadata, "acme/app"), true);

  const response: ghcrBootstrap.HttpResponse = new Response(null, {
    status: 403
  });
  const options: ghcrBootstrap.RequestOptions = {
    method: "GET",
    redirect: "error"
  };
  let calls = 0;
  const context: ghcrBootstrap.RequestContext = {
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(calls, 1);
      assert.equal(url, "https://api.test/package");
      assert.equal(init?.method, options.method);
      assert.equal(init?.redirect, options.redirect);
      assert.ok(init?.signal instanceof AbortSignal);
      return response;
    },
    sleep: async () => {
      assert.fail("Terminal HTTP rejection must not retry.");
    },
    now: () => 0,
    deadline: 1000,
    requestTimeoutMs: 100,
    operation: "bootstrap",
    credentialSource: "keyring"
  };
  assert.equal(
    await ghcrBootstrap.request(context, "https://api.test/package", options),
    response
  );
  assert.equal(calls, 1);
});

test("propagates credential rejection unchanged without registry I/O", async () => {
  const failure = new Error("fixture credential store unavailable");
  let loads = 0;
  await assert.rejects(
    ghcrBootstrap.bootstrapGHCRStatePackage({
      ...baseOptions,
      loadCredentials: async () => {
        loads++;
        throw failure;
      },
      fetchImpl: async () => {
        assert.fail("Credential failure must precede registry I/O.");
      }
    }),
    (error: unknown) => error === failure
  );
  assert.equal(loads, 1);
});

test.each([
  "",
  "https://ghcr.io/a/b",
  "ghcr.io/a/b@sha256:abc",
  "registry.test/a/b",
  "ghcr.io:123/a/b",
  "ghcr.io/a",
  "ghcr.io/a/b:tag"
])("rejects invalid bootstrap registry %s before HTTP", async (registry) => {
  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      registry,
      fetchImpl: async () => {
        throw new Error("Unexpected HTTP");
      }
    }),
    /Invalid GHCR|must be an untagged|must not include/
  );
});

test.each([null, {}, { type: "Bot" }])(
  "rejects unsupported owner metadata %j",
  async (body) => {
    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: async () => json(body)
      }),
      /Unsupported GitHub account type/
    );
  }
);

test.each([
  [200, null, /authentication probe/],
  [401, null, /challenge/],
  [401, 'Basic realm="registry"', /challenge/],
  [401, 'Bearer service="ghcr.io"', /token realm/],
  [401, 'Bearer realm="https://other.test/token"', /unexpected origin/]
] as const)("rejects challenge %s %s", async (status, challenge, error) => {
  const h = createHarness();
  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: (url, init) =>
        new URL(url).pathname === "/v2/" ?
          Promise.resolve(
            new Response("", {
              status,
              headers: challenge ? { "www-authenticate": challenge } : {}
            })
          )
        : h.fetchImpl(url, init)
    }),
    error
  );
});

test("defaults the registry service when the challenge omits it", async () => {
  const h = createHarness();
  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: (url, init) =>
      new URL(url).pathname === "/v2/" ?
        Promise.resolve(
          new Response("", {
            status: 401,
            headers: {
              "www-authenticate": 'Bearer realm="https://registry.test/token"'
            }
          })
        )
      : h.fetchImpl(url, init)
  });
  assert.equal(
    new URL(
      h.calls.find((call) => new URL(call.url).pathname === "/token")?.url || ""
    ).searchParams.get("service"),
    "ghcr.io"
  );
});

test.each([
  ["token", "/token", 400, /upload token/],
  ["owner", "/users/acme", 400, /GitHub API request failed/],
  ["blob", "/blobs/sha256:", 400, /Failed to check GHCR blob/],
  ["upload", "/blobs/uploads/", 400, /Failed to start GHCR blob/],
  ["upload retry", "/blobs/uploads/", 503, /remained absent/],
  [
    "manifest",
    "/manifests/bootstrap",
    400,
    /Failed to check the GHCR bootstrap manifest/
  ]
] as const)(
  "surfaces %s rejection without success fallback",
  async (_, match, status, error) => {
    const h = createHarness();
    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: (url, init) =>
          new URL(url).pathname.includes(match) ?
            Promise.resolve(new Response("", { status }))
          : h.fetchImpl(url, init)
      }),
      error
    );
  }
);

test("refuses a conflicting blob digest", async () => {
  const h = createHarness();
  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: (url, init) =>
        new URL(url).pathname.includes("/blobs/sha256:") ?
          Promise.resolve(
            new Response("", {
              status: 200,
              headers: { "docker-content-digest": wrongDigest }
            })
          )
        : h.fetchImpl(url, init)
    }),
    /conflicting digest/
  );
});

test("reuses exact blobs without uploading them", async () => {
  const h = createHarness();
  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: (url, init) =>
      new URL(url).pathname.includes("/blobs/sha256:") ?
        Promise.resolve(
          new Response("", {
            status: 200,
            headers: {
              "docker-content-digest":
                new URL(url).pathname.split("/").at(-1) || ""
            }
          })
        )
      : h.fetchImpl(url, init)
  });
  assert.equal(
    h.calls.some((call) => call.method === "POST"),
    false
  );
});

test("reads back a blob that became visible after the upload-start response was lost", async () => {
  const h = createHarness();
  let visible = false;
  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/blobs/uploads/")) {
        visible = true;
        return Promise.reject(new Error("response lost"));
      }
      if (visible && pathname.includes("/blobs/sha256:")) {
        return Promise.resolve(
          new Response("", {
            status: 200,
            headers: {
              "docker-content-digest": pathname.split("/").at(-1) || ""
            }
          })
        );
      }
      return h.fetchImpl(url, init);
    }
  });
});

test.each([
  "invalid",
  "null",
  "[]",
  "{}",
  '{"annotations":{}}',
  '{"annotations":{"org.opencontainers.image.source":7}}'
])("refuses unreadable or unrelated legacy manifest %s", async (body) => {
  const h = createHarness({ initialManifestDigest: wrongDigest });
  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      fetchImpl: (url, init) =>
        (
          new URL(url).pathname.endsWith("/manifests/bootstrap") &&
          (init?.method || "GET") === "GET"
        ) ?
          Promise.resolve(new Response(body))
        : h.fetchImpl(url, init)
    }),
    /different digest|different content|refusing to overwrite/
  );
});

test("accepts exact manifest readback after a conflict response", async () => {
  const h = createHarness();
  await bootstrapGHCRStatePackage({
    ...baseOptions,
    fetchImpl: async (url, init) => {
      const response = await h.fetchImpl(url, init);
      return (
          new URL(url).pathname.endsWith("/manifests/bootstrap") &&
            init?.method === "PUT"
        ) ?
          new Response("", { status: 409 })
        : response;
    }
  });
  assert.equal(h.manifestPushes, 1);
});

test.each([
  [{ "retry-after": "Wed, 01 Jan 2025 00:00:01 GMT" }, 1000],
  [{ "retry-after": "invalid", "x-ratelimit-reset": "1735689602" }, 2000],
  [{ "retry-after": "invalid" }, 500]
])("respects bounded retry headers %j", async (headers, delay) => {
  const h = createHarness();
  let first = true;
  const waits: number[] = [];
  await bootstrapGHCRStatePackage({
    ...baseOptions,
    now: () => Date.parse("2025-01-01T00:00:00Z"),
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetchImpl: (url, init) => {
      if (first) {
        first = false;
        return Promise.resolve(new Response("", { status: 429, headers }));
      }
      return h.fetchImpl(url, init);
    }
  });
  assert.deepEqual(waits, [delay]);
});

test("fails when metadata never appears and uses the default delay", async () => {
  vi.useFakeTimers();
  try {
    const h = createHarness({ metadataDelay: 10 });
    const result = assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        sleep: undefined,
        fetchImpl: h.fetchImpl,
        metadataAttempts: 2
      }),
      /not visible/
    );
    await vi.runAllTimersAsync();
    await result;
  } finally {
    vi.useRealTimers();
  }
});

test("rejects a runtime without fetch before acquiring credentials", async () => {
  vi.stubGlobal("fetch", undefined);
  try {
    await assert.rejects(
      bootstrapGHCRStatePackage(baseOptions),
      /does not provide fetch/
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("rejects empty package visibility", async () => {
  const h = createHarness({ initialMetadata: { visibility: "" } });
  await assert.rejects(
    bootstrapGHCRStatePackage({ ...baseOptions, fetchImpl: h.fetchImpl }),
    /visibility is "unknown"/
  );
});

test.each([false, true])(
  "reports a package read rejection with unreadable detail=%s",
  async (unreadable) => {
    const h = createHarness();
    await assert.rejects(
      bootstrapGHCRStatePackage({
        ...baseOptions,
        fetchImpl: (url, init) => {
          if (new URL(url).pathname.includes("/packages/container/")) {
            return Promise.resolve(
              new Response(
                unreadable ?
                  new ReadableStream({
                    start(controller) {
                      controller.error(new Error("body unavailable"));
                    }
                  })
                : "x".repeat(1100),
                { status: 400 }
              )
            );
          }
          return h.fetchImpl(url, init);
        }
      }),
      unreadable ? /HTTP 400\)$/ : (
        new RegExp(`HTTP 400\\): ${"x".repeat(1000)}$`)
      )
    );
  }
);

test("passes bootstrap package scope facts to host remediation", async () => {
  const h = createHarness();
  const guidance: unknown[] = [];
  await assert.rejects(
    bootstrapGHCRStatePackage({
      ...baseOptions,
      loadCredentials: async () => ({
        ...fixtureOptions.credentials,
        source: "keyring"
      }),
      authGuidance: (scopes, source) => {
        guidance.push([scopes, source]);
        return "host remediation";
      },
      fetchImpl: (url, init) =>
        new URL(url).pathname.includes("/packages/container/") ?
          Promise.resolve(new Response("", { status: 401 }))
        : h.fetchImpl(url, init)
    }),
    /host remediation/
  );
  assert.deepEqual(guidance, [[undefined, "keyring"]]);
});
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
  const githubCalls = harness.calls.filter(
    (call) => new URL(call.url).origin === baseOptions.apiBaseUrl
  );
  assert.ok(githubCalls.length > 0);
  assert.equal(ghcrBootstrap.GITHUB_API_VERSION, "2022-11-28");
  for (const call of githubCalls) {
    assert.equal(
      call.headers["X-GitHub-Api-Version"],
      ghcrBootstrap.GITHUB_API_VERSION
    );
  }
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
