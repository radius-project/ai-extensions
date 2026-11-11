// Checks the AWS workflow templates in .github/extension against the rules
// that keep their failures fast and readable: every step has a time limit,
// each job's limit is at least its longest step limit plus the limits of the
// steps that run after a failure, the inputs are checked before anything else
// runs, and Canvas's verify classifier puts each preflight message in the
// category its wording names.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  classifyVerifyFailure,
  type VerifyFailureCategory
} from "../verify-failure-classification.js";
import {
  classifyDeployCloudAuthDrift,
  extractErrorLines
} from "../workflow-diagnostics.js";

const EXTENSION = new URL("../../../../.github/extension/", import.meta.url);

const read = (file: string): string =>
  readFileSync(new URL(file, EXTENSION), "utf8");

const AWS_TEMPLATES = [
  "run-rad-commands-aws.yml",
  "delete-aws.yml",
  "delete-environment-aws.yml",
  "verify-aws.yml"
] as const;

interface Step {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string>>;
  readonly "timeout-minutes"?: number;
}

interface Job extends Step {
  readonly steps: readonly Step[];
}

interface Workflow extends Step {
  readonly jobs: Readonly<Record<string, Job>>;
}

interface ActionInput {
  readonly default?: string;
}

interface Action {
  readonly inputs: Readonly<Record<string, ActionInput>>;
  readonly runs: { readonly steps: readonly Step[] };
}

// SAFETY: these are the repository's own templates, and the values the tests
// compare as text are quoted in them. A quoted time limit would parse as a
// string, which the time-limit test rejects.
const workflowOf = (file: string): Workflow => parse(read(file)) as Workflow;

const jobsOf = (file: string): [string, Job][] =>
  Object.entries(workflowOf(file).jobs);

// SAFETY: as for workflowOf, these are the repository's own actions.
const actionOf = (directory: string): Action =>
  parse(read(`${directory}/action.yml`)) as Action;

const stepNamed = (file: string, name: string): Step => {
  const steps = jobsOf(file).flatMap(([, job]) => job.steps);
  const step = steps.find((candidate) => candidate.name === name);

  if (!step) throw new Error(`No step "${name}" in ${file}`);

  return step;
};

// Steps that still run after a failure, such as Teardown, which saves Radius
// state. The job limit counts them on top of the longest other step.
const AFTER_FAILURE = /\balways\(\)|!cancelled\(\)/;

// The other steps' normal time.
const MARGIN_MINUTES = 5;

describe.each(AWS_TEMPLATES)("%s time limits", (file) => {
  it.each(jobsOf(file))(
    "job %s limits every step and outlasts the longest one",
    (_name, job) => {
      const steps = job.steps;
      const unlimited: string[] = [];

      const minutes = (step: Step): number => {
        const limit = step["timeout-minutes"];

        if (limit !== undefined && Number.isInteger(limit)) return limit;
        unlimited.push(step.name ?? step.uses ?? "unnamed step");

        return Number.POSITIVE_INFINITY;
      };

      const cleanup = steps.filter((step) => AFTER_FAILURE.test(step.if ?? ""));

      const longest = Math.max(
        ...steps.flatMap((step) =>
          cleanup.includes(step) ? [] : [minutes(step)]
        )
      );

      const cleanupMinutes = cleanup.reduce(
        (total, step) => total + minutes(step),
        0
      );

      expect(unlimited).toEqual([]);
      expect(Number.isInteger(job["timeout-minutes"])).toBe(true);
      expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(
        longest + cleanupMinutes + MARGIN_MINUTES
      );
    }
  );
});

const TARGET_INPUTS = {
  "role-arn": "${{ vars.AWS_ROLE_ARN }}",
  "account-id": "${{ vars.AWS_ACCOUNT_ID }}",
  region: "${{ vars.AWS_REGION }}",
  "cluster-name": "${{ vars.AWS_EKS_CLUSTER_NAME }}"
};

