import { describe, expect, it } from "vitest";
import {
  classifyWorkflowPublication,
  cloudCanvasState,
  describeWorkflowPublication,
  environmentSubjectSuffix,
  evaluateCreateEnvironmentGate,
  expectedFederatedCredentialSubjects,
  findEnvironmentIdentityProblems,
  parseJsonPayload,
  readAzureAccount,
  readDirectoryPaths,
  readEnvironmentVariables,
  readOidcSubjectCustomization,
  readOperationSnapshot,
  readRepositoryIdentity,
  readServicePrincipalObjectId,
  readWorkflowDirectory,
  REQUIRED_DEFAULT_BRANCH_WORKFLOWS,
  selectFallbackBranches,
  selectFallbackPullRequests,
  TERMINAL_OPERATION_STATES,
  VERIFY_WORKFLOW_PATH
} from "./create-environment-journey.js";

const PROVISIONED = {
  fixtureProvisioned: true,
  unprovisionedReason: "The fixture repository is provisioned."
};

describe("evaluateCreateEnvironmentGate", () => {
  it("enables the journey once the flag, fixture, subscription, and token are all present", () => {
    expect(
      evaluateCreateEnvironmentGate({
        cloudE2eFlag: "1",
        ...PROVISIONED,
        subscriptionId: "sub-1",
        githubToken: "ghs_token"
      })
    ).toEqual({ enabled: true });
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "]
  ])("skips when RADIUS_CLOUD_E2E is %s", (_label, flag) => {
    const gate = evaluateCreateEnvironmentGate({
      cloudE2eFlag: flag,
      ...PROVISIONED,
      subscriptionId: "sub-1",
      githubToken: "ghs_token"
    });
    expect(gate.enabled).toBe(false);
    expect(gate.enabled === false && gate.reason).toContain("RADIUS_CLOUD_E2E");
  });

  it("reports the fixture repository's own reason before looking at credentials", () => {
    const gate = evaluateCreateEnvironmentGate({
      cloudE2eFlag: "1",
      fixtureProvisioned: false,
      unprovisionedReason: "FIXTURE_BASELINE_SHA still holds a placeholder.",
      subscriptionId: "",
      githubToken: ""
    });
    expect(gate).toEqual({
      enabled: false,
      reason: "FIXTURE_BASELINE_SHA still holds a placeholder."
    });
  });

  it("skips without a subscription", () => {
    const gate = evaluateCreateEnvironmentGate({
      cloudE2eFlag: "1",
      ...PROVISIONED,
      githubToken: "ghs_token"
    });
    expect(gate.enabled === false && gate.reason).toContain(
      "AZURE_SUBSCRIPTION_ID"
    );
  });

  it("skips without a GitHub token", () => {
    const gate = evaluateCreateEnvironmentGate({
      cloudE2eFlag: "1",
      ...PROVISIONED,
      subscriptionId: "sub-1",
      githubToken: " "
    });
    expect(gate.enabled === false && gate.reason).toContain("GH_TOKEN");
  });
});

describe("readAzureAccount", () => {
  const payload = {
    id: " sub-1 ",
    name: "Fixture subscription",
    tenantId: "tenant-1",
    user: { name: "runner@example.test", type: "user" }
  };

  it("narrows a signed-in user account", () => {
    expect(readAzureAccount(payload)).toEqual({
      tenantId: "tenant-1",
      subscriptionId: "sub-1",
      subscriptionName: "Fixture subscription",
      principalName: "runner@example.test",
      principalType: "user"
    });
  });

  it("narrows a service principal account", () => {
    expect(
      readAzureAccount({
        ...payload,
        user: {
          name: "00000000-0000-0000-0000-000000000001",
          type: "servicePrincipal"
        }
      }).principalType
    ).toBe("servicePrincipal");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "not-json"]
  ])("rejects %s in place of an account object", (_label, value) => {
    expect(() => readAzureAccount(value)).toThrow(/no account object/);
  });

  it("rejects a payload with no user object", () => {
    expect(() => readAzureAccount({ ...payload, user: undefined })).toThrow(
      /no "user" object/
    );
  });

  it("rejects an unrecognized principal type", () => {
    expect(() =>
      readAzureAccount({
        ...payload,
        user: { ...payload.user, type: "managedIdentity" }
      })
    ).toThrow(/unrecognized principal type "managedIdentity"/);
  });

  it.each([
    ["tenantId", { tenantId: "  " }],
    ["id", { id: "" }],
    ["name", { name: 7 }]
  ])("rejects a missing %s", (field, override) => {
    expect(() => readAzureAccount({ ...payload, ...override })).toThrow(
      new RegExp(`usable "${field}"`)
    );
  });

  it("rejects a user with no name", () => {
    expect(() =>
      readAzureAccount({ ...payload, user: { type: "user" } })
    ).toThrow(/usable "user.name"/);
  });
});

