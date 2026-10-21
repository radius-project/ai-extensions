import { describe, expect, it } from "vitest";
import {
  callerObjectIdArgs,
  classifyGitHubEnvironmentProbe,
  evaluateSeededAppGate,
  findAppReuseProblems,
  findRefusalProblems,
  findSeededAppMutationProblems,
  findSeededAppPreconditionProblems,
  FOREIGN_APP_FAILURE_CODES,
  FOREIGN_APP_NAME_VARIABLE,
  ORPHAN_APP_FAILURE_CODES,
  probeEnvironmentName,
  readCallerObjectId,
  readDirectoryObjectIds,
  readFederatedCredentials,
  readOperationFailureCode,
  readOrphanEnvironmentName,
  readSingleAppRegistration,
  SIGNED_OUT_FAILURE_CODES,
  SEED_SENTINEL_CREDENTIAL,
  type SeededAppSnapshot,
  withEnvironmentOverride
} from "./environment-edge-cases.js";

const REPOSITORY = "radius-project/ai-extensions-fixture";
const CALLER = "11111111-2222-3333-4444-555555555555";
const SENTINEL = { id: "sentinel-id", ...SEED_SENTINEL_CREDENTIAL };

function snapshot(
  overrides: Partial<SeededAppSnapshot> = {}
): SeededAppSnapshot {
  return {
    appId: "app-1",
    objectId: "obj-1",
    tags: [],
    ownerIds: ["99999999-0000-0000-0000-000000000000"],
    federatedCredentials: [SENTINEL],
    ...overrides
  };
}

describe("readOperationFailureCode", () => {
  it("reads the trimmed failure code", () => {
    expect(
      readOperationFailureCode({
        operation: { failure: { code: " az-not-logged-in " } }
      })
    ).toBe("az-not-logged-in");
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { operation: null },
    { operation: { failure: null } },
    { operation: { failure: { code: 7 } } }
  ])("returns an empty string when no code is recorded: %j", (payload) => {
    expect(readOperationFailureCode(payload)).toBe("");
  });
});

describe("findRefusalProblems", () => {
  it("accepts a failed operation with an expected code", () => {
    expect(
      findRefusalProblems({
        state: "failed",
        failureCode: "az-subscription-set-failed",
        expectedCodes: SIGNED_OUT_FAILURE_CODES
      })
    ).toEqual([]);
  });

  it("reports a success and a missing code", () => {
    expect(
      findRefusalProblems({
        state: "succeeded",
        failureCode: "",
        expectedCodes: FOREIGN_APP_FAILURE_CODES
      })
    ).toEqual([
      'The operation ended "succeeded", but it must end "failed".',
      'The operation failed with code "<none>", but it must be one of: app-registration-not-owned.'
    ]);
  });

  it("reports an unexpected code", () => {
    expect(
      findRefusalProblems({
        state: "failed",
        failureCode: "app-registration-not-owned",
        expectedCodes: ORPHAN_APP_FAILURE_CODES
      })
    ).toEqual([
      'The operation failed with code "app-registration-not-owned", but it must be one of: app-registration-radius-orphaned.'
    ]);
  });
});

describe("evaluateSeededAppGate", () => {
  it("enables the probe with the trimmed name", () => {
    expect(evaluateSeededAppGate(FOREIGN_APP_NAME_VARIABLE, " seed ")).toEqual({
      enabled: true,
      appName: "seed"
    });
  });

  it.each([undefined, "", "   "])("skips with a reason for %j", (value) => {
    const gate = evaluateSeededAppGate(FOREIGN_APP_NAME_VARIABLE, value);
    expect(gate.enabled).toBe(false);
    if (!gate.enabled) {
      expect(gate.reason).toContain(FOREIGN_APP_NAME_VARIABLE);
      expect(gate.reason).toContain("CLOUD_E2E_RUNBOOK.md");
    }
  });
});

