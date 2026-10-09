import { test, expect } from "@playwright/test";
import {
  JOURNEY_GATE_VARIABLE,
  canvasPageUrl,
  classifyBaselineModel,
  classifyModelProgress,
  findDeleteRefusalProblems,
  generateEnvironmentName,
  hasDeployment,
  modelingPrompt,
  parseSessionInfo,
  readDeployStatus,
  readDeploymentRows,
  readJourneyConfig,
  readOperationId,
  readOperationSnapshot,
  readSingleApplicationName,
  repositoryListingPath,
  sessionIdFromAppUrl
} from "../fixtures/journey.ts";

const SHA = "cc6a688a0123456789abcdef0123456789abcdef";
const TENANT = "11111111-2222-3333-4444-555555555555";
const SUBSCRIPTION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function validEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    [JOURNEY_GATE_VARIABLE]: "1",
    COPILOT_APP_E2E_REPO: "octo/fixture-unmodeled",
    COPILOT_APP_E2E_BASELINE_SHA: SHA,
    COPILOT_APP_E2E_AZURE_TENANT_ID: TENANT,
    COPILOT_APP_E2E_AZURE_SUBSCRIPTION_ID: SUBSCRIPTION,
    COPILOT_APP_E2E_AZURE_RESOURCE_GROUP: "rg-ux",
    COPILOT_APP_E2E_AKS_CLUSTER: "aks-ux",
    ...overrides
  };
}

const fixedName = () => "uxe2e-abc123";

test.describe("readJourneyConfig", () => {
  for (const gate of [undefined, "", "0", "true", "yes"]) {
    test(`is off when the gate is ${JSON.stringify(gate)}`, () => {
      const result = readJourneyConfig(
        validEnv({ [JOURNEY_GATE_VARIABLE]: gate }),
        fixedName
      );
      expect(result.enabled).toBe(false);
      if (!result.enabled) {
        expect(result.reason).toContain(`${JOURNEY_GATE_VARIABLE}=1`);
      }
    });
  }

  test("does not validate other values when the gate is off", () => {
    expect(readJourneyConfig({}, fixedName).enabled).toBe(false);
  });

  test("applies defaults for optional values", () => {
    const result = readJourneyConfig(validEnv(), fixedName);
    expect(result).toEqual({
      enabled: true,
      config: {
        repository: "octo/fixture-unmodeled",
        projectName: "fixture-unmodeled",
        baselineSha: SHA,
        defaultBranch: "main",
        tenantId: TENANT,
        subscriptionId: SUBSCRIPTION,
        resourceGroup: "rg-ux",
        clusterName: "aks-ux",
        namespace: "default",
        credentialProfile: "copilot-app-ux-e2e",
        environmentName: "uxe2e-abc123"
      }
    });
  });

  test("uses explicit optional values and trims them", () => {
    const result = readJourneyConfig(
      validEnv({
        COPILOT_APP_E2E_PROJECT: " fixture ",
        COPILOT_APP_E2E_DEFAULT_BRANCH: "trunk",
        COPILOT_APP_E2E_NAMESPACE: "apps",
        COPILOT_APP_E2E_CREDENTIAL_PROFILE: "my-profile",
        COPILOT_APP_E2E_ENV_NAME: "my-env"
      }),
      fixedName
    );
    expect(result.enabled && result.config).toMatchObject({
      projectName: "fixture",
      defaultBranch: "trunk",
      namespace: "apps",
      credentialProfile: "my-profile",
      environmentName: "my-env"
    });
  });

  test("lists every missing required value in one error", () => {
    expect(() =>
      readJourneyConfig({ [JOURNEY_GATE_VARIABLE]: "1" }, fixedName)
    ).toThrow(
      /COPILOT_APP_E2E_REPO is required[\s\S]*BASELINE_SHA is required[\s\S]*TENANT_ID is required[\s\S]*SUBSCRIPTION_ID is required[\s\S]*RESOURCE_GROUP is required[\s\S]*AKS_CLUSTER is required/
    );
  });

  const invalid: Array<[string, string]> = [
    ["COPILOT_APP_E2E_REPO", "no-slash"],
    ["COPILOT_APP_E2E_REPO", "octo/repo; rm -rf"],
    ["COPILOT_APP_E2E_BASELINE_SHA", "cc6a688a"],
    ["COPILOT_APP_E2E_BASELINE_SHA", SHA.toUpperCase()],
    ["COPILOT_APP_E2E_AZURE_TENANT_ID", "not-a-guid"],
    ["COPILOT_APP_E2E_AZURE_SUBSCRIPTION_ID", "1234"],
    ["COPILOT_APP_E2E_NAMESPACE", "Bad_Namespace"],
    ["COPILOT_APP_E2E_ENV_NAME", "UPPER"],
    ["COPILOT_APP_E2E_ENV_NAME", "ab"],
    ["COPILOT_APP_E2E_ENV_NAME", "ends-with-dash-"],
    ["COPILOT_APP_E2E_DEFAULT_BRANCH", "has space"]
  ];
  for (const [name, value] of invalid) {
    test(`rejects ${name}=${JSON.stringify(value)}`, () => {
      expect(() =>
        readJourneyConfig(validEnv({ [name]: value }), fixedName)
      ).toThrow(new RegExp(`${name} is not a valid`));
    });
  }
});

