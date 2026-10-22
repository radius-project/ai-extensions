import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
  bootstrapGHCRStatePackage,
  deleteGHCRStatePackage,
  loadGhKeyringCredentials,
  withGhcrDockerConfig
} from "./ghcr.js";
import type { FetchImplementation } from "./ghcr.js";
import { ghcrBootstrap } from "@radius-project/adapter-shared";

import {
  createHarness,
  json,
  baseOptions,
  type FetchCall
} from "@radius-project/adapter-shared/test-support/ghcr-bootstrap";

function createDeletionHarness({
  accountType = "User",
  metadata = {
    visibility: "private",
    repository: { full_name: "acme/app" }
  },
  deleteStatus = 204,
  packageReadStatus = 200,
  disappearAfterReads = 0,
  commitThenThrow = false
}: {
  accountType?: string;
  metadata?: unknown;
  deleteStatus?: number;
  packageReadStatus?: number;
  disappearAfterReads?: number;
  commitThenThrow?: boolean;
} = {}) {
  const calls: FetchCall[] = [];
  let deleted = false;
  let readsAfterDelete = 0;
  const fetchImpl: FetchImplementation = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || "GET";
    calls.push({
      url: url.toString(),
      method,
      headers: options.headers || {},
      signal: options.signal
    });
    if (url.pathname === "/users/acme") return json({ type: accountType });
    if (!url.pathname.includes("/packages/container/")) {
      throw new Error(`Unexpected request: ${method} ${url}`);
    }
    if (method === "DELETE") {
      deleted = deleteStatus < 400 || deleteStatus === 404;
      if (commitThenThrow) throw new Error("connection reset after deletion");
      return new Response(null, { status: deleteStatus });
    }
    if (packageReadStatus !== 200) {
      return new Response(null, { status: packageReadStatus });
    }
    if (deleted) {
      readsAfterDelete++;
      if (readsAfterDelete > disappearAfterReads) {
        return json({}, { status: 404 });
      }
    }
    return metadata === null ? json({}, { status: 404 }) : json(metadata);
  };
  return { fetchImpl, calls };
}

const deleteOptions = {
  targetRepository: "acme/app",
  registry: "ghcr.io/acme/app-radius-state-dev-123456789abc",
  credentials: {
    username: "octocat",
    token: "keyring-token",
    source: "keyring" as const,
    scopes: ["read:packages", "delete:packages"]
  },
  apiBaseUrl: "https://api.test",
  sleep: async () => {}
};

test("deletes a validated user-owned state package and confirms absence", async () => {
  const harness = createDeletionHarness();

  await assert.doesNotReject(async () => {
    const result = await deleteGHCRStatePackage({
      ...deleteOptions,
      fetchImpl: harness.fetchImpl
    });
    assert.deepEqual(result, {
      outcome: "deleted",
      registry: deleteOptions.registry
    });
  });
  assert.deepEqual(
    harness.calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ["GET", "/users/acme"],
      [
        "GET",
        "/users/acme/packages/container/app-radius-state-dev-123456789abc"
      ],
      [
        "DELETE",
        "/users/acme/packages/container/app-radius-state-dev-123456789abc"
      ],
      [
        "GET",
        "/users/acme/packages/container/app-radius-state-dev-123456789abc"
      ]
    ]
  );
  assert.equal(ghcrBootstrap.GITHUB_API_VERSION, "2022-11-28");
  for (const call of harness.calls) {
    assert.equal(
      call.headers["X-GitHub-Api-Version"],
      ghcrBootstrap.GITHUB_API_VERSION
    );
  }
});

test("treats initial absence confirmed with read-only package access as idempotent success", async () => {
  const harness = createDeletionHarness({ metadata: null });

  const result = await deleteGHCRStatePackage({
    ...deleteOptions,
    credentials: {
      username: "octocat",
      token: "keyring-token",
      source: "keyring",
      scopes: ["read:packages"]
    },
    fetchImpl: harness.fetchImpl
  });

  assert.deepEqual(result, {
    outcome: "not_found",
    registry: deleteOptions.registry
  });
  assert.equal(
    harness.calls.some((call) => call.method === "DELETE"),
    false
  );
});

