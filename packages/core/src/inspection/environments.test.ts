import { expect, it } from "vitest";
import {
  applyVerificationBypass,
  inspectedEnvironmentConfig
} from "./environments.js";

it.each([
  ["failed", "42", "42", "bypassed"],
  ["failed", "43", "42", "failed"],
  ["failed", "", "", "failed"],
  ["success", "42", "42", "success"]
])(
  "maps %s for run %s with bypass marker %s to %s",
  (status, run, marker, expected) => {
    expect(applyVerificationBypass(status, run, marker)).toBe(expected);
  }
);

it("uses the existing namespace precedence even when the current variable is empty", () => {
  expect(
    inspectedEnvironmentConfig(
      {
        AZURE_AKS_CLUSTER_NAME: "azure-cluster",
        KUBERNETES_NAMESPACE: "",
        RADIUS_NAMESPACE: "legacy"
      },
      "azure"
    )
  ).toEqual({ cluster: "azure-cluster" });
  expect(
    inspectedEnvironmentConfig(
      {
        AWS_EKS_CLUSTER_NAME: "aws-cluster",
        AWS_REGION: "us-west-2",
        RADIUS_NAMESPACE: "legacy"
      },
      "aws"
    )
  ).toEqual({
    cluster: "aws-cluster",
    region: "us-west-2",
    namespace: "legacy"
  });
});