test.describe("generateEnvironmentName", () => {
  test("builds a valid, short name", () => {
    const name = generateEnvironmentName(1_750_000_000_000, 0.5);
    expect(name).toMatch(/^uxe2e-[a-z0-9]{8}$/);
    expect(
      readJourneyConfig(validEnv({ COPILOT_APP_E2E_ENV_NAME: name }), fixedName)
        .enabled
    ).toBe(true);
  });

  test("pads the random part at the low boundary", () => {
    expect(generateEnvironmentName(0, 0)).toBe("uxe2e-000");
  });

  test("changes when the random part changes", () => {
    expect(generateEnvironmentName(1_000, 0.1)).not.toBe(
      generateEnvironmentName(1_000, 0.9)
    );
  });
});

test("modelingPrompt names the skill and forbids commit, push, and deploy", () => {
  const prompt = modelingPrompt();
  expect(prompt).toContain("radius-app-bicep");
  expect(prompt).toContain("Do not commit or push");
  expect(prompt).toContain("Do not deploy");
});

test.describe("parseSessionInfo", () => {
  const labels = [
    "Copy branch, octo-feature",
    "Copy base branch, main",
    "Copy path, C:\\repos\\wt\\octo-feature",
    "Show in Explorer",
    "Copy session name, Model, the app",
    "Copy session ID, 46bd5c43-30f7-474f-bd69-b24151d678c2",
    "Archive session"
  ];

  test("reads branch, base branch, path, and session ID", () => {
    expect(parseSessionInfo(labels)).toEqual({
      branch: "octo-feature",
      baseBranch: "main",
      path: "C:\\repos\\wt\\octo-feature",
      sessionId: "46bd5c43-30f7-474f-bd69-b24151d678c2"
    });
  });

  test("names every missing field", () => {
    expect(() => parseSessionInfo(["Copy branch, x"])).toThrow(
      /did not show: base branch, path, session ID/
    );
  });

  test("reports an empty dialog", () => {
    expect(() => parseSessionInfo([])).toThrow(/Labels seen: <none>/);
  });
});

test.describe("sessionIdFromAppUrl", () => {
  const cases: Array<[string, string | undefined]> = [
    ["http://tauri.localhost/workspaces/abc-123", "abc-123"],
    ["http://tauri.localhost/workspaces/abc-123/", "abc-123"],
    ["http://tauri.localhost/workspaces/a%20b", "a b"],
    ["http://tauri.localhost/", undefined],
    ["http://tauri.localhost/workspaces/abc/files", undefined],
    ["not a url", undefined]
  ];
  for (const [url, expected] of cases) {
    test(`${url} -> ${String(expected)}`, () => {
      expect(sessionIdFromAppUrl(url)).toBe(expected);
    });
  }
});

