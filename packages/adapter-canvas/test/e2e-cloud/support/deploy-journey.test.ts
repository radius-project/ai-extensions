import { describe, expect, it } from "vitest";

import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE
} from "../../../src/infra.js";
import { REQUIRED_DEFAULT_BRANCH_WORKFLOWS } from "./create-environment-journey.js";
import {
  applicationNamespace,
  classifyDeploymentPresence,
  describeDeployFailure,
  describeProblems,
  findDeleteEnvironmentRefusalProblems,
  findDeployedApplicationProblems,
  findSurvivingArtifactProblems,
  RADIUS_APPLICATION_LABEL,
  radiusApplicationSelector,
  readApplicationNames,
  readDeploymentRows,
  readDeployStatusSnapshot,
  readKubernetesResourceNames,
  readKubernetesWorkloads,
  REQUIRED_DELETE_WORKFLOWS,
  REQUIRED_DEPLOY_WORKFLOWS,
  REQUIRED_ENVIRONMENT_VARIABLES,
  REQUIRED_LIFECYCLE_WORKFLOWS,
  REQUIRED_STATE_VARIABLES,
  repositoryListingPath,
  requireSingleApplication,
  SUCCESSFUL_DEPLOY_STATE,
  TERMINAL_DEPLOY_STATES,
  type KubernetesWorkload
} from "./deploy-journey.js";

function workload(
  overrides: Partial<KubernetesWorkload> = {}
): KubernetesWorkload {
  return {
    name: "demo-frontend",
    application: "demo",
    desiredReplicas: 1,
    availableReplicas: 1,
    ...overrides
  };
}

function survivingInput(
  overrides: Partial<Parameters<typeof findSurvivingArtifactProblems>[0]> = {}
): Parameters<typeof findSurvivingArtifactProblems>[0] {
  return {
    environmentName: "radtest-env",
    environmentExists: true,
    expectedVariables: new Map(
      REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, `${name}-value`])
    ),
    variables: new Map(
      REQUIRED_ENVIRONMENT_VARIABLES.map((name) => [name, `${name}-value`])
    ),
    appIdBefore: "11111111-1111-1111-1111-111111111111",
    appIdAfter: "11111111-1111-1111-1111-111111111111",
    federatedSubjects: ["repo:acme/fixture:ref:refs/heads/main"],
    expectedFederatedSubjects: ["repo:acme/fixture:ref:refs/heads/main"],
    remainingWorkloads: [],
    ...overrides
  };
}

describe("required workflow and variable inventories", () => {
  it("takes the deploy and delete workflow file names from the product", () => {
    expect(REQUIRED_DEPLOY_WORKFLOWS).toEqual([
      DEPLOY_DISPATCHER_FILE,
      DEPLOY_AZURE_FILE
    ]);
    expect(REQUIRED_DELETE_WORKFLOWS).toEqual([
      DELETE_APP_DISPATCHER_FILE,
      DELETE_AZURE_FILE
    ]);
    expect(REQUIRED_LIFECYCLE_WORKFLOWS).toEqual([
      ...REQUIRED_DEFAULT_BRANCH_WORKFLOWS,
      ...REQUIRED_DEPLOY_WORKFLOWS,
      ...REQUIRED_DELETE_WORKFLOWS
    ]);
  });

  it("requires the Radius state variables the workflows read on top of the Azure ones", () => {
    expect(REQUIRED_STATE_VARIABLES).toEqual([
      "RADIUS_STATE_BACKEND",
      "RADIUS_STATE_REGISTRY",
      "RADIUS_STATE_ARCHIVE"
    ]);
    for (const name of REQUIRED_STATE_VARIABLES)
      expect(REQUIRED_ENVIRONMENT_VARIABLES).toContain(name);
    expect(REQUIRED_ENVIRONMENT_VARIABLES).toContain("AZURE_CLIENT_ID");
    expect(REQUIRED_ENVIRONMENT_VARIABLES).toContain("KUBERNETES_NAMESPACE");
  });

  it("treats complete and failed as terminal, and only complete as success", () => {
    expect(TERMINAL_DEPLOY_STATES).toEqual(["complete", "failed"]);
    expect(SUCCESSFUL_DEPLOY_STATE).toBe("complete");
    expect(TERMINAL_DEPLOY_STATES).not.toContain("success");
  });
});

