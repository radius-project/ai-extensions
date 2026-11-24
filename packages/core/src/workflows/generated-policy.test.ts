import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  assertTrustedGeneratedWorkflow,
  deployWorkflowFiles,
  stripAwsDispatcherJob,
  stripWorkflowRunTrigger,
  type GeneratedWorkflowArtifact
} from "./generated-policy.js";
import {
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  DEPLOY_DISPATCHER_FILE
} from "./deploy.js";

const provider = {
  on: { workflow_call: { inputs: { environment: {} } } },
  jobs: { run: { "runs-on": "ubuntu-latest" } }
};
const dispatcher = {
  on: { workflow_dispatch: { inputs: { environment: {} } } },
  jobs: { azure: { uses: `./.github/workflows/${DEPLOY_AZURE_FILE}` } }
};
const verify = {
  on: {
    workflow_dispatch: { inputs: { environment: {}, radius_operation: {} } }
  },
  "run-name":
    "${{ inputs.environment || 'dev' }} ${{ inputs.radius_operation || 'fixture' }}",
  jobs: {
    verify: {
      steps: [
        {
          name: "Verify GHCR package push permission",
          env: { GHCR_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
          run: "probe /blobs/uploads/"
        }
      ]
    }
  }
};

function check(
  document: unknown,
  kind: GeneratedWorkflowArtifact = "provider",
  files?: string[]
) {
  assertTrustedGeneratedWorkflow(
    parse,
    stringify(document),
    kind,
    "fixture workflow",
    files
  );
}

describe("generated workflow trust policy", () => {
  it("accepts each supported artifact and enforces the startup provider switch", () => {
    check(provider);
    check(dispatcher, "dispatcher", [DEPLOY_AZURE_FILE]);
    check(verify, "verify");
    expect(deployWorkflowFiles(false)).toEqual([
      DEPLOY_DISPATCHER_FILE,
      DEPLOY_AZURE_FILE
    ]);
    expect(deployWorkflowFiles(true)).toEqual([
      DEPLOY_DISPATCHER_FILE,
      DEPLOY_AZURE_FILE,
      DEPLOY_AWS_FILE
    ]);
  });

  it.each([
    [null, "document root"],
    [[], "document root"],
    [{ jobs: {} }, "`on`"],
    [{ on: {}, jobs: null }, "`jobs` must be a mapping"],
    [{ on: {}, jobs: {} }, "non-empty"],
    [{ ...provider, on: { push: {} } }, "workflow_call"],
    [{ ...provider, on: { workflow_call: null } }, "`on.workflow_call`"],
    [{ ...provider, on: { workflow_call: { inputs: null } } }, "inputs"],
    [{ ...provider, on: { workflow_call: { inputs: {} } } }, "environment"],
    [
      {
        ...provider,
        on: { workflow_call: { inputs: { environment: "invalid" } } }
      },
      "environment"
    ],
    [{ ...provider, name: "{{UNRESOLVED}}" }, "unresolved"]
  ])("rejects invalid provider structure %#", (document, message) => {
    expect(() => check(document)).toThrow(String(message));
  });

  it.each(["pull_request", "pull_request_target", "workflow_run", "schedule"])(
    "rejects the unsafe automatic trigger %s",
    (trigger) => {
      expect(() =>
        check({ ...provider, on: { ...provider.on, [trigger]: {} } })
      ).toThrow(`unsafe automatic trigger \`${trigger}\``);
    }
  );

  it.each([
    [{ ...dispatcher, on: { workflow_call: {} } }, "workflow_dispatch"],
    [
      { ...dispatcher, on: { workflow_dispatch: null } },
      "`on.workflow_dispatch`"
    ],
    [{ ...dispatcher, on: { workflow_dispatch: { inputs: null } } }, "inputs"],
    [
      { ...dispatcher, on: { workflow_dispatch: { inputs: {} } } },
      "environment"
    ],
    [
      {
        ...dispatcher,
        on: { workflow_dispatch: { inputs: { environment: null } } }
      },
      "environment"
    ],
    [{ ...dispatcher, jobs: { AWS: { run: "fixture" } } }, "AWS job"],
    [
      {
        ...dispatcher,
        jobs: {
          other: {
            nested: [{ uses: `./.github/workflows/${DEPLOY_AWS_FILE}` }]
          }
        }
      },
      "AWS job"
    ],
    [
      {
        ...dispatcher,
        jobs: { other: { run: "unrelated", nested: [null, "text"] } }
      },
      "must invoke"
    ]
  ])("rejects invalid dispatcher structure %#", (document, message) => {
    expect(() => check(document, "dispatcher", [DEPLOY_AZURE_FILE])).toThrow(
      message
    );
  });

  it("permits AWS references only when the expected provider list includes AWS", () => {
    check(
      {
        ...dispatcher,
        jobs: {
          ...dispatcher.jobs,
          aws: { uses: `./.github/workflows/${DEPLOY_AWS_FILE}` }
        }
      },
      "dispatcher",
      [DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE]
    );
  });

  it.each([
    [{ ...verify, on: { push: {} } }, "may only use"],
    [{ ...verify, on: { ...verify.on, workflow_call: {} } }, "may only use"],
    [{ ...verify, on: { ...verify.on, push: null } }, "`on.push`"],
    [{ ...verify, on: { ...verify.on, push: {} } }, "push trigger"],
    [
      { ...verify, on: { ...verify.on, push: { branches: [] } } },
      "push trigger"
    ],
    [
      { ...verify, on: { ...verify.on, push: { branches: ["main"] } } },
      "push trigger"
    ],
    [
      {
        ...verify,
        on: { ...verify.on, push: { branches: ["radius/setup-**"] } }
      },
      "push trigger"
    ],
    [
      {
        ...verify,
        on: { ...verify.on, push: { branches: ["radius/setup-**"], paths: [] } }
      },
      "push trigger"
    ],
    [
      {
        ...verify,
        on: {
          ...verify.on,
          push: { branches: ["radius/setup-**"], paths: ["wrong"] }
        }
      },
      "push trigger"
    ],
    [{ ...verify, on: { workflow_dispatch: null } }, "`on.workflow_dispatch`"],
    [{ ...verify, on: { workflow_dispatch: { inputs: null } } }, "inputs"],
    [
      { ...verify, on: { workflow_dispatch: { inputs: { environment: {} } } } },
      "radius_operation"
    ],
    [
      {
        ...verify,
        on: {
          workflow_dispatch: {
            inputs: { environment: {}, radius_operation: 1 }
          }
        }
      },
      "radius_operation"
    ],
    [{ ...verify, "run-name": null }, "marker-bearing"],
    [{ ...verify, "run-name": "plain" }, "marker-bearing"],
    [
      { ...verify, "run-name": "${{ inputs.environment || 'dev' }}" },
      "marker-bearing"
    ],
    [
      {
        ...verify,
        jobs: {
          one: null,
          two: {},
          three: { steps: [null, { name: "other" }] }
        }
      },
      "GHCR"
    ],
    [
      {
        ...verify,
        jobs: {
          one: {
            steps: [{ name: "Verify GHCR package push permission", env: null }]
          }
        }
      },
      "GHCR"
    ],
    [
      {
        ...verify,
        jobs: {
          one: {
            steps: [
              {
                name: "Verify GHCR package push permission",
                env: { GHCR_TOKEN: "wrong" }
              }
            ]
          }
        }
      },
      "GHCR"
    ],
    [
      {
        ...verify,
        jobs: {
          one: {
            steps: [
              {
                name: "Verify GHCR package push permission",
                env: { GHCR_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
                run: null
              }
            ]
          }
        }
      },
      "GHCR"
    ],
    [
      {
        ...verify,
        jobs: {
          one: {
            steps: [
              {
                name: "Verify GHCR package push permission",
                env: { GHCR_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
                run: "wrong"
              }
            ]
          }
        }
      },
      "GHCR"
    ]
  ])("rejects invalid verify structure %#", (document, message) => {
    expect(() => check(document, "verify")).toThrow(message);
  });

  it("preserves the constrained setup push trigger", () => {
    check(
      {
        ...verify,
        on: {
          ...verify.on,
          push: {
            branches: ["radius/setup-**"],
            paths: [".github/workflows/radius-verify-credentials.yml"]
          }
        }
      },
      "verify"
    );
  });

  it.each([new Error("parse failure"), "parse failure"])(
    "retains a parser failure and its cause",
    (error) => {
      expect(() =>
        assertTrustedGeneratedWorkflow(
          () => {
            throw error;
          },
          "invalid",
          "provider",
          "fixture"
        )
      ).toThrow("Generated fixture is invalid YAML: parse failure");
    }
  );
});

describe("explicit deployment trigger policy", () => {
  it.each(["plain", "jobs:\n  azure:\n    run: fixture"])(
    "leaves unrelated YAML unchanged",
    (source) => {
      expect(stripAwsDispatcherJob(source)).toBe(source);
      expect(stripWorkflowRunTrigger(source)).toBe(source);
    }
  );

  it("removes AWS comments and content without removing the next job", () => {
    expect(
      stripAwsDispatcherJob(
        "jobs:\n  azure: {}\n\n  # AWS\n  aws:\n    uses: aws\n  next: {}\nname: x"
      )
    ).toBe("jobs:\n  azure: {}\n  next: {}\nname: x");
    expect(stripAwsDispatcherJob("  # AWS\n  aws:\n    uses: aws")).toBe("");
    expect(stripAwsDispatcherJob("jobs:\n  aws:\n    uses: aws\nname: x")).toBe(
      "jobs:\nname: x"
    );
    expect(stripAwsDispatcherJob("  aws:\n    uses: aws")).toBe("");
  });

  it("removes workflow_run comments and children while preserving section boundaries", () => {
    expect(
      stripWorkflowRunTrigger(
        "on:\n  # automatic\n  workflow_run:\n    workflows: [verify]\n\n  workflow_dispatch: {}"
      )
    ).toBe("on:\n\n  workflow_dispatch: {}");
    expect(
      stripWorkflowRunTrigger("  workflow_run:\n\n    types: [completed]")
    ).toBe("");
    expect(stripWorkflowRunTrigger("  workflow_run:\n")).toBe("");
    expect(
      stripWorkflowRunTrigger(
        "on:\n  workflow_run:\n    types: [completed]\njobs: {}"
      )
    ).toBe("on:\njobs: {}");
  });
});