test.describe("classifyModelProgress", () => {
  const all = new Set([
    ".radius/app.bicep",
    ".radius/bicepconfig.json",
    ".radius/app.origin.json"
  ]);

  test("is ready when all files exist and are staged", () => {
    expect(
      classifyModelProgress(
        all,
        ".radius/app.bicep\r\n.radius/bicepconfig.json\n.radius/app.origin.json\n.radius/.gitignore\n"
      )
    ).toEqual({ ready: true, missingFiles: [], unstagedFiles: [] });
  });

  test("normalizes Windows separators in git output", () => {
    expect(
      classifyModelProgress(
        all,
        ".radius\\app.bicep\n.radius\\bicepconfig.json\n.radius\\app.origin.json"
      ).ready
    ).toBe(true);
  });

  test("is not ready while files exist but are not staged", () => {
    expect(classifyModelProgress(all, "")).toEqual({
      ready: false,
      missingFiles: [],
      unstagedFiles: [...all]
    });
  });

  test("is not ready before any file exists", () => {
    const progress = classifyModelProgress(new Set(), "");
    expect(progress.ready).toBe(false);
    expect(progress.missingFiles).toHaveLength(3);
  });
});

test.describe("canvasPageUrl", () => {
  test("sets the page and keeps other query values", () => {
    expect(
      canvasPageUrl("http://127.0.0.1:4100/?page=graph&t=abc#top", "deploying")
    ).toBe("http://127.0.0.1:4100/?page=deploying&t=abc");
  });

  test("adds the page when the URL has none", () => {
    expect(canvasPageUrl("http://127.0.0.1:4100/", "environment")).toBe(
      "http://127.0.0.1:4100/?page=environment"
    );
  });
});

test("repositoryListingPath encodes the repository and adds fresh", () => {
  expect(repositoryListingPath("/api/list-applications", "o/r")).toBe(
    "/api/list-applications?repo=o%2Fr"
  );
  expect(repositoryListingPath("/api/list-deployments", "o/r", true)).toBe(
    "/api/list-deployments?repo=o%2Fr&fresh=1"
  );
});

test.describe("readOperationId", () => {
  test("trims the ID", () => {
    expect(readOperationId({ operationId: " op_1 " })).toBe("op_1");
  });
  for (const payload of [null, {}, { operationId: "" }, { operationId: 7 }]) {
    test(`rejects ${JSON.stringify(payload)}`, () => {
      expect(() => readOperationId(payload)).toThrow(/operationId/);
    });
  }
});

test.describe("readOperationSnapshot", () => {
  test("reads a running operation", () => {
    expect(readOperationSnapshot({ operation: { state: "running" } })).toEqual({
      state: "running",
      terminal: false,
      error: ""
    });
  });

  test("treats every terminal state as terminal", () => {
    for (const state of [
      "succeeded",
      "failed",
      "cancelled",
      "action_required"
    ]) {
      expect(readOperationSnapshot({ operation: { state } }).terminal).toBe(
        true
      );
    }
  });

  test("prefers failure.message over error", () => {
    expect(
      readOperationSnapshot({
        operation: {
          state: "failed",
          error: "short",
          failure: { message: " detailed " }
        }
      }).error
    ).toBe("detailed");
  });

  test("falls back to error when failure.message is blank", () => {
    expect(
      readOperationSnapshot({
        operation: { state: "failed", error: " e ", failure: { message: " " } }
      }).error
    ).toBe("e");
  });

  test("uses a known terminalState even when state is not terminal", () => {
    expect(
      readOperationSnapshot({
        operation: { state: "cleanup", terminalState: "failed" }
      }).terminal
    ).toBe(true);
  });

  test("rejects an unknown terminalState", () => {
    expect(() =>
      readOperationSnapshot({
        operation: { state: "x", terminalState: "exploded" }
      })
    ).toThrow(/unknown terminal state/);
  });

  for (const payload of [
    null,
    {},
    { operation: [] },
    { operation: { state: " " } }
  ]) {
    test(`rejects ${JSON.stringify(payload)}`, () => {
      expect(() => readOperationSnapshot(payload)).toThrow(/operation/);
    });
  }
});

test.describe("readDeployStatus", () => {
  test("complete is terminal and successful", () => {
    expect(
      readDeployStatus({ status: "complete", deployRunUrl: " https://x " })
    ).toEqual({
      status: "complete",
      terminal: true,
      succeeded: true,
      error: "",
      runUrl: "https://x"
    });
  });

  test("failed is terminal and not successful", () => {
    expect(readDeployStatus({ status: "failed", error: "boom" })).toMatchObject(
      {
        terminal: true,
        succeeded: false,
        error: "boom"
      }
    );
  });

  test("success is not the terminal word", () => {
    expect(readDeployStatus({ status: "success" }).terminal).toBe(false);
  });

  for (const payload of [null, [], {}, { status: "" }, { status: 1 }]) {
    test(`rejects ${JSON.stringify(payload)}`, () => {
      expect(() => readDeployStatus(payload)).toThrow(/deploy status/);
    });
  }
});

