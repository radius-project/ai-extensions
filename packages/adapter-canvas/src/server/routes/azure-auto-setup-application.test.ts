import { describe, expect, it } from "vitest";
import {
  buildRadiusAppProvenanceTags,
  type ResolveOidcSubjectResult
} from "../../azure-oidc.js";
import { resolveAzureAutoSetupApplication } from "./azure-auto-setup-application.js";
import type {
  AzureAutoSetupApplicationInput,
  AzureAutoSetupCommandResult,
  AzureAutoSetupOperation,
  AzureAutoSetupWorkflow
} from "./azure-auto-setup-types.js";
import { createAzureAutoSetupTestDependencies } from "../../../test/support/server/azure-auto-setup.js";

const APP_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";

const OIDC: ResolveOidcSubjectResult = {
  federatedCredentials: [
    {
      name: "dev",
      subject: "repo:octo/app:environment:dev"
    }
  ],
  fullName: "octo/app",
  ownerId: 7,
  repoId: 5,
  subjectConfig: { useDefault: true }
};

interface Harness {
  input: AzureAutoSetupApplicationInput;
  calls: string[];
  failures: Record<string, unknown>[];
  responses: Array<{ status: number; payload: unknown }>;
}

function command(
  partial: Partial<AzureAutoSetupCommandResult> = {}
): AzureAutoSetupCommandResult {
  return {
    code: partial.code ?? 0,
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? ""
  };
}

function harness(
  options: {
    runAz?: (args: string[]) => Promise<AzureAutoSetupCommandResult>;
    runGitHubJson?: AzureAutoSetupWorkflow["runGitHubJson"];
    persist?: () => Promise<void>;
    finish?: AzureAutoSetupApplicationInput["dependencies"]["operations"]["finish"];
    report?: AzureAutoSetupApplicationInput["dependencies"]["operations"]["report"];
    checkpoint?: () => Promise<boolean>;
    overrides?: Partial<
      Omit<AzureAutoSetupApplicationInput, "dependencies" | "workflow">
    >;
  } = {}
): Harness {
  const calls: string[] = [];
  const failures: Record<string, unknown>[] = [];
  const responses: Array<{ status: number; payload: unknown }> = [];
  const operation: AzureAutoSetupOperation = {
    operationId: "op-app",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "authorize_identity"
  };
  const dependencies = createAzureAutoSetupTestDependencies({
    operations: {
      persist:
        options.persist ??
        (async () => {
          calls.push("persist");
        }),
      finish: options.finish ?? (() => calls.push("finish")),
      report: options.report ?? (() => calls.push("report")),
      recordAzureApp: (_operation, patch) =>
        calls.push(`record:${String(patch.state)}`)
    }
  });
  const workflow: AzureAutoSetupWorkflow = {
    operation,
    steps: [],
    respond: (status, payload) => responses.push({ status, payload }),
    runAz:
      options.runAz ??
      (async (args) => {
        throw new Error(`unscripted az call: ${args.join(" ")}`);
      }),
    runGitHubJson:
      options.runGitHubJson ??
      (async () => ({ ok: false, status: 404, json: null })),
    fail: async (status, error, code, extra = {}) => {
      failures.push({ status, error, code, extra });
    },
    checkpoint:
      options.checkpoint ??
      (async () => {
        calls.push("checkpoint");
        return true;
      })
  };
  return {
    calls,
    failures,
    responses,
    input: {
      workflow,
      dependencies: { operations: dependencies.operations },
      oidc: OIDC,
      environment: "dev",
      explicitAppId: "",
      createNewApp: false,
      appNameProvided: false,
      requestedAppName: "",
      requestedClientId: "",
      serviceManagementReference: "",
      ...options.overrides
    }
  };
}