test("fails closed when a package 404 is masked by insufficient credential scopes", async () => {
  const harness = createDeletionHarness({ metadata: null });

  await assert.rejects(
    deleteGHCRStatePackage({
      ...deleteOptions,
      credentials: {
        username: "octocat",
        token: "keyring-token",
        source: "keyring",
        scopes: ["delete:packages"]
      },
      fetchImpl: harness.fetchImpl
    }),
    /does not prove package read access.*--scopes read:packages/
  );
  assert.equal(
    harness.calls.some((call) => call.method === "DELETE"),
    false
  );
});

test("gives source-aware guidance for an injected credential denied deletion", async () => {
  const harness = createDeletionHarness({ deleteStatus: 403 });

  await assert.rejects(
    deleteGHCRStatePackage({
      ...deleteOptions,
      credentials: {
        username: "octocat",
        token: "injected-token",
        source: "injected-token",
        scopes: ["read:packages", "delete:packages"]
      },
      fetchImpl: harness.fetchImpl
    }),
    /GH_TOKEN or GITHUB_TOKEN.*gh auth refresh cannot change it/
  );
});

test("names the dedicated package token when package access is rejected", async () => {
  const harness = createDeletionHarness({ deleteStatus: 403 });
  const original = process.env.GH_PACKAGES_TOKEN;
  process.env.GH_PACKAGES_TOKEN = "dedicated-package-token";
  try {
    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        credentials: {
          username: "octocat",
          token: "dedicated-package-token",
          source: "injected-token",
          scopes: ["read:packages", "delete:packages"]
        },
        fetchImpl: harness.fetchImpl
      }),
      /GH_PACKAGES_TOKEN.*gh auth refresh cannot change it/
    );
  } finally {
    if (original === undefined) delete process.env.GH_PACKAGES_TOKEN;
    else process.env.GH_PACKAGES_TOKEN = original;
  }
});

test.each([401, 403])(
  "reports deletion scopes when the initial package lookup is rejected with HTTP %i",
  async (packageReadStatus) => {
    const harness = createDeletionHarness({ packageReadStatus });

    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        fetchImpl: harness.fetchImpl
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /gh auth refresh --hostname github\.com --scopes read:packages,delete:packages/
        );
        assert.doesNotMatch(error.message, /write:packages/);
        return true;
      }
    );
  }
);

test("uses the organization package endpoint", async () => {
  const harness = createDeletionHarness({ accountType: "Organization" });

  await deleteGHCRStatePackage({
    ...deleteOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.ok(
    harness.calls.some((call) =>
      new URL(call.url).pathname.startsWith("/orgs/acme/packages/container/")
    )
  );
});

test.each(
  (["owner lookup", "deletion confirmation"] as const).flatMap((stage) =>
    [401, 403].flatMap((status) =>
      (["keyring", "injected-token"] as const).map((source) => ({
        stage,
        status,
        source
      }))
    )
  )
)(
  "fails closed with $source guidance on $stage HTTP $status",
  async ({ stage, status, source }) => {
    const ownerUrl = "https://api.test/users/acme";
    const packageUrl =
      "https://api.test/users/acme/packages/container/app-radius-state-dev-123456789abc";
    const expectedCalls =
      stage === "owner lookup" ?
        [["GET", ownerUrl]]
      : [
          ["GET", ownerUrl],
          ["GET", packageUrl],
          ["DELETE", packageUrl],
          ["GET", packageUrl]
        ];
    const calls: string[][] = [];
    const fetchImpl: FetchImplementation = async (url, options = {}) => {
      const call = [options.method || "GET", url];
      assert.deepEqual(call, expectedCalls[calls.length]);
      calls.push(call);
      if (calls.length === expectedCalls.length) {
        return new Response(null, { status });
      }
      if (url === ownerUrl) return json({ type: "User" });
      if (options.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return json({
        visibility: "private",
        repository: { full_name: "acme/app" }
      });
    };

    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        credentials: { ...deleteOptions.credentials, source },
        fetchImpl,
        ghCommandPresentation: {
          kind: "absolute",
          shell: "posix",
          executablePath: "/fixture/GitHub CLI/gh",
          installationNote: "Use the fixture GitHub CLI."
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, /read:packages,delete:packages/);
        assert.doesNotMatch(error.message, /write:packages|keyring-token/);
        assert.match(error.message, /Use the fixture GitHub CLI/);
        if (source === "keyring") {
          assert.match(
            error.message,
            /'\/fixture\/GitHub CLI\/gh' auth refresh --hostname github\.com --scopes read:packages,delete:packages/
          );
        } else {
          assert.match(error.message, /gh auth refresh cannot change it/);
          assert.match(error.message, /Update that injected token/);
        }
        return true;
      }
    );
    assert.deepEqual(calls, expectedCalls);
  }
);

test("waits for package deletion to become visible", async () => {
  const harness = createDeletionHarness({ disappearAfterReads: 2 });
  const sleeps: number[] = [];

  const result = await deleteGHCRStatePackage({
    ...deleteOptions,
    fetchImpl: harness.fetchImpl,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    }
  });

  assert.equal(result.outcome, "deleted");
  assert.deepEqual(sleeps, [500, 1000]);
});