test.describe("readSingleApplicationName", () => {
  test("returns the only application", () => {
    expect(
      readSingleApplicationName({ applications: [{ name: " app " }] })
    ).toBe("app");
  });

  test("fails when the listing is empty", () => {
    expect(() => readSingleApplicationName({ applications: [] })).toThrow(
      /no application to deploy/
    );
  });

  test("fails when the listing has more than one application", () => {
    expect(() =>
      readSingleApplicationName({
        applications: [{ name: "a" }, { name: "b" }]
      })
    ).toThrow(/2 applications \(a, b\)/);
  });

  test("fails on an endpoint error", () => {
    expect(() =>
      readSingleApplicationName({ error: "gh failed", applications: [] })
    ).toThrow(/reported an error: gh failed/);
  });

  test("fails on a non-string endpoint error", () => {
    expect(() => readSingleApplicationName({ error: { code: 1 } })).toThrow(
      /\{"code":1\}/
    );
  });

  test("fails on a malformed entry", () => {
    expect(() => readSingleApplicationName({ applications: [{}] })).toThrow(
      /index 0/
    );
  });

  test("fails without an applications array", () => {
    expect(() => readSingleApplicationName({})).toThrow(/"applications"/);
  });
});

test.describe("readDeploymentRows and hasDeployment", () => {
  const rows = readDeploymentRows({
    deployments: [
      { app: "app", environment: "Env-A", status: "success" },
      { app: "other", environment: "env-b" }
    ]
  });

  test("reads rows and defaults a missing status", () => {
    expect(rows).toEqual([
      { app: "app", environment: "Env-A", status: "success" },
      { app: "other", environment: "env-b", status: "" }
    ]);
  });

  test("matches the environment without case", () => {
    expect(hasDeployment(rows, "app", "env-a")).toBe(true);
  });

  test("does not match another application or environment", () => {
    expect(hasDeployment(rows, "app", "env-b")).toBe(false);
    expect(hasDeployment([], "app", "env-a")).toBe(false);
  });

  test("an empty listing is valid", () => {
    expect(readDeploymentRows({ deployments: [] })).toEqual([]);
  });

  for (const payload of [
    {},
    { deployments: "x" },
    { deployments: [null] },
    { deployments: [{ app: "", environment: "e" }] },
    { deployments: [{ app: "a" }] },
    { error: "listing failed", deployments: [] }
  ]) {
    test(`rejects ${JSON.stringify(payload)}`, () => {
      expect(() => readDeploymentRows(payload)).toThrow(/deployment listing/);
    });
  }
});

test.describe("findDeleteRefusalProblems", () => {
  const good = {
    status: 409,
    payload: {
      code: "app-deployed",
      error: "Delete application demo first.",
      app: "demo"
    },
    application: "demo"
  };

  test("accepts a correct refusal", () => {
    expect(findDeleteRefusalProblems(good)).toEqual([]);
  });

  test("reports every wrong field", () => {
    const problems = findDeleteRefusalProblems({
      status: 202,
      payload: { code: "other", error: "", app: "x" },
      application: "demo"
    });
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain("HTTP 202");
    expect(problems[2]).toContain("<empty>");
  });

  test("reports a payload that is not an object", () => {
    expect(findDeleteRefusalProblems({ ...good, payload: "nope" })).toEqual([
      "The refusal had no JSON object."
    ]);
  });
});

test.describe("classifyBaselineModel", () => {
  test("exit code 0 means the model is present", () => {
    expect(classifyBaselineModel({ code: 0, stdout: "{}", stderr: "" })).toBe(
      "present"
    );
  });

  test("HTTP 404 means the model is absent", () => {
    expect(
      classifyBaselineModel({
        code: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)"
      })
    ).toBe("absent");
  });

  test("other failures are not proof of absence", () => {
    expect(() =>
      classifyBaselineModel({ code: 1, stdout: "", stderr: "HTTP 401" })
    ).toThrow(/HTTP 401/);
  });

  test("reports the exit code when there is no output", () => {
    expect(() =>
      classifyBaselineModel({ code: 4, stdout: "", stderr: "" })
    ).toThrow(/exit code 4/);
  });
});