describe("readOidcSubjectCustomization", () => {
  it("reads the default configuration", () => {
    expect(readOidcSubjectCustomization({ use_default: true })).toEqual({
      useDefault: true
    });
  });

  it("carries the immutable flag and prefix when GitHub reports them", () => {
    expect(
      readOidcSubjectCustomization({
        use_default: true,
        use_immutable_subject: true,
        sub_claim_prefix: " repo:octo@1/app@2 "
      })
    ).toEqual({
      useDefault: true,
      useImmutableSubject: true,
      subClaimPrefix: "repo:octo@1/app@2"
    });
  });

  it("ignores a blank prefix and a non-boolean immutable flag", () => {
    expect(
      readOidcSubjectCustomization({
        use_default: false,
        use_immutable_subject: "yes",
        sub_claim_prefix: "   "
      })
    ).toEqual({ useDefault: false });
  });

  it("rejects a payload that is not an object", () => {
    expect(() => readOidcSubjectCustomization(null)).toThrow(
      /could not be read as an object/
    );
  });

  it("refuses to guess when use_default is absent", () => {
    expect(() => readOidcSubjectCustomization({})).toThrow(
      /boolean "use_default"/
    );
  });
});

describe("environmentSubjectSuffix", () => {
  it.each([
    ["radtest-abc", "environment:radtest-abc"],
    ["a:b:c", "environment:a%3Ab%3Ac"],
    ["", "environment:"]
  ])("encodes %s", (name, expected) => {
    expect(environmentSubjectSuffix(name)).toBe(expected);
  });
});

describe("expectedFederatedCredentialSubjects", () => {
  const base = {
    fullName: "octo/app",
    ownerId: 111,
    repoId: 222,
    environmentName: "radtest-abc"
  };

  it("requires both subject forms when GitHub has not declared immutable subjects", () => {
    expect(
      expectedFederatedCredentialSubjects({
        ...base,
        customization: { useDefault: true }
      })
    ).toEqual({
      supported: true,
      required: [
        "repo:octo/app:environment:radtest-abc",
        "repo:octo@111/app@222:environment:radtest-abc"
      ]
    });
  });

  it("requires only the immutable form when GitHub declares immutable subjects", () => {
    expect(
      expectedFederatedCredentialSubjects({
        ...base,
        customization: { useDefault: true, useImmutableSubject: true }
      })
    ).toEqual({
      supported: true,
      required: ["repo:octo@111/app@222:environment:radtest-abc"]
    });
  });

  it("prefers GitHub's own reported prefix over a composed slug", () => {
    expect(
      expectedFederatedCredentialSubjects({
        ...base,
        customization: {
          useDefault: true,
          useImmutableSubject: true,
          subClaimPrefix: "repo:renamed@111/moved@222"
        }
      })
    ).toEqual({
      supported: true,
      required: ["repo:renamed@111/moved@222:environment:radtest-abc"]
    });
  });

  it("falls back to the composed slug when the reported prefix carries no ids", () => {
    expect(
      expectedFederatedCredentialSubjects({
        ...base,
        customization: {
          useDefault: true,
          useImmutableSubject: true,
          subClaimPrefix: "repo:octo/app"
        }
      })
    ).toEqual({
      supported: true,
      required: ["repo:octo@111/app@222:environment:radtest-abc"]
    });
  });

  it("accepts GitHub's repository-prefixed immutable slug", () => {
    expect(
      expectedFederatedCredentialSubjects({
        ...base,
        customization: {
          useDefault: true,
          useImmutableSubject: true,
          subClaimPrefix: "repository:renamed@111/moved@222"
        }
      })
    ).toEqual({
      supported: true,
      required: ["repo:renamed@111/moved@222:environment:radtest-abc"]
    });
  });

  it("accepts numeric ids reported as strings", () => {
    const result = expectedFederatedCredentialSubjects({
      ...base,
      ownerId: " 111 ",
      repoId: "222",
      customization: { useDefault: true, useImmutableSubject: true }
    });
    expect(result).toEqual({
      supported: true,
      required: ["repo:octo@111/app@222:environment:radtest-abc"]
    });
  });

  it.each([
    ["octo", "not an owner/repo"],
    ["octo/", "not an owner/repo"],
    ["/app", "not an owner/repo"],
    ["octo/app/extra", "not an owner/repo"]
  ])("refuses the malformed full name %s", (fullName, expected) => {
    const result = expectedFederatedCredentialSubjects({
      ...base,
      fullName,
      customization: { useDefault: true }
    });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reason).toContain(expected);
  });

  it("refuses a repository that customizes its subject claims", () => {
    const result = expectedFederatedCredentialSubjects({
      ...base,
      customization: { useDefault: false }
    });
    expect(result.supported).toBe(false);
    expect(result.supported === false && result.reason).toContain(
      "customizes its OIDC subject claims"
    );
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-numeric text", "abc"],
    ["absent", undefined]
  ])("refuses a %s repository id", (_label, repoId) => {
    const result = expectedFederatedCredentialSubjects({
      ...base,
      repoId,
      customization: { useDefault: true }
    });
    expect(result.supported).toBe(false);
    expect(result.supported === false && result.reason).toContain(
      "positive numeric owner and repository ids"
    );
  });
});