test("reconciles a transport failure after deletion", async () => {
  const harness = createDeletionHarness({ commitThenThrow: true });

  const result = await deleteGHCRStatePackage({
    ...deleteOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.equal(result.outcome, "deleted");
});

test("reconciles a package removed between validation and deletion", async () => {
  const harness = createDeletionHarness({ deleteStatus: 404 });

  const result = await deleteGHCRStatePackage({
    ...deleteOptions,
    fetchImpl: harness.fetchImpl
  });

  assert.equal(result.outcome, "deleted");
});

test("fails closed while the package remains after a rejected deletion", async () => {
  const harness = createDeletionHarness({ deleteStatus: 500 });

  await assert.rejects(
    deleteGHCRStatePackage({
      ...deleteOptions,
      fetchImpl: harness.fetchImpl,
      confirmationAttempts: 2
    }),
    /still present after deletion.*HTTP 500/
  );
});

test("fails closed when GitHub accepts deletion but the package remains", async () => {
  const harness = createDeletionHarness({
    deleteStatus: 204,
    disappearAfterReads: Number.POSITIVE_INFINITY
  });

  await assert.rejects(
    deleteGHCRStatePackage({
      ...deleteOptions,
      fetchImpl: harness.fetchImpl,
      confirmationAttempts: 2
    }),
    /still present after deletion/
  );
});

test.each([401, 403])(
  "reports delete:packages guidance when GitHub rejects deletion with HTTP %i",
  async (deleteStatus) => {
    const harness = createDeletionHarness({ deleteStatus });

    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        fetchImpl: harness.fetchImpl
      }),
      /gh auth refresh --hostname github\.com --scopes delete:packages/
    );
  }
);

test("refuses to delete an unsafe or mismatched package", async () => {
  for (const metadata of [
    { visibility: "public", repository: { full_name: "acme/app" } },
    { visibility: "private", repository: { full_name: "other/app" } },
    { visibility: "private", repository: null },
    {}
  ]) {
    const harness = createDeletionHarness({ metadata });
    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        fetchImpl: harness.fetchImpl
      })
    );
    assert.equal(
      harness.calls.some((call) => call.method === "DELETE"),
      false
    );
  }
});

test("validates deletion options before contacting GitHub", async () => {
  const harness = createDeletionHarness();

  for (const options of [
    { requestTimeoutMs: 0 },
    { deletionTimeoutMs: Number.NaN },
    { confirmationAttempts: 0 },
    { confirmationAttempts: 1.5 }
  ]) {
    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        ...options,
        fetchImpl: harness.fetchImpl
      }),
      /positive finite numbers/
    );
  }
  assert.equal(harness.calls.length, 0);
});

test("enforces the overall package deletion budget", async () => {
  const harness = createDeletionHarness();
  const timestamps = [0, 0, 31_000];

  await assert.rejects(
    deleteGHCRStatePackage({
      ...deleteOptions,
      fetchImpl: harness.fetchImpl,
      deletionTimeoutMs: 30_000,
      now: () => timestamps.shift() ?? 31_000
    }),
    /GHCR deletion exceeded its overall elapsed-time budget/
  );
  assert.equal(harness.calls.length, 1);
});

