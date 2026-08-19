import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createIdentityProfilesRoutes } from "../../../src/server/routes/identity-profiles.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { GitHubIdentity } from "../../../src/gh.js";
import type { CredentialProfile } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface Harness {
  profiles: Map<string, CredentialProfile[]>;
  calls: string[];
  login: string;
  preflight: string | Error;
  validSlugs: string[];
  identityThrows?: Error;
}

function identityFor(login: string): GitHubIdentity {
  return {
    actingLogin: login,
    displayLogin: `display-${login}`,
    mismatch: false,
    actingHasWorkflow: true,
    actingHasPackages: false,
    reason: `reason-${login}`,
    accounts: []
  };
}

function start(): Harness {
  const harness: Harness = {
    profiles: new Map(),
    calls: [],
    login: "initial-login",
    preflight: "",
    validSlugs: []
  };

  const routes = createTestRouteTable(
    createIdentityProfilesRoutes({
      listCredentialProfiles: (repo) => {
        harness.calls.push(`list(${repo})`);
        return harness.profiles.get(repo) ?? [];
      },
      saveCredentialProfile: (repo, profile) => {
        harness.calls.push(`save(${repo})`);
        const saved: CredentialProfile = {
          name: String(profile.name || "").trim(),
          status: "verified"
        };
        harness.profiles.set(repo, [
          ...(harness.profiles.get(repo) ?? []),
          saved
        ]);
        return saved;
      },
      deleteCredentialProfile: (repo, name) => {
        harness.calls.push(`delete(${repo},${name})`);
        const list = harness.profiles.get(repo) ?? [];
        const next = list.filter((p) => p.name !== name);
        harness.profiles.set(repo, next);
        return next.length !== list.length;
      },
      getGitHubIdentity: () => {
        harness.calls.push(`identity->${harness.login}`);
        if (harness.identityThrows) {
          return Promise.reject(harness.identityThrows);
        }
        return Promise.resolve(identityFor(harness.login));
      },
      resetGhIdentityCache: () => {
        harness.calls.push("reset");
      },
      prepareGitHubAccount: async ({ login }) => ({
        readiness: {
          ready: true,
          login,
          credentialSource: "keyring",
          summary: "Ready to configure deployments",
          checks: {
            repository: { state: "ready", detail: "ready" },
            workflow: { state: "ready", detail: "ready" },
            environment: { state: "ready", detail: "ready" },
            packages: { state: "ready", detail: "ready" },
            identity: { state: "ready", detail: "ready" }
          },
          repair: null,
          restoration: null
        },
        selectionHandle: "selection-handle",
        expiresAt: 1
      }),
      preflightRepoAdmin: (repo) => {
        harness.calls.push(`preflight(${repo})`);
        if (harness.preflight instanceof Error) {
          return Promise.reject(harness.preflight);
        }
        return Promise.resolve(harness.preflight);
      },
      isValidRepoSlug: (value) => harness.validSlugs.includes(String(value)),
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error)
    })
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation: () => true,
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return harness;
}

function post(baseUrl: string, path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", body });
}

