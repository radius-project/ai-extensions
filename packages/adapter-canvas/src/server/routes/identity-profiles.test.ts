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
    preferredLogin: null,
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
    switchGhAccount: () => {
      throw new Error("switchGhAccount not stubbed");
    },
    setPreferredGitHubLogin: () => {
      throw new Error("setPreferredGitHubLogin not stubbed");
    },
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

// The identity ports, wired as one discriminating group. `getGitHubIdentity`
// answers with whatever `setPreferredGitHubLogin` last recorded, so a handler
// that re-reads the identity *before* persisting the choice returns a
// different, detectably-stale payload.
function identityPorts(
  calls: Calls,
  options: {
    initialLogin?: string;
    switchResult?: { ok: boolean; error?: string };
    switchThrows?: Error;
    identityThrows?: Error;
    preflight?: string | Error;
    validSlugs?: string[];
  } = {}
): Partial<IdentityProfilesDependencies> {
  let currentLogin = options.initialLogin ?? "initial-login";
  return {
    resetGhIdentityCache: () => {
      calls.log.push("resetGhIdentityCache");
    },
    getGitHubIdentity: () => {
      calls.log.push(`getGitHubIdentity->${currentLogin}`);
      if (options.identityThrows) return Promise.reject(options.identityThrows);
      return Promise.resolve(identityFor(currentLogin));
    },
    switchGhAccount: (login) => {
      calls.log.push(`switchGhAccount(${login})`);
      if (options.switchThrows) return Promise.reject(options.switchThrows);
      return Promise.resolve(options.switchResult ?? { ok: true });
    },
    setPreferredGitHubLogin: (login) => {
      calls.log.push(`setPreferredGitHubLogin(${login})`);
      currentLogin = login;
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

  it("persists the chosen login before re-reading the identity", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "POST",
      "/api/github-account",
      '{"login":"  octocat  "}',
      handleGitHubAccount,
      dependencies(identityPorts(calls))
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE(200));
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      identity: identityFor("octocat")
    });
    // The identity read reports `octocat`, which is only possible if the
    // preference was persisted first.
    expect(calls.log).toEqual([
      "switchGhAccount(octocat)",
      "setPreferredGitHubLogin(octocat)",
      "getGitHubIdentity->octocat"
    ]);
  });

  it("answers a failed switch with 400 and the reported reason", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "POST",
      "/api/github-account",
      '{"login":"ghost"}',
      handleGitHubAccount,
      dependencies(
        identityPorts(calls, {
          switchResult: { ok: false, error: "no such account" }
        })
      )
    );
    // 400, not a 200 error payload — and nothing is persisted.
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"no such account"}');
    expect(calls.log).toEqual(["switchGhAccount(ghost)"]);
  });

  it("supplies a default message when the failed switch reports none", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "POST",
      "/api/github-account",
      '{"login":"ghost"}',
      handleGitHubAccount,
      dependencies(identityPorts(calls, { switchResult: { ok: false } }))
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe('{"error":"Failed to switch account."}');
  });

  it("treats an empty body as an empty login rather than a parse failure", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "POST",
      "/api/github-account",
      "",
      handleGitHubAccount,
      dependencies(
        identityPorts(calls, {
          switchResult: {
            ok: false,
            error: "A GitHub account login is required."
          }
        })
      )
    );
    // The rejection comes from the switch port, not from JSON.parse.
    expect(calls.log).toEqual(["switchGhAccount()"]);
    expect(recording.status).toBe(400);
    expect(recording.body).toBe(
      '{"error":"A GitHub account login is required."}'
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

  it("answers a throwing switch with 400", async () => {
    const calls: Calls = { log: [] };
    const recording = await run(
      "POST",
      "/api/github-account",
      '{"login":"octocat"}',
      handleGitHubAccount,
      dependencies(identityPorts(calls, { switchThrows: new Error("spawn") }))
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
});

// ── Differential oracle ──────────────────────────────────────────────────────
// Verbatim transcriptions of the five branches deleted from the legacy if-chain
// in `server.ts`, kept only so the migrated handlers can be proven identical
// while the fallback still exists. Each side is driven separately against its
// own fakes and the two recordings are compared afterwards — never through a
// single shared runner, because several of these paths throw or return early
// and a shared runner can pass while only exercising one side.

interface LegacyPorts {
  listCredentialProfiles: IdentityProfilesDependencies["listCredentialProfiles"];
  saveCredentialProfile: IdentityProfilesDependencies["saveCredentialProfile"];
  deleteCredentialProfile: IdentityProfilesDependencies["deleteCredentialProfile"];
  getGitHubIdentity: IdentityProfilesDependencies["getGitHubIdentity"];
  resetGhIdentityCache: IdentityProfilesDependencies["resetGhIdentityCache"];
  switchGhAccount: IdentityProfilesDependencies["switchGhAccount"];
  setPreferredGitHubLogin: IdentityProfilesDependencies["setPreferredGitHubLogin"];
  preflightRepoAdmin: IdentityProfilesDependencies["preflightRepoAdmin"];
  isValidRepoSlug: IdentityProfilesDependencies["isValidRepoSlug"];
}

function legacyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function legacyCredentialProfiles(
  url: URL,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): void {
  const repo = url.searchParams.get("repo") || "";
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(
    JSON.stringify({ profiles: repo ? ports.listCredentialProfiles(repo) : [] })
  );
}

async function legacyGitHubIdentity(
  url: URL,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  res.setHeader("Content-Type", "application/json");
  try {
    if (url.searchParams.get("fresh") === "1") ports.resetGhIdentityCache();
    const identity = await ports.getGitHubIdentity();
    const repoParam = (url.searchParams.get("repo") || "").trim();
    if (repoParam && ports.isValidRepoSlug(repoParam)) {
      try {
        const accessMsg = await ports.preflightRepoAdmin(repoParam);
        if (accessMsg) identity.repoAccess = accessMsg;
      } catch {
        /* preflight is advisory here; never fail identity on it */
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify(identity));
  } catch (e) {
    res.writeHead(200);
    res.end(JSON.stringify({ error: legacyErrorMessage(e), accounts: [] }));
  }
}

async function legacyGitHubAccount(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  res.setHeader("Content-Type", "application/json");
  try {
    const data = JSON.parse(body || "{}");
    const login = (data.login || "").trim();
    const result = await ports.switchGhAccount(login);
    if (!result.ok) {
      res.writeHead(400);
      res.end(
        JSON.stringify({ error: result.error || "Failed to switch account." })
      );
      return;
    }
    ports.setPreferredGitHubLogin(login);
    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        identity: await ports.getGitHubIdentity()
      })
    );
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: legacyErrorMessage(e) }));
  }
}

