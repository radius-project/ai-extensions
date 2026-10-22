import { describe, expect, it } from "vitest";
import {
  assessSetupPackageWriteAccess,
  preflightSetupRepository,
  selectedSetupPackageIdentity,
  type SetupPackageIdentity
} from "./setup-github-preflight.js";

describe("setup package authorization", () => {
  const credentials = { username: "octo", source: "keyring" as const };
  const identity = selectedSetupPackageIdentity(credentials, {
    login: "octo",
    scopes: ["workflow", "write:packages"]
  });

  it.each([
    [
      "matching selected account",
      credentials,
      "octo",
      ["write:packages"],
      true
    ],
    [
      "different selected account",
      credentials,
      "other",
      ["write:packages"],
      false
    ],
    [
      "explicit empty scopes",
      { ...credentials, scopes: [] },
      "octo",
      ["write:packages"],
      false
    ],
    [
      "explicit package scopes",
      { ...credentials, scopes: ["write:packages"] },
      "other",
      [],
      true
    ],
    [
      "injected credential",
      { ...credentials, source: "injected-token" as const },
      "octo",
      [],
      false
    ]
  ])(
    "uses credential scope precedence: %s",
    (_, facts, login, scopes, expected) => {
      const result = selectedSetupPackageIdentity(facts, { login, scopes });
      expect(result.packagesHasWrite).toBe(expected);
      expect(result.accounts[0]).toEqual({
        login: facts.username,
        hasWorkflow: false,
        hasPackages: expected,
        acting: facts.username === login,
        switchable: facts.source === "keyring"
      });
      expect(result.reason).toBe("selected-account-executor");
    }
  );

  it.each<{
    name: string;
    patch: Partial<SetupPackageIdentity>;
    expected: "allowed" | "scope-required";
  }>([
    { name: "same credential", patch: {}, expected: "allowed" },
    {
      name: "same credential denied",
      patch: { packagesHasWrite: false },
      expected: "scope-required"
    },
    {
      name: "source mismatch uses account",
      patch: { packagesCredentialSource: "injected-token" },
      expected: "allowed"
    },
    {
      name: "login mismatch uses account",
      patch: { packagesLogin: "other" },
      expected: "allowed"
    },
    {
      name: "acting fallback",
      patch: { packagesLogin: "other", accounts: [] },
      expected: "allowed"
    },
    {
      name: "acting denied",
      patch: { packagesLogin: "other", accounts: [], actingHasPackages: false },
      expected: "scope-required"
    },
    {
      name: "unrelated identity",
      patch: { packagesLogin: "other", accounts: [], actingLogin: "other" },
      expected: "scope-required"
    }
  ])("$name", ({ patch, expected }) => {
    expect(
      assessSetupPackageWriteAccess(credentials, { ...identity, ...patch })
    ).toEqual({ kind: expected, login: "octo" });
  });

  it("rejects blank identity and trims a named credential", () => {
    for (const username of ["", "  "]) {
      expect(
        assessSetupPackageWriteAccess({ ...credentials, username }, identity)
      ).toEqual({ kind: "identity-missing" });
    }
    expect(
      assessSetupPackageWriteAccess(
        { ...credentials, username: " octo " },
        identity
      )
    ).toEqual({ kind: "allowed", login: "octo" });
    expect(identity.accounts[0].hasWorkflow).toBe(true);
  });
});

describe("setup repository preflight", () => {
  it.each([
    ["admin", true, { admin: true }, undefined, "allowed"],
    ["missing permissions", true, undefined, undefined, "account-denied"],
    ["malformed permissions", true, "invalid", undefined, "account-denied"],
    ["not admin", true, { admin: false }, undefined, "account-denied"],
    ["inaccessible", false, undefined, 404, "account-denied"],
    ["transient", false, undefined, 500, "ambiguous"]
  ])("%s", async (_, ok, permissions, status, kind) => {
    const calls: string[] = [];
    const result = await preflightSetupRepository("octo/app", {
      read: async (path) => {
        calls.push(path);
        return path === "user" ?
            { ok: true, json: { login: "octo" } }
          : { ok, status, json: { permissions } };
      },
      fallbackLogin: async () => {
        throw new Error("unexpected fallback");
      },
      isAppLogin: () => false,
      probes: [],
      optionalString: (value) => (typeof value === "string" ? value : ""),
      record: (value) => Object(value)
    });
    expect(result.kind).toBe(kind);
    expect(calls).toEqual(["user", "repos/octo/app"]);
  });

  it.each([
    ["inaccessible repository", 404, [], "app-denied", undefined],
    ["permitted probes", 200, [200, 200], "allowed", undefined],
    ["explicit forbidden", 200, [200, 403], "app-denied", "Variables"],
    ["explicit missing", 200, [404], "app-denied", "Environments"],
    ["ambiguous probe", 200, [503], "ambiguous", undefined]
  ])("%s", async (_, repoStatus, statuses, kind, permission) => {
    const calls: string[] = [];
    let probe = 0;
    const result = await preflightSetupRepository("octo/app", {
      read: async (path) => {
        calls.push(path);
        if (path === "user") return { ok: false };
        if (path === "repos/octo/app")
          return { ok: repoStatus === 200, status: repoStatus };
        const status = statuses[probe++];
        if (status === undefined) throw new Error("unexpected probe");
        return { ok: status === 200, status };
      },
      fallbackLogin: async () => {
        calls.push("fallback");
        return "app[bot]";
      },
      isAppLogin: (login) => login === "app[bot]",
      probes: [
        { path: (repo) => `${repo}/environments`, permission: "Environments" },
        { path: (repo) => `${repo}/variables`, permission: "Variables" }
      ],
      optionalString: () => {
        throw new Error("unexpected user response");
      },
      record: (value) => Object(value)
    });
    expect(result.kind).toBe(kind);
    if (result.kind === "app-denied")
      expect(result.permission).toBe(permission);
    expect(calls.slice(0, 3)).toEqual(["user", "fallback", "repos/octo/app"]);
    expect(probe).toBe(statuses.length);
  });
});