describe("readSingleAppRegistration", () => {
  it("reads the one application with that name and sorts its tags", () => {
    expect(
      readSingleAppRegistration(
        [
          { displayName: "other", appId: "x", id: "y" },
          null,
          {
            displayName: "seed",
            appId: " app ",
            id: " obj ",
            tags: ["b", " a ", "", 4, "b"]
          }
        ],
        "seed"
      )
    ).toEqual({ appId: "app", objectId: "obj", tags: ["a", "b"] });
  });

  it("treats missing tags as none", () => {
    expect(
      readSingleAppRegistration(
        [{ displayName: "seed", appId: "app", id: "obj" }],
        "seed"
      ).tags
    ).toEqual([]);
  });

  it("refuses a payload that is not a list", () => {
    expect(() => readSingleAppRegistration({}, "seed")).toThrow(
      "did not return a list"
    );
  });

  it.each([
    [[], 0],
    [
      [
        { displayName: "seed", appId: "a", id: "1" },
        { displayName: "seed", appId: "b", id: "2" }
      ],
      2
    ]
  ])("refuses %j because it does not have exactly one match", (payload, n) => {
    expect(() => readSingleAppRegistration(payload, "seed")).toThrow(
      `found ${n} applications named "seed"`
    );
  });

  it("refuses an application with no app id or object id", () => {
    expect(() =>
      readSingleAppRegistration([{ displayName: "seed", id: "1" }], "seed")
    ).toThrow('returned no "appId"');
    expect(() =>
      readSingleAppRegistration([{ displayName: "seed", appId: "a" }], "seed")
    ).toThrow('returned no "id"');
  });
});

describe("readDirectoryObjectIds", () => {
  it("returns sorted, unique ids", () => {
    expect(
      readDirectoryObjectIds([{ id: "b" }, { id: "a" }, { id: "b" }], "owners")
    ).toEqual(["a", "b"]);
  });

  it("refuses a payload that is not a list or an entry with no id", () => {
    expect(() => readDirectoryObjectIds(null, "owners")).toThrow(
      "owners did not return a list."
    );
    expect(() => readDirectoryObjectIds([{}], "owners")).toThrow(
      'owners returned no "id".'
    );
  });
});

describe("readFederatedCredentials", () => {
  it("preserves complete credentials and sorts audiences and records", () => {
    expect(
      readFederatedCredentials(
        [{ ...SENTINEL, id: "z", audiences: ["b", "a"] }, SENTINEL],
        "fic"
      )
    ).toEqual([SENTINEL, { ...SENTINEL, id: "z", audiences: ["a", "b"] }]);
  });

  it("refuses a payload that is not a list", () => {
    expect(() => readFederatedCredentials("x", "fic")).toThrow(
      "fic did not return a list."
    );
  });

  it.each(["id", "name", "issuer", "subject"])(
    "rejects a missing %s",
    (field) => {
      expect(() =>
        readFederatedCredentials([{ ...SENTINEL, [field]: "" }], "fic")
      ).toThrow(`returned no "${field}"`);
    }
  );

  it.each([undefined, [], "audience", [4]])(
    "rejects invalid audiences %j",
    (audiences) => {
      expect(() =>
        readFederatedCredentials([{ ...SENTINEL, audiences }], "fic")
      ).toThrow();
    }
  );

  it("rejects a null entry", () => {
    expect(() => readFederatedCredentials([null], "fic")).toThrow();
  });
});

describe("findSeededAppMutationProblems", () => {
  it("accepts an unchanged application", () => {
    expect(findSeededAppMutationProblems(snapshot(), snapshot())).toEqual([]);
  });

  it("reports every change", () => {
    expect(
      findSeededAppMutationProblems(
        snapshot(),
        snapshot({
          objectId: "obj-2",
          tags: ["radius-managed"],
          ownerIds: [CALLER],
          federatedCredentials: []
        })
      )
    ).toEqual([
      "The application identity changed from app-1/obj-1 to app-1/obj-2.",
      "The tags changed from [] to [radius-managed].",
      `The owners changed from [99999999-0000-0000-0000-000000000000] to [${CALLER}].`,
      `The federated credentials changed from [${JSON.stringify(SENTINEL)}] to [].`
    ]);
  });

  it("reports a changed app id", () => {
    expect(
      findSeededAppMutationProblems(snapshot(), snapshot({ appId: "app-2" }))
    ).toHaveLength(1);
  });

  it.each([
    { id: "replacement-id" },
    { name: "replacement-name" },
    { issuer: "https://changed.invalid" },
    { audiences: ["changed-audience"] }
  ])(
    "detects a trust or identity change with the same subject: %j",
    (change) => {
      expect(
        findSeededAppMutationProblems(
          snapshot(),
          snapshot({
            federatedCredentials: [{ ...SENTINEL, ...change }]
          })
        )
      ).toHaveLength(1);
    }
  );

  it("detects an added credential with the same subject", () => {
    expect(
      findSeededAppMutationProblems(
        snapshot(),
        snapshot({
          federatedCredentials: [SENTINEL, { ...SENTINEL, id: "extra" }]
        })
      )
    ).toHaveLength(1);
  });
});

