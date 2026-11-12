import { describe, expect, it } from "vitest";
import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  classifyDeploymentWorkflow,
  extractAppName,
  resolveDeployStatus,
  selectDeploymentRecord,
  deploymentIdentityRefusal,
  deploymentRunId,
  readDeleteApplicationName,
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
    identity: { state: "known" as const, application: "modeled-app" },
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
      identity: context.identity,
      environment: "production",
      provider: "azure",
      status: "success",
      deploymentId: "42",
      runUrl: record.runUrl
    });
  });

  it("keeps unidentified rows visible without inventing an application", () => {
    const identity = { state: "unavailable" as const, reason: "expired" };
    expect(
      selectDeploymentRecord(record, { ...context, identity })
    ).toMatchObject({
      app: "",
      identity,
      deploymentId: "42",
      status: "success"
    });
  });

  describe("deployment identity authorization", () => {
    const row = {
      app: "custom",
      environment: "dev",
      provider: "azure",
      status: "success",
      deploymentId: "42",
      runUrl: "https://github.com/org/app/actions/runs/123",
      identity: { state: "known" as const, application: "custom" }
    };
    it("requires matching application evidence and optional record freshness", () => {
      expect(
        deploymentIdentityRefusal(row, " CUSTOM ", {
          deploymentId: "42",
          runUrl: row.runUrl
        })
      ).toBeNull();
      expect(deploymentIdentityRefusal(row, "default")).toMatchObject({
        status: 409
      });
      expect(
        deploymentIdentityRefusal(row, "custom", { deploymentId: "43" })
      ).toMatchObject({ status: 409 });
      expect(
        deploymentIdentityRefusal(row, "custom", { runUrl: "other" })
      ).toMatchObject({ status: 409 });
      expect(
        deploymentIdentityRefusal({ ...row, app: "wrong" }, "custom")
      ).toMatchObject({ status: 409 });
      expect(
        deploymentIdentityRefusal(
          { ...row, identity: { state: "known", application: " " } },
          ""
        )
      ).toMatchObject({ status: 409 });
    });
    it("distinguishes absent legacy records, unavailable evidence and failed reads", () => {
      expect(deploymentIdentityRefusal(null, "custom")).toBeNull();
      expect(
        deploymentIdentityRefusal(null, "custom", { deploymentId: "42" })
      ).toMatchObject({ status: 409 });
      expect(
        deploymentIdentityRefusal({ ...row, identity: undefined }, "custom")
      ).toMatchObject({ status: 409 });
      expect(
        deploymentIdentityRefusal(
          { ...row, identity: { state: "unavailable", reason: "expired" } },
          "custom"
        )
      ).toEqual({ status: 409, error: "expired" });
      expect(
        deploymentIdentityRefusal(
          {
            ...row,
            identity: {
              state: "unavailable",
              reason: "denied",
              readFailed: true
            }
          },
          "custom"
        )
      ).toEqual({ status: 503, error: "denied" });
    });
    it.each([
      undefined,
      "",
      "{",
      "null",
      "[]",
      '{"name":"app"}',
      '{"resourceType":"container","name":"app"}',
      '{"resourceType":"application","name":" "}',
      '{"resourceType":"application","name":7}'
    ])("refuses invalid delete identity %s", (source) => {
      expect(readDeleteApplicationName(source)).toBeNull();
    });
    it("reads application identity without relying on CLI output", () => {
      expect(
        readDeleteApplicationName(
          '{"resourceType":"application","name":" custom ","output":"default"}'
        )
      ).toBe("custom");
    });
    it.each([
      "",
      "garbage",
      "http://github.com/org/app/actions/runs/42",
      "https://other.example/org/app/actions/runs/42",
      "https://github.com/other/app/actions/runs/42",
      "https://github.com/org/app/actions/runs/0",
      "https://github.com/org/app/actions/runs/9007199254740992",
      "https://github.com/org/app/actions/runs/42oops"
    ])("rejects unlinked run URL %s", (url) => {
      expect(deploymentRunId("org/app", url)).toBeNull();
    });
    it.each(["42", "42/", "42/job/123"])("reads a linked run %s", (suffix) => {
      expect(
        deploymentRunId(
          "ORG/App",
          `https://github.com/org/app/actions/runs/${suffix}`
        )
      ).toBe(42);
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
  it("scans repeated application markers and nameless headers without rescanning suffixes", () => {
    const markers = "applications@".repeat(20_000);
    const headers = 'applications@"={{'.repeat(20_000);
    expect(extractAppName(markers)).toBe("");
    expect(extractAppName(headers)).toBe("");
    expect(extractAppName(`name: 'fallback' ${headers}`)).toBe("fallback");
    expect(extractAppName(`${markers}" = { name: 'selected' }`)).toBe(
      "selected"
    );
    expect(extractAppName(`${headers} name: 'selected'`)).toBe("selected");
  });

  it("bounds header whitespace scans at the next non-whitespace character", () => {
    const spaces = " ".repeat(100_000);
    expect(
      extractAppName(`applications@v1'${spaces}=${spaces}{ name: 'app' }`)
    ).toBe("app");
    expect(extractAppName(`applications@v1'${spaces}`)).toBe("");
    expect(extractAppName(`applications@v1'=${spaces}`)).toBe("");
    expect(extractAppName(`name: 'fallback' applications@v1'=${spaces}x`)).toBe(
      "fallback"
    );
  });

  it.each([
    ["name: 'backing' applications@v1' = { name: 'app'", "app"],
    ['applications@bad"x applications@good\' = { name: "app"', "app"],
    ["applications@bad\" applications@good\" = { name: 'app'", "app"],
    ['applications@v1"\t=\u00a0{ name: \'mixed"', "mixed"],
    ["name: 'fallback' applications@v1' = { name: '' }", "fallback"],
    ["applications@v1' = {} xname: 'wrong' name: 'outside'", "outside"],
    ["name: 'first' Applications@v1' = { name: 'second'", "first"]
  ])("retains legacy extraction for %s", (source, expected) => {
    expect(extractAppName(source)).toBe(expected);
  });

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