// A missing target must stop the run before it restores state, changes
// anything, or falls back to a cluster on the runner.
describe.each(AWS_TEMPLATES)("%s input validation", (file) => {
  const steps = jobsOf(file).flatMap(([, job]) => job.steps);
  const position = steps.findIndex((step) => step.name === "Validate inputs");
  const validate = stepNamed(file, "Validate inputs");

  it("checks the AWS target unconditionally before any other step", () => {
    expect(position).toBeGreaterThanOrEqual(0);
    const earlier = steps.slice(0, position).map((step) => step.name);
    expect(earlier.filter((name) => name !== "Checkout")).toEqual([]);
    expect(validate.uses).toMatch(/\/actions\/validate-aws-inputs@/);
    expect(validate.if).toBeUndefined();
    expect(validate.with).toMatchObject(TARGET_INPUTS);
  });

  it("skips no step based on the AWS variables", () => {
    expect(steps.filter((step) => /\bvars\.AWS_/.test(step.if ?? ""))).toEqual(
      []
    );
  });

  it("requires subnets only where recipes use them", () => {
    expect(validate.with?.["require-subnets"]).toBe(
      file.startsWith("delete-") ? undefined : "true"
    );
  });
});

describe("run-rad-commands-aws.yml input validation", () => {
  const validate = stepNamed("run-rad-commands-aws.yml", "Validate inputs");

  it.each([
    ["Configure AWS Credentials (OIDC)", "with", "role-to-assume", "role-arn"],
    [
      "Create Radius environment and deploy provider recipe pack",
      "env",
      "AWS_ACCOUNT_ID",
      "account-id"
    ],
    [
      "Create Radius environment and deploy provider recipe pack",
      "env",
      "AWS_REGION",
      "region"
    ],
    [
      "Create Radius environment and deploy provider recipe pack",
      "env",
      "AWS_EKS_CLUSTER_NAME",
      "cluster-name"
    ],
    [
      "Create Radius environment and deploy provider recipe pack",
      "env",
      "RADIUS_SUBNET_IDS",
      "subnet-ids"
    ],
    [
      "Create Radius environment and deploy provider recipe pack",
      "env",
      "RECIPE_PACK_URL",
      "recipe-pack-url"
    ],
    [
      "Create Radius environment and deploy provider recipe pack",
      "env",
      "RECIPE_PACK_REF",
      "recipe-pack-ref"
    ],
    ["Run rad commands", "with", "app-file", "app-file"],
    ["Run rad commands", "with", "rad-commands", "rad-commands"],
    ["Run rad commands", "with", "deploy-params", "deploy-params"]
  ] as const)(
    "checks the value %s reads as %s.%s",
    (name, section, key, input) => {
      const value = stepNamed("run-rad-commands-aws.yml", name)[section]?.[key];
      expect(value).toBeTruthy();
      expect(validate.with?.[input]).toBe(value);
    }
  );
});

// GitHub prints each step's `run:` body and inputs into the job log, including
// those of the composite actions it calls. Canvas shows the last error-like
// lines of a failed verify log, so verify's printed text must hold none, or
// the messages of checks that never fired crowd out the real error.
it("prints no error-like lines from verify-aws.yml's steps", () => {
  const printed = (step: Step): string[] => [
    ...(step.run?.split("\n") ?? []),
    ...Object.entries({ ...step.env, ...step.with }).map(
      ([name, value]) => `  ${name}: ${value}`
    )
  ];

  // GitHub prints nothing for a composite step whose condition on the
  // action's inputs is false.
  const runs = (
    step: Step,
    inputs: Readonly<Record<string, string>>
  ): boolean => {
    const condition =
      /^\$\{\{\s*inputs\.([\w-]+)\s*(==|!=)\s*'([^']*)'\s*\}\}$/.exec(
        step.if ?? ""
      );

    if (!condition) return true;
    const [, name, operator, value] = condition;

    return (inputs[name] === value) === (operator === "==");
  };

  const workflow = workflowOf("verify-aws.yml");

  const lines = jobsOf("verify-aws.yml").flatMap(([, job]) =>
    [workflow, job, ...job.steps].flatMap((step) => {
      const action = /\/\.github\/extension\/(.+)@\{\{RADIUS_REF\}\}$/.exec(
        step.uses ?? ""
      );

      if (!action) return printed(step);

      const definition = actionOf(action[1]);

      const defaults = Object.entries(definition.inputs).map(
        ([name, input]): [string, string] => [name, input.default ?? ""]
      );

      const inputs = { ...Object.fromEntries(defaults), ...step.with };

      return [
        ...printed(step),
        ...definition.runs.steps
          .filter((actionStep) => runs(actionStep, inputs))
          .flatMap(printed)
      ];
    })
  );

  expect(lines.length).toBeGreaterThan(0);
  expect(extractErrorLines(lines.join("\n"), lines.length)).toEqual([]);
});