describe("findSeededAppPreconditionProblems", () => {
  const orphanTags = [
    "radius-managed",
    `radius-repo:${REPOSITORY.toUpperCase()}`,
    "radius-environment:radtest-orphan"
  ];

  it.each([
    { federatedCredentials: [] },
    { federatedCredentials: [{ ...SENTINEL, id: "" }] },
    { federatedCredentials: [{ ...SENTINEL, name: "wrong" }] },
    {
      federatedCredentials: [
        { ...SENTINEL, issuer: "https://token.actions.githubusercontent.com" }
      ]
    },
    {
      federatedCredentials: [
        { ...SENTINEL, subject: "repo:real/repo:environment:prod" }
      ]
    },
    { federatedCredentials: [{ ...SENTINEL, audiences: [] }] },
    { federatedCredentials: [{ ...SENTINEL, audiences: ["wrong"] }] }
  ])(
    "rejects a missing or changed sentinel: %j",
    ({ federatedCredentials }) => {
      expect(
        findSeededAppPreconditionProblems({
          kind: "foreign",
          snapshot: snapshot({ federatedCredentials }),
          callerObjectId: CALLER,
          repository: REPOSITORY
        })
      ).toEqual([
        expect.stringContaining("needs the sentinel federated credential")
      ]);
    }
  );

  it("accepts a correct foreign seed", () => {
    expect(
      findSeededAppPreconditionProblems({
        kind: "foreign",
        snapshot: snapshot(),
        callerObjectId: CALLER,
        repository: REPOSITORY
      })
    ).toEqual([]);
  });

  it("rejects a foreign seed the caller owns or Radius tagged", () => {
    expect(
      findSeededAppPreconditionProblems({
        kind: "foreign",
        snapshot: snapshot({ ownerIds: [CALLER], tags: ["radius-managed"] }),
        callerObjectId: CALLER,
        repository: REPOSITORY
      })
    ).toEqual([
      `The CI identity ${CALLER} owns the seeded foreign application, so the product would reuse it.`,
      'The seeded foreign application has the "radius-managed" tag; remove it, or the product reports an orphan.'
    ]);
  });

  it("accepts a correct orphan seed, comparing the repository without case", () => {
    expect(
      findSeededAppPreconditionProblems({
        kind: "orphan",
        snapshot: snapshot({ tags: orphanTags }),
        callerObjectId: CALLER,
        repository: REPOSITORY
      })
    ).toEqual([]);
  });

  it("rejects an orphan seed without the Radius tags", () => {
    expect(
      findSeededAppPreconditionProblems({
        kind: "orphan",
        snapshot: snapshot({ ownerIds: [CALLER] }),
        callerObjectId: CALLER,
        repository: REPOSITORY
      })
    ).toEqual([
      `The CI identity ${CALLER} owns the seeded orphan application, so the product would reuse it.`,
      'The seeded orphan application needs the "radius-managed" tag.',
      `The seeded orphan application needs the tag "radius-repo:${REPOSITORY}", but it has "<none>".`,
      'The seeded orphan application needs a "radius-environment:<environment>" tag.'
    ]);
  });

  it("rejects an orphan seed tagged for another repository", () => {
    expect(
      findSeededAppPreconditionProblems({
        kind: "orphan",
        snapshot: snapshot({
          tags: [
            "radius-managed",
            "radius-repo:other/repo",
            "radius-environment:e"
          ]
        }),
        callerObjectId: CALLER,
        repository: REPOSITORY
      })
    ).toEqual([
      `The seeded orphan application needs the tag "radius-repo:${REPOSITORY}", but it has "other/repo".`
    ]);
  });
});

