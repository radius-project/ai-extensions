import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { renewGitHubAppInstallationToken } from "./github-app-token.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function successfulRequest() {
  return vi
    .fn()
    .mockResolvedValueOnce(response({ id: 42 }))
    .mockResolvedValueOnce(
      response({
        token: "installation-token",
        expires_at: "2026-08-29T13:00:00.000Z"
      })
    );
}

describe("renewGitHubAppInstallationToken", () => {
  it("mints a repository-scoped token with the required permissions", async () => {
    const request = successfulRequest();

    await expect(
      renewGitHubAppInstallationToken({
        clientId: "Iv1.example",
        privateKey: PRIVATE_KEY,
        repository: "radius-project/cloud-fixture",
        now: () => NOW,
        request
      })
    ).resolves.toBe("installation-token");

    const lookup = request.mock.calls[0];
    expect(lookup?.[0]).toBe(
      "https://api.github.com/repos/radius-project/cloud-fixture/installation"
    );
    const authorization = (lookup?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    const payload = JSON.parse(
      Buffer.from(
        authorization.Authorization.slice("Bearer ".length).split(".")[1] ?? "",
        "base64url"
      ).toString("utf8")
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      iss: "Iv1.example",
      iat: Math.floor(NOW.getTime() / 1000) - 60,
      exp: Math.floor(NOW.getTime() / 1000) + 8 * 60
    });

    expect(request.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/app/installations/42/access_tokens"
    );
    expect(
      JSON.parse((request.mock.calls[1]?.[1] as RequestInit).body as string)
    ).toEqual({
      repositories: ["cloud-fixture"],
      permissions: {
        actions: "read",
        administration: "read",
        contents: "write",
        environments: "write",
        pull_requests: "write",
        variables: "write",
        workflows: "write"
      }
    });
  });

  it("uses the runtime clock and fetch implementation by default", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 42 }))
      .mockResolvedValueOnce(
        response({
          token: "runtime-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
        })
      );
    vi.stubGlobal("fetch", request);
    try {
      await expect(
        renewGitHubAppInstallationToken({
          clientId: " Iv1.example ",
          privateKey: PRIVATE_KEY,
          repository: "owner/repo"
        })
      ).resolves.toBe("runtime-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["client ID", { clientId: "" }, /client ID is required/],
    ["private key", { privateKey: " " }, /private key is required/],
    ["repository", { repository: "owner/repo/extra" }, /canonical owner\/name/]
  ])(
    "rejects an invalid %s before making a request",
    async (_, patch, error) => {
      const request = successfulRequest();
      await expect(
        renewGitHubAppInstallationToken({
          clientId: "Iv1.example",
          privateKey: PRIVATE_KEY,
          repository: "owner/repo",
          now: () => NOW,
          request,
          ...patch
        })
      ).rejects.toThrow(error);
      expect(request).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["HTTP lookup failure", [response({}, 403)], /lookup failed with HTTP 403/],
    ["malformed lookup", [response([])], /lookup returned a malformed/],
    [
      "missing installation id",
      [response({ id: 0 })],
      /no valid installation id/
    ],
    [
      "HTTP token failure",
      [response({ id: 42 }), response({}, 403)],
      /renewal failed with HTTP 403/
    ],
    [
      "missing token",
      [response({ id: 42 }), response({ expires_at: "2026-08-29T13:00:00Z" })],
      /returned no token/
    ],
    [
      "short token lifetime",
      [
        response({ id: 42 }),
        response({
          token: "short-lived",
          expires_at: "2026-08-29T12:49:59Z"
        })
      ],
      /insufficient lifetime/
    ],
    [
      "missing expiry",
      [response({ id: 42 }), response({ token: "unknown-lifetime" })],
      /insufficient lifetime/
    ]
  ])("fails closed on %s", async (_, responses, error) => {
    const request = vi.fn();
    for (const item of responses) request.mockResolvedValueOnce(item);
    await expect(
      renewGitHubAppInstallationToken({
        clientId: "Iv1.example",
        privateKey: PRIVATE_KEY,
        repository: "owner/repo",
        now: () => NOW,
        request
      })
    ).rejects.toThrow(error);
  });
});