describe("identity-profiles real-loopback HIT (RF-02)", () => {
  it("round-trips a credential profile over a real socket", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    const empty = await fetch(
      `${entry.baseUrl}/api/credential-profiles?repo=octo/app`
    );
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toBe("application/json");
    expect(await empty.text()).toBe('{"profiles":[]}');

    const saved = await post(
      entry.baseUrl,
      "/api/save-credential-profile",
      '{"repo":"octo/app","name":"prod","provider":"azure"}'
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      success: true,
      profile: { name: "prod", status: "verified" }
    });

    const listed = await fetch(
      `${entry.baseUrl}/api/credential-profiles?repo=octo/app`
    );
    expect(await listed.json()).toEqual({
      profiles: [{ name: "prod", status: "verified" }]
    });

    // A different repo never sees the profile.
    const other = await fetch(
      `${entry.baseUrl}/api/credential-profiles?repo=octo/site`
    );
    expect(await other.text()).toBe('{"profiles":[]}');

    const removed = await post(
      entry.baseUrl,
      "/api/delete-credential-profile",
      '{"repo":"octo/app","name":"prod"}'
    );
    expect(removed.status).toBe(200);
    expect(await removed.text()).toBe('{"success":true,"removed":true}');
  });

  it("answers a missing repo with an empty list and no store call", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/credential-profiles`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"profiles":[]}');
    expect(harness.calls).toEqual([]);

    // Only GET is declared, so POST reaches unmatched routing.
    const posted = await post(entry.baseUrl, "/api/credential-profiles", "");
    expect(posted.status).toBe(404);
  });

  it("keeps save validating and delete unvalidated on the wire", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const rejected = await post(
      entry.baseUrl,
      "/api/save-credential-profile",
      "{}"
    );
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get("content-type")).toBe("application/json");
    expect(await rejected.text()).toBe(
      '{"error":"repo and name are required."}'
    );

    // The same empty body is a 200 for delete, and it reaches the store.
    const deleted = await post(
      entry.baseUrl,
      "/api/delete-credential-profile",
      ""
    );
    expect(deleted.status).toBe(200);
    expect(await deleted.text()).toBe('{"success":true,"removed":false}');
    expect(harness.calls).toEqual(["delete(,)"]);

    const malformed = await post(
      entry.baseUrl,
      "/api/delete-credential-profile",
      "not json"
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("content-type")).toBe("application/json");
  });

  it("serves the identity, folds in the preflight, and refreshes on demand", async () => {
    const harness = start();
    harness.validSlugs = ["octo/app"];
    harness.preflight = "write, not admin";
    const entry = await container!.getOrCreate("panel-a");

    const plain = await fetch(`${entry.baseUrl}/api/github-identity`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("application/json");
    expect(await plain.json()).toEqual(identityFor("initial-login"));

    harness.calls.length = 0;
    const withRepo = await fetch(
      `${entry.baseUrl}/api/github-identity?repo=octo/app&fresh=1`
    );
    expect((await withRepo.json()) as GitHubIdentity).toHaveProperty(
      "repoAccess",
      "write, not admin"
    );
    // Cache reset precedes the read, and the preflight follows it.
    expect(harness.calls).toEqual([
      "reset",
      "identity->initial-login",
      "preflight(octo/app)"
    ]);

    // An invalid slug silently skips the preflight and still renders.
    harness.calls.length = 0;
    const invalid = await fetch(
      `${entry.baseUrl}/api/github-identity?repo=not-a-slug`
    );
    expect(invalid.status).toBe(200);
    expect(harness.calls).toEqual(["identity->initial-login"]);
  });

  it("answers a failed identity resolution with 200 and an empty account list", async () => {
    const harness = start();
    harness.identityThrows = new Error("gh unavailable");
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/github-identity`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"error":"gh unavailable","accounts":[]}'
    );
  });

  it("returns selected-account readiness and rejects invalid input", async () => {
    const harness = start();
    harness.validSlugs = ["octo/app"];
    const entry = await container!.getOrCreate("panel-a");

    const switched = await post(
      entry.baseUrl,
      "/api/github-account",
      '{"login":"  octocat  ","repo":"octo/app","environment":"dev"}'
    );
    expect(switched.status).toBe(200);
    expect(await switched.json()).toMatchObject({
      success: true,
      selectionHandle: "selection-handle",
      readiness: { ready: true, login: "octocat" }
    });

    const failed = await post(
      entry.baseUrl,
      "/api/github-account",
      '{"login":"ghost","repo":"not-a-repo"}'
    );
    expect(failed.status).toBe(400);
    expect(failed.headers.get("content-type")).toBe("application/json");
    expect(await failed.text()).toBe(
      '{"error":"A GitHub login, environment, and valid repository are required."}'
    );

    const malformed = await post(
      entry.baseUrl,
      "/api/github-account",
      "not json"
    );
    expect(malformed.status).toBe(400);
  });
});
