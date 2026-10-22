import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_CONTROL_ACTIONS,
  ENVIRONMENT_CONTROL_ARGUMENT_SCHEMA as ENVIRONMENT_CONTROL_SCHEMA,
  ENVIRONMENT_SETUP_ARGUMENT_SCHEMA as ENVIRONMENT_SETUP_SCHEMA,
  ENVIRONMENT_STATUS_SCHEMA,
  readEnvironmentArguments
} from "./environment-tool-schema.js";

const target = {
  operationId: "setup-1",
  repo: "fixture/app",
  environment: "dev"
};
const azure = {
  repo: target.repo,
  environment: target.environment,
  provider: "azure",
  tenantId: "11111111-1111-4111-8111-111111111111",
  subscriptionId: "22222222-2222-4222-8222-222222222222",
  resourceGroup: "fixture-rg",
  cluster: "fixture-cluster"
};
const aws = {
  repo: target.repo,
  environment: target.environment,
  provider: "aws",
  roleArn: "arn:aws:iam::123456789012:role/fixture",
  accountId: "123456789012",
  region: "us-west-2",
  cluster: "fixture"
};
const resume = {
  ...target,
  action: "resume",
  provider: "azure",
  checkpoint: "application",
  interactionId: "interaction-1"
};

describe("strict environment handler argument contracts", () => {
  it.each([azure, aws])("accepts and copies $provider setup", (input) => {
    const parsed = readEnvironmentArguments(input, ENVIRONMENT_SETUP_SCHEMA);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
  });
  it.each([
    {
      ...azure,
      branch: "feature/setup",
      namespace: "team",
      profileName: "fixture",
      clientId: azure.tenantId,
      appId: azure.tenantId,
      appName: "app",
      clusterResourceGroup: "aks-rg",
      createNew: false,
      serviceManagementReference: "ref"
    },
    { ...aws, vpcId: "vpc-123", subnetIds: "subnet-1,subnet-2" }
  ])("accepts supported optional fields", (input) => {
    expect(readEnvironmentArguments(input, ENVIRONMENT_SETUP_SCHEMA)).toEqual(
      input
    );
  });
  it.each([null, [], true, "", 0, undefined, {}])(
    "refuses a non-input %j",
    (input) => {
      expect(() =>
        readEnvironmentArguments(input, ENVIRONMENT_SETUP_SCHEMA)
      ).toThrow("closed schema");
    }
  );
  it.each([
    "repo",
    "environment",
    "provider",
    "tenantId",
    "subscriptionId",
    "resourceGroup",
    "cluster"
  ])("requires Azure %s", (field) => {
    const input: Record<string, unknown> = { ...azure };
    delete input[field];
    expect(() =>
      readEnvironmentArguments(input, ENVIRONMENT_SETUP_SCHEMA)
    ).toThrow();
  });
  it.each([
    "repo",
    "environment",
    "provider",
    "roleArn",
    "accountId",
    "region",
    "cluster"
  ])("requires AWS %s", (field) => {
    const input: Record<string, unknown> = { ...aws };
    delete input[field];
    expect(() =>
      readEnvironmentArguments(input, ENVIRONMENT_SETUP_SCHEMA)
    ).toThrow();
  });
  it.each([
    { ...azure, environment: "" },
    { ...azure, branch: " " },
    { ...azure, createNew: "true" },
    { ...azure, clientId: null },
    { ...azure, roleArn: "not-azure" },
    { ...aws, tenantId: "not-aws" },
    { ...azure, confirmed: true },
    { ...azure, githubLogin: "octocat" },
    { ...azure, selectionHandle: "panel-selection" },
    { ...azure, token: "not-accepted" }
  ])("rejects malformed or privileged setup inputs", (input) => {
    expect(() =>
      readEnvironmentArguments(input, ENVIRONMENT_SETUP_SCHEMA)
    ).toThrow();
  });
  it.each(ENVIRONMENT_CONTROL_ACTIONS)(
    "accepts %s without agent consent",
    (action) => {
      expect(
        readEnvironmentArguments(
          { ...target, action },
          ENVIRONMENT_CONTROL_SCHEMA
        )
      ).toEqual({ ...target, action });
    }
  );
  it.each([
    {
      code: "service-management-reference-required",
      serviceManagementReference: "ref"
    },
    { code: "app-selection-required", createNew: true },
    { code: "app-selection-required", createNew: false, appId: azure.tenantId }
  ])("accepts exact typed resume alternative %j", (answer) => {
    expect(
      readEnvironmentArguments(
        { ...resume, answer },
        ENVIRONMENT_CONTROL_SCHEMA
      )
    ).toEqual({ ...resume, answer });
  });
  it.each([
    { code: "app-selection-required", createNew: true, appId: azure.tenantId },
    { code: "app-selection-required", createNew: false },
    { code: "app-selection-required", createNew: false, appId: "" },
    {
      code: "service-management-reference-required",
      serviceManagementReference: " ",
      consent: true
    },
    { code: "unknown" },
    null
  ])("rejects ambiguous and unknown resume answers %j", (answer) => {
    expect(() =>
      readEnvironmentArguments(
        { ...resume, answer },
        ENVIRONMENT_CONTROL_SCHEMA
      )
    ).toThrow();
  });
  it.each([
    { ...target, action: "delete-environment" },
    { ...target, action: "rollback", confirmed: true },
    { ...target, action: "resume" },
    {
      ...resume,
      provider: "aws",
      answer: { code: "app-selection-required", createNew: true }
    }
  ])("rejects unsupported controls", (input) => {
    expect(() =>
      readEnvironmentArguments(input, ENVIRONMENT_CONTROL_SCHEMA)
    ).toThrow();
  });
  it("requires an exact status target without implicit selection", () => {
    expect(readEnvironmentArguments(target, ENVIRONMENT_STATUS_SCHEMA)).toEqual(
      target
    );
    for (const field of Object.keys(target)) {
      const input: Record<string, unknown> = { ...target };
      delete input[field];
      expect(() =>
        readEnvironmentArguments(input, ENVIRONMENT_STATUS_SCHEMA)
      ).toThrow();
    }
    expect(() =>
      readEnvironmentArguments(
        { ...target, newest: true },
        ENVIRONMENT_STATUS_SCHEMA
      )
    ).toThrow();
  });
});