describe("classifyWorkflowPublication", () => {
  const context = { repository: "octo/app", defaultBranch: "main" };

  it("reports the committed path when every required file is on the default branch", () => {
    const publication = classifyWorkflowPublication({
      defaultBranchPaths: [VERIFY_WORKFLOW_PATH, "README.md"],
      fallbackBranches: [],
      openPullRequests: []
    });
    expect(publication).toEqual({
      outcome: "committed",
      paths: [...REQUIRED_DEFAULT_BRANCH_WORKFLOWS]
    });
    expect(describeWorkflowPublication(publication, context)).toContain(
      "octo/app@main carries"
    );
  });

  it("reports the pull-request fallback even when the files are also on the default branch", () => {
    const publication = classifyWorkflowPublication({
      defaultBranchPaths: [VERIFY_WORKFLOW_PATH],
      fallbackBranches: ["radius/setup-radtest-abc-workflows-1234"],
      openPullRequests: [17]
    });
    expect(publication).toEqual({
      outcome: "pull-request",
      branches: ["radius/setup-radtest-abc-workflows-1234"],
      pullRequests: [17]
    });
    const message = describeWorkflowPublication(publication, context);
    expect(message).toContain("radius/setup-radtest-abc-workflows-1234");
    expect(message).toContain("#17");
    expect(message).toContain("workflows: write");
  });

  it("still reports the fallback when only a branch survived", () => {
    const publication = classifyWorkflowPublication({
      defaultBranchPaths: [],
      fallbackBranches: ["radius/setup-radtest-abc-workflows-1234"],
      openPullRequests: []
    });
    expect(describeWorkflowPublication(publication, context)).toContain(
      "open pull requests none"
    );
  });

  it("reports missing files when neither path produced them", () => {
    const publication = classifyWorkflowPublication({
      defaultBranchPaths: ["README.md"],
      fallbackBranches: [],
      openPullRequests: []
    });
    expect(publication).toEqual({
      outcome: "missing",
      missingPaths: [VERIFY_WORKFLOW_PATH]
    });
    expect(describeWorkflowPublication(publication, context)).toContain(
      "no pull-request fallback explains it"
    );
  });

  it("honors an explicit required-path list", () => {
    expect(
      classifyWorkflowPublication({
        defaultBranchPaths: [VERIFY_WORKFLOW_PATH],
        fallbackBranches: [],
        openPullRequests: [],
        requiredPaths: [".github/workflows/run-rad-commands.yml"]
      })
    ).toEqual({
      outcome: "missing",
      missingPaths: [".github/workflows/run-rad-commands.yml"]
    });
  });
});