async function legacySaveCredentialProfile(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  try {
    const data = JSON.parse(body || "{}");
    const repo = (data.repo || "").trim();
    const name = (data.name || "").trim();
    if (!repo || !name) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(400);
      res.end(JSON.stringify({ error: "repo and name are required." }));
      return;
    }
    const saved = ports.saveCredentialProfile(repo, data);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, profile: saved }));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: legacyErrorMessage(e) }));
  }
}

async function legacyDeleteCredentialProfile(
  body: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  try {
    const data = JSON.parse(body || "{}");
    const repo = (data.repo || "").trim();
    const name = (data.name || "").trim();
    const removed = ports.deleteCredentialProfile(repo, name);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, removed }));
  } catch (e) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(JSON.stringify({ error: legacyErrorMessage(e) }));
  }
}

type Route =
  | "credential-profiles"
  | "github-identity"
  | "github-account"
  | "save-credential-profile"
  | "delete-credential-profile";

interface DifferentialCase {
  route: Route;
  query?: string;
  body?: string;
  profiles?: Record<string, { name: string }[]>;
  throwingStore?: boolean;
  saveResult?: "profile" | "null";
  removed?: boolean;
  identity?: Parameters<typeof identityPorts>[1];
}

interface Side {
  recording: Recording;
  calls: string[];
  thrown: string | null;
  // Recorded rather than inferred. A side that never ran leaves this false, and
  // `compare` asserts it on BOTH sides — that is what stops a case from
  // silently degenerating into a one-sided test when one implementation throws
  // or short-circuits before the other is reached.
  ran: boolean;
}