describe("Azure auto-setup App Registration service (SU-08)", () => {
  it("rejects an explicitly blank app name before any Azure call", async () => {
    const test = harness({
      overrides: { appNameProvided: true, requestedAppName: "  " }
    });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures).toHaveLength(1);
    expect(test.failures[0]).toMatchObject({ code: "invalid-app-name" });
  });

  it("rejects an overlong derived app name before reading repository variables", async () => {
    const test = harness({
      overrides: {
        oidc: {
          ...OIDC,
          fullName: `octo/${"a".repeat(120)}`
        }
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({ code: "invalid-app-name" });
  });

  it("reads and reuses AZURE_CLIENT_ID from the GitHub environment variable", async () => {
    const githubCalls: string[] = [];
    const test = harness({
      runGitHubJson: async (path) => {
        githubCalls.push(path);
        return {
          ok: true,
          status: 200,
          json: { value: ` ${APP_ID} ` }
        };
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app show --id")) {
          return command({ stdout: "app-object" });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toEqual({
      clientId: APP_ID,
      appName: "radius-deploy-octo-app"
    });
    expect(githubCalls).toEqual([
      "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID"
    ]);
  });

  it("reuses the repository's owned client id and persists before returning", async () => {
    const azCalls: string[] = [];
    const test = harness({
      overrides: { requestedClientId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        azCalls.push(line);
        if (line.startsWith("ad app show --id")) {
          return command({ stdout: "app-object" });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    const result = await resolveAzureAutoSetupApplication(test.input);
    expect(result).toEqual({
      clientId: APP_ID,
      appName: "radius-deploy-octo-app"
    });
    expect(test.calls).toEqual(["record:reused", "persist"]);
    expect(azCalls).toHaveLength(3);
  });

  it.each([
    ["the signed-in user lookup fails", "signed-in", "app-owner-lookup-failed"],
    ["the owner list fails", "owners", "app-owner-lookup-failed"],
    ["the application lookup fails", "show", "client-id-lookup-failed"]
  ])(
    "fails closed when %s for an existing client id",
    async (_label, stage, code) => {
      const test = harness({
        overrides: { requestedClientId: APP_ID },
        runAz: async (args) => {
          const line = args.join(" ");
          if (line.startsWith("ad app show --id")) {
            return stage === "show" ?
                command({ code: 1, stderr: "directory unavailable" })
              : command({ stdout: "app-object" });
          }
          if (line.startsWith("ad signed-in-user show")) {
            return stage === "signed-in" ?
                command({ code: 1, stderr: "user unavailable" })
              : command({ stdout: USER_ID });
          }
          if (line.startsWith("ad app owner list")) {
            return stage === "owners" ?
                command({ code: 1, stderr: "owners unavailable" })
              : command({ stdout: USER_ID });
          }
          throw new Error(`unscripted az call: ${line}`);
        }
      });

      expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
      expect(test.failures[0]).toMatchObject({ code });
    }
  );

  it("falls through from a stale AZURE_CLIENT_ID to application name lookup", async () => {
    const test = harness({
      overrides: {
        requestedClientId: APP_ID,
        appNameProvided: true,
        requestedAppName: "radius-custom"
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app show --id")) {
          return command({
            code: 1,
            stderr: "Request_ResourceNotFound"
          });
        }
        if (line.startsWith("ad app list ")) {
          expect(line).toContain("radius-custom");
          return command({ stdout: "[]" });
        }
        if (line.startsWith("ad app create ")) {
          return command({ code: 1, stderr: "creation denied" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({ code: "app-create-failed" });
  });

  it("fails closed when a reused application cannot be persisted", async () => {
    const test = harness({
      overrides: { requestedClientId: APP_ID },
      persist: async () => {
        throw new Error("read-only store");
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app show --id")) {
          return command({ stdout: "app-object" });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.calls).toEqual(["record:reused", "report", "finish"]);
    expect(test.responses).toEqual([
      {
        status: 500,
        payload: {
          error:
            "Radius changed no cloud resources because it could not save the setup recovery record.",
          code: "operation-persistence-failed",
          operationId: "op-app"
        }
      }
    ]);
  });

  it("rejects an invalid explicit application id without spawning Azure", async () => {
    const test = harness({ overrides: { explicitAppId: "not-a-guid" } });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({ code: "invalid-app-id" });
  });

  it("rejects an explicit application not owned by the signed-in user", async () => {
    const test = harness({
      overrides: { explicitAppId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: "somebody-else" });
        }
        if (line.includes("--query tags")) {
          return command({ stdout: "[]" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-registration-not-owned"
    });
  });

  it("rejects an unowned AZURE_CLIENT_ID when provenance cannot be read", async () => {
    const test = harness({
      overrides: { requestedClientId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app show --id")) {
          return command({ stdout: "app-object" });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: "somebody-else" });
        }
        if (line.includes("--query tags")) {
          return command({ code: 1, stderr: "tags unavailable" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-registration-not-owned"
    });
  });

  it("uses an explicitly selected application after verifying ownership", async () => {
    const test = harness({
      overrides: { explicitAppId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toEqual({
      clientId: APP_ID,
      appName: "radius-deploy-octo-app"
    });
    expect(test.calls).toEqual(["record:reused"]);
  });

  it("fails closed when ownership of an explicit application cannot be read", async () => {
    const test = harness({
      overrides: { explicitAppId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ code: 1, stderr: "owners unavailable" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-owner-lookup-failed"
    });
  });

  it.each([
    [
      "a command failure",
      command({ code: 1, stderr: "tenant denied" }),
      "app-lookup-failed"
    ],
    [
      "a non-array response",
      command({ stdout: '{"appId":"one"}' }),
      "app-lookup-parse"
    ],
    ["invalid JSON", command({ stdout: "{oops" }), "app-lookup-parse"]
  ])("reports %s during name lookup", async (_label, result, code) => {
    const test = harness({
      runAz: async (args) => {
        if (args.join(" ").startsWith("ad app list ")) return result;
        throw new Error(`unscripted az call: ${args.join(" ")}`);
      }
    });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({ code });
  });

  it("returns enriched candidates when multiple owned name matches need selection", async () => {
    const candidates = [
      { appId: APP_ID, displayName: "Radius One", createdDateTime: "one" },
      {
        appId: "55555555-5555-5555-5555-555555555555",
        displayName: "Radius Two",
        createdDateTime: "two"
      }
    ];
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({ stdout: JSON.stringify(candidates) });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        if (line.includes("federated-credential list")) {
          return command({
            stdout: JSON.stringify(["repo:octo/served:environment:production"])
          });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-selection-required",
      extra: {
        candidates: [
          {
            appId: APP_ID,
            displayName: "Radius One",
            createdDateTime: "one",
            servesRepos: ["octo/served"]
          },
          {
            appId: "55555555-5555-5555-5555-555555555555",
            displayName: "Radius Two",
            createdDateTime: "two",
            servesRepos: ["octo/served"]
          }
        ]
      }
    });
  });

  it("reuses the sole owned name match and skips malformed lookup entries", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([
              null,
              {},
              {
                appId: APP_ID,
                displayName: "Radius",
                createdDateTime: "today"
              }
            ])
          });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toEqual({
      clientId: APP_ID,
      appName: "radius-deploy-octo-app"
    });
    expect(test.calls).toEqual(["record:reused", "persist"]);
  });

  it("fails closed when the reused name match cannot be persisted", async () => {
    const test = harness({
      persist: async () => {
        throw new Error("read-only store");
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([{ appId: APP_ID, displayName: "Radius" }])
          });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.responses[0]).toMatchObject({
      status: 500,
      payload: { code: "operation-persistence-failed" }
    });
  });

  it("fails closed when a name-match ownership lookup fails", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([{ appId: APP_ID, displayName: "Radius" }])
          });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ code: 1, stderr: "owners unavailable" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-owner-lookup-failed"
    });
  });

  it("rejects an unowned name match carrying Radius provenance", async () => {
    const provenanceTags = buildRadiusAppProvenanceTags({
      repo: "octo/app",
      environment: "dev",
      operationId: "older-operation"
    });
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([
              {
                appId: APP_ID,
                displayName: "Radius",
                tags: provenanceTags
              }
            ])
          });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: "somebody-else" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-registration-radius-orphaned"
    });
  });

  it("omits servesRepos when candidate credential lookup is unavailable or malformed", async () => {
    let credentialLookup = 0;
    const candidates = [
      { appId: APP_ID, displayName: "Radius One", createdDateTime: "one" },
      {
        appId: "55555555-5555-5555-5555-555555555555",
        displayName: "Radius Two",
        createdDateTime: "two"
      }
    ];
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({ stdout: JSON.stringify(candidates) });
        }
        if (line.startsWith("ad signed-in-user show")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list")) {
          return command({ stdout: USER_ID });
        }
        if (line.includes("federated-credential list")) {
          credentialLookup += 1;
          return credentialLookup === 1 ?
              command({ code: 1, stderr: "unavailable" })
            : command({ stdout: "{oops" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "app-selection-required",
      extra: {
        candidates: [
          {
            appId: APP_ID,
            displayName: "Radius One",
            createdDateTime: "one"
          },
          {
            appId: "55555555-5555-5555-5555-555555555555",
            displayName: "Radius Two",
            createdDateTime: "two"
          }
        ]
      }
    });
  });

  it("creates, owns, tags, and verifies a new application in order", async () => {
    const azCalls: string[] = [];
    const requiredTags = buildRadiusAppProvenanceTags({
      repo: "octo/app",
      environment: "dev",
      operationId: "op-app"
    });
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        azCalls.push(line);
        if (line.startsWith("ad app list ")) {
          return command({ stdout: "[]" });
        }
        if (line.startsWith("ad app create ")) {
          return command({ stdout: APP_ID });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner add ")) return command();
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("rest --method PATCH ")) return command();
        if (line.startsWith("ad app show ") && line.includes("--query tags")) {
          return command({ stdout: JSON.stringify(requiredTags) });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    const result = await resolveAzureAutoSetupApplication(test.input);
    expect(result).toEqual({
      clientId: APP_ID,
      appName: "radius-deploy-octo-app"
    });
    expect(test.calls).toEqual(["record:created", "checkpoint"]);
    const create = azCalls.findIndex((line) =>
      line.startsWith("ad app create ")
    );
    const ownerAdd = azCalls.findIndex((line) =>
      line.startsWith("ad app owner add ")
    );
    const ownerList = azCalls.findIndex((line) =>
      line.startsWith("ad app owner list ")
    );
    const tagPatch = azCalls.findIndex((line) =>
      line.startsWith("rest --method PATCH ")
    );
    const tagShow = azCalls.findIndex(
      (line) => line.startsWith("ad app show ") && line.includes("--query tags")
    );
    expect([create, ownerAdd, ownerList, tagPatch, tagShow]).toEqual(
      [...[create, ownerAdd, ownerList, tagPatch, tagShow]].sort(
        (left, right) => left - right
      )
    );
  });

  it("reports a non-policy application creation failure", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({ stdout: "[]" });
        }
        if (line.startsWith("ad app create ")) {
          return command({ code: 1, stderr: "directory denied" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({ code: "app-create-failed" });
  });

  it("stops before ownership mutation when the post-create checkpoint cancels", async () => {
    const azCalls: string[] = [];
    const test = harness({
      checkpoint: async () => false,
      runAz: async (args) => {
        const line = args.join(" ");
        azCalls.push(line);
        if (line.startsWith("ad app list ")) {
          return command({ stdout: "[]" });
        }
        if (line.startsWith("ad app create ")) {
          return command({ stdout: APP_ID });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.calls).toEqual(["record:created"]);
    expect(azCalls.some((line) => line.startsWith("ad app owner add "))).toBe(
      false
    );
  });

  it.each([
    ["signed-in-user", "app-owner-lookup-failed"],
    ["owner-add", "app-owner-add-failed"],
    ["owner-list", "app-owner-lookup-failed"],
    ["owner-missing", "app-owner-verify-failed"],
    ["tag-patch", "app-tag-update-failed"],
    ["tag-show", "app-tag-read-failed"],
    ["tag-parse", "app-tag-parse-failed"],
    ["tag-missing", "app-tag-verify-failed"]
  ])(
    "rolls back through the failure contract when %s fails after creation",
    async (stage, expectedCode) => {
      const requiredTags = buildRadiusAppProvenanceTags({
        repo: "octo/app",
        environment: "dev",
        operationId: "op-app"
      });
      const test = harness({
        runAz: async (args) => {
          const line = args.join(" ");
          if (line.startsWith("ad app list ")) {
            return command({ stdout: "[]" });
          }
          if (line.startsWith("ad app create ")) {
            return command({ stdout: APP_ID });
          }
          if (line.startsWith("ad signed-in-user show ")) {
            return stage === "signed-in-user" ?
                command({ code: 1, stderr: "user unavailable" })
              : command({ stdout: USER_ID });
          }
          if (line.startsWith("ad app owner add ")) {
            return stage === "owner-add" ?
                command({ code: 1, stderr: "owner denied" })
              : command();
          }
          if (line.startsWith("ad app owner list ")) {
            if (stage === "owner-list") {
              return command({ code: 1, stderr: "owners unavailable" });
            }
            return command({
              stdout: stage === "owner-missing" ? "somebody-else" : USER_ID
            });
          }
          if (line.startsWith("rest --method PATCH ")) {
            return stage === "tag-patch" ?
                command({ code: 1, stderr: "tag denied" })
              : command();
          }
          if (
            line.startsWith("ad app show ") &&
            line.includes("--query tags")
          ) {
            if (stage === "tag-show") {
              return command({ code: 1, stderr: "tags unavailable" });
            }
            if (stage === "tag-parse") {
              return command({ stdout: "{oops" });
            }
            if (stage === "tag-missing") {
              return command({ stdout: "[]" });
            }
            return command({ stdout: JSON.stringify(requiredTags) });
          }
          throw new Error(`unscripted az call: ${line}`);
        }
      });

      expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
      expect(test.failures[0]).toMatchObject({ code: expectedCode });
    }
  );

  it("accepts an already-assigned owner response and continues verification", async () => {
    const requiredTags = buildRadiusAppProvenanceTags({
      repo: "octo/app",
      environment: "dev",
      operationId: "op-app"
    });
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({ stdout: "[]" });
        }
        if (line.startsWith("ad app create ")) {
          return command({ stdout: APP_ID });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner add ")) {
          return command({
            code: 1,
            stderr: "One or more added object references already exist"
          });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("rest --method PATCH ")) return command();
        if (line.startsWith("ad app show ") && line.includes("--query tags")) {
          return command({ stdout: JSON.stringify(requiredTags) });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toMatchObject({ clientId: APP_ID });
  });

  it("turns a tenant SMR policy rejection into input-required failure data", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({ stdout: "[]" });
        }
        if (line.startsWith("ad app create ")) {
          return command({
            code: 1,
            stderr: "ServiceManagementReference is required by directory policy"
          });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures[0]).toMatchObject({
      code: "service-management-reference-required"
    });
  });
});
