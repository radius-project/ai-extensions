import { describe, expect, it } from "vitest";
import { DEPLOY_RAD_COMMANDS_STEP } from "./index.js";
import type { WorkflowRunDetail } from "./workflow-observation.js";
import {
  collectWorkflowFailure,
  extractRadDeployError
} from "./workflow-diagnostics.js";
import {
  explainOidcEnterpriseClaim,
  classifyDeployCloudAuthDrift,
  extractErrorLines,
  extractGitHubActionsStepLog
} from "./workflow-diagnostics.js";

// The exact rejection surfaced by GitHub Actions' "Azure Login (OIDC)" step when
// a personal-account repo hits a tenant that enforces the enterprise claim.
const MS_ERROR =
  "AADSTS7002381: Federated identity credentials issued by " +
  "'https://token.actions.githubusercontent.com/' for applications or managed " +
  "identities registered in this tenant must contain the enterprise claim with " +
  "value 'microsoft', 'github' or 'microsoftopensource' but actual value is ''.";

it("exports the deployment step name used by workflow evidence consumers", () => {
  expect(DEPLOY_RAD_COMMANDS_STEP).toBe("Run rad commands");
});

describe("explainOidcEnterpriseClaim", () => {
  it("explains the Microsoft-tenant rejection, parsing accepted + empty actual value", () => {
    const out = explainOidcEnterpriseClaim(MS_ERROR);
    expect(out).not.toBe("");
    // All three accepted values are surfaced dynamically (parsed, not hardcoded).
    expect(out).toContain("microsoft");
    expect(out).toContain("github");
    expect(out).toContain("microsoftopensource");
    // Frames it as the missing "enterprise" claim.
    expect(out.toLowerCase()).toContain("enterprise");
    expect(out).toContain("missing");
    // Explains the personal-account root cause and the empty actual value.
    expect(out.toLowerCase()).toContain("personal");
    expect(out).toContain("empty");
  });

  describe("extractGitHubActionsStepLog", () => {
    it("isolates the actual Azure Login step from advisory text that mentions AADSTS7002381", () => {
      const log = [
        "verify\tAzure Login (OIDC)\t2026-08-07T04:04:47Z ##[error]No subscriptions found.",
        'verify\tReport possible GitHub enterprise-claim mismatch\t2026-08-07T04:04:48Z echo "Check for AADSTS7002381"',
        'verify\tReport possible GitHub enterprise-claim mismatch\t2026-08-07T04:04:48Z echo "must contain the enterprise claim"'
      ].join("\n");
      const azureLogin = extractGitHubActionsStepLog(log, "Azure Login (OIDC)");
      expect(azureLogin).toContain("No subscriptions found");
      expect(azureLogin).not.toContain("AADSTS7002381");
      expect(explainOidcEnterpriseClaim(azureLogin)).toBe("");
    });

    it("returns an empty string when structured step prefixes are unavailable", () => {
      expect(
        extractGitHubActionsStepLog(
          "AADSTS7002381 was mentioned outside a structured step log",
          "Azure Login (OIDC)"
        )
      ).toBe("");
    });

    it("isolates Azure Login when gh labels every log row UNKNOWN STEP", () => {
      const log = [
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:46Z ##[group]Run azure/login@abc123",
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:47Z Running Azure CLI Login.",
        `verify\tUNKNOWN STEP\t2026-08-07T04:04:48Z ##[error]${MS_ERROR}`,
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:49Z ##[endgroup]",
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:50Z Logout succeeded.",
        'verify\tUNKNOWN STEP\t2026-08-07T04:04:51Z ##[group]Run echo "Check for AADSTS7002381"',
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:52Z must contain the enterprise claim"
      ].join("\n");

      const azureLogin = extractGitHubActionsStepLog(log, "Azure Login (OIDC)");
      expect(azureLogin).toContain("AADSTS7002381");
      expect(azureLogin).toContain("Logout succeeded");
      expect(azureLogin).not.toContain('Run echo "Check for AADSTS7002381"');
      expect(explainOidcEnterpriseClaim(azureLogin)).toContain(
        "GitHub Enterprise"
      );
    });
  });

  it("is tenant-agnostic: surfaces a non-Microsoft tenant's accepted + actual values", () => {
    const log =
      "AADSTS7002381: ... must contain the enterprise claim with value " +
      "'contoso' or 'fabrikam' but actual value is 'personal-acct'.";
    const out = explainOidcEnterpriseClaim(log);
    expect(out).not.toBe("");
    expect(out).toContain("contoso");
    expect(out).toContain("fabrikam");
    expect(out).toContain("personal-acct");
    // Proves nothing is hardcoded to Microsoft's values.
    expect(out).not.toContain("microsoft");
  });

  it("distinguishes a present-but-untrusted claim value (not 'missing')", () => {
    const log =
      "AADSTS7002381: ... must contain the enterprise claim with value " +
      "'microsoft' or 'github' but actual value is 'fabrikam'.";
    const out = explainOidcEnterpriseClaim(log);
    expect(out).not.toBe("");
    // The claim IS present, just not trusted — must not say it's "missing".
    expect(out).toContain("not trusted");
    expect(out).toContain("fabrikam");
    expect(out).not.toContain("missing");
  });

  it("returns '' for an unrelated error", () => {
    expect(explainOidcEnterpriseClaim("some unrelated error: forbidden")).toBe(
      ""
    );
  });

  it("falls back to a generic accepted label and 'not reported' when only the AADSTS code is present", () => {
    const log =
      "Login failed: AADSTS7002381 was returned by the token endpoint.";
    const out = explainOidcEnterpriseClaim(log);
    expect(out).not.toBe("");
    expect(out).toContain("a value required by the target Azure tenant");
    // Actual value was not parseable — don't assert a definite empty/personal value.
    expect(out).toContain("not reported");
    expect(out).not.toContain("missing");
    expect(out).not.toContain("empty (this repository");
  });

  it("returns '' for empty / undefined input", () => {
    expect(explainOidcEnterpriseClaim("")).toBe("");
    expect(explainOidcEnterpriseClaim(undefined)).toBe("");
    expect(explainOidcEnterpriseClaim(null)).toBe("");
  });
});

