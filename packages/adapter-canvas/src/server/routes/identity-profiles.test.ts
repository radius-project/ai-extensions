import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createIdentityProfilesRoutes,
  handleCredentialProfiles,
  handleDeleteCredentialProfile,
  handleGitHubAccount,
  handleGitHubIdentity,
  handleSaveCredentialProfile,
  type IdentityProfilesDependencies
} from "./identity-profiles.js";
import type { GitHubIdentity } from "../../gh.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  headers: Record<string, string>;
  // Header placement is observable on these routes: two of them set
  // `Content-Type` before the try (so it survives the error path) and two set
  // it inside each branch. `headerSteps` records *when* each set happened
  // relative to the write, which `headers` alone cannot express.
  headerOrder: string[];
  headerSteps: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    headerSteps: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      // Mirrors Node: re-setting a header overwrites it and keeps its position.
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      recording.headerSteps.push(`set:${name}=${value}`);
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      recording.headerSteps.push(`writeHead:${status}`);
      return this;
    },
    end(value = "") {
      recording.body += value;
      recording.headerSteps.push("end");
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(method: string, url: string, body = ""): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url,
    method,
    headers: {}
  }) as unknown as IncomingMessage;
}

// Every fake returns a distinct, identifiable value and throws on an argument
// it was not scripted for, so calling the wrong port — or calling the right
// ports in the wrong order — fails loudly instead of silently matching.
interface Calls {
  log: string[];
}

function identityFor(login: string): GitHubIdentity {
  return {
    actingLogin: login,
    displayLogin: `display-${login}`,
    mismatch: login !== "",
    actingHasWorkflow: true,
    actingHasPackages: false,
    reason: `reason-${login}`,
    accounts: [
      {
        login,
        hasWorkflow: true,
        hasPackages: false,
        switchable: true,
        acting: true
      }
    ]
  };
}