describe("readDeployStatusSnapshot", () => {
  it("reports a completed deploy as terminal and successful", () => {
    const snapshot = readDeployStatusSnapshot({
      status: "complete",
      active: false,
      deployRunUrl: "https://github.com/acme/fixture/actions/runs/1"
    });
    expect(snapshot).toEqual({
      status: "complete",
      terminal: true,
      succeeded: true,
      active: false,
      logs: [],
      error: "",
      errorKind: "",
      runUrl: "https://github.com/acme/fixture/actions/runs/1"
    });
  });

  it("reports a failed deploy as terminal but not successful, carrying its error", () => {
    const snapshot = readDeployStatusSnapshot({
      status: "failed",
      error: "bicep build failed",
      errorKind: "compile"
    });
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.succeeded).toBe(false);
    expect(snapshot.error).toBe("bicep build failed");
    expect(snapshot.errorKind).toBe("compile");
  });

  it("carries the bounded deploy logs returned by the status route", () => {
    const snapshot = readDeployStatusSnapshot({
      status: "failed",
      logs: ["Compiling app.bicep", "Deployment failed"]
    });
    expect(snapshot.logs).toEqual(["Compiling app.bicep", "Deployment failed"]);
  });

  it("treats absent or null deploy logs as an empty list", () => {
    expect(readDeployStatusSnapshot({ status: "idle" }).logs).toEqual([]);
    expect(
      readDeployStatusSnapshot({ status: "idle", logs: null }).logs
    ).toEqual([]);
  });

  it("reports an in-progress deploy as neither terminal nor successful", () => {
    const snapshot = readDeployStatusSnapshot({
      status: "in_progress",
      active: true
    });
    expect(snapshot.terminal).toBe(false);
    expect(snapshot.succeeded).toBe(false);
    expect(snapshot.active).toBe(true);
  });

  it("treats a non-boolean active flag as inactive", () => {
    expect(
      readDeployStatusSnapshot({ status: "idle", active: "yes" }).active
    ).toBe(false);
  });

  it("trims surrounding whitespace before classifying the status", () => {
    const snapshot = readDeployStatusSnapshot({ status: "  complete  " });
    expect(snapshot.status).toBe("complete");
    expect(snapshot.terminal).toBe(true);
  });

  it("treats a null optional field as absent rather than as a value", () => {
    const snapshot = readDeployStatusSnapshot({
      status: "complete",
      error: null,
      errorKind: undefined
    });
    expect(snapshot.error).toBe("");
    expect(snapshot.errorKind).toBe("");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "complete"],
    ["a number", 7]
  ])("rejects a payload that is %s", (_label, payload) => {
    expect(() => readDeployStatusSnapshot(payload)).toThrow(
      /not a JSON object/
    );
  });

  it.each([
    ["missing", {}],
    ["not a string", { status: 3 }],
    ["empty", { status: "" }],
    ["only whitespace", { status: "   " }]
  ])("rejects a status that is %s", (_label, payload) => {
    expect(() => readDeployStatusSnapshot(payload)).toThrow(
      /carried no usable "status"/
    );
  });

  it.each(["error", "errorKind", "deployRunUrl"])(
    "rejects a non-string %s rather than silently dropping it",
    (field) => {
      expect(() =>
        readDeployStatusSnapshot({ status: "complete", [field]: 42 })
      ).toThrow(new RegExp(`non-string "${field}"`));
    }
  );

  it("rejects a non-array logs field", () => {
    expect(() =>
      readDeployStatusSnapshot({ status: "failed", logs: "not-an-array" })
    ).toThrow(/non-array "logs"/);
  });

  it("rejects a non-string log entry", () => {
    expect(() =>
      readDeployStatusSnapshot({ status: "failed", logs: ["valid", 42] })
    ).toThrow(/non-string "logs" entry at index 1/);
  });
});

