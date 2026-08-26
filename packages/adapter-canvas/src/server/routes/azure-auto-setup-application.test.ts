import { describe, expect, it } from "vitest";
import {
  prepareProviderMutation,
  settleProviderMutation
} from "../../operations.js";
import {
  buildRadiusAppProvenanceTags,
  type ResolveOidcSubjectResult
} from "../../azure-oidc.js";
import {
  ENTRA_APP_RETENTION_NOTICE,
  resolveAzureAutoSetupApplication
} from "./azure-auto-setup-application.js";
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
  recorded: Record<string, unknown>[];
  failures: Record<string, unknown>[];
  responses: Array<{ status: number; payload: unknown }>;
  steps: string[];
}

function command(
  partial: Partial<AzureAutoSetupCommandResult> = {}
): AzureAutoSetupCommandResult {
  return {
    code: partial.code ?? 0,
    stdout: partial.stdout ?? "",
    stderr: partial.stderr ?? "",
    ...(partial.timedOut ? { timedOut: true } : {})
  };
}

function harness(
  options: {
    runAz?: (args: string[]) => Promise<AzureAutoSetupCommandResult>;
    runGitHubJson?: AzureAutoSetupWorkflow["runGitHubJson"];
    persist?: () => Promise<void>;
    finish?: AzureAutoSetupApplicationInput["dependencies"]["operations"]["finish"];
    report?: AzureAutoSetupApplicationInput["dependencies"]["operations"]["report"];
    stopBoundary?: AzureAutoSetupWorkflow["stopBoundary"];
    checkpoint?: AzureAutoSetupWorkflow["checkpoint"];
    overrides?: Partial<
      Omit<AzureAutoSetupApplicationInput, "dependencies" | "workflow">
    >;
  } = {}
): Harness {
  const calls: string[] = [];
  const recorded: Record<string, unknown>[] = [];
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
      recordAzureApp: (_operation, patch) => {
        recorded.push(patch);
        calls.push(`record:${String(patch.state)}`);
      }
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
    stopBoundary: options.stopBoundary ?? (async () => true),
    checkpoint:
      options.checkpoint ??
      (async () => {
        calls.push("checkpoint");
        return true;
      })
  };
  return {
    calls,
    recorded,
    failures,
    responses,
    steps: workflow.steps,
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
      appName: "radius-deploy-octo-app",
      state: "reused"
    });
    expect(githubCalls).toEqual([
      "/repos/octo/app/environments/dev/variables/AZURE_CLIENT_ID"
    ]);
    expect(test.steps).toContain(
      `✅ Reusing the App Registration already wired into AZURE_CLIENT_ID: ${APP_ID}`
    );
    expect(test.steps.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
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
      appName: "radius-deploy-octo-app",
      state: "reused"
    });
    expect(test.calls).toEqual(["record:reused", "persist"]);
    // The tag read is the fourth call: reuse now records where the application
    // came from, and only its Radius provenance tags can say.
    expect(azCalls).toEqual([
      `ad app show --id ${APP_ID} --query id -o tsv`,
      "ad signed-in-user show --query id -o tsv",
      `ad app owner list --id ${APP_ID} --query [].id -o tsv`,
      `ad app show --id ${APP_ID} --query tags -o json`
    ]);
    expect(test.steps).toContain(
      `✅ Reusing the App Registration already wired into AZURE_CLIENT_ID: ${APP_ID}`
    );
    expect(test.steps.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
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

  it("honors Stop after a failed owner write before automatic rollback", async () => {
    const test = harness({
      checkpoint: async (boundary) =>
        boundary !== "after-app-registration-owner-add",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) return command({ stdout: "[]" });
        if (line.startsWith("ad app create "))
          return command({ stdout: APP_ID });
        if (line.startsWith("ad signed-in-user show "))
          return command({ stdout: USER_ID });
        if (line.startsWith("ad app owner add ")) {
          // A rejection Entra composed, so the journal settles the attempt
          // without a reconciling read and the Stop lands on settled provenance.
          return command({
            code: 1,
            stderr:
              "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
          });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures).toEqual([]);
  });

  it("honors Stop after a rejected create instead of reporting the rejection", async () => {
    const test = harness({
      stopBoundary: async (boundary) =>
        boundary !== "after-app-registration-create-attempt",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) return command({ stdout: "[]" });
        if (line.startsWith("ad app create ")) {
          return command({
            code: 1,
            stderr:
              "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
          });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
    expect(test.failures).toEqual([]);
  });

  // Each checkpoint saves the write that just finished and then decides whether
  // a Stop recorded while it ran is honored before the next one starts.
  it.each([
    ["after-app-registration-owner-verify", "rest --method PATCH "],
    ["after-app-registration-tag-update", "ad app show "],
    ["after-app-registration-tag-verify", ""]
  ])(
    "stops at the %s checkpoint without failing the operation",
    async (boundary, forbiddenCommand) => {
      const azCalls: string[] = [];
      const requiredTags = buildRadiusAppProvenanceTags({
        repo: "octo/app",
        environment: "dev",
        operationId: "op-app"
      });
      const test = harness({
        checkpoint: async (current) => current !== boundary,
        runAz: async (args) => {
          const line = args.join(" ");
          azCalls.push(line);
          if (line.startsWith("ad app list ")) return command({ stdout: "[]" });
          if (line.startsWith("ad app create "))
            return command({ stdout: APP_ID });
          if (line.startsWith("ad signed-in-user show "))
            return command({ stdout: USER_ID });
          if (line.startsWith("ad app owner add ")) return command();
          if (line.startsWith("ad app owner list "))
            return command({ stdout: USER_ID });
          if (line.startsWith("rest --method PATCH ")) return command();
          if (line.startsWith("ad app show ") && line.includes("--query tags"))
            return command({ stdout: JSON.stringify(requiredTags) });
          throw new Error(`unscripted az call: ${line}`);
        }
      });

      expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
      expect(test.failures).toEqual([]);
      if (forbiddenCommand) {
        expect(azCalls.some((line) => line.startsWith(forbiddenCommand))).toBe(
          false
        );
      }
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
          return command({
            code: 1,
            stderr:
              "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
          });
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
        if (line.includes("--query tags")) {
          return command({ code: 1, stderr: "tags unavailable" });
        }
        if (line.startsWith("ad app show --id")) {
          return command({ stdout: "app-object" });
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
        if (line.startsWith("ad app show --id") && line.includes("tags")) {
          return command({ stdout: "[]" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    expect(await resolveAzureAutoSetupApplication(test.input)).toEqual({
      clientId: APP_ID,
      appName: "radius-deploy-octo-app",
      state: "reused"
    });
    expect(test.calls).toEqual(["record:reused"]);
    expect(test.steps).toContain(
      `✅ Using the selected App Registration: ${APP_ID}`
    );
    expect(test.steps.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
    expect(test.recorded).toEqual([
      expect.objectContaining({ state: "reused", origin: "pre_existing" })
    ]);
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
      appName: "radius-deploy-octo-app",
      state: "reused"
    });
    expect(test.calls).toEqual(["record:reused", "persist"]);
    expect(test.steps).toContain(
      `✅ Reusing existing App Registration: ${APP_ID}`
    );
    expect(test.steps.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
    // The list projection already carries tags, so an untagged match is decided
    // without a second lookup.
    expect(test.recorded[0]).toMatchObject({ origin: "pre_existing" });
  });

  it("names an earlier Radius setup as the source of a reused name match", async () => {
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([
              {
                appId: APP_ID,
                displayName: "Radius",
                createdDateTime: "today",
                tags: buildRadiusAppProvenanceTags({
                  repo: "octo/app",
                  environment: "dev",
                  operationId: "op_earlier"
                })
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
      appName: "radius-deploy-octo-app",
      state: "reused"
    });
    expect(test.recorded[0]).toMatchObject({
      state: "reused",
      origin: "radius_earlier_setup",
      appId: APP_ID
    });
  });

  it("names an earlier Radius setup behind the repository's AZURE_CLIENT_ID", async () => {
    const test = harness({
      overrides: { requestedClientId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("--query tags")) {
          return command({
            stdout: JSON.stringify(
              buildRadiusAppProvenanceTags({
                repo: "octo/app",
                environment: "dev",
                operationId: "op_earlier"
              })
            )
          });
        }
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

    await resolveAzureAutoSetupApplication(test.input);

    expect(test.recorded[0]).toMatchObject({
      state: "reused",
      origin: "radius_earlier_setup"
    });
  });

  it("does not claim Radius provenance from another environment's tags", async () => {
    const test = harness({
      overrides: { requestedClientId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("--query tags")) {
          return command({
            stdout: JSON.stringify(
              buildRadiusAppProvenanceTags({
                repo: "octo/app",
                environment: "prod",
                operationId: "op_earlier"
              })
            )
          });
        }
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

    await resolveAzureAutoSetupApplication(test.input);

    expect(test.recorded[0]).toMatchObject({ origin: "pre_existing" });
  });

  it("claims nothing when the provenance tags cannot be read", async () => {
    const test = harness({
      overrides: { requestedClientId: APP_ID },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.includes("--query tags")) {
          return command({ code: 1, stderr: "Graph denied" });
        }
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
    await resolveAzureAutoSetupApplication(test.input);
    await resolveAzureAutoSetupApplication(test.input);
    expect(test.recorded[0]).toMatchObject({ origin: "pre_existing" });
    expect(test.recorded[0]).toMatchObject({ origin: "pre_existing" });
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

  it("refuses a recent same-name application without immutable operation provenance", async () => {
    let listCalls = 0;
    let createCalls = 0;
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          listCalls += 1;
          return command({
            stdout:
              listCalls === 1 ? "[]" : (
                JSON.stringify([
                  {
                    appId: APP_ID,
                    displayName: "radius-deploy-octo-app",
                    createdDateTime: new Date().toISOString()
                  },
                  {
                    appId: "55555555-5555-5555-5555-555555555555",
                    displayName: "radius-deploy-octo-app",
                    createdDateTime: new Date().toISOString()
                  }
                ])
              )
          });
        }
        if (line.startsWith("ad app create ")) {
          createCalls += 1;
          return command({ code: 1, timedOut: true });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("immutable provenance")
    });
    expect(createCalls).toBe(1);
    expect(test.recorded).toEqual([]);
    expect(
      (
        test.input.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: { mutations: Array<{ status: string }> };
        }
      ).providerRecovery.mutations[0]?.status
    ).toBe("manual_required");
  });

  it("adopts an interrupted application only from immutable operation provenance", async () => {
    let listCalls = 0;
    const requiredTags = buildRadiusAppProvenanceTags({
      repo: "octo/app",
      environment: "dev",
      operationId: "op-app"
    });
    const test = harness({
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          listCalls += 1;
          return command({
            stdout:
              listCalls === 1 ? "[]" : (
                JSON.stringify([
                  {
                    appId: APP_ID,
                    displayName: "radius-deploy-octo-app",
                    tags: requiredTags
                  }
                ])
              )
          });
        }
        if (line.startsWith("ad app create ")) {
          return command({ code: 1, timedOut: true });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: "different-ambient-principal" });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: "different-ambient-principal" });
        }
        if (line.startsWith("ad app owner add ")) return command();
        if (line.startsWith("rest --method PATCH ")) return command();
        if (line.startsWith("ad app show ") && line.includes("--query tags")) {
          return command({ stdout: JSON.stringify(requiredTags) });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toMatchObject({
      clientId: APP_ID,
      state: "created"
    });
    expect(test.recorded).toContainEqual(
      expect.objectContaining({
        state: "created",
        appId: APP_ID,
        origin: "this_operation"
      })
    );
  });

  it("reconciles a restarted application before reuse and transfers directly to rollback", async () => {
    let listCalls = 0;
    let ownerAdds = 0;
    const requiredTags = buildRadiusAppProvenanceTags({
      operationId: "op-app"
    });
    let test: Harness;
    test = harness({
      checkpoint: async () =>
        (
          test.input.workflow.operation as AzureAutoSetupOperation & {
            providerRecovery?: { state?: string };
          }
        ).providerRecovery?.state !== "rollback_pending",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          listCalls += 1;
          if (listCalls === 1) return command({ stdout: "[]" });
          if (listCalls === 2)
            return command({ code: 1, stderr: "temporarily unavailable" });
          return command({
            stdout: JSON.stringify([
              {
                appId: APP_ID,
                displayName: "radius-deploy-octo-app",
                tags: requiredTags
              }
            ])
          });
        }
        if (line.startsWith("ad app create ")) {
          return command({ code: 1, timedOut: true });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: "changed-principal" });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: "changed-principal" });
        }
        if (line.startsWith("ad app owner add ")) {
          ownerAdds += 1;
          return command();
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });
    (
      test.input.workflow.operation as AzureAutoSetupOperation & {
        recoveryState?: string;
      }
    ).recoveryState = "provider_reconciliation_pending";

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toBeNull();
    expect(ownerAdds).toBe(0);
    expect(
      (
        test.input.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: { state: string };
        }
      ).providerRecovery.state
    ).toBe("rollback_pending");
  });

  it("reconciles a pending application before reading a changed AZURE_CLIENT_ID", async () => {
    const requiredTags = buildRadiusAppProvenanceTags({
      operationId: "op-app"
    });
    let githubVariableReads = 0;
    let unrelatedAppReads = 0;
    let test: Harness;
    test = harness({
      checkpoint: async () =>
        (
          test.input.workflow.operation as AzureAutoSetupOperation & {
            providerRecovery?: { state?: string };
          }
        ).providerRecovery?.state !== "rollback_pending",
      runGitHubJson: async () => {
        githubVariableReads += 1;
        return {
          ok: true,
          status: 200,
          json: { value: "55555555-5555-5555-5555-555555555555" }
        };
      },
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([
              {
                appId: APP_ID,
                displayName: "radius-deploy-octo-app",
                tags: requiredTags
              }
            ])
          });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app show ")) {
          unrelatedAppReads += 1;
          return command({ stdout: "unrelated-app" });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    const operation = test.input.workflow
      .operation as AzureAutoSetupOperation & {
      recoveryState?: string;
      providerRecovery: { state: string };
    };
    const mutation = prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:dev:radius-deploy-octo-app"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      "The response was lost."
    );
    operation.recoveryState = "provider_reconciliation_pending";

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toBeNull();
    expect(githubVariableReads).toBe(0);
    expect(unrelatedAppReads).toBe(0);
    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(test.recorded).toContainEqual(
      expect.objectContaining({
        state: "created",
        origin: "this_operation",
        appId: APP_ID
      })
    );
  });

  it("adopts a restarted application by the ledger artifact it recorded", async () => {
    let createCalls = 0;
    let test: Harness;
    test = harness({
      checkpoint: async () =>
        (
          test.input.workflow.operation as AzureAutoSetupOperation & {
            providerRecovery?: { state?: string };
          }
        ).providerRecovery?.state !== "rollback_pending",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([
              {
                appId: APP_ID,
                displayName: "radius-deploy-octo-app",
                tags: []
              }
            ])
          });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app create ")) {
          createCalls += 1;
          return command();
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    const operation = test.input.workflow
      .operation as AzureAutoSetupOperation & {
      recoveryState?: string;
      setupArtifacts: {
        azureApp: { origin: string; appId: string };
      };
    };
    operation.setupArtifacts = {
      azureApp: { origin: "this_operation", appId: APP_ID }
    };
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:dev:radius-deploy-octo-app"
    });

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toBeNull();
    expect(createCalls).toBe(0);
    expect(
      (
        operation as AzureAutoSetupOperation & {
          providerRecovery: { state: string };
        }
      ).providerRecovery.state
    ).toBe("rollback_pending");
  });

  it("adopts a restarted application by the provider id settled with the acknowledgement", async () => {
    // The window the journal exists to close: the create was acknowledged and
    // settled, then the process died before `recordAzureApp` wrote the ledger
    // artifact. No artifact, no tags — the settled provider id is the only
    // identity that exists, so the reconcile has to match on it or orphan a
    // real App Registration.
    let createCalls = 0;
    let test: Harness;
    test = harness({
      checkpoint: async () =>
        (
          test.input.workflow.operation as AzureAutoSetupOperation & {
            providerRecovery?: { state?: string };
          }
        ).providerRecovery?.state !== "rollback_pending",
      runAz: async (args) => {
        const line = args.join(" ");
        if (line.startsWith("ad app list ")) {
          return command({
            stdout: JSON.stringify([
              {
                appId: APP_ID,
                displayName: "radius-deploy-octo-app",
                tags: []
              }
            ])
          });
        }
        if (line.startsWith("ad signed-in-user show ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("ad app create ")) {
          createCalls += 1;
          return command();
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });
    const operation = test.input.workflow
      .operation as AzureAutoSetupOperation & {
      recoveryState?: string;
    };
    operation.recoveryState = "provider_reconciliation_pending";
    const mutation = prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:dev:radius-deploy-octo-app"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      "The provider request ended without a response.",
      APP_ID
    );

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toBeNull();
    // Adopted, not recreated and not handed off.
    expect(createCalls).toBe(0);
    expect(
      (
        operation as AzureAutoSetupOperation & {
          providerRecovery: { state: string };
        }
      ).providerRecovery.state
    ).toBe("rollback_pending");
  });

  it("reconciles timed-out owner and provenance mutations before continuing", async () => {
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
          return command({ code: 1, timedOut: true });
        }
        if (line.startsWith("ad app owner list ")) {
          return command({ stdout: USER_ID });
        }
        if (line.startsWith("rest --method PATCH ")) {
          return command({ code: 1, timedOut: true });
        }
        if (line.startsWith("ad app show ") && line.includes("--query tags")) {
          return command({ stdout: JSON.stringify(requiredTags) });
        }
        throw new Error(`unscripted az call: ${line}`);
      }
    });

    await expect(
      resolveAzureAutoSetupApplication(test.input)
    ).resolves.toMatchObject({
      clientId: APP_ID,
      state: "created"
    });
    expect(
      (
        test.input.workflow.operation as AzureAutoSetupOperation & {
          providerRecovery: {
            mutations: Array<{ kind: string; status: string }>;
          };
        }
      ).providerRecovery.mutations
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "azure_app_owner.add",
          status: "confirmed"
        }),
        expect.objectContaining({
          kind: "azure_app_tags.patch",
          status: "confirmed"
        })
      ])
    );
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
      appName: "radius-deploy-octo-app",
      state: "created"
    });
    expect(test.calls).toEqual([
      "persist",
      "persist",
      "record:created",
      "checkpoint",
      "persist",
      "persist",
      "checkpoint",
      "checkpoint",
      "persist",
      "persist",
      "checkpoint",
      "checkpoint"
    ]);
    expect(test.steps).toContain(
      `✅ Entra app registration created: ${APP_ID}`
    );
    expect(test.steps.join("\n")).not.toContain(ENTRA_APP_RETENTION_NOTICE);
    expect(test.recorded[0]).toMatchObject({
      state: "created",
      origin: "this_operation",
      appId: APP_ID
    });
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
          return command({
            code: 1,
            stderr:
              "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
          });
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
    expect(test.calls).toEqual(["persist", "persist", "record:created"]);
    expect(azCalls.some((line) => line.startsWith("ad app owner add "))).toBe(
      false
    );
  });

  it.each([
    ["before-app-registration-create", "ad app create "],
    ["before-app-registration-owner-add", "ad app owner add "],
    ["before-app-registration-tag-update", "rest --method PATCH "]
  ])(
    "starts no %s mutation after Stop is observed",
    async (boundary, forbiddenCommand) => {
      const azCalls: string[] = [];
      const requiredTags = buildRadiusAppProvenanceTags({
        repo: "octo/app",
        environment: "dev",
        operationId: "op-app"
      });
      const test = harness({
        stopBoundary: async (current) => current !== boundary,
        runAz: async (args) => {
          const line = args.join(" ");
          azCalls.push(line);
          if (line.startsWith("ad app list ")) return command({ stdout: "[]" });
          if (line.startsWith("ad app create "))
            return command({ stdout: APP_ID });
          if (line.startsWith("ad signed-in-user show "))
            return command({ stdout: USER_ID });
          if (line.startsWith("ad app owner add ")) return command();
          if (line.startsWith("ad app owner list "))
            return command({ stdout: USER_ID });
          if (line.startsWith("rest --method PATCH ")) return command();
          if (line.startsWith("ad app show ") && line.includes("--query tags"))
            return command({ stdout: JSON.stringify(requiredTags) });
          throw new Error(`unscripted az call: ${line}`);
        }
      });

      expect(await resolveAzureAutoSetupApplication(test.input)).toBeNull();
      expect(azCalls.some((line) => line.startsWith(forbiddenCommand))).toBe(
        false
      );
    }
  );

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
                command({
                  code: 1,
                  stderr:
                    "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
                })
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
                command({
                  code: 1,
                  stderr:
                    "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
                })
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
