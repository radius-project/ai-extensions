import { describe, expect, it } from "vitest";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  classifyDeploymentWorkflow,
  extractAppName,
  resolveDeployStatus,
  selectDeploymentRecord,
  type DeploymentRecord
} from "./deployment-lookup-policy.js";

describe("resolveDeployStatus", () => {
  it.each([
    [{ runConclusion: "success" }, "success"],
    [{ runConclusion: "failure" }, "failed"],
    [{ runConclusion: "future-conclusion", state: "success" }, "failed"],
    [{ runStatus: "in_progress", state: "success" }, "pending"],
    [{ runStatus: "completed", state: "success" }, "success"],
    [{ state: "success" }, "success"],
    [{ state: "failure" }, "failed"],
    [{ state: "error" }, "failed"],
    [{}, "pending"]
  ])("maps %# to %s", (record, expected) => {
    expect(resolveDeployStatus(record)).toBe(expected);
  });
});

describe("deployment workflow identity", () => {
  it.each([
    [false, "deploy.yml", "unknown"],
    [true, "", "unknown"],
    [true, "deploy.yml", "deploy"],
    [true, ".github/workflows/deploy.yml", "deploy"],
    [true, ".github/workflows/delete.yml", "delete"],
    [true, "prefix-deploy.yml", "unrelated"],
    [true, "deploy.yml.old", "unrelated"],
    [true, "deployYyml", "unrelated"]
  ] as const)("classifies %s %s as %s", (hasRun, path, expected) => {
    expect(
      classifyDeploymentWorkflow(hasRun, path, "deploy.yml", "delete.yml")
    ).toBe(expected);
  });
});

describe("deployment record selection", () => {
  const context = {
    appName: "modeled-app",
    environment: "production",
    provider: "azure"
  };
  const record: DeploymentRecord = {
    id: "42",
    state: "success",
    description: "",
    runUrl: "https://github.com/acme/app/actions/runs/42",
    workflow: "deploy",
    runStatus: "completed",
    runConclusion: "success"
  };

  it("returns the actual application name and run evidence", () => {
    expect(selectDeploymentRecord(record, context)).toEqual({
      app: "modeled-app",
      environment: "production",
      provider: "azure",
      status: "success",
      deploymentId: "42",
      runUrl: record.runUrl
    });
  });

  it("ends selection at the exact abandoned marker, even without workflow identity", () => {
    expect(
      selectDeploymentRecord(
        {
          ...record,
          state: "inactive",
          description: ABANDONED_DEPLOYMENT_DESCRIPTION,
          workflow: "unknown"
        },
        context
      )
    ).toBeNull();
    expect(() =>
      selectDeploymentRecord(
        {
          ...record,
          state: "inactive",
          description: "Different marker",
          workflow: "unknown"
        },
        context
      )
    ).toThrow(
      "Could not identify GitHub deployment 42 for environment production."
    );
  });

  it("skips unrelated workflows but never skips unknown identity", () => {
    expect(
      selectDeploymentRecord({ ...record, workflow: "unrelated" }, context)
    ).toBe("skip");
    expect(() =>
      selectDeploymentRecord({ ...record, workflow: "unknown" }, context)
    ).toThrow("Could not identify");
  });

  it.each([
    ["success", null],
    ["", "deleting"],
    ["failure", "delete-failed"]
  ] as const)(
    "selects the newest delete outcome %s",
    (runConclusion, expected) => {
      const actual = selectDeploymentRecord(
        { ...record, workflow: "delete", runConclusion },
        context
      );
      if (expected === null) expect(actual).toBeNull();
      else expect(actual).toMatchObject({ status: expected });
    }
  );
});

describe("extractAppName", () => {
  it.each([undefined, null, "", 7, {}])("returns no name for %j", (source) => {
    expect(extractAppName(source)).toBe("");
  });

  it("prefers the application resource over earlier backing resources", () => {
    expect(
      extractAppName(`resource storage 'Storage/accounts@v1' = { name: 'storage' }
resource app 'Radius.Core/applications@v1' = { name: 'modeled-app' }`)
    ).toBe("modeled-app");
  });

  it("retains both quote styles and the first-name compatibility fallback", () => {
    expect(
      extractAppName(
        'resource app "Radius.Core/applications@v1" = { name: "app" }'
      )
    ).toBe("app");
    expect(
      extractAppName("resource item 'Fixture/type@v1' = { name: 'one' }")
    ).toBe("one");
    expect(extractAppName("param location string")).toBe("");
  });
});
