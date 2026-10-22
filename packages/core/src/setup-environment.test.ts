import { describe, expect, it } from "vitest";
import { configureSetupEnvironment } from "./setup-environment.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";
import { setupEnvironmentHarness } from "../test/support/setup-environment.js";

describe("configureSetupEnvironment", () => {
  it.each(["azure", "aws"])(
    "configures %s without a panel, ignores optional false writes, and persists before projection",
    async (provider) => {
      const h = setupEnvironmentHarness();
      h.input.provider = provider;
      h.input.data.roleArn = "role";
      h.input.data.profileName = "profile";
      const result = await configureSetupEnvironment(h.input, h.ports);
      expect(result).toEqual({
        kind: "configured",
        operationId: "op_setup",
        environment: "dev",
        provider,
        repo: "octo/app",
        stateBackend: "oci",
        stateRegistry: "ghcr.io/octo/app-dev",
        stateArchive: "state",
        verifyRunUrl: "https://github.test/run/10",
        actionRequired: false,
        pullRequestUrl: "",
        pullRequestBranch: null,
        pullRequestBaseBranch: null,
        verifySkipped: false,
        verifySkipReason: null
      });
      expect(h.transcript).toContainEqual([
        "bind",
        {
          targetRepo: "octo/app",
          envName: "dev",
          environmentProviderId: "env-id",
          journalVariables: provider === "azure"
        }
      ]);
      const checkpoint = h.transcript.findIndex(
        (entry) =>
          JSON.stringify(entry) ===
          '["checkpoint","after-verification-dispatch"]'
      );
      const projection = h.transcript.findIndex(
        (entry) => Array.isArray(entry) && entry[0] === "project"
      );
      expect(projection).toBe(checkpoint + 1);
      expect(h.mutations.map((mutation) => mutation.kind)).toEqual([
        "github_workflow.put",
        "github_workflow.put",
        "github_workflow.put"
      ]);
      expect(h.transcript).not.toContain("deploy");
    }
  );

  it.each([
    "before-ghcr-bootstrap",
    "after-github-environment",
    "before-workflow-policy-read"
  ])("stops at %s without later work", async (boundary) => {
    const h = setupEnvironmentHarness();
    h.ports.stopBoundary = async (name) => name !== boundary;
    h.ports.checkpoint = async (name) => name !== boundary;
    expect(await configureSetupEnvironment(h.input, h.ports)).toEqual({
      kind: "stopped"
    });
    expect(
      h.events.some((event) => event.kind === "verification-dispatched")
    ).toBe(false);
  });

  it.each<Record<string, string | number | boolean | null>>([
    { name: "", value: "value" },
    { name: "RADIUS_MANAGED", value: "" },
    {},
    { name: 4, value: false }
  ])(
    "rejects incomplete durable variable intent %j without a write",
    async (intent) => {
      const h = setupEnvironmentHarness();
      h.mutations.push({
        mutationId: "var",
        kind: "github_environment_variable.put",
        target: "octo/app:dev:RADIUS_MANAGED",
        status: "prepared",
        evidence: null,
        intent
      });
      await expect(
        configureSetupEnvironment(h.input, h.ports)
      ).rejects.toMatchObject({
        code: "provider-mutation-manual-required",
        message:
          "Radius cannot reconcile the interrupted GitHub environment variable because its saved intent is incomplete. Review the environment variables manually before starting a new setup."
      });
      expect(h.transcript.at(-1)).toBe("persist");
      expect(
        h.transcript.some(
          (entry) => Array.isArray(entry) && entry[0] === "variable"
        )
      ).toBe(false);
    }
  );

  it("stops after reconciling the saved variable rather than bootstrapping a new package", async () => {
    const h = setupEnvironmentHarness({
      checkpoint: async (name) =>
        name !== "after-environment-variable-reconciliation:RADIUS_MANAGED"
    });
    h.mutations.push({
      mutationId: "var",
      kind: "github_environment_variable.put",
      target: "variable",
      status: "prepared",
      evidence: null,
      intent: { name: "RADIUS_MANAGED", value: "true" }
    });
    expect(await configureSetupEnvironment(h.input, h.ports)).toEqual({
      kind: "stopped"
    });
    expect(h.transcript).toContainEqual(["variable", "RADIUS_MANAGED", "true"]);
    expect(h.transcript).not.toContain("packages");
  });

  it.each([
    "baseline_failed",
    "rejected",
    "cancelled",
    "manual_required"
  ] as const)("preserves the %s dispatch exit", async (state) => {
    const h = setupEnvironmentHarness({
      runVerificationDispatch: async () => {
        switch (state) {
          case "baseline_failed":
            return { state, unreadable: true, detail: "", result: null };
          case "rejected":
            return {
              state,
              detail: "",
              result: { code: 1, stdout: "", stderr: "" }
            };
          case "cancelled":
            return { state };
          case "manual_required":
            return { state, guidance: "run identity ambiguous" };
        }
      }
    });
    if (state === "manual_required") {
      await expect(
        configureSetupEnvironment(h.input, h.ports)
      ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });
    } else {
      expect(await configureSetupEnvironment(h.input, h.ports)).toEqual({
        kind: state === "cancelled" ? "stopped" : "failed"
      });
    }
    expect(
      h.transcript.some(
        (entry) => Array.isArray(entry) && entry[0] === "project"
      )
    ).toBe(false);
  });

  it("propagates the original uncertain mutation error without honoring stop or finalizing twice", async () => {
    const error = new ProviderMutationRecoveryError(
      "unknown write",
      "provider-mutation-outcome-unknown"
    );
    const h = setupEnvironmentHarness({
      bootstrapStatePackage: async () => {
        throw error;
      }
    });
    await expect(configureSetupEnvironment(h.input, h.ports)).rejects.toBe(
      error
    );
    expect(h.failures).toEqual([]);
    expect(h.transcript).not.toContainEqual([
      "stop",
      "after-ghcr-state-package-attempt"
    ]);
  });

  it.each(["failed", "stopped"] as const)(
    "awaits typed failure finalization and returns its %s outcome",
    async (outcome) => {
      const order: string[] = [];
      const h = setupEnvironmentHarness({
        getDefaultBranch: async () => null,
        finalizeFailure: async () => {
          order.push("finalizing");
          await Promise.resolve();
          order.push("finalized");
          return outcome;
        }
      });
      const result = await configureSetupEnvironment(h.input, h.ports);
      order.push(result.kind);
      expect(order).toEqual(["finalizing", "finalized", outcome]);
    }
  );

  it.each(["cancelled", "manual_required"] as const)(
    "handles %s automatic discovery before projection",
    async (state) => {
      const h = setupEnvironmentHarness({
        planCredentialVerification: async () => ({
          shouldDispatch: true,
          trigger: "push",
          ref: "setup",
          defaultBranch: "trunk",
          pullRequestUrl: "",
          skipReason: ""
        }),
        discoverAutomaticVerificationRun: async () =>
          state === "cancelled" ?
            { state }
          : { state, guidance: "ambiguous automatic run" }
      });
      h.protectDefaultBranch();
      if (state === "cancelled")
        expect(await configureSetupEnvironment(h.input, h.ports)).toEqual({
          kind: "stopped"
        });
      else {
        await expect(
          configureSetupEnvironment(h.input, h.ports)
        ).rejects.toMatchObject({ message: "ambiguous automatic run" });
        expect(h.transcript.slice(-2)).toEqual([
          ["terminal-manual", "ambiguous automatic run"],
          "persist"
        ]);
      }
    }
  );

  it.each([
    ["invalid JSON", "{", 0, "unreadable pull request list"],
    ["non-array", "{}", 0, null],
    ["no matching PR", "[]", 0, null],
    [
      "exact PR",
      '[{"html_url":"https://github.test/pr/3","number":3,"head":{"ref":"saved"},"base":{"ref":"trunk"}}]',
      0,
      null
    ],
    [
      "duplicate PR",
      '[{"html_url":"one","number":1,"head":{"ref":"saved"},"base":{"ref":"trunk"}},{"html_url":"two","number":2,"head":{"ref":"saved"},"base":{"ref":"trunk"}}]',
      0,
      "Multiple pull requests"
    ],
    ["read failure", "", 1, "GitHub pull requests could not be read."],
    ["stdout failure", "forbidden", 1, "forbidden"]
  ] as const)(
    "reconciles %s using the saved PR head and base",
    async (_, stdout, code, error) => {
      const h = setupEnvironmentHarness();
      h.mutations.push(
        {
          mutationId: "branch",
          kind: "github_branch.create",
          target: "octo/app\0saved\0base-sha",
          status: "confirmed",
          evidence: null
        },
        {
          mutationId: "pr",
          kind: "github_pull_request.create",
          target: "octo/app:saved:trunk",
          status: "prepared",
          evidence: null
        }
      );
      const bind = h.ports.bindEnvironment;
      h.ports.bindEnvironment = (target) => {
        const runner = bind(target);
        return {
          ...runner,
          runGh: async (args) => {
            if (args[1]?.includes("/git/ref/heads/"))
              return {
                code: 0,
                stdout: '{"object":{"sha":"base-sha"}}',
                stderr: ""
              };
            if (args[1]?.includes("/pulls?"))
              return { code, stdout, stderr: "" };
            return runner.runGh(args);
          }
        };
      };
      h.ports.createPullRequest = async () => {
        throw new Error("Do not repeat PR creation");
      };
      if (error)
        await expect(
          configureSetupEnvironment(h.input, h.ports)
        ).rejects.toThrow(error);
      else {
        const result = await configureSetupEnvironment(h.input, h.ports);
        expect(result.kind).toBe("configured");
        expect(
          h.events.some((event) => event.kind === "pull-request-opened")
        ).toBe(stdout.includes("pr/3"));
      }
    }
  );

  it("honors a stop recorded by the PR-intent save before sending the PR", async () => {
    const h = setupEnvironmentHarness();
    h.protectDefaultBranch();
    h.ports.recovery.persist = async () => {
      if (
        h.mutations.some(
          (entry) =>
            entry.kind === "github_pull_request.create" &&
            entry.status === "prepared"
        )
      )
        h.stop();
    };
    h.ports.createPullRequest = async () => {
      throw new Error("PR sent after stop");
    };
    expect(await configureSetupEnvironment(h.input, h.ports)).toEqual({
      kind: "stopped"
    });
    expect(h.mutations.at(-1)?.status).toBe("not_applied");
  });

  it("does not start another workflow write when live stop and journal state require reconciliation", async () => {
    const h = setupEnvironmentHarness();
    const record = h.ports.recordCommittedWorkflowFile;
    h.ports.recordCommittedWorkflowFile = (entry) => {
      record(entry);
      h.mutations[0].status = "outcome_unknown";
      h.stop();
    };
    await expect(
      configureSetupEnvironment(h.input, h.ports)
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });
    expect(h.mutations).toHaveLength(1);
  });

  it("rereads the journal after publication before claiming completion", async () => {
    const h = setupEnvironmentHarness();
    let checkpoints = 0;
    h.ports.checkpoint = async (boundary) => {
      if (boundary === "after-workflow-commit" && ++checkpoints === 4)
        h.mutations[0].status = "outcome_unknown";
      return true;
    };
    expect(await configureSetupEnvironment(h.input, h.ports)).toEqual({
      kind: "failed"
    });
    expect(h.failures).toEqual([{ kind: "workflow-reconciliation-pending" }]);
  });

  it("continues the status-only path after a complete variable reconciliation", async () => {
    const h = setupEnvironmentHarness();
    h.mutations.push({
      mutationId: "var",
      kind: "github_environment_variable.put",
      target: "variable",
      status: "prepared",
      evidence: null,
      intent: { name: "RADIUS_MANAGED", value: "true" }
    });
    const result = await configureSetupEnvironment(h.input, h.ports);
    expect(result.kind).toBe("configured");
    expect(h.transcript).not.toContain("packages");
  });

  it("keeps merge-required identity when GitHub acknowledges a PR without a URL", async () => {
    const h = setupEnvironmentHarness({
      createPullRequest: async () => ({ ok: true, number: 1 }),
      planCredentialVerification: async ({ prState, defaultBranch }) => {
        if (!prState) throw new Error("Expected protected-branch publication");
        return {
          shouldDispatch: false,
          trigger: "none",
          ref: prState.branch,
          defaultBranch,
          pullRequestUrl: "",
          skipReason: "merge required"
        };
      }
    });
    h.protectDefaultBranch();
    const result = await configureSetupEnvironment(h.input, h.ports);
    expect(result).toMatchObject({
      kind: "configured",
      actionRequired: true,
      pullRequestUrl: "",
      pullRequestBranch: "radius/setup-dev-workflows-setup"
    });
    expect(h.transcript).toContainEqual([
      "finish-merge",
      {
        outcome: "awaiting-merge",
        pullRequestUrl: null,
        branch: "radius/setup-dev-workflows-setup",
        baseBranch: "trunk"
      }
    ]);
  });

  it.each([null, "legacy"])(
    "reads current verification state %j after automatic discovery rather than merging a stale snapshot",
    async (current) => {
      let verification: unknown;
      const h = setupEnvironmentHarness({
        verification: () => verification,
        setVerification: (value) => {
          verification = value;
        },
        planCredentialVerification: async ({ prState, defaultBranch }) => {
          if (!prState)
            throw new Error("Expected protected-branch publication");
          return {
            shouldDispatch: false,
            trigger: "push",
            ref: prState.branch,
            defaultBranch,
            pullRequestUrl: "",
            skipReason: ""
          };
        },
        discoverAutomaticVerificationRun: async () => {
          verification = current;
          return {
            state: "discovered",
            runId: "10",
            runUrl: "https://github.test/run/10"
          };
        }
      });
      h.protectDefaultBranch();
      expect((await configureSetupEnvironment(h.input, h.ports)).kind).toBe(
        "configured"
      );
      expect(verification).toMatchObject({
        runId: "10",
        event: "push",
        operationMarker: "op_setup"
      });
    }
  );
});