test("loads package credentials when none are supplied", async () => {
  const harness = createDeletionHarness();
  const runKeyringCommand = vi.fn(async (args: string[]) =>
    args[0] === "auth" ? "keyring-token" : "octocat"
  );

  await deleteGHCRStatePackage({
    ...deleteOptions,
    credentials: undefined,
    runKeyringCommand,
    fetchImpl: harness.fetchImpl
  });

  assert.equal(runKeyringCommand.mock.calls.length, 2);
});

test("rejects a runtime without fetch", async () => {
  vi.stubGlobal("fetch", undefined);
  try {
    await assert.rejects(
      deleteGHCRStatePackage({
        ...deleteOptions,
        fetchImpl: undefined
      }),
      /does not provide fetch/
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

test("uses the default confirmation delay", async () => {
  vi.useFakeTimers();
  try {
    const harness = createDeletionHarness({ disappearAfterReads: 1 });
    const result = deleteGHCRStatePackage({
      ...deleteOptions,
      fetchImpl: harness.fetchImpl,
      sleep: undefined
    });

    await vi.advanceTimersByTimeAsync(500);

    assert.equal((await result).outcome, "deleted");
  } finally {
    vi.useRealTimers();
  }
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

test.each(["token", "username"])(
  "rejects an empty stored %s with actionable keyring guidance",
  async (missing) => {
    const runKeyringCommand = vi.fn(async (args: string[]) => {
      const tokenRequest = args[0] === "auth";
      return (missing === "token") === tokenRequest ? "" : "fixture-value";
    });
    await assert.rejects(
      loadGhKeyringCredentials({ runKeyringCommand }),
      /A stored GitHub CLI login with package access is required/
    );
    assert.equal(runKeyringCommand.mock.calls.length, 2);
  }
);

test("uses the real keyring process binding for default package and publish credentials without ambient authority", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "radius-keyring-test-"));
  const executable = path.join(
    directory,
    process.platform === "win32" ? "gh.exe" : "gh"
  );
  const hook = path.join(directory, "keyring.cjs");
  try {
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o755);
    writeFileSync(
      hook,
      [
        'const args = [require("node:path").basename(process.argv[1]), ...process.argv.slice(2)];',
        "if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_HOST) process.exit(61);",
        "const commands = {",
        '  \'["auth","token","--hostname","github.com"]\': "fixture-keyring-token",',
        '  \'["api","--hostname","github.com","user","--jq",".login"]\': "fixture-keyring-user"',
        "};",
        "const output = commands[JSON.stringify(args)];",
        "if (!output) { process.stderr.write(`Unexpected fake gh command: ${JSON.stringify(args)}`); process.exit(62); }",
        "process.stdout.write(output);",
        "process.exit(0);"
      ].join("\n")
    );
    const pathKey =
      Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
      "PATH";
    vi.stubEnv(pathKey, directory);
    vi.stubEnv("NODE_OPTIONS", `--require="${hook.replaceAll("\\", "/")}"`);
    vi.stubEnv("GH_CONFIG_DIR", directory);
    vi.stubEnv("GH_TOKEN", "ambient-token-must-not-be-used");
    vi.stubEnv("GITHUB_TOKEN", "ambient-token-must-not-be-used");
    vi.stubEnv("GH_HOST", "wrong-host.invalid");
    assert.deepEqual(await loadGhKeyringCredentials(), {
      token: "fixture-keyring-token",
      username: "fixture-keyring-user"
    });
    const bootstrap = createHarness();
    await bootstrapGHCRStatePackage({
      ...baseOptions,
      credentials: undefined,
      fetchImpl: bootstrap.fetchImpl
    });
    for (const failPublish of [false, true]) {
      let configDirectory = "";
      const publishing = withGhcrDockerConfig(async ({ DOCKER_CONFIG }) => {
        configDirectory = DOCKER_CONFIG;
        const config = JSON.parse(
          readFileSync(path.join(DOCKER_CONFIG, "config.json"), "utf8")
        );
        assert.equal(
          config.auths["ghcr.io"].auth,
          Buffer.from("fixture-keyring-user:fixture-keyring-token").toString(
            "base64"
          )
        );
        if (failPublish) throw new Error("fixture publish failure");
        return "published";
      });
      if (failPublish) {
        await assert.rejects(publishing, /fixture publish failure/);
      } else {
        assert.equal(await publishing, "published");
      }
      assert.ok(configDirectory);
      assert.equal(existsSync(configDirectory), false);
    }
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
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