function dependencies(
  overrides: Partial<IdentityProfilesDependencies> = {}
): IdentityProfilesDependencies {
  return {
    listCredentialProfiles: () => {
      throw new Error("listCredentialProfiles not stubbed");
    },
    saveCredentialProfile: () => {
      throw new Error("saveCredentialProfile not stubbed");
    },
    deleteCredentialProfile: () => {
      throw new Error("deleteCredentialProfile not stubbed");
    },
    getGitHubIdentity: () => {
      throw new Error("getGitHubIdentity not stubbed");
    },
    resetGhIdentityCache: () => {
      throw new Error("resetGhIdentityCache not stubbed");
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
    preflightRepoAdmin: () => {
      throw new Error("preflightRepoAdmin not stubbed");
    },
    isValidRepoSlug: () => {
      throw new Error("isValidRepoSlug not stubbed");
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

const INITIAL_LOGIN = "initial-login";
// The identity ports, wired as one discriminating group.
function identityPorts(
  calls: Calls,
  options: {
    initialLogin?: string;
    identityThrows?: Error;
    preflight?: string | Error;
    validSlugs?: string[];
  } = {}
): Partial<IdentityProfilesDependencies> {
  const currentLogin = options.initialLogin ?? INITIAL_LOGIN;
  return {
    resetGhIdentityCache: () => {
      calls.log.push("resetGhIdentityCache");
    },
    getGitHubIdentity: () => {
      calls.log.push(`getGitHubIdentity->${currentLogin}`);
      if (options.identityThrows) return Promise.reject(options.identityThrows);
      return Promise.resolve(identityFor(currentLogin));
    },
    isValidRepoSlug: (value) => {
      calls.log.push(`isValidRepoSlug(${String(value)})`);
      return (options.validSlugs ?? []).includes(String(value));
    },
    preflightRepoAdmin: (repo) => {
      calls.log.push(`preflightRepoAdmin(${repo})`);
      if (options.preflight instanceof Error) {
        return Promise.reject(options.preflight);
      }
      return Promise.resolve(options.preflight ?? "");
    }
  };
}

type Handler = (
  context: ReturnType<typeof createRequestContext>,
  deps: IdentityProfilesDependencies
) => void | Promise<void>;

async function run(
  method: string,
  url: string,
  body: string,
  handler: Handler,
  deps: IdentityProfilesDependencies
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(method, url, body),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handler(context, deps);
  return recording;
}

const JSON_ONLY = ["Content-Type"];
const SET_THEN_WRITE = (status: number) => [
  "set:Content-Type=application/json",
  `writeHead:${status}`,
  "end"
];

describe("identity-profiles routes (SU-06, SU-07)", () => {
  it("declares exactly the five routes it owns", () => {
    const routes = createIdentityProfilesRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/credential-profiles",
      "GET /api/github-identity",
      "POST /api/github-account",
      "POST /api/save-credential-profile",
      "POST /api/delete-credential-profile"
    ]);
  });

  // ── GET /api/credential-profiles (SU-07) ───────────────────────────────────

  it("lists the profiles for the repo named in the query string", async () => {
    const seen: string[] = [];
    const recording = await run(
      "GET",
      "/api/credential-profiles?repo=octo/app",
      "",
      handleCredentialProfiles,
      dependencies({
        listCredentialProfiles: (repo) => {
          seen.push(repo);
          return [{ name: `profile-for-${repo}` }];
        }
      })
    );
    expect(seen).toEqual(["octo/app"]);
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(recording.body).toBe(
      '{"profiles":[{"name":"profile-for-octo/app"}]}'
    );
  });

  it("isolates profiles per repository", async () => {
    const store: Record<string, { name: string }[]> = {
      "octo/app": [{ name: "app-azure" }],
      "octo/site": [{ name: "site-aws" }]
    };
    const deps = dependencies({
      listCredentialProfiles: (repo) => store[repo] ?? []
    });
    const app = await run(
      "GET",
      "/api/credential-profiles?repo=octo/app",
      "",
      handleCredentialProfiles,
      deps
    );
    const other = await run(
      "GET",
      "/api/credential-profiles?repo=octo/other",
      "",
      handleCredentialProfiles,
      deps
    );
    expect(app.body).toBe('{"profiles":[{"name":"app-azure"}]}');
    expect(other.body).toBe('{"profiles":[]}');
  });

  it("answers a missing repo with an empty list without touching the store", async () => {
    // The port throws on any call, so reaching it at all fails this test —
    // which is exactly the short-circuit being pinned.
    const recording = await run(
      "GET",
      "/api/credential-profiles",
      "",
      handleCredentialProfiles,
      dependencies()
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"profiles":[]}');
  });

  it("treats an empty repo parameter as no repo", async () => {
    const recording = await run(
      "GET",
      "/api/credential-profiles?repo=",
      "",
      handleCredentialProfiles,
      dependencies()
    );
    expect(recording.body).toBe('{"profiles":[]}');
  });

  it("propagates a throwing profile store rather than degrading to a list", async () => {
    // No try/catch on this route: a persistence failure is not swallowed here,
    // unlike every other route in this family.
    await expect(
      run(
        "GET",
        "/api/credential-profiles?repo=octo/app",
        "",
        handleCredentialProfiles,
        dependencies({
          listCredentialProfiles: () => {
            throw new Error("credentials file unreadable");
          }
        })
      )
    ).rejects.toThrow("credentials file unreadable");
  });

  // ── GET /api/github-identity (SU-06) ───────────────────────────────────────

  it("returns the resolved identity without touching the cache or preflight", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "GET",
      "/api/github-identity",
      "",
      handleGitHubIdentity,
      dependencies(identityPorts(calls))
    );
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(JSON.parse(recording.body)).toEqual(identityFor("initial-login"));
    // No repo means no slug check and no preflight at all.
    expect(calls.log).toEqual(["getGitHubIdentity->initial-login"]);
  });

  it("drops the memoized snapshot before resolving identity when fresh=1", async () => {
    const calls: Calls = { log: [] };
    await run(
      "GET",
      "/api/github-identity?fresh=1",
      "",
      handleGitHubIdentity,
      dependencies(identityPorts(calls))
    );
    // Order matters: resetting *after* the read would return the stale scopes
    // the re-check exists to clear.
    expect(calls.log).toEqual([
      "resetGhIdentityCache",
      "getGitHubIdentity->initial-login"
    ]);
  });

  it("ignores any fresh value other than the literal 1", async () => {
    const calls: Calls = { log: [] };
    await run(
      "GET",
      "/api/github-identity?fresh=true",
      "",
      handleGitHubIdentity,
      dependencies(identityPorts(calls))
    );
    expect(calls.log).toEqual(["getGitHubIdentity->initial-login"]);
  });

  it("folds an advisory repo preflight into the identity after resolving it", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "GET",
      "/api/github-identity?repo=octo/app",
      "",
      handleGitHubIdentity,
      dependencies(
        identityPorts(calls, {
          validSlugs: ["octo/app"],
          preflight: "You have write, not admin, on octo/app."
        })
      )
    );
    expect(recording.status).toBe(200);
    expect((JSON.parse(recording.body) as GitHubIdentity).repoAccess).toBe(
      "You have write, not admin, on octo/app."
    );
    // Identity resolves FIRST so the preflight acts as the same account.
    expect(calls.log).toEqual([
      "getGitHubIdentity->initial-login",
      "isValidRepoSlug(octo/app)",
      "preflightRepoAdmin(octo/app)"
    ]);
  });

  it("omits repoAccess when the preflight reports nothing", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "GET",
      "/api/github-identity?repo=octo/app",
      "",
      handleGitHubIdentity,
      dependencies(
        identityPorts(calls, { validSlugs: ["octo/app"], preflight: "" })
      )
    );
    expect(JSON.parse(recording.body)).not.toHaveProperty("repoAccess");
  });

  it("skips the preflight entirely for an invalid repo slug", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "GET",
      "/api/github-identity?repo=not-a-slug",
      "",
      handleGitHubIdentity,
      // `validSlugs` is empty, so the slug check rejects and `preflightRepoAdmin`
      // — which throws when reached — must never be called.
      dependencies(identityPorts(calls, { validSlugs: [] }))
    );
    expect(recording.status).toBe(200);
    expect(calls.log).toEqual([
      "getGitHubIdentity->initial-login",
      "isValidRepoSlug(not-a-slug)"
    ]);
  });

  it("skips the slug check for a blank repo parameter", async () => {
    const calls: Calls = { log: [] };
    await run(
      "GET",
      "/api/github-identity?repo=%20%20",
      "",
      handleGitHubIdentity,
      dependencies(identityPorts(calls))
    );
    expect(calls.log).toEqual(["getGitHubIdentity->initial-login"]);
  });

  it("still renders the identity when the preflight throws", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "GET",
      "/api/github-identity?repo=octo/app",
      "",
      handleGitHubIdentity,
      dependencies(
        identityPorts(calls, {
          validSlugs: ["octo/app"],
          preflight: new Error("rate limited")
        })
      )
    );
    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual(identityFor("initial-login"));
  });

  it("answers a failed identity resolution with 200 and an empty account list", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "GET",
      "/api/github-identity",
      "",
      handleGitHubIdentity,
      dependencies(
        identityPorts(calls, { identityThrows: new Error("gh unavailable") })
      )
    );
    // A pre-existing success fallback: this route never reports a failure
    // status. The header was set before the try, so it is present here too.
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(recording.body).toBe('{"error":"gh unavailable","accounts":[]}');
  });

  // ── POST /api/github-account (SU-06) ───────────────────────────────────────

  it("returns readiness and a server-minted handle without persisting a preferred login", async () => {
    const prepared: Array<{
      instanceId: string;
      repo: string;
      login: string;
    }> = [];
    const recording = await run(
      "POST",
      "/api/github-account",
      '{"login":"  octocat  ","repo":"octo/app","environment":"dev"}',
      handleGitHubAccount,
      dependencies({
        resetGhIdentityCache: () => {},
        isValidRepoSlug: (value) => value === "octo/app",
        prepareGitHubAccount: async (input) => {
          prepared.push(input);
          return {
            readiness: {
              ready: true,
              login: "octocat",
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
            selectionHandle: "handle",
            expiresAt: 123
          };
        }
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(JSON.parse(recording.body)).toMatchObject({
      success: true,
      selectionHandle: "handle",
      readiness: { ready: true, login: "octocat" }
    });
    expect(prepared).toEqual([
      {
        instanceId: "panel-a",
        repo: "octo/app",
        environment: "dev",
        login: "octocat"
      }
    ]);
  });

  it("requires both a login and a valid repository", async () => {
    const recording = await run(
      "POST",
      "/api/github-account",
      "",
      handleGitHubAccount,
      dependencies({ isValidRepoSlug: () => false })
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe(
      '{"error":"A GitHub login, environment, and valid repository are required."}'
    );
  });

  it("answers a malformed body with 400", async () => {
    const recording = await run(
      "POST",
      "/api/github-account",
      "not json",
      handleGitHubAccount,
      dependencies()
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
  });

  it("answers a throwing readiness check with 400", async () => {
    const recording = await run(
      "POST",
      "/api/github-account",
      '{"login":"octocat","repo":"octo/app","environment":"dev"}',
      handleGitHubAccount,
      dependencies({
        resetGhIdentityCache: () => {},
        isValidRepoSlug: () => true,
        prepareGitHubAccount: async () => {
          throw new Error("spawn");
        }
      })
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"spawn"}');
  });

  // ── POST /api/save-credential-profile (SU-07) ──────────────────────────────

  it("saves a profile and echoes what the store returned", async () => {
    const saves: { repo: string; profile: unknown }[] = [];
    const recording = await run(
      "POST",
      "/api/save-credential-profile",
      '{"repo":"  octo/app  ","name":"  prod  ","provider":"azure"}',
      handleSaveCredentialProfile,
      dependencies({
        saveCredentialProfile: (repo, profile) => {
          saves.push({ repo, profile });
          return { name: "prod", provider: "azure", status: "verified" };
        }
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(recording.body).toBe(
      '{"success":true,"profile":{"name":"prod","provider":"azure","status":"verified"}}'
    );
    // The trimmed repo is passed, but the *whole* parsed body travels as the
    // profile — including the untrimmed name and the provider field.
    expect(saves).toEqual([
      {
        repo: "octo/app",
        profile: { repo: "  octo/app  ", name: "  prod  ", provider: "azure" }
      }
    ]);
  });

  it("rejects a missing repo or name with 400 before reaching the store", async () => {
    for (const body of [
      "{}",
      '{"repo":"octo/app"}',
      '{"name":"prod"}',
      '{"repo":"  ","name":"prod"}',
      '{"repo":"octo/app","name":"   "}'
    ]) {
      const recording = await run(
        "POST",
        "/api/save-credential-profile",
        body,
        handleSaveCredentialProfile,
        // The store port throws when called, so any reach fails the test.
        dependencies()
      );
      expect(recording.status, body).toBe(400);
      expect(recording.headerSteps, body).toEqual(SET_THEN_WRITE(400));
      expect(recording.body, body).toBe(
        '{"error":"repo and name are required."}'
      );
    }
  });

  it("answers a malformed save body with 400", async () => {
    const recording = await run(
      "POST",
      "/api/save-credential-profile",
      "not json",
      handleSaveCredentialProfile,
      dependencies()
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
  });

  it("reports a persistence failure as 400", async () => {
    const recording = await run(
      "POST",
      "/api/save-credential-profile",
      '{"repo":"octo/app","name":"prod"}',
      handleSaveCredentialProfile,
      dependencies({
        saveCredentialProfile: () => {
          throw new Error("disk full");
        }
      })
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"disk full"}');
  });

  it("serializes a rejected save as a null profile with 200", async () => {
    const recording = await run(
      "POST",
      "/api/save-credential-profile",
      '{"repo":"octo/app","name":"prod"}',
      handleSaveCredentialProfile,
      dependencies({ saveCredentialProfile: () => null })
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"success":true,"profile":null}');
  });

  // ── POST /api/delete-credential-profile (SU-07) ────────────────────────────

  it("deletes a profile and reports whether anything was removed", async () => {
    const deletes: [string, string][] = [];
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      '{"repo":"  octo/app  ","name":"  prod  "}',
      handleDeleteCredentialProfile,
      dependencies({
        deleteCredentialProfile: (repo, name) => {
          deletes.push([repo, name]);
          return true;
        }
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(recording.body).toBe('{"success":true,"removed":true}');
    expect(deletes).toEqual([["octo/app", "prod"]]);
  });

  it("reports an unknown profile as removed:false", async () => {
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      '{"repo":"octo/app","name":"gone"}',
      handleDeleteCredentialProfile,
      dependencies({ deleteCredentialProfile: () => false })
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"success":true,"removed":false}');
  });

  it("calls the store with empty strings instead of validating, unlike save", async () => {
    const deletes: [string, string][] = [];
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      "",
      handleDeleteCredentialProfile,
      dependencies({
        deleteCredentialProfile: (repo, name) => {
          deletes.push([repo, name]);
          return false;
        }
      })
    );
    // `save` answers 400 for the same body. That asymmetry is pre-existing and
    // deliberately preserved.
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"success":true,"removed":false}');
    expect(deletes).toEqual([["", ""]]);
  });

  it("answers a malformed delete body with 400", async () => {
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      "not json",
      handleDeleteCredentialProfile,
      dependencies()
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
  });

  it("reports a failing delete store as 400", async () => {
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      '{"repo":"octo/app","name":"prod"}',
      handleDeleteCredentialProfile,
      dependencies({
        deleteCredentialProfile: () => {
          throw new Error("disk full");
        }
      })
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"disk full"}');
  });

  // ── Truthy non-string inputs (SU-06, SU-07) ────────────────────────────────
  //
  // `(value || "").trim()` has no `trim` to call on a truthy non-string, so the
  // handler throws into its own catch and answers 400 *without* reaching the
  // port. A future refactor that coerced these to strings instead would switch
  // the account to "42", or write and delete a credential profile under a
  // stringified key, while still answering plausibly. The ports below succeed
  // when called, so only the recorded call count can fail these cases.

  it.each([
    ["numeric login", '{"login":42}'],
    ["boolean login", '{"login":true}'],
    ["array login", '{"login":["octocat"]}'],
    ["object login", '{"login":{"name":"octocat"}}']
  ])("rejects a %s without preparing an account", async (_label, body) => {
    const preparations: unknown[] = [];
    const recording = await run(
      "POST",
      "/api/github-account",
      body,
      handleGitHubAccount,
      dependencies({
        prepareGitHubAccount: async (input) => {
          preparations.push(input);
          throw new Error("unexpected account preparation");
        },
        getGitHubIdentity: () => Promise.resolve(identityFor("octocat"))
      })
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
    expect(preparations).toEqual([]);
  });

  it.each([
    ["numeric repo", '{"repo":42,"name":"prod"}'],
    ["boolean name", '{"repo":"octo/app","name":true}'],
    // The array case would coerce to a plausible-looking slug, so a coercing
    // refactor's response body would look correct while the write was wrong.
    ["array repo and name", '{"repo":["octo/app"],"name":["prod"]}'],
    ["object name", '{"repo":"octo/app","name":{"label":"prod"}}']
  ])("rejects a %s without saving a profile", async (_label, body) => {
    const saves: unknown[] = [];
    const recording = await run(
      "POST",
      "/api/save-credential-profile",
      body,
      handleSaveCredentialProfile,
      dependencies({
        saveCredentialProfile: (repo, profile) => {
          saves.push({ repo, profile });
          return { name: "prod" };
        }
      })
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
    expect(saves).toEqual([]);
  });

  it.each([
    ["numeric repo", '{"repo":42,"name":"prod"}'],
    ["boolean name", '{"repo":"octo/app","name":true}'],
    ["array repo and name", '{"repo":["octo/app"],"name":["prod"]}'],
    ["object name", '{"repo":"octo/app","name":{"label":"prod"}}']
  ])("rejects a %s without deleting a profile", async (_label, body) => {
    // The most consequential case: delete has no `!repo || !name` guard, so
    // under coercion a truthy non-string would reach the store and destroy a
    // profile the handler is supposed to reject.
    const deletes: unknown[] = [];
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      body,
      handleDeleteCredentialProfile,
      dependencies({
        deleteCredentialProfile: (repo, name) => {
          deletes.push([repo, name]);
          return true;
        }
      })
    );
    expect(recording.status).toBe(400);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(400));
    expect(JSON.parse(recording.body)).toHaveProperty("error");
    expect(deletes).toEqual([]);
  });

  // Falsy non-strings are a different path: `||` rescues them before `.trim()`,
  // so they reach the shared validation guard rather than throwing. That is the
  // documented save/delete asymmetry, and it is pinned so the two paths cannot
  // be conflated.

  it.each([
    ["zero repo", '{"repo":0,"name":"prod"}'],
    ["false name", '{"repo":"octo/app","name":false}'],
    ["null repo and name", '{"repo":null,"name":null}']
  ])(
    "rejects a %s by validation before the save store",
    async (_label, body) => {
      const saves: unknown[] = [];
      const recording = await run(
        "POST",
        "/api/save-credential-profile",
        body,
        handleSaveCredentialProfile,
        dependencies({
          saveCredentialProfile: (repo, profile) => {
            saves.push({ repo, profile });
            return { name: "prod" };
          }
        })
      );
      expect(recording.status).toBe(400);
      expect(recording.body).toBe('{"error":"repo and name are required."}');
      expect(saves).toEqual([]);
    }
  );

  it("passes falsy non-string delete fields to the store as empty strings", async () => {
    const deletes: [string, string][] = [];
    const recording = await run(
      "POST",
      "/api/delete-credential-profile",
      '{"repo":false,"name":0}',
      handleDeleteCredentialProfile,
      dependencies({
        deleteCredentialProfile: (repo, name) => {
          deletes.push([repo, name]);
          return false;
        }
      })
    );
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"success":true,"removed":false}');
    expect(deletes).toEqual([["", ""]]);
  });
});
