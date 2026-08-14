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
  switchResult: { ok: boolean; error?: string };
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
    preferredLogin: null,
    reason: `reason-${login}`,
    accounts: []
  };
}

function start(): Harness {
  const harness: Harness = {
    profiles: new Map(),
    calls: [],
    login: "initial-login",
    switchResult: { ok: true },
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
      switchGhAccount: (login) => {
        harness.calls.push(`switch(${login})`);
        return Promise.resolve(harness.switchResult);
      },
      setPreferredGitHubLogin: (login) => {
        harness.calls.push(`prefer(${login})`);
        harness.login = login;
      },
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
        legacyFallback: (_request, response) => {
          response.writeHead(418);
          response.end("legacy");
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

    // Only GET is declared, so POST still falls through to the fallback.
    const posted = await post(entry.baseUrl, "/api/credential-profiles", "");
    expect(posted.status).toBe(418);
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

  it("switches the account, persisting before re-reading, and 400s a failure", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const switched = await post(
      entry.baseUrl,
      "/api/github-account",
      '{"login":"  octocat  "}'
    );
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      success: true,
      identity: identityFor("octocat")
    });
    expect(harness.calls).toEqual([
      "switch(octocat)",
      "prefer(octocat)",
      "identity->octocat"
    ]);

    harness.switchResult = { ok: false, error: "no such account" };
    const failed = await post(
      entry.baseUrl,
      "/api/github-account",
      '{"login":"ghost"}'
    );
    // 400, not a 200 error payload.
    expect(failed.status).toBe(400);
    expect(failed.headers.get("content-type")).toBe("application/json");
    expect(await failed.text()).toBe('{"error":"no such account"}');

    const malformed = await post(
      entry.baseUrl,
      "/api/github-account",
      "not json"
    );
    expect(malformed.status).toBe(400);

    // Unmigrated routes still reach the fallback. `/api/delete-environment` is
    // used rather than a route from this file's family: the auth/verify half of
    // `identity-credentials` migrated in the following slice, so probing one of
    // those paths here would silently stop testing the fallback.
    const residual = await fetch(`${entry.baseUrl}/api/list-environments`);
    expect(residual.status).toBe(418);
    const deferred = await post(entry.baseUrl, "/api/delete-environment", "{}");
    expect(deferred.status).toBe(418);
  });
});
