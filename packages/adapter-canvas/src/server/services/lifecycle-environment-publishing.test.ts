import { expect, it } from "vitest";
import {
  portFailure,
  portSuccess,
  type AuthorizedScope,
  type RequestControl
} from "@radius-project/core/lifecycle";
import type { EnvironmentWorkflowPreview } from "@radius-project/adapter-shared";
import { createEnvironmentWorkflowPublisher } from "./lifecycle-environment-publishing.js";
import type {
  WorkflowPublisherPorts,
  WorkflowPublisherTarget
} from "../routes/create-environment-workflow-publisher.js";

function fixture() {
  const target = { repo: "owner/repo", environment: "dev" };
  const scope: AuthorizedScope<"environment.create"> = {
    authorizationRef: "authority",
    principalRef: "principal",
    operation: "environment.create",
    operationId: "operation",
    target
  };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const files = {
    "run-rad-commands.yml": "reviewed dispatcher",
    "run-rad-commands-azure.yml": "reviewed azure",
    "run-rad-commands-aws.yml": "reviewed aws"
  };
  const preview: EnvironmentWorkflowPreview = {
    intent: {
      operation: "environment.create",
      target,
      change: {
        operation: "environment.create",
        configuration: {
          provider: "azure",
          identityRef: "profile",
          settings: {
            subscriptionId: "subscription",
            resourceGroup: "group",
            location: "westus"
          },
          recipes: []
        }
      }
    },
    assets: {
      workflow: ".github/workflows/run-rad-commands.yml",
      executionVersion: 1,
      producerRef: "a".repeat(40),
      selectedFiles: files,
      reviewedFiles: files,
      producerFiles: {},
      reviewedProducerFiles: {}
    }
  };
  const calls: string[] = [];
  const state = { changed: false, failure: false, cancelled: false };
  const ports: WorkflowPublisherPorts = {
    generateVerifyWorkflow: async () => "reviewed verification",
    generateDeployWorkflow: async () => (state.changed ? {} : files),
    generateDeleteWorkflow: async () => ({}),
    commitWorkflowFileSmart: async (path) => {
      calls.push(path);
      return {
        ok: !state.failure,
        changed: true,
        viaPr: false,
        commitSha: "b".repeat(40)
      };
    },
    recordCommittedWorkflowFile: () => {},
    deleteLegacyDeployWorkflow: async () => true,
    pullRequestBranch: () => null,
    errorMessage: () => "Controlled publisher failure.",
    pushStep: () => {},
    gate: async () => !state.cancelled
  };
  const publisherTarget: WorkflowPublisherTarget = {
    operation: {
      operationId: "operation",
      repo: target.repo,
      environment: target.environment,
      provider: "azure"
    },
    targetRepo: target.repo,
    envName: target.environment,
    provider: "azure",
    defaultBranch: "main"
  };
  const deps = {
    resolve: async () => portSuccess({ ports, target: publisherTarget }),
    readPublished: async () =>
      portSuccess({
        ...preview,
        commit: "b".repeat(40),
        observation: {
          quality: "current" as const,
          completeness: "complete" as const,
          evidence: "configuration" as const
        }
      })
  };
  return { scope, control, preview, publisherTarget, calls, state, deps };
}
it.each(["before", "publisher-gate"])(
  "fences cancellation at %s",
  async (phase) => {
    const f = fixture();
    f.state.cancelled = phase === "publisher-gate";
    const control = {
      ...f.control,
      cancellation: { aborted: phase === "before", onAbort: () => () => {} }
    };
    expect(
      await createEnvironmentWorkflowPublisher(f.deps)(
        f.scope,
        f.preview,
        control
      )
    ).toMatchObject({ status: "cancelled" });
    expect(f.calls).toEqual([]);
  }
);
it.each(["resolve", "readPublished"])(
  "rejects a missing %s publisher dependency before writing workflows",
  (dependency) => {
    const f = fixture();
    Reflect.deleteProperty(f.deps, dependency);
    expect(() => createEnvironmentWorkflowPublisher(f.deps)).toThrow(
      "Environment publishing requires"
    );
    expect(f.calls).toEqual([]);
  }
);

