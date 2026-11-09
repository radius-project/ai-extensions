import { describe, expect, it, vi } from "vitest";
import { createOperation } from "../../operations.js";
import { releaseRecordedAwsLock } from "./aws-recorded-lock.js";

const LOCK_ARN =
  "arn:aws:iam::123456789012:policy/radius-lock-radius-deploy-octo-shop";
const RECOVERY = `Check that "aws iam get-policy --policy-arn ${LOCK_ARN} --query Policy.PolicyId --output text" prints LOCK0, which is this run's lock, and only then run: aws iam delete-policy --policy-arn ${LOCK_ARN}`;

function stoppedSetup(provider = "aws") {
  const op = createOperation({
    operationId: "op_stopped",
    repo: "octo/shop",
    environment: "dev",
    provider
  });
  op.context.awsDeployIdentityLock = { policyArn: LOCK_ARN, policyId: "LOCK0" };
  return op;
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const labels = (op: { steps: Array<{ label: string; state: string }> }) =>
  op.steps.map((step) => [step.state, step.label]);

describe("releaseRecordedAwsLock", () => {
  it("removes exactly the recorded lock and forgets it", async () => {
    const op = stoppedSetup();
    const remove = vi.fn(async () => ({ ok: true as const, removed: true }));

    await releaseRecordedAwsLock(op, {
      awsEnabled: true,
      remove,
      errorMessage
    });

    expect(remove).toHaveBeenCalledExactlyOnceWith({
      policyArn: LOCK_ARN,
      policyId: "LOCK0"
    });
    expect(op.context.awsDeployIdentityLock).toBeNull();
    expect(labels(op)).toEqual([
      [
        "succeeded",
        "🔓 Released the lock this setup held on IAM role radius-deploy-octo-shop (policy ID LOCK0)."
      ]
    ]);
  });

  it("forgets a lock that was already gone", async () => {
    const op = stoppedSetup();

    await releaseRecordedAwsLock(op, {
      awsEnabled: true,
      remove: async () => ({ ok: true, removed: false }),
      errorMessage
    });

    expect(op.context.awsDeployIdentityLock).toBeNull();
    expect(labels(op)).toEqual([
      [
        "succeeded",
        "The lock this setup held on IAM role radius-deploy-octo-shop was already gone."
      ]
    ]);
  });

  it("leaves a newer lock another run took in place", async () => {
    const op = stoppedSetup();

    await releaseRecordedAwsLock(op, {
      awsEnabled: true,
      remove: async () => ({
        ok: false,
        code: "aws-lock-changed",
        message: "The lock changed since it was shown."
      }),
      errorMessage
    });

    expect(op.context.awsDeployIdentityLock).toBeNull();
    expect(labels(op)).toEqual([
      [
        "succeeded",
        "The lock on IAM role radius-deploy-octo-shop is no longer the one this setup took (policy ID LOCK0), so Radius left it in place."
      ]
    ]);
  });

  it.each([
    [
      "a refused removal",
      async () => ({
        ok: false as const,
        code: "aws-lock-denied",
        message: "Radius could not remove the lock: AccessDenied"
      }),
      "Radius could not remove the lock: AccessDenied."
    ],
    [
      "a removal that throws",
      async () => {
        throw new Error("spawn aws ENOENT");
      },
      "Radius could not remove the lock: spawn aws ENOENT."
    ],
    [
      "a session in another account",
      async () => ({
        ok: false as const,
        code: "aws-account-mismatch",
        message: "The AWS CLI is signed in to account 999999999999."
      }),
      "The AWS CLI is signed in to account 999999999999."
    ]
  ])(
    "keeps the lock recorded and names how to remove it after %s",
    async (_label, remove, reason) => {
      const op = stoppedSetup();

      await releaseRecordedAwsLock(op, {
        awsEnabled: true,
        remove,
        errorMessage
      });

      expect(op.context.awsDeployIdentityLock).toEqual({
        policyArn: LOCK_ARN,
        policyId: "LOCK0"
      });
      expect(labels(op)).toEqual([
        [
          "warning",
          `Radius did not release the lock this setup holds on IAM role radius-deploy-octo-shop. ${reason} Other Radius runs that change this role wait for it, and can remove it with Remove lock. ${RECOVERY}`
        ]
      ]);
    }
  );

  it.each([
    ["an Azure setup", stoppedSetup("azure")],
    [
      "a setup with no recorded lock",
      createOperation({
        operationId: "op_none",
        repo: "octo/shop",
        environment: "dev",
        provider: "aws"
      })
    ]
  ])("does nothing for %s", async (_label, op) => {
    const remove = vi.fn();

    await releaseRecordedAwsLock(op, {
      awsEnabled: true,
      remove,
      errorMessage
    });

    expect(remove).not.toHaveBeenCalled();
    expect(op.steps).toEqual([]);
  });
});

describe("releaseRecordedAwsLock with AWS turned off", () => {
  it("keeps the lock recorded and names it, running no AWS command", async () => {
    const op = stoppedSetup();
    const remove = vi.fn();

    await releaseRecordedAwsLock(op, {
      awsEnabled: false,
      remove,
      errorMessage
    });

    expect(remove).not.toHaveBeenCalled();
    expect(op.context.awsDeployIdentityLock).toEqual({
      policyArn: LOCK_ARN,
      policyId: "LOCK0"
    });
    expect(labels(op)).toEqual([
      [
        "warning",
        `AWS environments are turned off, so Radius did not release the lock this setup holds on IAM role radius-deploy-octo-shop. Other Radius runs that change this role wait for it, and can remove it with Remove lock. ${RECOVERY}`
      ]
    ]);
  });
});