// Compares two independently produced outcomes. Neither side is ever driven
// through a shared runner, so a throw on one cannot prevent the other from
// being exercised.
function compare(legacy: Side, migrated: Side): void {
  expect(legacy.ran, "legacy side was not driven").toBe(true);
  expect(migrated.ran, "migrated side was not driven").toBe(true);
  expect(migrated.thrown).toEqual(legacy.thrown);
  expect(migrated.recording).toEqual(legacy.recording);
  expect(migrated.calls).toEqual(legacy.calls);
}

// Builds one independent set of fakes. Each side of the comparison gets its own
// so a mutation on one side cannot be masked by shared state.
function differentialPorts(input: DifferentialCase): {
  calls: Calls;
  ports: LegacyPorts;
  deps: IdentityProfilesDependencies;
} {
  const calls: Calls = { log: [] };
  const store: Partial<IdentityProfilesDependencies> = {
    listCredentialProfiles: (repo) => {
      calls.log.push(`listCredentialProfiles(${repo})`);
      if (input.throwingStore) throw new Error("store unavailable");
      return input.profiles?.[repo] ?? [];
    },
    saveCredentialProfile: (repo, profile) => {
      calls.log.push(
        `saveCredentialProfile(${repo},${JSON.stringify(profile)})`
      );
      if (input.throwingStore) throw new Error("store unavailable");
      return input.saveResult === "null" ?
          null
        : { name: `saved-in-${repo}`, status: "verified" };
    },
    deleteCredentialProfile: (repo, name) => {
      calls.log.push(`deleteCredentialProfile(${repo},${name})`);
      if (input.throwingStore) throw new Error("store unavailable");
      return input.removed ?? false;
    }
  };
  const deps = dependencies({
    ...store,
    ...identityPorts(calls, input.identity ?? {})
  });
  return {
    calls,
    ports: {
      listCredentialProfiles: deps.listCredentialProfiles,
      saveCredentialProfile: deps.saveCredentialProfile,
      deleteCredentialProfile: deps.deleteCredentialProfile,
      getGitHubIdentity: deps.getGitHubIdentity,
      resetGhIdentityCache: deps.resetGhIdentityCache,
      switchGhAccount: deps.switchGhAccount,
      setPreferredGitHubLogin: deps.setPreferredGitHubLogin,
      preflightRepoAdmin: deps.preflightRepoAdmin,
      isValidRepoSlug: deps.isValidRepoSlug
    },
    deps
  };
}

const LEGACY_TRANSCRIPTIONS: Record<
  Route,
  (
    url: URL,
    body: string,
    res: ServerResponse<IncomingMessage>,
    ports: LegacyPorts
  ) => void | Promise<void>
> = {
  "credential-profiles": (url, _body, res, ports) =>
    legacyCredentialProfiles(url, res, ports),
  "github-identity": (url, _body, res, ports) =>
    legacyGitHubIdentity(url, res, ports),
  "github-account": (_url, body, res, ports) =>
    legacyGitHubAccount(body, res, ports),
  "save-credential-profile": (_url, body, res, ports) =>
    legacySaveCredentialProfile(body, res, ports),
  "delete-credential-profile": (_url, body, res, ports) =>
    legacyDeleteCredentialProfile(body, res, ports)
};

async function recordLegacy(input: DifferentialCase): Promise<Side> {
  const { calls, ports } = differentialPorts(input);
  const { recording, response } = recorder();
  const url = new URL(
    `/api/${input.route}${input.query ?? ""}`,
    "http://localhost"
  );
  const body = input.body ?? "";
  // Looked up rather than branched, so an unmapped route leaves `ran` false
  // instead of falling through to some other transcription.
  const transcription = LEGACY_TRANSCRIPTIONS[input.route];
  if (!transcription) {
    return { recording, calls: calls.log, thrown: null, ran: false };
  }
  let ran = false;
  try {
    ran = true;
    await transcription(url, body, response, ports);
  } catch (e) {
    return {
      recording,
      calls: calls.log,
      thrown: legacyErrorMessage(e),
      ran
    };
  }
  return { recording, calls: calls.log, thrown: null, ran };
}