describe("readEnvironmentVariables", () => {
  it("indexes the variables GitHub reports", () => {
    const variables = readEnvironmentVariables({
      variables: [
        { name: "AZURE_CLIENT_ID", value: "app-1" },
        { name: "AZURE_LOCATION" },
        { name: 7, value: "ignored" },
        "not-an-object"
      ]
    });
    expect([...variables]).toEqual([
      ["AZURE_CLIENT_ID", "app-1"],
      ["AZURE_LOCATION", ""]
    ]);
  });

  it("rejects a payload with no variables array", () => {
    expect(() => readEnvironmentVariables({ variables: {} })).toThrow(
      /no "variables" array/
    );
  });
});

describe("findEnvironmentIdentityProblems", () => {
  const expected = {
    tenantId: "tenant-1",
    subscriptionId: "sub-1",
    resourceGroup: "radtest-canvas-abc",
    cluster: "aks-abc",
    location: "westus3",
    namespace: "default"
  };
  const complete = (clientId: string): ReadonlyMap<string, string> =>
    new Map([
      ["AZURE_CLIENT_ID", clientId],
      ["AZURE_TENANT_ID", expected.tenantId],
      ["AZURE_SUBSCRIPTION_ID", expected.subscriptionId],
      ["AZURE_RESOURCE_GROUP", expected.resourceGroup],
      ["AZURE_AKS_CLUSTER_NAME", expected.cluster],
      ["AZURE_LOCATION", expected.location],
      ["KUBERNETES_NAMESPACE", expected.namespace]
    ]);

  it("accepts an environment wired to the created application", () => {
    expect(
      findEnvironmentIdentityProblems({
        variables: complete("APP-1"),
        createdAppId: "app-1",
        bootstrapClientId: "bootstrap-1",
        expected
      })
    ).toEqual([]);
  });

  it("names the bootstrap identity specifically when it reached the environment", () => {
    const problems = findEnvironmentIdentityProblems({
      variables: complete("bootstrap-1"),
      createdAppId: "app-1",
      bootstrapClientId: "BOOTSTRAP-1",
      expected
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is the bootstrap identity");
  });

  it("reports a client id that is neither the created application nor the bootstrap identity", () => {
    const problems = findEnvironmentIdentityProblems({
      variables: complete("someone-else"),
      createdAppId: "app-1",
      expected
    });
    expect(problems).toEqual([
      'AZURE_CLIENT_ID is "someone-else" but the product created application "app-1".'
    ]);
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["whitespace", "  "]
  ])("reports an %s client id", (_label, value) => {
    const variables = new Map(complete("app-1"));
    if (value === undefined) variables.delete("AZURE_CLIENT_ID");
    else variables.set("AZURE_CLIENT_ID", value);
    const problems = findEnvironmentIdentityProblems({
      variables,
      createdAppId: "app-1",
      expected
    });
    expect(problems[0]).toContain("AZURE_CLIENT_ID is absent or empty");
  });

  it("reports every mismatched and absent configuration value", () => {
    const problems = findEnvironmentIdentityProblems({
      variables: new Map([
        ["AZURE_CLIENT_ID", "app-1"],
        ["AZURE_TENANT_ID", "other-tenant"],
        ["AZURE_SUBSCRIPTION_ID", expected.subscriptionId],
        ["AZURE_RESOURCE_GROUP", "someone-elses-group"],
        ["AZURE_LOCATION", "eastus"]
      ]),
      createdAppId: "app-1",
      expected
    });
    expect(problems).toEqual([
      'AZURE_TENANT_ID is "other-tenant"; expected "tenant-1".',
      'AZURE_RESOURCE_GROUP is "someone-elses-group"; expected "radtest-canvas-abc".',
      'AZURE_AKS_CLUSTER_NAME is absent; expected "aks-abc".',
      'AZURE_LOCATION is "eastus"; expected "westus3".',
      'KUBERNETES_NAMESPACE is absent; expected "default".'
    ]);
  });
});

describe("readServicePrincipalObjectId", () => {
  it("reads the object id role assignments are made against", () => {
    expect(readServicePrincipalObjectId({ id: " sp-1 " })).toBe("sp-1");
  });

  it.each([
    ["a non-object", null],
    ["a missing id", {}],
    ["a blank id", { id: "  " }],
    ["a non-string id", { id: 7 }]
  ])("rejects %s", (_label, payload) => {
    expect(() => readServicePrincipalObjectId(payload)).toThrow(/usable "id"/);
  });
});

describe("readRepositoryIdentity", () => {
  it("reads the numeric ids and the default branch", () => {
    expect(
      readRepositoryIdentity({
        id: 222,
        owner: { id: 111 },
        default_branch: " main "
      })
    ).toEqual({ ownerId: 111, repoId: 222, defaultBranch: "main" });
  });

  it.each([
    ["the owner id is absent", { id: 222, default_branch: "main" }],
    [
      "the repository id is a string",
      { id: "222", owner: { id: 111 }, default_branch: "main" }
    ],
    ["the payload is not an object", null]
  ])("rejects a payload where %s", (_label, payload) => {
    expect(() => readRepositoryIdentity(payload)).toThrow(
      /numeric "owner.id" and "id"/
    );
  });

  it("rejects a payload with no default branch", () => {
    expect(() =>
      readRepositoryIdentity({
        id: 222,
        owner: { id: 111 },
        default_branch: ""
      })
    ).toThrow(/usable "default_branch"/);
  });
});

describe("readDirectoryPaths", () => {
  it("keeps only entries that carry a path", () => {
    expect(
      readDirectoryPaths([
        { path: ".github/workflows/radius-verify-credentials.yml" },
        { name: "no-path" },
        "not-an-object"
      ])
    ).toEqual([".github/workflows/radius-verify-credentials.yml"]);
  });

  it("refuses to read a non-array listing as an empty directory", () => {
    expect(() => readDirectoryPaths({ message: "Not Found" })).toThrow(
      /did not return an array/
    );
  });
});

describe("selectFallbackBranches", () => {
  it("matches only this run's fallback branches", () => {
    expect(
      selectFallbackBranches(
        [
          { name: "main" },
          { name: "radius/setup-radtest-abc-workflows-1234" },
          { name: "radius/setup-radtest-other-workflows-9999" },
          { notAName: true }
        ],
        "radtest-abc"
      )
    ).toEqual(["radius/setup-radtest-abc-workflows-1234"]);
  });

  it("reads refs returned by the matching-refs endpoint", () => {
    expect(
      selectFallbackBranches(
        [
          { ref: "refs/heads/radius/setup-radtest-abc-workflows-1234" },
          { ref: "refs/heads/feature/other" }
        ],
        "radtest-abc"
      )
    ).toEqual(["radius/setup-radtest-abc-workflows-1234"]);
  });

  it("rejects a non-array listing", () => {
    expect(() => selectFallbackBranches(null, "radtest-abc")).toThrow(
      /array of branches/
    );
  });
});

describe("selectFallbackPullRequests", () => {
  it("matches on the head ref rather than the title", () => {
    expect(
      selectFallbackPullRequests(
        [
          {
            number: 17,
            title: "Anything at all",
            head: { ref: "radius/setup-radtest-abc-workflows-1234" }
          },
          { number: 18, head: { ref: "feature/other" } },
          {
            number: "19",
            head: { ref: "radius/setup-radtest-abc-workflows-2" }
          },
          { head: { ref: "radius/setup-radtest-abc-workflows-3" } },
          { number: 20 }
        ],
        "radtest-abc"
      )
    ).toEqual([17]);
  });

  it("flattens pages returned by gh --paginate --slurp", () => {
    expect(
      selectFallbackPullRequests(
        [
          [
            {
              number: 17,
              head: { ref: "radius/setup-radtest-abc-workflows-1234" }
            }
          ],
          [{ number: 18, head: { ref: "feature/other" } }]
        ],
        "radtest-abc"
      )
    ).toEqual([17]);
  });

  it("rejects a non-array listing", () => {
    expect(() => selectFallbackPullRequests(undefined, "radtest-abc")).toThrow(
      /array of pull requests/
    );
  });
});

describe("readOperationSnapshot", () => {
  it.each(TERMINAL_OPERATION_STATES)("treats %s as terminal", (state) => {
    expect(readOperationSnapshot({ operation: { state } }).terminal).toBe(true);
  });

  it("carries the server's error text on a terminal failure", () => {
    expect(
      readOperationSnapshot({
        operation: { state: " failed ", error: "Azure said no." }
      })
    ).toEqual({ state: "failed", terminal: true, error: "Azure said no." });
  });

  it("keeps a running operation non-terminal", () => {
    expect(readOperationSnapshot({ operation: { state: "running" } })).toEqual({
      state: "running",
      terminal: false,
      error: ""
    });
  });

  it.each([
    ["a payload with no operation", {}, /operation" object/],
    ["a non-object payload", null, /operation" object/],
    ["a non-string state", { operation: { state: 7 } }, /operation.state/],
    ["a blank state", { operation: { state: " " } }, /operation.state/],
    [
      "a non-string error",
      { operation: { state: "failed", error: 7 } },
      /operation.error/
    ]
  ])("rejects %s", (_label, payload, expected) => {
    expect(() => readOperationSnapshot(payload)).toThrow(expected);
  });

  it("accepts a null error as absent", () => {
    expect(
      readOperationSnapshot({ operation: { state: "running", error: null } })
    ).toEqual({ state: "running", terminal: false, error: "" });
  });
});

describe("parseJsonPayload", () => {
  it("parses a JSON body", () => {
    expect(parseJsonPayload(' {"a":1} ', "the probe")).toEqual({ a: 1 });
  });

  it("rejects an empty body", () => {
    expect(() => parseJsonPayload("  ", "the probe")).toThrow(
      /returned no output/
    );
  });

  it("reports the parse failure with its context", () => {
    expect(() => parseJsonPayload("{oops", "the probe")).toThrow(
      /the probe returned output that is not valid JSON/
    );
  });
});

describe("readWorkflowDirectory", () => {
  it("reads the paths from a successful probe", () => {
    expect(
      readWorkflowDirectory(
        {
          code: 0,
          stdout: JSON.stringify([{ path: VERIFY_WORKFLOW_PATH }]),
          stderr: ""
        },
        "the workflow listing"
      )
    ).toEqual([VERIFY_WORKFLOW_PATH]);
  });

  it.each([
    ["gh: Not Found (HTTP 404)", ""],
    ["", "HTTP 404: Not Found"]
  ])("treats an absent directory as no workflows", (stderr, stdout) => {
    expect(
      readWorkflowDirectory({ code: 1, stdout, stderr }, "the workflow listing")
    ).toEqual([]);
  });

  it("raises any other failure instead of reading it as an empty directory", () => {
    expect(() =>
      readWorkflowDirectory(
        { code: 4, stdout: "", stderr: "gh: HTTP 500" },
        "the workflow listing"
      )
    ).toThrow(/failed with exit code 4: gh: HTTP 500/);
  });

  it("falls back to stdout when a failure wrote nothing to stderr", () => {
    expect(() =>
      readWorkflowDirectory(
        { code: 4, stdout: "server error", stderr: "" },
        "the workflow listing"
      )
    ).toThrow(/failed with exit code 4: server error/);
  });
});

describe("cloudCanvasState", () => {
  it("points every repository and branch field at the fixture clone", () => {
    expect(
      cloudCanvasState({
        repository: "octo/app",
        branch: "main",
        workspacePath: "/tmp/clone"
      })
    ).toEqual({
      contextRepo: "octo/app",
      contextBranch: "main",
      workspacePath: "/tmp/clone",
      workspaceRepo: "octo/app",
      workspaceBranch: "main",
      graphTargetRepo: "octo/app",
      graphBranch: "main",
      plannedRepo: "octo/app",
      plannedBranch: "main",
      deployingRepo: "octo/app",
      deployingBranch: "main"
    });
  });
});
