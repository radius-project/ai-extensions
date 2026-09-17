import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  portSuccess,
  portCancelled,
  type ExecutionIdentity,
  type WorkflowPreparation
} from "@radius-project/core/lifecycle";
import { createWorkflowExecution } from "@radius-project/adapter-shared";
import { createLifecycleBinding } from "../../src/runtime/create-lifecycle-binding.js";
import { createLifecycleFixture } from "./lifecycle.js";

export function createDeploymentFixture() {
  const fixture = createLifecycleFixture();
  const commit = "a".repeat(40);
  const fingerprint = `sha256:${"b".repeat(64)}`;
  const target = {
    repo: "owner/repo",
    environment: "dev",
    application: "app",
    definition: ".radius/app.bicep",
    source: { kind: "git" as const, ref: "feature", expectedCommit: commit }
  };
  const source = {
    kind: "git" as const,
    repo: target.repo,
    ref: "feature",
    commit,
    fingerprint,
    resolvedAt: fixture.ports.clock.now()
  };
  const files = Object.fromEntries(
    [
      "run-rad-commands.yml",
      "run-rad-commands-azure.yml",
      "run-rad-commands-aws.yml"
    ].map((file) => [
      file,
      readFileSync(resolve(".github", "extension", file), "utf8")
        .replaceAll("{{RADIUS_REF}}", commit)
        .replaceAll("{{ENV}}", "dev")
        .replaceAll("{{APP_FILE}}", ".radius/app.bicep")
        .replaceAll("{{LIFECYCLE_APPLICATION}}", "app")
    ])
  );
  const state = {
    dispatches: [] as (readonly string[])[],
    reads: 0,
    timedOut: false,
    cancelQualification: false,
    wrongCommit: false,
    foreign: false,
    noRuns: false,
    artifact: true,
    saveFailure: false,
    forbidden: false,
    conclusion: "success" as
      "success" | "failure" | "cancelled" | "in_progress",
    prepared: undefined as WorkflowPreparation | undefined
  };
  const producerFiles = Object.fromEntries(
    [
      "lifecycle-evidence/action.yml",
      "lifecycle-evidence/evidence.sh",
      "run-rad-commands/action.yml",
      "restore-state/action.yml",
      "teardown/action.yml",
      "publish-lifecycle-result/action.yml",
      "deploy-progress/progress.sh"
    ].map((file) => [
      file,
      readFileSync(resolve(".github", "extension", "actions", file), "utf8")
    ])
  );
  const qualify = async (input: WorkflowPreparation) => {
    if (state.cancelQualification) return portCancelled("request_cancelled");
    state.prepared = input;
    return portSuccess({
      repo: target.repo,
      environment: target.environment,
      application: target.application,
      definition: target.definition,
      workflow: ".github/workflows/run-rad-commands.yml",
      executionVersion: 1 as const,
      producerRef: commit,
      commit,
      selectedFiles: files,
      reviewedFiles: files,
      producerFiles,
      reviewedProducerFiles: producerFiles,
      protections: "verified" as const
    });
  };
  function identity(): ExecutionIdentity {
    if (!state.prepared) throw new Error("No workflow prepared");
    return {
      ...state.prepared.correlation,
      run: {
        repo: target.repo,
        workflow: ".github/workflows/run-rad-commands.yml",
        runId: "123",
        runAttempt: 1,
        commit
      }
    };
  }
  const workflow = createWorkflowExecution({
    ids: fixture.ports.ids,
    clock: { ...fixture.ports.clock, wait: async () => portSuccess(undefined) },
    qualify,
    revalidate: qualify,
    dispatch: async (args) => {
      state.dispatches.push(args);
      return { code: state.timedOut ? 1 : 0, timedOut: state.timedOut };
    },
    runs: async () => {
      state.reads++;
      return portSuccess(state.noRuns ? [] : [identity()]);
    },
    observation: async () => {
      state.reads++;
      const actual = identity();
      return portSuccess({
        identity: actual,
        conclusion: state.saveFailure ? "failure" : state.conclusion,
        ...(state.artifact ?
          {
            artifact: JSON.stringify({
              executionSchemaVersion: 1,
              operationId: actual.operationId,
              attemptId: actual.attemptId,
              operation: actual.operation,
              ...actual.target,
              expectedCommit: commit,
              actualCommit: state.foreign ? "c".repeat(40) : commit,
              runId: 123,
              runAttempt: 1,
              sequence: 5,
              observedAt: fixture.ports.clock.now(),
              phases: {
                restore: { outcome: "succeeded", exitCode: 0 },
                commands: { outcome: "succeeded", exitCode: 0 },
                stateSave: {
                  outcome: state.saveFailure ? "failed" : "succeeded",
                  exitCode: state.saveFailure ? 7 : 0
                },
                cleanup: { outcome: "succeeded", exitCode: 0 }
              }
            })
          }
        : {})
      });
    }
  });
  const binding = createLifecycleBinding({
    authority: fixture.ports.identity,
    ids: fixture.ports.ids,
    clock: fixture.ports.clock,
    hostBinding: () => ({
      bindingRef: "fixture-binding",
      sessionRef: fixture.caller.sessionRef
    }),
    resolveWorkspaceSource: async () => {
      throw new Error("Deployment must not capture workspace source");
    },
    resolveGitSource: async () => portSuccess(target.source),
    knownLegacyOperations: () => [],
    deployment: {
      workflow,
      source: {
        capture: async () =>
          portSuccess({
            status: "captured",
            snapshot: {
              snapshotRef: "snapshot",
              selection: target,
              provenance: {
                ...source,
                commit: state.wrongCommit ? "c".repeat(40) : commit
              },
              manifest: {
                completeness: "complete",
                definition: target.definition,
                fingerprint,
                inputs: [
                  {
                    path: target.definition,
                    kind: "definition",
                    existed: true,
                    contentHash: fingerprint
                  }
                ]
              }
            }
          }),
        releaseSnapshot: async () => portSuccess({ status: "released" })
      }
    }
  });
  const start = () =>
    binding.execute({
      operation: "deployment.start",
      target,
      input: {
        approvalRef: "trusted-approval",
        repairPolicy: { mode: "manual", maxAttempts: 0 }
      }
    });
  return {
    binding,
    state,
    target,
    start,
    identity,
    close: async () => {
      await binding.close();
      await fixture.binding.close();
    }
  };
}