describe("readApplicationNames", () => {
  it("narrows the listing to usable names", () => {
    expect(
      readApplicationNames({
        applications: [{ name: "demo" }, { name: "api" }]
      })
    ).toEqual(["demo", "api"]);
  });

  it("trims a padded name", () => {
    expect(
      readApplicationNames({ applications: [{ name: "  demo  " }] })
    ).toEqual(["demo"]);
  });

  it.each([null, "demo", { name: 4 }, { name: "  " }, {}])(
    "rejects a malformed application entry %#",
    (entry) => {
      expect(() => readApplicationNames({ applications: [entry] })).toThrow(
        /malformed entry at index 0/
      );
    }
  );

  it("rejects an endpoint error instead of accepting a guessed application", () => {
    expect(() =>
      readApplicationNames({
        applications: [{ name: "guessed-repository-name" }],
        error: "app.bicep could not be read"
      })
    ).toThrow(/application listing failed: app\.bicep could not be read/);
  });

  it("rejects a malformed endpoint error", () => {
    expect(() =>
      readApplicationNames({ applications: [], error: { message: "failed" } })
    ).toThrow(/non-string "error"/);
  });

  it.each([
    ["a non-object payload", null],
    ["a payload with no applications key", {}],
    ["a payload whose applications is not an array", { applications: 1 }]
  ])("refuses to read %s as no applications", (_label, payload) => {
    expect(() => readApplicationNames(payload)).toThrow(
      /carried no "applications" array/
    );
  });
});

describe("requireSingleApplication", () => {
  it("returns the fixture's single application", () => {
    expect(requireSingleApplication(["demo"])).toBe("demo");
  });

  it("refuses to deploy when the repository exposes no application", () => {
    expect(() => requireSingleApplication([])).toThrow(
      /exposes no application to deploy/
    );
  });

  it("refuses to pick one of several rather than depending on listing order", () => {
    expect(() => requireSingleApplication(["demo", "api"])).toThrow(
      /exposes 2 applications \(demo, api\)/
    );
  });
});

describe("readDeploymentRows", () => {
  it("narrows well-formed rows and defaults the optional text fields", () => {
    const rows = readDeploymentRows({
      deployments: [
        {
          app: "demo",
          environment: "radtest-env",
          status: "success",
          runUrl: "https://example.invalid/run"
        },
        { app: "other", environment: "radtest-env" }
      ]
    });
    expect(rows).toEqual([
      {
        app: "demo",
        environment: "radtest-env",
        status: "success",
        runUrl: "https://example.invalid/run"
      },
      { app: "other", environment: "radtest-env", status: "", runUrl: "" }
    ]);
  });

  it("returns an empty list for a listing with no deployments", () => {
    expect(readDeploymentRows({ deployments: [] })).toEqual([]);
  });

  it.each([
    [null, /must be an object/],
    ["demo", /must be an object/],
    [["demo"], /must be an object/],
    [{ app: 1, environment: "radtest-env" }, /must be strings/],
    [{ app: "demo", environment: 2 }, /must be strings/],
    [{ app: "demo", environment: "radtest-env", status: 1 }, /"status"/],
    [{ app: "demo", environment: "radtest-env", runUrl: 1 }, /"runUrl"/]
  ])("rejects malformed deployment row %#", (entry, message) => {
    expect(() => readDeploymentRows({ deployments: [entry] })).toThrow(
      message as RegExp
    );
  });

  it("rejects an endpoint error instead of proving false absence", () => {
    expect(() =>
      readDeploymentRows({
        deployments: [],
        error: "GitHub deployments are unavailable"
      })
    ).toThrow(/deployment listing failed: GitHub deployments are unavailable/);
  });

  it("rejects a malformed endpoint error", () => {
    expect(() =>
      readDeploymentRows({ deployments: [], error: { message: "failed" } })
    ).toThrow(/non-string "error"/);
  });

  it.each([
    ["a non-object payload", null],
    ["a payload with no deployments key", {}],
    ["a payload whose deployments is not an array", { deployments: {} }]
  ])("refuses to read %s as an empty listing", (_label, payload) => {
    expect(() => readDeploymentRows(payload)).toThrow(
      /carried no "deployments" array/
    );
  });
});