const HANDLERS: Record<Route, { method: string; handler: Handler }> = {
  "credential-profiles": { method: "GET", handler: handleCredentialProfiles },
  "github-identity": { method: "GET", handler: handleGitHubIdentity },
  "github-account": { method: "POST", handler: handleGitHubAccount },
  "save-credential-profile": {
    method: "POST",
    handler: handleSaveCredentialProfile
  },
  "delete-credential-profile": {
    method: "POST",
    handler: handleDeleteCredentialProfile
  }
};

async function recordMigrated(input: DifferentialCase): Promise<Side> {
  const { calls, deps } = differentialPorts(input);
  const registered = HANDLERS[input.route];
  const { recording, response } = recorder();
  // Resolved from the registry the production route module exports, so a route
  // this harness forgot to wire leaves `ran` false rather than quietly
  // comparing two empty recordings.
  if (!registered) {
    return { recording, calls: calls.log, thrown: null, ran: false };
  }
  const context = createRequestContext(
    request(
      registered.method,
      `/api/${input.route}${input.query ?? ""}`,
      input.body ?? ""
    ),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  let ran = false;
  try {
    ran = true;
    await registered.handler(context, deps);
  } catch (e) {
    return {
      recording,
      calls: calls.log,
      thrown: legacyErrorMessage(e),
      ran
    };
  }
  return { recording, calls: calls.log, thrown: null, ran };
}

describe("identity-profiles legacy/migrated differential contract", () => {
  it.each<[string, DifferentialCase]>([
    [
      "populated repo",
      {
        route: "credential-profiles",
        query: "?repo=octo/app",
        profiles: { "octo/app": [{ name: "prod" }] }
      }
    ],
    [
      "unknown repo",
      { route: "credential-profiles", query: "?repo=octo/other" }
    ],
    ["absent repo parameter", { route: "credential-profiles" }],
    ["empty repo parameter", { route: "credential-profiles", query: "?repo=" }],
    [
      "throwing store",
      {
        route: "credential-profiles",
        query: "?repo=octo/app",
        throwingStore: true
      }
    ]
  ])("matches /api/credential-profiles for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    ["plain resolution", { route: "github-identity" }],
    ["fresh re-check", { route: "github-identity", query: "?fresh=1" }],
    ["non-1 fresh value", { route: "github-identity", query: "?fresh=yes" }],
    [
      "valid repo with a preflight message",
      {
        route: "github-identity",
        query: "?repo=octo/app",
        identity: { validSlugs: ["octo/app"], preflight: "write, not admin" }
      }
    ],
    [
      "valid repo with a silent preflight",
      {
        route: "github-identity",
        query: "?repo=octo/app",
        identity: { validSlugs: ["octo/app"], preflight: "" }
      }
    ],
    [
      "invalid repo slug",
      { route: "github-identity", query: "?repo=nonsense", identity: {} }
    ],
    ["whitespace repo", { route: "github-identity", query: "?repo=%20" }],
    [
      "throwing preflight",
      {
        route: "github-identity",
        query: "?repo=octo/app",
        identity: {
          validSlugs: ["octo/app"],
          preflight: new Error("rate limited")
        }
      }
    ],
    [
      "failing identity resolution",
      {
        route: "github-identity",
        identity: { identityThrows: new Error("gh unavailable") }
      }
    ],
    [
      "fresh re-check with a failing resolution",
      {
        route: "github-identity",
        query: "?fresh=1",
        identity: { identityThrows: new Error("gh unavailable") }
      }
    ]
  ])("matches /api/github-identity for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    [
      "successful switch",
      { route: "github-account", body: '{"login":"octocat"}' }
    ],
    [
      "untrimmed login",
      { route: "github-account", body: '{"login":"  octocat  "}' }
    ],
    [
      "failed switch with a reason",
      {
        route: "github-account",
        body: '{"login":"ghost"}',
        identity: { switchResult: { ok: false, error: "no such account" } }
      }
    ],
    [
      "failed switch without a reason",
      {
        route: "github-account",
        body: '{"login":"ghost"}',
        identity: { switchResult: { ok: false } }
      }
    ],
    [
      "empty body",
      {
        route: "github-account",
        body: "",
        identity: { switchResult: { ok: false, error: "login required" } }
      }
    ],
    [
      "missing login field",
      {
        route: "github-account",
        body: "{}",
        identity: { switchResult: { ok: false } }
      }
    ],
    ["malformed body", { route: "github-account", body: "not json" }],
    ["null body", { route: "github-account", body: "null" }],
    [
      "throwing switch",
      {
        route: "github-account",
        body: '{"login":"octocat"}',
        identity: { switchThrows: new Error("spawn failed") }
      }
    ],
    [
      "throwing identity re-read after a successful switch",
      {
        route: "github-account",
        body: '{"login":"octocat"}',
        identity: { identityThrows: new Error("gh unavailable") }
      }
    ]
  ])("matches /api/github-account for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    [
      "complete profile",
      {
        route: "save-credential-profile",
        body: '{"repo":"octo/app","name":"prod","provider":"aws"}'
      }
    ],
    [
      "untrimmed fields",
      {
        route: "save-credential-profile",
        body: '{"repo":"  octo/app  ","name":"  prod  "}'
      }
    ],
    [
      "store-rejected profile",
      {
        route: "save-credential-profile",
        body: '{"repo":"octo/app","name":"prod"}',
        saveResult: "null"
      }
    ],
    ["missing both fields", { route: "save-credential-profile", body: "{}" }],
    [
      "missing name",
      { route: "save-credential-profile", body: '{"repo":"octo/app"}' }
    ],
    [
      "missing repo",
      { route: "save-credential-profile", body: '{"name":"prod"}' }
    ],
    [
      "whitespace-only name",
      {
        route: "save-credential-profile",
        body: '{"repo":"octo/app","name":"   "}'
      }
    ],
    ["empty body", { route: "save-credential-profile", body: "" }],
    ["malformed body", { route: "save-credential-profile", body: "not json" }],
    ["null body", { route: "save-credential-profile", body: "null" }],
    [
      "throwing store",
      {
        route: "save-credential-profile",
        body: '{"repo":"octo/app","name":"prod"}',
        throwingStore: true
      }
    ]
  ])("matches /api/save-credential-profile for a %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    [
      "removed profile",
      {
        route: "delete-credential-profile",
        body: '{"repo":"octo/app","name":"prod"}',
        removed: true
      }
    ],
    [
      "unknown profile",
      {
        route: "delete-credential-profile",
        body: '{"repo":"octo/app","name":"gone"}'
      }
    ],
    [
      "untrimmed fields",
      {
        route: "delete-credential-profile",
        body: '{"repo":"  octo/app  ","name":"  prod  "}',
        removed: true
      }
    ],
    // The unvalidated cases below are the asymmetry with `save`: they reach the
    // store instead of answering 400.
    ["missing both fields", { route: "delete-credential-profile", body: "{}" }],
    ["empty body", { route: "delete-credential-profile", body: "" }],
    [
      "missing name",
      { route: "delete-credential-profile", body: '{"repo":"octo/app"}' }
    ],
    [
      "malformed body",
      { route: "delete-credential-profile", body: "not json" }
    ],
    ["null body", { route: "delete-credential-profile", body: "null" }],
    [
      "throwing store",
      {
        route: "delete-credential-profile",
        body: '{"repo":"octo/app","name":"prod"}',
        throwingStore: true
      }
    ]
  ])(
    "matches /api/delete-credential-profile for a %s",
    async (_label, input) => {
      const legacy = await recordLegacy(input);
      const migrated = await recordMigrated(input);
      compare(legacy, migrated);
    }
  );
});
