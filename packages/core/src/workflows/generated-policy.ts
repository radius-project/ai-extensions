import {
  DEPLOY_AWS_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE
} from "./deploy.js";
import { DELETE_AWS_FILE, DELETE_ENV_AWS_FILE } from "./delete.js";
import { VERIFY_OPERATION_INPUT } from "../setup-verification-plan.js";

export type GeneratedWorkflowArtifact = "verify" | "dispatcher" | "provider";

const awsFiles = new Set([
  DEPLOY_AWS_FILE,
  DELETE_AWS_FILE,
  DELETE_ENV_AWS_FILE
]);
const unsafeTriggers = new Set([
  "pull_request",
  "pull_request_target",
  "workflow_run",
  "schedule"
]);

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsWorkflowReference(value: unknown, fileName: string): boolean {
  if (Array.isArray(value))
    return value.some((child) => containsWorkflowReference(child, fileName));
  if (!isMapping(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (key === "uses" && child === `./.github/workflows/${fileName}`) ||
      containsWorkflowReference(child, fileName)
  );
}

export function assertTrustedGeneratedWorkflow(
  parse: (source: string) => unknown,
  workflow: string,
  artifact: GeneratedWorkflowArtifact,
  context: string,
  expectedProviderWorkflows: readonly string[] = []
): void {
  let parsed: unknown;
  try {
    parsed = parse(workflow);
  } catch (error) {
    throw new Error(
      `Generated ${context} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const fail = (reason: string): never => {
    throw new Error(`Generated ${context} failed trust validation: ${reason}`);
  };
  const requireMapping = (
    value: unknown,
    reason: string
  ): Record<string, unknown> => (isMapping(value) ? value : fail(reason));
  const document = requireMapping(
    parsed,
    "the document root must be a mapping."
  );
  if (/(?<!\$)\{\{[^{}]+\}\}/u.test(workflow))
    fail("an unresolved {{...}} template placeholder remains.");
  const triggers = requireMapping(
    document.on,
    "`on` must be a trigger mapping."
  );
  const triggerNames = Object.keys(triggers);
  const unsafeTrigger = triggerNames.find((trigger) =>
    unsafeTriggers.has(trigger)
  );
  if (unsafeTrigger)
    fail(`unsafe automatic trigger \`${unsafeTrigger}\` is not allowed.`);
  const jobs = requireMapping(document.jobs, "`jobs` must be a mapping.");
  if (Object.keys(jobs).length === 0)
    fail("`jobs` must be a non-empty mapping.");

  if (artifact === "provider") {
    if (triggerNames.length !== 1 || triggerNames[0] !== "workflow_call")
      fail("the reusable `workflow_call` trigger must be the only trigger.");
    const call = requireMapping(
      triggers.workflow_call,
      "`on.workflow_call` must be a mapping."
    );
    const inputs = requireMapping(
      call.inputs,
      "`on.workflow_call.inputs` must be a mapping."
    );
    if (!Object.hasOwn(inputs, "environment") || !isMapping(inputs.environment))
      fail("workflow call input `environment` is required.");
    return;
  }
  if (artifact === "dispatcher") {
    if (triggerNames.length !== 1 || triggerNames[0] !== "workflow_dispatch")
      fail("the workflow must be triggered only by `workflow_dispatch`.");
    const dispatch = requireMapping(
      triggers.workflow_dispatch,
      "`on.workflow_dispatch` must be a mapping."
    );
    const inputs = requireMapping(
      dispatch.inputs,
      "`on.workflow_dispatch.inputs` must be a mapping."
    );
    if (!Object.hasOwn(inputs, "environment") || !isMapping(inputs.environment))
      fail("workflow dispatch input `environment` is required.");
    if (
      !expectedProviderWorkflows.some((file) => awsFiles.has(file)) &&
      (Object.keys(jobs).some((job) => job.toLowerCase() === "aws") ||
        [...awsFiles].some((file) => containsWorkflowReference(jobs, file)))
    ) {
      fail("the dispatcher must not contain an AWS job or workflow reference.");
    }
    for (const file of expectedProviderWorkflows) {
      if (!containsWorkflowReference(jobs, file))
        fail(`the dispatcher must invoke \`./.github/workflows/${file}\`.`);
    }
    return;
  }

  const verifyTriggers = new Set(triggerNames);
  if (
    !verifyTriggers.has("workflow_dispatch") ||
    [...verifyTriggers].some(
      (trigger) => trigger !== "workflow_dispatch" && trigger !== "push"
    )
  ) {
    fail(
      "the verify workflow may only use `workflow_dispatch` and the constrained setup-branch `push` trigger."
    );
  }
  if (verifyTriggers.has("push")) {
    const push = requireMapping(triggers.push, "`on.push` must be a mapping.");
    if (
      !Array.isArray(push.branches) ||
      push.branches.length !== 1 ||
      push.branches[0] !== "radius/setup-**" ||
      !Array.isArray(push.paths) ||
      push.paths.length !== 1 ||
      push.paths[0] !== ".github/workflows/radius-verify-credentials.yml"
    ) {
      fail(
        "the push trigger must be limited to `radius/setup-**` and the generated verify workflow path."
      );
    }
  }
  const dispatch = requireMapping(
    triggers.workflow_dispatch,
    "`on.workflow_dispatch` must be a mapping."
  );
  const inputs = requireMapping(
    dispatch.inputs,
    "`on.workflow_dispatch.inputs` must be a mapping."
  );
  for (const input of ["environment", VERIFY_OPERATION_INPUT]) {
    if (!Object.hasOwn(inputs, input) || !isMapping(inputs[input]))
      fail(`workflow dispatch input \`${input}\` is required.`);
  }
  const runName = document["run-name"];
  if (
    typeof runName !== "string" ||
    !runName.includes("${{ inputs.environment ||") ||
    !runName.includes(`\${{ inputs.${VERIFY_OPERATION_INPUT} ||`)
  ) {
    fail(
      "the marker-bearing `run-name` must include the environment and Radius operation inputs."
    );
  }
  const trustedProbe = Object.values(jobs).some(
    (job) =>
      isMapping(job) &&
      Array.isArray(job.steps) &&
      job.steps.some(
        (step) =>
          isMapping(step) &&
          step.name === "Verify GHCR package push permission" &&
          isMapping(step.env) &&
          step.env.GHCR_TOKEN === "${{ secrets.GITHUB_TOKEN }}" &&
          typeof step.run === "string" &&
          step.run.includes("/blobs/uploads/")
      )
  );
  if (!trustedProbe)
    fail("the trusted non-mutating GHCR push-permission probe is required.");
}

export function deployWorkflowFiles(includeAws: boolean): string[] {
  return includeAws ?
      [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE]
    : [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
}

export function stripAwsDispatcherJob(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^  aws:\s*$/.test(line));
  if (start === -1) return yaml;
  let from = start;
  while (from > 0 && /^  #/.test(lines[from - 1])) from--;
  if (from > 0 && lines[from - 1].trim() === "") from--;
  let to = start + 1;
  while (
    to < lines.length &&
    !/^  \S/.test(lines[to]) &&
    !/^\S/.test(lines[to])
  )
    to++;
  lines.splice(from, to - from);
  return lines.join("\n");
}

export function stripWorkflowRunTrigger(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^  workflow_run:\s*$/.test(line));
  if (start === -1) return yaml;
  let from = start;
  while (from > 0 && /^  #/.test(lines[from - 1])) from--;
  let to = start + 1;
  while (
    to < lines.length &&
    (/^    /.test(lines[to]) || lines[to].trim() === "")
  ) {
    if (
      lines[to].trim() === "" &&
      !(to + 1 < lines.length && /^    /.test(lines[to + 1]))
    )
      break;
    to++;
  }
  lines.splice(from, to - from);
  return lines.join("\n");
}
