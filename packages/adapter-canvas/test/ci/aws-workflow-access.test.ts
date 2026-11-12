import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const CONNECTION_ENV_EXPRESSIONS = {
  CLUSTER: "${{ vars.AWS_EKS_CLUSTER_NAME }}",
  REGION: "${{ vars.AWS_REGION }}",
  ENDPOINT: "${{ steps.eks-preflight.outputs.endpoint }}",
  CA_DATA: "${{ steps.eks-preflight.outputs.certificate-authority }}"
};

const CONNECTION_ENV = {
  CLUSTER: "test-cluster",
  REGION: "us-east-2",
  ENDPOINT: "https://eks.example.invalid",
  CA_DATA: "dGVzdA=="
};

async function connectionScript(file: string): Promise<string> {
  const source = await readFile(
    new URL(`../../../../.github/extension/${file}`, import.meta.url),
    "utf8"
  );
  const workflow: unknown = parse(source);
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    !("jobs" in workflow) ||
    typeof workflow.jobs !== "object" ||
    workflow.jobs === null
  )
    throw new Error("Missing workflow jobs");
  const jobs: unknown[] = Object.values(workflow.jobs);
  for (const job of jobs) {
    if (
      typeof job !== "object" ||
      job === null ||
      !("steps" in job) ||
      !Array.isArray(job.steps)
    )
      continue;
    const steps: unknown[] = job.steps;
    for (const step of steps) {
      if (
        typeof step === "object" &&
        step !== null &&
        "name" in step &&
        "run" in step &&
        step.name === "Connect to EKS cluster" &&
        typeof step.run === "string"
      ) {
        expect(step).toHaveProperty("env", CONNECTION_ENV_EXPRESSIONS);

        return step.run;
      }
    }
  }
  throw new Error(`Missing EKS connection step in ${file}`);
}

describe
  .skipIf(process.platform === "win32")
  .each(["run-rad-commands-aws.yml", "delete-aws.yml"])(
  "%s EKS connection commands",
  (file) => {
    it.each(["ready", "cluster-unreachable", "no-preflight-endpoint"])(
      "runs without access administration when %s",
      async (scenario) => {
        const root = await mkdtemp(
          path.join(tmpdir(), "radius-workflow-access-")
        );
        try {
          const log = path.join(root, "calls.jsonl");
          const target = path.join(root, "kubeconfig");
          const shim = `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({tool,args})+"\\n");
if (tool === "aws" && args[0] === "eks" && args[1] === "get-token") {
  console.log(JSON.stringify({status:{token:"workflow-test-token"}}));
} else if (tool === "kubectl" && args[0] === "--kubeconfig" && args.at(-1) === "cluster-info") {
  process.exit(process.env.TEST_SCENARIO === "cluster-unreachable" ? 1 : 0);
} else { console.error("Unscripted command", tool, args); process.exit(97); }
`;
          await Promise.all(
            ["aws", "kubectl"].map((tool) =>
              writeFile(path.join(root, tool), shim, { mode: 0o700 })
            )
          );
          await writeFile(log, "");

          const result = spawnSync(
            "bash",
            ["-e", "-o", "pipefail", "-c", await connectionScript(file)],
            {
              cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
              env: {
                ...CONNECTION_ENV,
                ENDPOINT:
                  scenario === "no-preflight-endpoint" ? "" : (
                    CONNECTION_ENV.ENDPOINT
                  ),
                PATH: `${root}${path.delimiter}${process.env.PATH || ""}`,
                RADIUS_TARGET_KUBECONFIG: target,
                TEST_CALLS: log,
                TEST_SCENARIO: scenario
              },
              encoding: "utf8",
              timeout: 5000
            }
          );
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(scenario === "ready" ? 0 : 1);
          const calls = await readFile(log, "utf8");
          expect(calls).not.toMatch(
            /create-access-entry|associate-access-policy|update-access-entry|delete-access-entry/
          );

          if (scenario === "no-preflight-endpoint") {
            expect(calls).toBe("");
          } else {
            expect(calls).toContain('"cluster-info"');
            expect(parse(await readFile(target, "utf8"))).toMatchObject({
              users: [{ user: { token: "workflow-test-token" } }],
              clusters: [{ cluster: { server: "https://eks.example.invalid" } }]
            });
          }

          if (scenario === "cluster-unreachable")
            expect(result.stdout).toContain(
              "::error title=EKS API server unreachable::[EKS_ENDPOINT_UNREACHABLE]"
            );

          if (scenario === "no-preflight-endpoint")
            expect(result.stdout).toContain(
              "::error title=Preflight script error::[PREFLIGHT_ERROR]"
            );
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    );
  }
);
