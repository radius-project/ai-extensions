import { expect, it } from "vitest";
import { buildDeploymentPolicy } from "./deployment-policy.js";
import type { WorkflowPreparation } from "./ports.js";

function preparation(): WorkflowPreparation {
  const source = {
    kind: "git" as const,
    repo: "owner/repo",
    ref: "feature",
    commit: "a".repeat(40),
    fingerprint: `sha256:${"b".repeat(64)}`,
    resolvedAt: "2026-09-16T00:00:00Z"
  };
  const target = {
    repo: source.repo,
    environment: "dev",
    application: "app",
    definition: ".radius/app.bicep",
    source: {
      kind: "git" as const,
      ref: source.ref,
      expectedCommit: source.commit
    }
  };
  return {
    source,
    scope: {
      authorizationRef: "authority",
      principalRef: "principal",
      operation: "deployment.start",
      target,
      source,
      approvalRef: "trusted-approval",
      operationId: "operation-1"
    },
    intent: { operation: "deployment.start", target },
    correlation: {
      operation: "deployment.start",
      operationId: "operation-1",
      attemptId: "attempt-1",
      target: { repo: source.repo, environment: "dev", application: "app" },
      expectedCommit: source.commit
    }
  };
}
it("builds reviewed argv and all five lifecycle inputs without caller shell text", () => {
  expect(buildDeploymentPolicy(preparation())).toMatchObject({
    status: "ok",
    value: {
      argv: [
        "deploy",
        ".radius/app.bicep",
        "--environment",
        "dev",
        "--application",
        "app"
      ],
      inputs: {
        environment: "dev",
        lifecycle_version: "1",
        lifecycle_operation: "deployment.start",
        operation_id: "operation-1",
        attempt_id: "attempt-1",
        expected_commit: "a".repeat(40)
      },
      requiredPhases: [
        "dispatch",
        "checkout",
        "restore",
        "command",
        "state-save",
        "cleanup"
      ]
    }
  });
});

it("does not accept environment mutation as deployment intent", () => {
  expect(
    buildDeploymentPolicy({
      ...preparation(),
      intent: {
        operation: "environment.configure",
        target: { repo: "owner/repo", environment: "dev" },
        change: {
          operation: "environment.configure",
          patch: { provider: "azure" }
        }
      }
    })
  ).toMatchObject({ status: "failed", error: { code: "VERSION_UNSUPPORTED" } });
});
it("rejects an invalid source selection before authorizing its command", () => {
  const value = preparation();
  if (value.intent.operation !== "deployment.start")
    throw new Error("Wrong fixture intent");
  expect(
    buildDeploymentPolicy({
      ...value,
      intent: {
        ...value.intent,
        target: { ...value.intent.target, definition: "../escape.bicep" }
      }
    })
  ).toMatchObject({ status: "failed" });
});

it.each(["commit", "ref", "repo"] as const)(
  "rejects stale resolved source %s",
  (field) => {
    const value = preparation();
    expect(
      buildDeploymentPolicy({
        ...value,
        source: {
          ...value.source,
          [field]: field === "commit" ? "c".repeat(40) : "other"
        }
      })
    ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
  }
);
it.each(["approvalRef", "operationId", "authorizationRef"] as const)(
  "requires current bound authority: %s",
  (field) => {
    const value = preparation();
    expect(
      buildDeploymentPolicy({
        ...value,
        scope: { ...value.scope, [field]: "" }
      }).status
    ).not.toBe("ok");
  }
);
it.each(["operationId", "attemptId"] as const)("rejects unsafe %s", (field) => {
  const value = preparation();
  expect(
    buildDeploymentPolicy({
      ...value,
      correlation: { ...value.correlation, [field]: "unsafe\nvalue" }
    }).status
  ).not.toBe("ok");
});
