import { describe, expect, it, vi } from "vitest";
import {
  createNodeGitHubAppTokenPorts,
  mintGitHubAppToken,
  readGitHubAppTokenConfig,
  refreshProcessGitHubToken,
  takeGitHubAppTokenConfig,
  type GitHubAppTokenConfig,
  type GitHubAppTokenPorts
} from "./github-app-token.js";

const CONFIG: GitHubAppTokenConfig = {
  clientId: "Iv1.fixture",
  installationId: "1234",
  privateKey: "private-key",
  repository: "radius-project/cloud-fixture",
  apiUrl: "https://github.example/api/v3"
};
const NOW = new Date("2026-09-04T20:00:00Z");

function response(
  body: unknown,
  options: { ok?: boolean; status?: number; statusText?: string } = {}
): Pick<Response, "ok" | "status" | "statusText" | "json"> {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 201,
    statusText: options.statusText ?? "Created",
    json: async () => body
  };
}

function ports(
  result: Pick<Response, "ok" | "status" | "statusText" | "json">
): GitHubAppTokenPorts & { request: ReturnType<typeof vi.fn> } {
  return {
    now: () => NOW,
    request: vi.fn(async () => result),
    signJwt: vi.fn(() => "signed")
  };
}

describe("readGitHubAppTokenConfig", () => {
  it("returns null when refresh credentials are entirely absent", () => {
    expect(readGitHubAppTokenConfig({})).toBeNull();
  });

  it("normalizes a complete configuration", () => {
    expect(
      readGitHubAppTokenConfig({
        CLOUD_E2E_BOT_CLIENT_ID: " Iv1.fixture ",
        CLOUD_E2E_BOT_INSTALLATION_ID: " 1234 ",
        CLOUD_E2E_BOT_PRIVATE_KEY: "line-1\\nline-2",
        AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: " radius-project/cloud-fixture ",
        GITHUB_API_URL: "https://github.example/api/v3/"
      })
    ).toEqual({
      ...CONFIG,
      privateKey: "line-1\nline-2"
    });
  });

  it.each([
    ["client id", { CLOUD_E2E_BOT_INSTALLATION_ID: "1234" }],
    ["installation id", { CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture" }],
    [
      "private key",
      {
        CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture",
        CLOUD_E2E_BOT_INSTALLATION_ID: "1234"
      }
    ]
  ])("rejects a partial configuration missing the %s", (_name, env) => {
    expect(() =>
      readGitHubAppTokenConfig({
        ...env,
        AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: "radius-project/cloud-fixture"
      })
    ).toThrow(/is required/);
  });

  it("rejects refresh credentials without a fixture repository", () => {
    expect(() =>
      readGitHubAppTokenConfig({
        CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture",
        CLOUD_E2E_BOT_INSTALLATION_ID: "1234",
        CLOUD_E2E_BOT_PRIVATE_KEY: "key"
      })
    ).toThrow(/AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY is required/);
  });

  it("rejects malformed installation and repository identities", () => {
    expect(() =>
      readGitHubAppTokenConfig({
        CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture",
        CLOUD_E2E_BOT_INSTALLATION_ID: "zero",
        CLOUD_E2E_BOT_PRIVATE_KEY: "key",
        AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: "radius-project/cloud-fixture"
      })
    ).toThrow(/positive integer/);
    expect(() =>
      readGitHubAppTokenConfig({
        CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture",
        CLOUD_E2E_BOT_INSTALLATION_ID: "1234",
        CLOUD_E2E_BOT_PRIVATE_KEY: "key",
        AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: "not-a-repository"
      })
    ).toThrow(/owner\/name/);
  });

  it("removes the private key from the process environment after reading it", () => {
    const env: NodeJS.ProcessEnv = {
      CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture",
      CLOUD_E2E_BOT_INSTALLATION_ID: "1234",
      CLOUD_E2E_BOT_PRIVATE_KEY: "key",
      AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: "radius-project/cloud-fixture"
    };

    expect(takeGitHubAppTokenConfig(env)).toMatchObject({ privateKey: "key" });
    expect(env.CLOUD_E2E_BOT_PRIVATE_KEY).toBeUndefined();
  });

  it("removes the private key even when the refresh configuration is invalid", () => {
    const env: NodeJS.ProcessEnv = {
      CLOUD_E2E_BOT_CLIENT_ID: "Iv1.fixture",
      CLOUD_E2E_BOT_PRIVATE_KEY: "key"
    };

    expect(() => takeGitHubAppTokenConfig(env)).toThrow(/is required/);
    expect(env.CLOUD_E2E_BOT_PRIVATE_KEY).toBeUndefined();
  });
});

describe("mintGitHubAppToken", () => {
  it("requests a repository-scoped token with the journey permissions", async () => {
    const fake = ports(
      response({
        token: "ghs_refreshed",
        expires_at: "2026-09-04T21:00:00Z"
      })
    );

    await expect(mintGitHubAppToken(CONFIG, fake)).resolves.toBe(
      "ghs_refreshed"
    );
    expect(fake.request).toHaveBeenCalledOnce();
    const [url, init] = fake.request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://github.example/api/v3/app/installations/1234/access_tokens"
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer [^.]+\.[^.]+\.signed$/)
    });
    expect(JSON.parse(String(init.body))).toEqual({
      repositories: ["cloud-fixture"],
      permissions: {
        actions: "write",
        administration: "read",
        contents: "write",
        deployments: "read",
        environments: "write",
        pull_requests: "write",
        variables: "write",
        workflows: "write"
      }
    });
  });

  it("builds a short-lived app JWT with the configured client id", async () => {
    const fake = ports(
      response({
        token: "ghs_refreshed",
        expires_at: "2026-09-04T21:00:00Z"
      })
    );

    await mintGitHubAppToken(CONFIG, fake);

    expect(fake.signJwt).toHaveBeenCalledOnce();
    const [unsignedJwt, privateKey] = vi.mocked(fake.signJwt).mock.calls[0];
    const [header, payload] = unsignedJwt
      .split(".")
      .map((part) =>
        JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
      );
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({
      iat: Math.floor(NOW.getTime() / 1000) - 60,
      exp: Math.floor(NOW.getTime() / 1000) + 9 * 60,
      iss: CONFIG.clientId
    });
    expect(privateKey).toBe(CONFIG.privateKey);
  });

  it("surfaces HTTP failures without exposing credentials", async () => {
    await expect(
      mintGitHubAppToken(
        CONFIG,
        ports(response({}, { ok: false, status: 403, statusText: "Forbidden" }))
      )
    ).rejects.toThrow("HTTP 403 Forbidden");
  });

  it.each([
    ["a non-object", null],
    ["missing fields", {}],
    ["an empty token", { token: " ", expires_at: "2026-09-04T21:00:00Z" }],
    ["an invalid expiration", { token: "ghs_token", expires_at: "tomorrow" }],
    [
      "an expired token",
      { token: "ghs_expired", expires_at: "2026-09-04T19:59:59Z" }
    ]
  ])("rejects %s response", async (_name, payload) => {
    await expect(
      mintGitHubAppToken(CONFIG, ports(response(payload)))
    ).rejects.toThrow(/no (?:token|usable unexpired token)/);
  });

  it("updates both token variables only after minting succeeds", async () => {
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: "old",
      GITHUB_TOKEN: "old"
    };

    await refreshProcessGitHubToken(
      CONFIG,
      env,
      ports(
        response({
          token: " ghs_refreshed ",
          expires_at: "2026-09-04T21:00:00Z"
        })
      )
    );

    expect(env.GH_TOKEN).toBe("ghs_refreshed");
    expect(env.GITHUB_TOKEN).toBe("ghs_refreshed");
  });

  it("preserves both token variables when minting fails", async () => {
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: "old",
      GITHUB_TOKEN: "old"
    };

    await expect(
      refreshProcessGitHubToken(
        CONFIG,
        env,
        ports(response({}, { ok: false, status: 403, statusText: "Forbidden" }))
      )
    ).rejects.toThrow("HTTP 403 Forbidden");

    expect(env.GH_TOKEN).toBe("old");
    expect(env.GITHUB_TOKEN).toBe("old");
  });

  it("signs with the Node crypto production port", () => {
    const production = createNodeGitHubAppTokenPorts();
    expect(() => production.signJwt("payload", "not-a-private-key")).toThrow();
  });
});