describe("classifyDeployCloudAuthDrift", () => {
  // Exception 5.2: a redeploy whose cloud login/credentials step fails before
  // `rad deploy` touches a resource is credential drift, not a resource failure.
  it("classifies an Azure login-step failure before any resource was touched", () => {
    const out = classifyDeployCloudAuthDrift({
      provider: "azure",
      resourcesTouched: false,
      failedStepNames: ["Azure Login (OIDC)"]
    });
    expect(out).toContain("Cloud authentication or authorization failed");
    expect(out).toContain("Azure");
    expect(out).toContain("federated credential or role assignment");
    expect(out).toContain("Re-verify the environment's credentials");
    // Prior verification is unknown here, so the message must not assert it.
    expect(out).toContain("If this environment authenticated before");
    expect(out).not.toContain("verified earlier");
  });

  it("classifies an AWS configure-credentials / assume-role failure", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "aws",
        resourcesTouched: false,
        failedStepNames: ["Configure AWS Credentials"]
      })
    ).toContain("AWS");
    const assume = classifyDeployCloudAuthDrift({
      provider: "aws",
      resourcesTouched: false,
      failedStepNames: ["Assume role"]
    });
    expect(assume).toContain("IAM role's trust policy or permissions");
  });

  it("uses a provider-agnostic label for an unknown provider", () => {
    // An unknown provider cannot be tied to a provider-specific login step, so
    // its failure is no longer force-classified as drift.
    const out = classifyDeployCloudAuthDrift({
      provider: "gcp",
      resourcesTouched: false,
      failedStepNames: ["OIDC login"]
    });
    expect(out).toBe("");
  });

  it("returns '' once a resource was touched (that is a 5.1 resource failure)", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: true,
        failedStepNames: ["Azure Login (OIDC)"]
      })
    ).toBe("");
  });

  it("returns '' when no failed step looks like a cloud auth step", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "aws",
        resourcesTouched: false,
        failedStepNames: ["Run rad commands", undefined]
      })
    ).toBe("");
  });

  it("returns '' when there are no failed steps at all", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: []
      })
    ).toBe("");
  });

  it("returns '' when a mutation step failed even though login is also listed", () => {
    // A failed mutation step (e.g. registering credentials with Radius) means
    // state was already being changed, so this is not clean pre-mutation drift.
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: [
          "Azure Login (OIDC)",
          "Register cloud credentials with Radius"
        ]
      })
    ).toBe("");
  });

  it("does not misread a mutation step that mentions credentials as a login failure", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: ["Refresh external deployment target credentials"]
      })
    ).toBe("");
  });

  it("returns '' when the environment never verified (bypassed), even at the login step", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: ["Azure Login (OIDC)"],
        environmentPreviouslyVerified: false
      })
    ).toBe("");
  });

  it("classifies drift when the environment previously verified and login failed", () => {
    const out = classifyDeployCloudAuthDrift({
      provider: "aws",
      resourcesTouched: false,
      failedStepNames: ["Configure AWS Credentials (OIDC)"],
      environmentPreviouslyVerified: true
    });
    expect(out).toContain("Cloud authentication or authorization failed");
    // Prior success is proven, so the message may assert it.
    expect(out).toContain("This environment verified earlier");
  });
});

