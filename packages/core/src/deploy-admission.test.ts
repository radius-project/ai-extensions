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

  it.each(["", " ", "\t"])(
    "refuses explicit empty model %j before fallback for fresh and repair starts",
    (appFile) => {
      const normalizeAppFile = vi.fn((path: string) => path);
      for (const attemptId of [undefined, "repair"]) {
        expect(
          resolveDeploymentTarget(
            { appFile, attemptId },
            {
              ...options(),
              previous,
              previousAppFile: "custom.bicep",
              normalizeAppFile
            }
          )
        ).toMatchObject({
          status: 400,
          error: expect.stringContaining("must not be empty")
        });
      }
      expect(normalizeAppFile).not.toHaveBeenCalled();
    }
  );

  it("does not promote an automatically selected model to explicit repeat intent", () => {
    expect(
      resolveDeploymentTarget(
        {},
        {
          ...options(),
          previous: { ...previous, appFile: "app.bicep" }
        }
      )
    ).toEqual({ target: previous });
  });

  it("inherits explicit prior model intent only within the repository and resolved branch", () => {
    const prior = { ...previous, appFile: "custom.bicep" };
    expect(
      resolveDeploymentTarget(
        {},
        {
          ...options(),
          previous: prior,
          previousAppFile: "custom.bicep"
        }
      )
    ).toEqual({ target: prior });
    for (const input of [
      { branch: "other" },
      { repo: "fixture/other", environment: "dev", branch: "topic" },
      { environment: "other" }
    ]) {
      expect(
        resolveDeploymentTarget(input, {
          ...options(),
          previous: prior,
          previousAppFile: "custom.bicep"
        })
      ).toMatchObject({ target: { appFile: ".radius/app.bicep" } });
    }
  });

  it("keeps explicit selection authoritative and repairs pinned to the selected model", () => {
    const prior = { ...previous, appFile: "custom.bicep" };
    expect(
      resolveDeploymentTarget(
        { appFile: "chosen.bicep" },
        {
          ...options(),
          previous: prior,
          previousAppFile: "custom.bicep"
        }
      )
    ).toMatchObject({ target: { appFile: "chosen.bicep" } });
    expect(
      resolveDeploymentTarget(
        { attemptId: "repair" },
        {
          ...options(),
          previous: prior
        }
      )
    ).toEqual({ target: prior });
    expect(
      resolveDeploymentTarget(
        { attemptId: "repair", branch: "other" },
        {
          ...options(),
          previous: prior
        }
      )
    ).toMatchObject({ status: 409 });
  });

  it("inherits across repository and environment case without rewriting requested values", () => {
    const prior = {
      ...previous,
      environment: "prod",
      provider: "aws",
      appFile: "custom.bicep"
    };
    const base = {
      ...options(),
      awsEnabled: true,
      previous: prior,
      previousAppFile: "custom.bicep",
      workspace: { repo: "FIXTURE/APP", branch: "workspace" }
    };
    expect(
      resolveDeploymentTarget(
        { repo: "FIXTURE/App", environment: "Prod" },
        base
      )
    ).toEqual({
      target: { ...prior, repo: "FIXTURE/App", environment: "Prod" }
    });
    expect(
      resolveDeploymentTarget(
        {
          repo: "FIXTURE/App",
          environment: "Prod",
          branch: "Topic",
          provider: "azure",
          appFile: "chosen.bicep"
        },
        base
      )
    ).toEqual({
      target: {
        repo: "FIXTURE/App",
        environment: "Prod",
        branch: "Topic",
        provider: "azure",
        appFile: "chosen.bicep"
      }
    });
    expect(
      resolveDeploymentTarget({ environment: "Prod", branch: "Topic" }, base)
    ).toMatchObject({
      target: { branch: "Topic", appFile: ".radius/app.bicep" }
    });
    expect(
      resolveDeploymentTarget({ environment: "Other" }, base)
    ).toMatchObject({
      target: {
        environment: "Other",
        branch: "workspace",
        provider: "azure",
        appFile: ".radius/app.bicep"
      }
    });
    expect(resolveDeploymentTarget({ attemptId: "repair" }, base)).toEqual({
      target: prior
    });
    expect(
      resolveDeploymentTarget(
        { attemptId: "repair", environment: "Prod" },
        base
      )
    ).toMatchObject({ status: 409 });
  });

  it("resolves branch as explicit, eligible prior, matching workspace, then unresolved repository default", () => {
    const workspace = { repo: previous.repo, branch: "workspace" };
    const base = { ...options(), previous, workspace };
    expect(resolveDeploymentTarget({ branch: "explicit" }, base)).toMatchObject(
      { target: { branch: "explicit" } }
    );
    expect(resolveDeploymentTarget({}, base)).toMatchObject({
      target: { branch: "topic" }
    });
    expect(
      resolveDeploymentTarget({ environment: "other" }, base)
    ).toMatchObject({ target: { branch: "workspace", provider: "azure" } });
    expect(
      resolveDeploymentTarget(
        { repo: previous.repo, environment: "dev" },
        { ...options(), workspace }
      )
    ).toMatchObject({ target: { branch: "workspace" } });
    expect(
      resolveDeploymentTarget(
        { repo: previous.repo, environment: "dev" },
        {
          ...options(),
          workspace: { repo: "fixture/other", branch: "unrelated" }
        }
      )
    ).toMatchObject({ target: { branch: "" } });
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