it("retains cancellation after a publication write without reading stronger success", async () => {
  const f = fixture();
  const resolved = await f.deps.resolve();
  const commit = resolved.value.ports.commitWorkflowFileSmart;
  resolved.value.ports.commitWorkflowFileSmart = async (...args) => {
    const result = await commit(...args);
    f.state.cancelled = true;
    return result;
  };
  expect(
    await createEnvironmentWorkflowPublisher(f.deps)(
      f.scope,
      f.preview,
      f.control
    )
  ).toMatchObject({ status: "cancelled" });
  expect(f.calls).toHaveLength(1);
});

it("publishes the explicit configure intent through the same reviewed publisher", async () => {
  const f = fixture();
  const preview: EnvironmentWorkflowPreview = {
    ...f.preview,
    intent: {
      operation: "environment.configure",
      target: f.scope.target,
      change: {
        operation: "environment.configure",
        patch: { provider: "azure", settings: { location: "eastus" } }
      }
    }
  };
  expect(
    await createEnvironmentWorkflowPublisher(f.deps)(
      { ...f.scope, operation: "environment.configure" },
      preview,
      f.control
    )
  ).toMatchObject({ status: "ok" });
});

it("uses the existing workflow publisher without dispatching verification or deployment", async () => {
  const f = fixture();
  const result = await createEnvironmentWorkflowPublisher(f.deps)(
    f.scope,
    f.preview,
    f.control
  );
  expect(result).toMatchObject({
    status: "ok",
    value: { commit: "b".repeat(40) }
  });
  expect(f.calls).toEqual([
    ".github/workflows/radius-verify-credentials.yml",
    ".github/workflows/run-rad-commands.yml",
    ".github/workflows/run-rad-commands-azure.yml",
    ".github/workflows/run-rad-commands-aws.yml"
  ]);
});
it.each([
  "repo",
  "environment",
  "operation",
  "provider",
  "automatic-verification"
])(
  "refuses a mismatched %s publisher binding before committing",
  async (field) => {
    const f = fixture();
    if (field === "repo") f.publisherTarget.targetRepo = "owner/other";
    if (field === "environment") f.publisherTarget.envName = "other";
    if (field === "operation")
      f.publisherTarget.operation.operationId = "other";
    if (field === "provider") f.publisherTarget.provider = "aws";
    if (field === "automatic-verification")
      f.publisherTarget.setupPushOperationMarker = "unexpected-automatic-run";
    expect(
      await createEnvironmentWorkflowPublisher(f.deps)(
        f.scope,
        f.preview,
        f.control
      )
    ).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.calls).toEqual([]);
  }
);
it("rejects regenerated deploy assets that differ from the reviewed publication", async () => {
  const f = fixture();
  f.state.changed = true;
  expect(
    await createEnvironmentWorkflowPublisher(f.deps)(
      f.scope,
      f.preview,
      f.control
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  expect(f.calls).toEqual([]);
});
it("preserves publication refusal rather than reporting setup success", async () => {
  const f = fixture();
  f.state.failure = true;
  expect(
    await createEnvironmentWorkflowPublisher(f.deps)(
      f.scope,
      f.preview,
      f.control
    )
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
  expect(f.calls).toHaveLength(1);
});
it("propagates unavailable publisher resolution without committing", async () => {
  const f = fixture();
  expect(
    await createEnvironmentWorkflowPublisher({
      ...f.deps,
      resolve: async () => portFailure("PRECONDITION_FAILED")
    })(f.scope, f.preview, f.control)
  ).toMatchObject({ status: "failed" });
  expect(f.calls).toEqual([]);
});
