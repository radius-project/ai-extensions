import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
        return step.run
          .replaceAll("${{ vars.AWS_EKS_CLUSTER_NAME }}", "test-cluster")
          .replaceAll("${{ vars.AWS_REGION }}", "us-east-2");
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
    it.each(["ready", "access-missing", "discovery-denied"])(
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
if (tool === "aws" && args[0] === "eks" && args[1] === "describe-cluster") {
  if (process.env.TEST_SCENARIO === "discovery-denied") process.exit(1);
  console.log(args.includes("cluster.endpoint") ? "https://eks.example.invalid" : "dGVzdA==");
} else if (tool === "aws" && args[0] === "eks" && args[1] === "get-token") {
  console.log(JSON.stringify({status:{token:"workflow-test-token"}}));
} else if (tool === "kubectl" && args[0] === "--kubeconfig" && args[2] === "cluster-info") {
  process.exit(process.env.TEST_SCENARIO === "access-missing" ? 1 : 0);
} else { console.error("Unscripted command", tool, args); process.exit(97); }
`;
          await Promise.all(
            ["aws", "kubectl"].map((tool) =>
              writeFile(path.join(root, tool), shim, { mode: 0o700 })
            )
          );
          const result = spawnSync(
            "bash",
            ["-e", "-o", "pipefail", "-c", await connectionScript(file)],
            {
              cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
              env: {
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
          if (scenario === "discovery-denied") {
            expect(calls.trim().split("\n")).toHaveLength(1);
          } else {
            expect(calls).toContain('"cluster-info"');
            expect(parse(await readFile(target, "utf8"))).toMatchObject({
              users: [{ user: { token: "workflow-test-token" } }],
              clusters: [{ cluster: { server: "https://eks.example.invalid" } }]
            });
          }
          if (scenario === "access-missing")
            expect(result.stdout).toContain("rerun environment setup");
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    );
  }
);