describe("repositoryListingPath", () => {
  it("scopes application discovery to the encoded repository", () => {
    expect(
      repositoryListingPath("/api/list-applications", "owner/repo name")
    ).toBe("/api/list-applications?repo=owner%2Frepo%20name");
  });

  it("preserves the fresh deployment flag with repository scope", () => {
    expect(
      repositoryListingPath("/api/list-deployments", "owner/repo", true)
    ).toBe("/api/list-deployments?repo=owner%2Frepo&fresh=1");
  });
});

describe("classifyDeploymentPresence", () => {
  const rows = [
    {
      app: "demo",
      environment: "RadTest-Env",
      status: "success",
      runUrl: "https://example.invalid/run"
    }
  ];

  it("reports a matching row with its status and run url", () => {
    expect(classifyDeploymentPresence(rows, "demo", "radtest-env")).toEqual({
      present: true,
      status: "success",
      runUrl: "https://example.invalid/run"
    });
  });

  it("reports absence once the row is gone", () => {
    expect(classifyDeploymentPresence([], "demo", "radtest-env")).toEqual({
      present: false
    });
  });

  it("does not match a different application in the same environment", () => {
    expect(
      classifyDeploymentPresence(rows, "other", "radtest-env").present
    ).toBe(false);
  });

  it("does not match the same application in a different environment", () => {
    expect(classifyDeploymentPresence(rows, "demo", "other-env").present).toBe(
      false
    );
  });
});

describe("applicationNamespace", () => {
  it("joins the environment namespace and application, normalized", () => {
    expect(applicationNamespace("RadTest-NS", "Demo")).toBe("radtest-ns-demo");
  });

  it("trims each part before joining", () => {
    expect(applicationNamespace("  ns  ", "  demo  ")).toBe("ns-demo");
  });

  it.each([
    ["environment namespace", "", "demo", /environment namespace is empty/],
    [
      "environment namespace of whitespace",
      "   ",
      "demo",
      /environment namespace is empty/
    ],
    ["application name", "ns", "", /application name is empty/]
  ])("rejects an empty %s", (_label, namespace, application, expected) => {
    expect(() => applicationNamespace(namespace, application)).toThrow(
      expected
    );
  });

  it("accepts a namespace of exactly the 63-character limit", () => {
    const application = "a".repeat(60);
    expect(applicationNamespace("ns", application)).toHaveLength(63);
  });

  it("rejects a namespace one character over the limit Kubernetes accepts", () => {
    expect(() => applicationNamespace("ns", "a".repeat(61))).toThrow(
      /is 64 characters; Kubernetes rejects anything longer than 63/
    );
  });
});

describe("radiusApplicationSelector", () => {
  it("selects on the label Radius stamps on rendered workloads", () => {
    expect(radiusApplicationSelector("Demo")).toBe(
      `${RADIUS_APPLICATION_LABEL}=demo`
    );
  });

  it("refuses to build a selector that would match every workload", () => {
    expect(() => radiusApplicationSelector("  ")).toThrow(
      /application name is empty/
    );
  });
});