// Writes executable stubs into a temporary directory and returns it.
function stubDirectory(stubs: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "radius-aws-workflow-"));

  for (const [tool, body] of Object.entries(stubs)) {
    const file = path.join(directory, tool);
    writeFileSync(file, `#!/bin/bash\n${body}`);
    chmodSync(file, 0o755);
  }

  return directory;
}

const cluster = ({
  status = "ACTIVE",
  auth = "API",
  publicAccess = true,
  privateAccess = false,
  cidrs = ["0.0.0.0/0"]
} = {}): string =>
  JSON.stringify({
    cluster: {
      status,
      endpoint: "https://192.0.2.1",
      certificateAuthority: { data: "dGVzdA==" },
      accessConfig: { authenticationMode: auth },
      resourcesVpcConfig: {
        vpcId: "vpc-1",
        endpointPublicAccess: publicAccess,
        endpointPrivateAccess: privateAccess,
        publicAccessCidrs: cidrs
      }
    }
  });

// Reachability messages say "could not connect", permission messages carry an
// HTTP status or an AWS denial, and the rest name neither, so Canvas shows them
// as generic failures that the user cannot skip.
const PREFLIGHT_CASES: [
  string,
  string,
  VerifyFailureCategory,
  Record<string, string>
][] = [
  [
    "a runner outside publicAccessCidrs",
    "EKS_ENDPOINT_NOT_ALLOWED",
    "cluster-unreachable",
    { STUB_CLUSTER: cluster({ cidrs: ["198.51.100.0/24"] }) }
  ],
  [
    "a cluster without a public endpoint",
    "EKS_ENDPOINT_UNREACHABLE",
    "cluster-unreachable",
    { STUB_CLUSTER: cluster({ publicAccess: false, privateAccess: true }) }
  ],
  [
    "an allowed runner and a silent endpoint",
    "EKS_ENDPOINT_UNREACHABLE",
    "cluster-unreachable",
    {}
  ],
  [
    "a permission check that cannot connect",
    "EKS_ENDPOINT_UNREACHABLE",
    "cluster-unreachable",
    {
      STUB_API: "401",
      STUB_CAN_I:
        "Unable to connect to the server: dial tcp 192.0.2.1:443: i/o timeout"
    }
  ],
  [
    "an unreachable EKS API",
    "AWS_API_UNREACHABLE",
    "cluster-unreachable",
    {
      STUB_AWS_ERROR:
        'Could not connect to the endpoint URL: "https://eks.us-east-2.amazonaws.com/clusters/lab"'
    }
  ],
  [
    "a role that cannot describe the cluster",
    "AWS_PERMISSION_DENIED",
    "permissions",
    {
      STUB_AWS_ERROR:
        "An error occurred (AccessDeniedException) when calling the DescribeCluster operation: User: arn:aws:sts::111122223333:assumed-role/radius-deploy/GitHubActions is not authorized to perform: eks:DescribeCluster"
    }
  ],
  [
    "a role without an access entry",
    "EKS_UNAUTHORIZED",
    "permissions",
    {
      STUB_API: "401",
      STUB_KUBECTL_VERSION:
        "error: You must be logged in to the server (Unauthorized)"
    }
  ],
  [
    "a role without RBAC",
    "EKS_RBAC_MISSING",
    "permissions",
    { STUB_API: "401", STUB_CAN_I: "no" }
  ],
  [
    "a missing cluster",
    "EKS_CLUSTER_NOT_FOUND",
    "generic",
    {
      STUB_AWS_ERROR:
        "An error occurred (ResourceNotFoundException) when calling the DescribeCluster operation: No cluster found for name: lab."
    }
  ],
  [
    "a cluster being created",
    "EKS_CLUSTER_NOT_ACTIVE",
    "generic",
    { STUB_CLUSTER: cluster({ status: "CREATING" }) }
  ],
  [
    "a cluster without access entries",
    "EKS_ACCESS_ENTRIES_DISABLED",
    "generic",
    { STUB_CLUSTER: cluster({ auth: "CONFIG_MAP" }) }
  ],
  [
    "subnets in another VPC",
    "AWS_SUBNET_INVALID",
    "generic",
    { RADIUS_SUBNET_IDS: "subnet-0a,subnet-0b" }
  ]
];