describe("extractErrorLines", () => {
  it("returns trailing error-ish lines only", () => {
    const log = [
      "starting up",
      "everything is fine",
      "Error: something exploded",
      "cleanup done",
      "fatal: giving up"
    ].join("\n");
    const out = extractErrorLines(log, 8);
    expect(out).toContain("Error: something exploded");
    expect(out).toContain("fatal: giving up");
    expect(out).not.toContain("everything is fine");
  });

  describe("Radius excerpts", () => {
    it("does not borrow another step's log or a nested ungrouped boundary", () => {
      expect(
        extractGitHubActionsStepLog("job\tOther\tdate error", "Deploy")
      ).toBe("");
      const text = [
        "job\tUNKNOWN STEP\tdate before login",
        "job\tUNKNOWN STEP\tdate ##[group]Run azure/login@v2",
        "job\tUNKNOWN STEP\tdate ##[group]nested",
        "job\tUNKNOWN STEP\tdate error",
        "job\tUNKNOWN STEP\tdate ##[endgroup]"
      ].join("\n");
      expect(extractGitHubActionsStepLog(text, "Azure Login (OIDC)")).toBe(
        text.split("\n").slice(1).join("\n")
      );
    });
    it("explains an enterprise policy whose accepted value is not quoted", () => {
      expect(
        explainOidcEnterpriseClaim(
          "must contain the enterprise claim with value enterprise but actual value is 'other'"
        )
      ).toContain("a value required by the target Azure tenant");
    });
    it.each([undefined, null, ""])("accepts an unavailable log: %s", (log) => {
      expect(extractRadDeployError(log)).toBe("");
    });
    it("takes the last structured block and stops at the trace or Actions wrapper", () => {
      const prefix = "job\tRun rad commands\t2026-01-01 ";
      expect(
        extractRadDeployError(
          [
            "Error: { old }",
            "Error: {",
            "recipe failed",
            "TraceId: 123",
            "ignored error"
          ]
            .map((line) => prefix + line)
            .join("\n")
        )
      ).toBe("Error: {\nrecipe failed\nTraceId: 123");
      expect(
        extractRadDeployError(
          "Error: {\nrecipe failed\nError: Process completed"
        )
      ).toBe("Error: {\nrecipe failed");
      expect(extractRadDeployError("Error: { detail }", 8)).toBe("Error: {");
    });
    it("bounds fallback lines and the final excerpt", () => {
      const lines = Array.from({ length: 21 }, (_, i) => `error ${i}`);
      expect(extractRadDeployError(lines.join("\n"))).toBe(
        lines.slice(1).join("\n")
      );
      expect(extractRadDeployError("normal\nerror detail\n", 5)).toBe("error");
      expect(extractRadDeployError("normal")).toBe("");
    });
  });

  describe("terminal collection of an already-observed run", () => {
    const target = Object.freeze({ repo: "org/app", runId: 41 });
    it.each([
      "in_progress",
      "waiting",
      "queued",
      "future_status",
      "",
      undefined
    ])(
      "does not collect failure evidence when the observed status is %j",
      async (status) => {
        const observed: WorkflowRunDetail = {
          status,
          conclusion: "failure",
          jobs: [],
          steps: [{ name: "Azure Login (OIDC)", conclusion: "failure" }]
        };
        const reads: string[] = [];
        const result = await collectWorkflowFailure(
          target,
          observed,
          { provider: "azure", resourcesTouched: false },
          {
            readLog: async () => {
              reads.push("workflow");
              return "Error: incomplete run";
            },
            readControlPlaneLog: async () => {
              reads.push("control-plane");
              return "incomplete control-plane evidence";
            }
          }
        );
        expect(reads).toEqual([]);
        expect(result).toEqual({
          message:
            "Workflow outcome is unconfirmed. View the full run: https://github.com/org/app/actions/runs/41",
          radiusError: "",
          authDriftMessage: "",
          narration: []
        });
      }
    );
    const run = Object.freeze({
      status: "completed",
      conclusion: "failure",
      steps: Object.freeze([
        Object.freeze({ name: "Azure Login (OIDC)", conclusion: "failure" }),
        Object.freeze({ name: "Run rad commands", conclusion: "skipped" }),
        Object.freeze({ name: "Checkout", conclusion: "success" }),
        Object.freeze({ name: "Waiting", conclusion: null })
      ])
    });
    it("prefixes Azure OIDC claim help before raw failure and reads diagnostics in order", async () => {
      const calls: string[] = [];
      const result = await collectWorkflowFailure(
        target,
        { ...run, steps: [...run.steps] },
        { provider: "azure", resourcesTouched: false },
        {
          readLog: async (repo, runId) => {
            expect([repo, runId]).toEqual(["org/app", 41]);
            expect(calls).toEqual([]);
            calls.push("workflow");
            return `deploy\tAzure Login (OIDC)\t2026-01-01 ${MS_ERROR}`;
          },
          readControlPlaneLog: async () => {
            expect(calls).toEqual(["workflow"]);
            calls.push("control-plane");
            return "control-plane evidence";
          }
        }
      );
      expect(calls).toEqual(["workflow", "control-plane"]);
      expect(result.message).toMatch(
        /^Azure Login \(OIDC\) was rejected because this repository/
      );
      expect(result.message).toContain(
        'GitHub OIDC token is missing the required "enterprise" claim.'
      );
      expect(result.message).toContain(
        "microsoft, github, microsoftopensource (actual: empty"
      );
      expect(result.message).toContain(
        "\u2014 raw error \u2014\nDeployment failed (failure). Failed step: Azure Login (OIDC).\n\n" +
          "\u2014 control-plane log \u2014\ncontrol-plane evidence\n\n" +
          "View the full run: https://github.com/org/app/actions/runs/41"
      );
      expect(result.radiusError).toBe("");
      expect(result.narration).toEqual([
        "",
        "──────── control-plane log ────────",
        "  control-plane evidence",
        "───────────────────────────────────"
      ]);
    });
    it.each([null, "", "  \n "])(
      "retains ordinary failure for missing log %j and still reads control-plane evidence",
      async (log) => {
        const calls: string[] = [];
        const result = await collectWorkflowFailure(
          target,
          { ...run, steps: [...run.steps] },
          {
            provider: "azure",
            resourcesTouched: false
          },
          {
            readLog: async (repo, runId) => {
              calls.push(`${repo}:${runId}`);
              return log;
            },
            readControlPlaneLog: async () => {
              calls.push("control-plane");
              return log;
            }
          }
        );
        expect(calls).toEqual(["org/app:41", "control-plane"]);
        expect(result.message).toBe(
          "Deployment failed (failure). Failed step: Azure Login (OIDC).\n\nView the full run: https://github.com/org/app/actions/runs/41"
        );
        expect(result.radiusError).toBe("");
        expect(result.narration).toEqual([]);
        expect(result.authDriftMessage).toContain(
          "If this environment authenticated before"
        );
      }
    );
    it("retains observed failure and explicitly reports both secondary read failures without leaking exceptions", async () => {
      const calls: string[] = [];
      const result = await collectWorkflowFailure(
        target,
        { ...run, steps: [...run.steps] },
        {
          provider: "azure",
          resourcesTouched: false
        },
        {
          readLog: () => {
            calls.push("log");
            throw new Error("fixture-private-log-detail");
          },
          readControlPlaneLog: () => {
            calls.push("control-plane");
            throw new Error("fixture-private-artifact-detail");
          }
        }
      );
      expect(result.message).toBe(
        "Deployment failed (failure). Failed step: Azure Login (OIDC).\n\nThe workflow log could not be read.\n\nThe control-plane log could not be read.\n\nView the full run: https://github.com/org/app/actions/runs/41"
      );
      expect(calls).toEqual(["log", "control-plane"]);
      expect(JSON.stringify(result)).not.toContain("fixture-private");
      expect(result.authDriftMessage).toContain("Cloud authentication");
      expect(result.radiusError).toBe("");
      expect(result.narration).toEqual([
        "The workflow log could not be read.",
        "The control-plane log could not be read."
      ]);
    });
    it("keeps the normal failure when the best-effort control-plane read throws", async () => {
      const result = await collectWorkflowFailure(
        target,
        { status: "completed", conclusion: "failure", steps: [] },
        {
          resourcesTouched: false
        },
        {
          readLog: async () => "Error: recipe failed",
          readControlPlaneLog: () => {
            throw new Error("artifact expired");
          }
        }
      );
      expect(result.message).toBe(
        "Deployment failed (failure).\n\nError: recipe failed\n\nThe control-plane log could not be read.\n\nView the full run: https://github.com/org/app/actions/runs/41"
      );
      expect(result.radiusError).toBe("Error: recipe failed");
      expect(result.narration).toEqual([
        "",
        "──────── failure details ────────",
        "  Error: recipe failed",
        "─────────────────────────────────",
        "The control-plane log could not be read."
      ]);
    });
    it("does not retain prior details or narration when a later collection loses both reads", async () => {
      const observed = {
        status: "completed",
        conclusion: "failure",
        steps: [{ name: "Run rad commands", conclusion: "failure" }]
      };
      const first = await collectWorkflowFailure(
        target,
        observed,
        { resourcesTouched: true },
        {
          readLog: async () => "Error: earlier recipe failed",
          readControlPlaneLog: async () => "earlier control-plane evidence"
        }
      );
      const originalNarration = [...first.narration];
      expect(first.radiusError).toBe("Error: earlier recipe failed");
      expect(first.narration).toContain("  earlier control-plane evidence");

      const second = await collectWorkflowFailure(
        { ...target, runId: 42 },
        observed,
        { resourcesTouched: true },
        {
          readLog: async () => {
            throw new Error("fixture-private-log-detail");
          },
          readControlPlaneLog: async () => {
            throw new Error("fixture-private-artifact-detail");
          }
        }
      );
      expect(second).toEqual({
        message:
          "Deployment failed (failure). Failed step: Run rad commands.\n\nThe workflow log could not be read.\n\nThe control-plane log could not be read.\n\nView the full run: https://github.com/org/app/actions/runs/42",
        radiusError: "",
        authDriftMessage: "",
        narration: [
          "The workflow log could not be read.",
          "The control-plane log could not be read."
        ]
      });
      expect(second.narration).not.toBe(first.narration);
      expect(first.narration).toEqual(originalNarration);
    });
    it.each([null, undefined, "", "future_conclusion"])(
      "does not let diagnostics manufacture a failure from %j",
      async (conclusion) => {
        const result = await collectWorkflowFailure(
          target,
          {
            status: "completed",
            conclusion,
            steps: [{ name: "Azure Login (OIDC)", conclusion: "failure" }]
          },
          { provider: "azure", resourcesTouched: false },
          {
            readLog: () => {
              throw new Error("must not read diagnostics without outcome");
            },
            readControlPlaneLog: () => {
              throw new Error("must not read artifacts without outcome");
            }
          }
        );
        expect(result).toEqual({
          message:
            "Workflow outcome is unconfirmed. View the full run: https://github.com/org/app/actions/runs/41",
          radiusError: "",
          authDriftMessage: "",
          narration: []
        });
      }
    );
    it("still collects control-plane evidence after the run log throws", async () => {
      const result = await collectWorkflowFailure(
        target,
        {
          status: "completed",
          conclusion: "failure",
          steps: [{ name: "Run rad commands", conclusion: "failure" }]
        },
        { resourcesTouched: true },
        {
          readLog: () => Promise.reject(new Error("fixture-private")),
          readControlPlaneLog: async () => "recipe provisioning failed"
        }
      );
      expect(result.message).toContain("Failed step: Run rad commands.");
      expect(result.message).toContain("recipe provisioning failed");
      expect(result.message).toContain("The workflow log could not be read.");
      expect(result.radiusError).toBe("");
    });
    it.each([
      {
        names: ["Run rad commands", "Persist Radius state (rad shutdown)"],
        logs: [
          "deploy\tRun rad commands\t2026-01-01 Error: { primary quota }",
          "deploy\tPersist Radius state (rad shutdown)\t2026-01-01 Error: { secondary shutdown }"
        ],
        expected: "Error: { primary quota }"
      },
      {
        names: ["Run rad commands", "Cleanup control plane cluster"],
        logs: [
          "deploy\tRun rad commands\t2026-01-01 deployment output",
          "deploy\tCleanup control plane cluster\t2026-01-01 Error: { cleanup only }"
        ],
        expected: "Error: { cleanup only }"
      },
      {
        names: ["Run rad commands"],
        logs: ["deploy\tUNKNOWN STEP\t2026-01-01 Error: { unattributed }"],
        expected: "Error: { unattributed }"
      },
      {
        names: ["Run rad commands", "Persist Radius state (rad shutdown)"],
        logs: [
          "deploy\tUNKNOWN STEP\t2026-01-01T00:00:01Z Error: { deployment quota }",
          "deploy\tUNKNOWN STEP\t2026-01-01T00:00:02Z Error: { teardown failed }",
          "deploy\tUNKNOWN STEP\t2026-01-01T00:00:03Z TraceId: fixture-trace"
        ],
        expected: "Error: { teardown failed }\nTraceId: fixture-trace"
      },
      {
        names: ["Run rad commands"],
        logs: ["Error: { unprefixed }"],
        expected: "Error: { unprefixed }"
      },
      {
        names: ["Persist Radius state (rad shutdown)"],
        logs: [
          "deploy\tPersist Radius state (rad shutdown)\t2026-01-01 Error: { persistence failed }"
        ],
        expected: "Error: { persistence failed }"
      },
      {
        names: ["Run rad commands", "Run rad commands"],
        logs: [
          "first\tRun rad commands\t2026-01-01 Error: { first job }",
          "second\tRun rad commands\t2026-01-01 Error: { second job }"
        ],
        expected: "Error: { second job }"
      },
      {
        names: ["Run rad commands"],
        logs: [
          "first\tRun rad commands\t2026-01-01 Error: { first job }",
          "second\tRun rad commands\t2026-01-01 Error: { second job }"
        ],
        expected: "Error: { second job }"
      }
    ])(
      "uses only unambiguous primary attribution for $names / $logs",
      async ({ names, logs, expected }) => {
        const result = await collectWorkflowFailure(
          target,
          {
            status: "completed",
            conclusion: "failure",
            steps: names.map((name) => ({
              name,
              status: "completed",
              conclusion: "failure"
            })),
            jobs: [
              {
                name: "deploy",
                steps: names.map((name) => ({
                  name,
                  status: "completed",
                  conclusion: "failure"
                }))
              }
            ]
          },
          { resourcesTouched: true },
          {
            readLog: async () => logs.join("\n"),
            readControlPlaneLog: async () => null
          }
        );
        expect(result.radiusError).toBe(expected);
        expect(result.message).toBe(
          `Deployment failed (failure). Failed step: ${names.join(", ")}.\n\n${expected}\n\nView the full run: https://github.com/org/app/actions/runs/41`
        );
        expect(result.narration).toEqual([
          "",
          "──────── failure details ────────",
          ...expected.split("\n").map((line) => "  " + line),
          "─────────────────────────────────"
        ]);
      }
    );
    it("keeps the 40-line tail and narration order", async () => {
      const lines = Array.from({ length: 41 }, (_, index) => `line-${index}`);
      const result = await collectWorkflowFailure(
        target,
        { status: "completed", conclusion: "timed_out", steps: [] },
        {
          resourcesTouched: false
        },
        {
          readLog: async () => "Error: failure",
          readControlPlaneLog: async () => lines.join("\n") + "\n\n"
        }
      );
      expect(result.authDriftMessage).toBe("");
      expect(result.message).not.toContain("line-0");
      expect(result.message).toContain(lines.slice(1).join("\n"));
      expect(result.narration).toEqual([
        "",
        "──────── failure details ────────",
        "  Error: failure",
        "─────────────────────────────────",
        "",
        "──────── control-plane log ────────",
        ...lines.slice(1).map((line) => "  " + line),
        "───────────────────────────────────"
      ]);
    });

    it.each([
      undefined,
      [],
      [{}],
      [
        {
          name: "renamed display name",
          steps: [{ name: "Run rad commands", conclusion: "failure" }]
        }
      ],
      [{ name: "deploy" }],
      [
        {
          name: "deploy",
          steps: [{ name: "Run rad commands", conclusion: "success" }]
        }
      ],
      [
        {
          name: "deploy",
          steps: [{ name: "Different command", conclusion: "failure" }]
        }
      ],
      [
        {
          name: "deploy",
          steps: [{ name: "Run rad commands", conclusion: "failure" }]
        },
        {
          name: "deploy",
          steps: [{ name: "Run rad commands", conclusion: "failure" }]
        }
      ]
    ])(
      "retains unscoped evidence when job attribution is absent or conflicting: %j",
      async (jobs) => {
        const result = await collectWorkflowFailure(
          target,
          {
            status: "completed",
            conclusion: "failure",
            steps: [{ name: "Run rad commands", conclusion: "failure" }],
            jobs
          },
          { resourcesTouched: true },
          {
            readLog: async () =>
              [
                "deploy\tRun rad commands\t2026-01-01 Error: { unattributed deploy }",
                "deploy\tCleanup\t2026-01-01 Error: { available teardown evidence }"
              ].join("\n"),
            readControlPlaneLog: async () => null
          }
        );
        expect(result.radiusError).toBe(
          "Error: { available teardown evidence }"
        );
        expect(result.message).toContain("Failed step: Run rad commands.");
      }
    );
  });

  it("returns [] for empty input", () => {
    expect(extractErrorLines("")).toEqual([]);
    expect(extractErrorLines(undefined)).toEqual([]);
  });
});