describe("readKubernetesWorkloads", () => {
  it("narrows a listing into names, labels and replica counts", () => {
    expect(
      readKubernetesWorkloads({
        items: [
          {
            metadata: {
              name: "  demo-frontend  ",
              labels: { [RADIUS_APPLICATION_LABEL]: "demo" }
            },
            spec: { replicas: 2 },
            status: { availableReplicas: 2 }
          }
        ]
      })
    ).toEqual([
      {
        name: "demo-frontend",
        application: "demo",
        desiredReplicas: 2,
        availableReplicas: 2
      }
    ]);
  });

  it("returns an empty list for an empty listing", () => {
    expect(readKubernetesWorkloads({ items: [] })).toEqual([]);
  });

  it("reports an unlabelled workload with no application rather than guessing one", () => {
    const [parsed] = readKubernetesWorkloads({
      items: [{ metadata: { name: "orphan" } }]
    });
    expect(parsed?.application).toBe("");
  });

  it("ignores a non-string application label", () => {
    const [parsed] = readKubernetesWorkloads({
      items: [
        {
          metadata: {
            name: "orphan",
            labels: { [RADIUS_APPLICATION_LABEL]: 5 }
          }
        }
      ]
    });
    expect(parsed?.application).toBe("");
  });

  it.each([
    ["missing", {}],
    ["not a number", { replicas: "2", availableReplicas: "2" }],
    [
      "not finite",
      { replicas: Number.NaN, availableReplicas: Number.POSITIVE_INFINITY }
    ]
  ])("counts replicas as zero when they are %s", (_label, counts) => {
    const [parsed] = readKubernetesWorkloads({
      items: [
        {
          metadata: { name: "demo-frontend" },
          spec: { replicas: (counts as Record<string, unknown>).replicas },
          status: {
            availableReplicas: (counts as Record<string, unknown>)
              .availableReplicas
          }
        }
      ]
    });
    expect(parsed?.desiredReplicas).toBe(0);
    expect(parsed?.availableReplicas).toBe(0);
  });

  it.each([
    ["a non-object payload", null, /not a JSON object/],
    ["a payload with no items", {}, /carried no "items" array/],
    [
      "a payload whose items is not an array",
      { items: 3 },
      /carried no "items" array/
    ],
    ["a non-object entry", { items: [null] }, /non-object entry at index 0/],
    [
      "an entry with no metadata",
      { items: [{}] },
      /entry at index 0 with no usable "metadata.name"/
    ],
    [
      "an entry with a non-string name",
      { items: [{ metadata: { name: 4 } }] },
      /entry at index 0 with no usable "metadata.name"/
    ],
    [
      "an entry with a blank name",
      { items: [{ metadata: { name: "  " } }] },
      /entry at index 0 with no usable "metadata.name"/
    ]
  ])("refuses to read %s as no workloads", (_label, payload, expected) => {
    expect(() => readKubernetesWorkloads(payload)).toThrow(expected);
  });

  it("names the offending index rather than the first one", () => {
    expect(() =>
      readKubernetesWorkloads({
        items: [{ metadata: { name: "ok" } }, null]
      })
    ).toThrow(/non-object entry at index 1/);
  });
});