describe.skipIf(process.platform === "win32")(
  "verify classification of the EKS preflight",
  () => {
    const bin = stubDirectory({
      aws: `case " $* " in
  *" get-token "*) echo '{"status":{"token":"k8s-aws-v1.test"}}'; exit 0 ;;
  *" describe-subnets "*)
    echo '{"Subnets":[{"SubnetId":"subnet-0a","VpcId":"vpc-2","AvailabilityZone":"us-east-2a"},{"SubnetId":"subnet-0b","VpcId":"vpc-2","AvailabilityZone":"us-east-2b"}]}'
    exit 0 ;;
esac
if [ -n "\${STUB_AWS_ERROR:-}" ]; then echo "$STUB_AWS_ERROR" >&2; exit 254; fi
printf '%s\\n' "$STUB_CLUSTER"
`,
      // Answers the runner address lookup. The /version probe fails the way a
      // dropped connection does unless STUB_API names the HTTP status the API
      // server answers with.
      curl: `case "$*" in *checkip.amazonaws.com*) echo 203.0.113.9; exit 0 ;; esac
if [ -z "\${STUB_API:-}" ]; then
  echo "curl: (28) Connection timed out after 5002 milliseconds" >&2
  printf 000
  exit 28
fi
printf '%s' "$STUB_API"
`,
      kubectl: `case " $* " in
  *" version "*)
    if [ -n "\${STUB_KUBECTL_VERSION:-}" ]; then echo "$STUB_KUBECTL_VERSION" >&2; exit 1; fi
    echo '{}' ;;
  *" auth can-i "*)
    case "\${STUB_CAN_I:-yes}" in
      yes) echo yes ;;
      no) echo no; exit 1 ;;
      *) echo "$STUB_CAN_I" >&2; exit 1 ;;
    esac ;;
esac
`
    });

    afterAll(() => rmSync(bin, { recursive: true, force: true }));

    // GitHub prints each step's script into the log, and the classifier reads
    // the whole log, so the steps that pass before "Verify EKS Access" count.
    const verifySteps = jobsOf("verify-aws.yml").flatMap(
      ([, job]) => job.steps
    );

    const earlierScripts = verifySteps
      .slice(
        0,
        verifySteps.findIndex((step) => step.name === "Verify EKS Access")
      )
      .flatMap((step) => (step.run ? [`##[group]Run ${step.run}`] : []));

    it.each(PREFLIGHT_CASES)(
      "classifies %s (%s) as %s",
      (_label, code, category, env) => {
        const result = spawnSync(
          "bash",
          [
            fileURLToPath(
              new URL("actions/eks-preflight/eks-preflight.sh", EXTENSION)
            )
          ],
          {
            env: {
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
              AWS_REGION: "us-east-2",
              AWS_EKS_CLUSTER_NAME: "lab",
              STUB_CLUSTER: cluster(),
              ...env
            },
            encoding: "utf8",
            timeout: 20_000
          }
        );

        expect(result.status).toBe(1);
        const output = `${result.stdout}${result.stderr}`;
        expect(output).toContain(`[${code}] `);

        const log = [
          ...earlierScripts,
          '##[group]Run bash "$GITHUB_ACTION_PATH/eks-preflight.sh"',
          output
        ].join("\n");

        expect(
          classifyVerifyFailure({
            failedSteps: [{ name: "Verify EKS Access", conclusion: "failure" }],
            log,
            oidcHelp: "",
            noSubscriptionsHelp: ""
          }).category
        ).toBe(category);
      }
    );
  }
);