describe("readOrphanEnvironmentName", () => {
  it("reads the environment from the tag", () => {
    expect(
      readOrphanEnvironmentName(["radius-managed", "radius-environment: env "])
    ).toBe("env");
  });

  it("refuses tags with no environment", () => {
    expect(() => readOrphanEnvironmentName(["radius-environment:"])).toThrow(
      'has no "radius-environment:" tag'
    );
  });
});

describe("callerObjectIdArgs", () => {
  it("looks up a service principal by its client id", () => {
    expect(
      callerObjectIdArgs({
        principalType: "servicePrincipal",
        principalName: "client-id"
      })
    ).toEqual([
      "ad",
      "sp",
      "show",
      "--id",
      "client-id",
      "--query",
      "id",
      "-o",
      "tsv"
    ]);
  });

  it("looks up a user through the signed-in user", () => {
    expect(
      callerObjectIdArgs({ principalType: "user", principalName: "a@b.c" })
    ).toEqual(["ad", "signed-in-user", "show", "--query", "id", "-o", "tsv"]);
  });
});

describe("readCallerObjectId", () => {
  it("returns the lower-case GUID", () => {
    expect(readCallerObjectId(` ${CALLER.toUpperCase()}\n`)).toBe(CALLER);
  });

  it("refuses output that is not a GUID", () => {
    expect(() => readCallerObjectId("nope")).toThrow('returned "nope"');
  });
});

describe("probeEnvironmentName", () => {
  it("adds the suffix to the run's name", () => {
    expect(probeEnvironmentName("radtest-1", "signed-out")).toBe(
      "radtest-1-signed-out"
    );
  });

  it("refuses a name GitHub would reject", () => {
    expect(() => probeEnvironmentName("r".repeat(250), "suffix")).toThrow(
      "longer than 255 characters"
    );
  });
});

describe("classifyGitHubEnvironmentProbe", () => {
  it("reads success as present", () => {
    expect(
      classifyGitHubEnvironmentProbe({ code: 0, stdout: "{}", stderr: "" }, "e")
    ).toBe("present");
  });

  it("reads a 404 as absent", () => {
    expect(
      classifyGitHubEnvironmentProbe(
        { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" },
        "e"
      )
    ).toBe("absent");
  });

  it("throws on any other failure", () => {
    expect(() =>
      classifyGitHubEnvironmentProbe(
        { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)" },
        "e"
      )
    ).toThrow('Could not determine whether GitHub Environment "e" exists');
    expect(() =>
      classifyGitHubEnvironmentProbe(
        { code: 2, stdout: "boom", stderr: "" },
        "e"
      )
    ).toThrow("gh exited 2: boom");
  });
});

describe("findAppReuseProblems", () => {
  it("accepts the same application", () => {
    expect(
      findAppReuseProblems(
        { appId: "a", objectId: "o" },
        { appId: "a", objectId: "o" }
      )
    ).toEqual([]);
  });

  it.each([[{ appId: "b", objectId: "o" }], [{ appId: "a", objectId: "p" }]])(
    "reports a different application %j",
    (reused) => {
      expect(
        findAppReuseProblems({ appId: "a", objectId: "o" }, reused)
      ).toEqual([
        `The second create used application ${reused.appId}/${reused.objectId}, but the first create made a/o.`
      ]);
    }
  );
});

describe("withEnvironmentOverride", () => {
  it("sets the value while running and restores the earlier value", async () => {
    const env: NodeJS.ProcessEnv = { KEY: "before" };
    const seen = await withEnvironmentOverride(
      "KEY",
      "during",
      async () => env.KEY,
      env
    );
    expect(seen).toBe("during");
    expect(env).toEqual({ KEY: "before" });
  });

  it("removes a value that was not set, even when the run throws", async () => {
    const env: NodeJS.ProcessEnv = {};
    await expect(
      withEnvironmentOverride(
        "KEY",
        "during",
        async () => {
          throw new Error("probe failed");
        },
        env
      )
    ).rejects.toThrow("probe failed");
    expect(Object.prototype.hasOwnProperty.call(env, "KEY")).toBe(false);
  });

  it("uses process.env by default", async () => {
    const key = "RADIUS_EDGE_CASE_TEST_OVERRIDE";
    expect(process.env[key]).toBeUndefined();
    await withEnvironmentOverride(key, "x", async () => {
      expect(process.env[key]).toBe("x");
    });
    expect(process.env[key]).toBeUndefined();
  });
});