describe("findDeleteEnvironmentRefusalProblems", () => {
  const refusal = (
    overrides: Partial<
      Parameters<typeof findDeleteEnvironmentRefusalProblems>[0]
    > = {}
  ): Parameters<typeof findDeleteEnvironmentRefusalProblems>[0] => ({
    status: 409,
    payload: {
      error:
        'Application "demo" is still deployed to environment "radtest-env". Delete the application deployment first, then delete the environment.',
      code: "app-deployed",
      app: "demo",
      environment: "radtest-env"
    },
    application: "demo",
    environmentName: "radtest-env",
    environmentExists: true,
    ...overrides
  });

  it("accepts a refusal that names the application and leaves the environment standing", () => {
    expect(findDeleteEnvironmentRefusalProblems(refusal())).toEqual([]);
  });

  it("reports a delete that was allowed while an application was still deployed", () => {
    const problems = findDeleteEnvironmentRefusalProblems(
      refusal({ status: 200, payload: { success: true } })
    );
    expect(problems[0]).toMatch(/answered 200, not 409/);
    expect(problems[0]).toMatch(/never orphaned/);
  });

  it("stops at a payload it cannot inspect", () => {
    const problems = findDeleteEnvironmentRefusalProblems(
      refusal({ payload: "conflict" })
    );
    expect(problems).toEqual([
      "The refusal carried no JSON object to inspect."
    ]);
  });

  it("reports a refusal the browser cannot tell apart from another conflict", () => {
    const problems = findDeleteEnvironmentRefusalProblems(
      refusal({
        payload: {
          error: 'Application "demo" is still deployed.',
          code: "conflict",
          app: "demo"
        }
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/reported code "conflict"/);
  });

  it.each([
    ["no message at all", { code: "app-deployed", app: "demo" }],
    ["an empty message", { error: "  ", code: "app-deployed", app: "demo" }]
  ])("reports a refusal carrying %s", (_label, payload) => {
    const problems = findDeleteEnvironmentRefusalProblems(refusal({ payload }));
    expect(problems).toEqual([
      "The refusal carried no error message to show the user."
    ]);
  });

  it("reports a message that never names the application to delete first", () => {
    const problems = findDeleteEnvironmentRefusalProblems(
      refusal({
        payload: {
          error: "Something is still deployed.",
          code: "app-deployed",
          app: "demo"
        }
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not name application "demo"/);
  });

  it("reports a refusal naming a different application than the deploy created", () => {
    const problems = findDeleteEnvironmentRefusalProblems(
      refusal({
        payload: {
          error: 'Application "demo" is still deployed.',
          code: "app-deployed",
          app: "other"
        }
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/named application "other"/);
  });

  it("reports a guard that refused and deleted the environment anyway", () => {
    const problems = findDeleteEnvironmentRefusalProblems(
      refusal({ environmentExists: false })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/worse than no guard/);
  });
});

describe("findDeployedApplicationProblems", () => {
  it("accepts a namespace holding a running workload for the application", () => {
    expect(
      findDeployedApplicationProblems({
        application: "demo",
        namespace: "ns-demo",
        namespaceExists: true,
        workloads: [workload()]
      })
    ).toEqual([]);
  });

  it("matches the application label without regard to case", () => {
    expect(
      findDeployedApplicationProblems({
        application: "Demo",
        namespace: "ns-demo",
        namespaceExists: true,
        workloads: [workload({ application: "demo" })]
      })
    ).toEqual([]);
  });

  it("reports a missing namespace as the deploy never reaching the cluster, and stops there", () => {
    const problems = findDeployedApplicationProblems({
      application: "demo",
      namespace: "ns-demo",
      namespaceExists: false,
      workloads: []
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not exist on the target cluster/);
    expect(problems[0]).toMatch(/ephemeral control plane/);
  });

  it("distinguishes an empty namespace from one holding unrelated workloads", () => {
    const empty = findDeployedApplicationProblems({
      application: "demo",
      namespace: "ns-demo",
      namespaceExists: true,
      workloads: []
    });
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatch(/The namespace is empty/);

    const unrelated = findDeployedApplicationProblems({
      application: "demo",
      namespace: "ns-demo",
      namespaceExists: true,
      workloads: [workload({ name: "stray", application: "other" })]
    });
    expect(unrelated).toHaveLength(1);
    expect(unrelated[0]).toMatch(/1 unrelated workload\(s\): "stray"/);
  });

  it("reports every workload that applied but never became available", () => {
    const problems = findDeployedApplicationProblems({
      application: "demo",
      namespace: "ns-demo",
      namespaceExists: true,
      workloads: [
        workload({
          name: "frontend",
          availableReplicas: 0,
          desiredReplicas: 1
        }),
        workload({ name: "backend", availableReplicas: 0, desiredReplicas: 2 }),
        workload({ name: "worker" })
      ]
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(
      /"frontend" applied but has 0 available replica\(s\) of 1 desired/
    );
    expect(problems[1]).toMatch(/"backend"/);
  });
});

describe("findSurvivingArtifactProblems", () => {
  it("accepts an environment, identity and cluster left in the required state", () => {
    expect(findSurvivingArtifactProblems(survivingInput())).toEqual([]);
  });

  it("reports a deleted environment and does not then audit its variables", () => {
    const problems = findSurvivingArtifactProblems(
      survivingInput({ environmentExists: false, variables: new Map() })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no longer exists/);
    expect(problems[0]).toMatch(/delete-environment journey's job/);
  });

  it("reports a removed environment variable", () => {
    const variables = new Map(survivingInput().variables);
    variables.delete("RADIUS_STATE_ARCHIVE");
    const problems = findSurvivingArtifactProblems(
      survivingInput({ variables })
    );
    expect(problems).toEqual([
      "Environment variable RADIUS_STATE_ARCHIVE was removed by the delete; the environment can no longer deploy."
    ]);
  });

  it("reports a variable that survived but was emptied", () => {
    const variables = new Map(survivingInput().variables);
    variables.set("AZURE_CLIENT_ID", "   ");
    const problems = findSurvivingArtifactProblems(
      survivingInput({ variables })
    );
    expect(problems).toEqual([
      "Environment variable AZURE_CLIENT_ID changed across the delete; the surviving environment no longer matches " +
        "the configuration stage one proved."
    ]);
  });

  it("reports a variable whose non-empty value changed", () => {
    const variables = new Map(survivingInput().variables);
    variables.set("AZURE_AKS_CLUSTER_NAME", "different-cluster");
    expect(
      findSurvivingArtifactProblems(survivingInput({ variables }))
    ).toEqual([
      "Environment variable AZURE_AKS_CLUSTER_NAME changed across the delete; the surviving environment no longer " +
        "matches the configuration stage one proved."
    ]);
  });

  it("reports removal of a captured product variable outside the required inventory", () => {
    const expectedVariables = new Map(survivingInput().expectedVariables);
    expectedVariables.set("RADIUS_MANAGED", "true");
    expect(
      findSurvivingArtifactProblems(
        survivingInput({
          expectedVariables,
          variables: survivingInput().variables
        })
      )
    ).toEqual([
      "Environment variable RADIUS_MANAGED was removed by the delete; the environment can no longer deploy."
    ]);
  });

  it("reports changes to a captured product variable outside the required inventory", () => {
    const expectedVariables = new Map(survivingInput().expectedVariables);
    const variables = new Map(survivingInput().variables);
    expectedVariables.set("RADIUS_CREDENTIAL_PROFILE", "cloud-e2e");
    variables.set("RADIUS_CREDENTIAL_PROFILE", "other");
    expect(
      findSurvivingArtifactProblems(
        survivingInput({ expectedVariables, variables })
      )
    ).toEqual([
      "Environment variable RADIUS_CREDENTIAL_PROFILE changed across the delete; the surviving environment no longer matches the configuration stage one proved."
    ]);
  });

  it("refuses to claim survival without a stage-one variable value", () => {
    const expectedVariables = new Map(survivingInput().expectedVariables);
    expectedVariables.delete("AZURE_LOCATION");
    expect(
      findSurvivingArtifactProblems(survivingInput({ expectedVariables }))
    ).toEqual([
      "Stage one did not record environment variable AZURE_LOCATION, so its survival cannot be proved."
    ]);
  });

  it("reports a deleted Entra application", () => {
    const problems = findSurvivingArtifactProblems(
      survivingInput({ appIdAfter: "  " })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no longer exists/);
    expect(problems[0]).toMatch(/must not touch the identity/);
  });

  describe("readKubernetesResourceNames", () => {
    it("reads kind-qualified deployment and pod names", () => {
      expect(
        readKubernetesResourceNames({
          items: [
            { kind: "Deployment", metadata: { name: "frontend" } },
            { kind: "Pod", metadata: { name: "frontend-abc" } }
          ]
        })
      ).toEqual(["Deployment/frontend", "Pod/frontend-abc"]);
    });

    it("accepts a resource without a kind and trims its name", () => {
      expect(
        readKubernetesResourceNames({
          items: [{ metadata: { name: " frontend " } }]
        })
      ).toEqual(["frontend"]);
    });

    it.each([
      [[], "not a JSON object"],
      [{}, 'no "items" array'],
      [{ items: [null] }, "non-object entry at index 0"],
      [{ items: [{ metadata: {} }] }, 'no usable "metadata.name"']
    ])("rejects malformed resource listings", (payload, message) => {
      expect(() => readKubernetesResourceNames(payload)).toThrow(message);
    });
  });

  it("reports an Entra application replaced by a different one", () => {
    const problems = findSurvivingArtifactProblems(
      survivingInput({
        appIdAfter: "22222222-2222-2222-2222-222222222222"
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/changed from 1111.* to 2222/);
  });

  it("accepts the same application id reported in a different case", () => {
    expect(
      findSurvivingArtifactProblems(
        survivingInput({
          appIdBefore: "AAAAAAAA-1111-1111-1111-111111111111",
          appIdAfter: " aaaaaaaa-1111-1111-1111-111111111111 "
        })
      )
    ).toEqual([]);
  });

  it("reports a federated credential subject the delete removed", () => {
    const problems = findSurvivingArtifactProblems(
      survivingInput({
        federatedSubjects: [],
        expectedFederatedSubjects: ["repo:acme/fixture:ref:refs/heads/main"]
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/can no longer exchange a GitHub token/);
  });

  it("reports a case-mutated federated credential subject", () => {
    const problems = findSurvivingArtifactProblems(
      survivingInput({
        federatedSubjects: ["REPO:ACME/FIXTURE:REF:REFS/HEADS/MAIN"],
        expectedFederatedSubjects: ["repo:acme/fixture:ref:refs/heads/main"]
      })
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/can no longer exchange a GitHub token/);
  });

  it("reports every workload the delete failed to tear down", () => {
    const problems = findSurvivingArtifactProblems(
      survivingInput({
        remainingWorkloads: [
          workload({ name: "frontend" }),
          workload({ name: "backend" })
        ]
      })
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/"frontend" is still labelled/);
    expect(problems[1]).toMatch(/"backend" is still labelled/);
  });
});

describe("describeDeployFailure", () => {
  it("reports the state, kind, error, run url and the tail of the logs", () => {
    const message = describeDeployFailure(
      {
        status: "failed",
        terminal: true,
        succeeded: false,
        active: false,
        logs: [],
        error: "deployment failed",
        errorKind: "deploy",
        runUrl: "https://example.invalid/run"
      },
      ["first", "second"]
    );
    expect(message).toContain('finished in state "failed" (deploy)');
    expect(message).toContain(": deployment failed");
    expect(message).toContain("Workflow run: https://example.invalid/run");
    expect(message).toContain("Last 2 log line(s):");
    expect(message).toContain("  first");
  });

  it("keeps only the last twenty log lines", () => {
    const message = describeDeployFailure(
      {
        status: "failed",
        terminal: true,
        succeeded: false,
        active: false,
        logs: [],
        error: "",
        errorKind: "",
        runUrl: ""
      },
      Array.from({ length: 25 }, (_value, index) => `line-${index}`)
    );
    expect(message).toContain("Last 20 log line(s):");
    expect(message).toContain("line-24");
    expect(message).not.toContain("line-4\n");
  });

  it("says plainly when a deploy produced no logs and no error detail", () => {
    const message = describeDeployFailure(
      {
        status: "failed",
        terminal: true,
        succeeded: false,
        active: false,
        logs: [],
        error: "",
        errorKind: "",
        runUrl: ""
      },
      []
    );
    expect(message).toBe(
      'The deploy finished in state "failed".\nThe deploy produced no log lines at all.'
    );
  });
});

describe("describeProblems", () => {
  it("returns nothing when there is nothing wrong", () => {
    expect(describeProblems("Stage two failed:", [])).toBe("");
  });

  it("renders each problem under the headline", () => {
    expect(describeProblems("Stage two failed:", ["one", "two"])).toBe(
      "Stage two failed:\n  - one\n  - two"
    );
  });
});