describe("deploy steps before the first change to Radius", () => {
  const steps = jobsOf("run-rad-commands-aws.yml").flatMap(
    ([, job]) => job.steps
  );

  const names = steps
    .slice(
      0,
      steps.findIndex(
        (step) => step.name === "Project cloud OIDC tokens into Radius pods"
      )
    )
    .map((step) => step.name ?? "");

  it.each(names)("%s does not hide AWS credential drift", (name) => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "aws",
        resourcesTouched: false,
        failedStepNames: ["Configure AWS Credentials (OIDC)", name]
      })
    ).not.toBe("");
  });
});

// The shared actions keep kubectl's default wait for Azure. The AWS templates
// pass request-timeout so a cluster that stops answering fails in seconds.
describe.skipIf(process.platform === "win32")("request-timeout", () => {
  const actionStep = (action: string, name: string): Step => {
    const step = actionOf(`actions/${action}`).runs.steps.find(
      (candidate) => candidate.name === name
    );

    if (!step) throw new Error(`No step "${name}" in ${action}`);

    return step;
  };

  const root = mkdtempSync(path.join(tmpdir(), "radius-aws-timeout-"));
  const calls = path.join(root, "calls");
  const kubeconfig = path.join(root, "kubeconfig");
  writeFileSync(kubeconfig, "");

  const bin = stubDirectory({
    kubectl: `echo "kubectl $*" >>"$CALLS"
if [ -n "\${STUB_KUBECTL_FAIL:-}" ]; then
  echo "Unable to connect to the server: dial tcp 192.0.2.1:443: i/o timeout" >&2
  exit "$STUB_KUBECTL_FAIL"
fi
`
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const run = (action: string, name: string, env: Record<string, string>) => {
    writeFileSync(calls, "");

    const result = spawnSync(
      "bash",
      ["-e", "-c", actionStep(action, name).run ?? ""],
      {
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          CALLS: calls,
          RADIUS_TARGET_KUBECONFIG: kubeconfig,
          GITHUB_ACTION_PATH: fileURLToPath(
            new URL(`actions/${action}/`, EXTENSION)
          ),
          NAMESPACE: "default",
          APP_FILE: path.join(root, "missing-app.bicep"),
          ...env
        },
        encoding: "utf8",
        timeout: 10_000
      }
    );

    const kubectlCalls = readFileSync(calls, "utf8").trim().split("\n");

    return { ...result, kubectlCalls };
  };

  it.each(AWS_TEMPLATES.filter((file) => file !== "verify-aws.yml"))(
    "%s passes 10s to the shared actions",
    (file) => {
      const uses = jobsOf(file)
        .flatMap(([, job]) => job.steps)
        .filter((step) =>
          /\/actions\/(?:restore-state|run-rad-commands|manage-routes-gateway)@/.test(
            step.uses ?? ""
          )
        );

      expect(uses.length).toBeGreaterThan(0);

      for (const step of uses)
        expect(step.with).toMatchObject({ "request-timeout": "10s" });
    }
  );

  it.each(AWS_TEMPLATES)(
    "%s turns on coded errors in the shared actions",
    (file) => {
      const uses = jobsOf(file)
        .flatMap(([, job]) => job.steps)
        .filter((step) =>
          /\/actions\/(?:restore-state|verify-ghcr-push)@/.test(step.uses ?? "")
        );

      expect(uses.length).toBeGreaterThan(0);

      for (const step of uses)
        expect(step.with).toMatchObject({ "coded-messages": "true" });
    }
  );

  it.each([
    ["restore-state", "Configure Radius workspace", { STUB_KUBECTL_FAIL: "1" }],
    ["run-rad-commands", "Verify app namespace on target cluster", {}]
  ] as const)("%s adds the limit only when set", (action, name, env) => {
    const limited = run(action, name, { ...env, REQUEST_TIMEOUT: "10s" });
    expect(limited.kubectlCalls.length).toBeGreaterThan(0);

    for (const call of limited.kubectlCalls)
      expect(call).toContain("--request-timeout=10s");

    const unlimited = run(action, name, { ...env, REQUEST_TIMEOUT: "" });
    expect(unlimited.kubectlCalls).toEqual(
      limited.kubectlCalls.map((call) =>
        call.replace(" --request-timeout=10s", "")
      )
    );
  });

  it("codes a failed namespace restore only when coded-messages is true", () => {
    const failure = {
      STUB_KUBECTL_FAIL: "3"
    };

    const coded = run("restore-state", "Configure Radius workspace", {
      ...failure,
      CODED_MESSAGES: "true"
    });

    expect(coded.status).toBe(3);
    expect(coded.stdout).toContain(
      "::error title=Radius state was not restored::[STATE_RESTORE_FAILED] Could not create the namespace default on the target cluster."
    );

    const uncoded = run("restore-state", "Configure Radius workspace", {
      ...failure,
      CODED_MESSAGES: "false"
    });

    expect(uncoded.status).toBe(3);
    expect(uncoded.stdout).not.toContain("::error");
  });
});

// "Project cloud OIDC tokens into Radius pods" must stop before it stores a
// token when GitHub does not return one, and must not hide a failed patch.
describe
  .skipIf(process.platform === "win32")
  .each([
    "run-rad-commands-aws.yml",
    "delete-aws.yml",
    "delete-environment-aws.yml"
  ])("%s token projection", (file) => {
  const step = stepNamed(file, "Project cloud OIDC tokens into Radius pods");
  const root = mkdtempSync(path.join(tmpdir(), "radius-aws-project-"));
  const calls = path.join(root, "calls");

  const bin = stubDirectory({
    curl: `echo "curl $*" >>"$CALLS"
case "\${STUB_OIDC:-ok}" in
  ok) echo '{"count":1,"value":"github-oidc-token"}' ;;
  empty) echo '{"message":"Unable to get ACTIONS_ID_TOKEN_REQUEST_URL"}' ;;
  fail) echo "curl: (22) The requested URL returned error: 500" >&2; exit 22 ;;
esac
`,
    kubectl: `echo "kubectl $*" >>"$CALLS"
if [ "$1" = create ]; then echo "secret-yaml"; fi
if [ "$1" = apply ]; then cat >>"$CALLS"; fi
if [ "$1" = patch ] && [ -n "\${STUB_PATCH_FAIL:-}" ]; then
  echo 'The request is invalid: the server rejected our request due to an error in our request' >&2
  exit 1
fi
`
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const run = (env: Record<string, string>) => {
    writeFileSync(calls, "");

    const result = spawnSync("bash", ["-e", "-c", step.run ?? ""], {
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        CALLS: calls,
        AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/radius-deploy",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/request?a=1",
        ...env
      },
      encoding: "utf8",
      timeout: 10_000
    });

    return { ...result, calls: readFileSync(calls, "utf8") };
  };

  it("stores the token, patches the pods, and waits for them", () => {
    const result = run({});
    expect(result.status).toBe(0);
    expect(result.calls).toContain("--connect-timeout 5 --max-time 20");
    expect(result.calls).toContain("--from-literal=token=github-oidc-token");
    expect(result.calls.match(/^kubectl patch /gm)).toHaveLength(3);
    expect(result.calls.match(/^kubectl rollout status /gm)).toHaveLength(4);
  });

  it.each([
    ["a failed token request", "fail"],
    ["a response without a token", "empty"]
  ])("stops on %s before it stores anything", (_label, mode) => {
    const result = run({ STUB_OIDC: mode });
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toMatch(/^kubectl /m);
    expect(result.calls).not.toContain("null");

    if (mode === "empty")
      expect(result.stderr).toContain(
        "GitHub returned no OIDC token for the sts.amazonaws.com audience."
      );
  });

  it("fails when a patch fails", () => {
    const result = run({ STUB_PATCH_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.calls).not.toMatch(/^kubectl rollout status /m);
  });
});
