import { describe, expect, it, vi } from "vitest";
import {
  deploymentStatusBlocksMutation,
  resolveDeploymentTarget,
  type DeploymentTarget
} from "./deploy-admission.js";

const previous: DeploymentTarget = {
  repo: "fixture/app",
  branch: "topic",
  environment: "dev",
  provider: "azure",
  appFile: ".radius/app.bicep"
};

describe("deploymentStatusBlocksMutation", () => {
  it.each(["pending", "in_progress", "deleting"])(
    "blocks the non-terminal status %s",
    (status) => {
      expect(deploymentStatusBlocksMutation(status)).toBe(true);
    }
  );
  it.each(["success", "failed", "unknown", "", undefined])(
    "allows the terminal status %s",
    (status) => {
      expect(deploymentStatusBlocksMutation(status)).toBe(false);
    }
  );
});

function options() {
  return { awsEnabled: false, normalizeAppFile: (path: string) => path };
}

describe("deployment target admission", () => {
  it("uses a trusted workspace branch and keeps the Azure default", () => {
    expect(
      resolveDeploymentTarget(
        { environment: "dev" },
        {
          ...options(),
          workspace: { repo: "fixture/app", branch: "topic" }
        }
      )
    ).toEqual({ target: previous });
  });

  it("repeats one known target without a panel", () => {
    expect(resolveDeploymentTarget({}, { ...options(), previous })).toEqual({
      target: previous
    });
  });

  it("does not carry branch, environment, or provider across repositories", () => {
    expect(
      resolveDeploymentTarget(
        { repo: "fixture/other", environment: "new" },
        {
          ...options(),
          previous: { ...previous, provider: "aws" }
        }
      )
    ).toEqual({
      target: {
        repo: "fixture/other",
        environment: "new",
        branch: "",
        provider: "azure",
        appFile: ".radius/app.bicep"
      }
    });
  });

  it.each([
    { repo: "not-a-slug", environment: "dev" },
    { repo: "fixture/app" },
    { repo: "fixture/app", environment: " " },
    {}
  ])("refuses an incomplete or invalid target %j", (input) => {
    expect(resolveDeploymentTarget(input, options())).toMatchObject({
      status: 400
    });
  });

  it.each(["aws", "unknown"])("refuses a disabled provider %s", (provider) => {
    expect(
      resolveDeploymentTarget({ ...previous, provider }, options())
    ).toMatchObject({
      status: 400,
      error: expect.stringContaining("not enabled")
    });
  });

  it("preserves enabled AWS and explicit model selection", () => {
    const input = {
      ...previous,
      provider: "aws",
      appFile: ".radius/custom.bicep"
    };
    expect(
      resolveDeploymentTarget(input, { ...options(), awsEnabled: true })
    ).toEqual({ target: input });
  });

  it.each([
    ["repo", "fixture/other"],
    ["branch", "other"],
    ["environment", "other"],
    ["provider", "aws"],
    ["appFile", "other.bicep"]
  ])("refuses retargeting repair field %s", (field, value) => {
    expect(
      resolveDeploymentTarget(
        {
          ...previous,
          attemptId: "repair",
          [field]: value
        },
        { ...options(), previous, awsEnabled: true }
      )
    ).toMatchObject({ status: 409 });
  });

  it("replays the unchanged repair target", () => {
    expect(
      resolveDeploymentTarget(
        { attemptId: "repair" },
        {
          ...options(),
          previous
        }
      )
    ).toEqual({ target: previous });
  });

  it("normalizes the path through the authorized host boundary and propagates refusal", () => {
    const normalizeAppFile = vi.fn(() => {
      throw new Error("path escaped workspace");
    });
    expect(() =>
      resolveDeploymentTarget(previous, {
        ...options(),
        normalizeAppFile
      })
    ).toThrow("path escaped workspace");
    expect(normalizeAppFile).toHaveBeenCalledWith(".radius/app.bicep");
  });
});
