import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    model: { type: "string", multiple: true },
    case: { type: "string" },
    "guidance-ref": { type: "string" },
    list: { type: "boolean", default: false }
  }
});
const output = join(root, ".artifacts", "agent-modeling");
await mkdir(output, { recursive: true });
const runDirectory = await mkdtemp(join(output, "run-"));
try {
  const guidanceCommit = execFileSync(
    "git",
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${values["guidance-ref"] ?? "HEAD"}^{commit}`
    ],
    { cwd: root, encoding: "utf8" }
  ).trim();
  const entry = join(
    root,
    "packages",
    "adapter-canvas",
    "test",
    "support",
    "agent-eval"
  );
  const bundle = join(runDirectory, "evaluation.mjs");
  const historical = (path) =>
    execFileSync("git", ["show", `${guidanceCommit}:${path}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
  await build({
    stdin: {
      contents:
        'export { MODELING_CASES } from "./modeling-cases.js"; export { createModelingEvaluation } from "./modeling-evaluation.js"; export { startEvaluationServer } from "./mcp-server.js"; export { evaluationMatrix, agentArguments } from "./agent-runner.js";',
      resolveDir: entry,
      sourcefile: "evaluation.ts"
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins:
      values["guidance-ref"] ?
        [
          {
            name: "historical-handoff",
            setup(builder) {
              builder.onLoad(
                // esbuild's Go regex engine does not accept the Unicode flag.
                { filter: /[/\\]runtime[/\\]hooks\.ts$/ },
                () => ({
                  contents: historical(
                    "packages/adapter-canvas/src/runtime/hooks.ts"
                  ),
                  loader: "ts"
                })
              );
            }
          }
        ]
      : []
  });
  const {
    MODELING_CASES,
    createModelingEvaluation,
    startEvaluationServer,
    evaluationMatrix,
    agentArguments
  } = await import(pathToFileURL(bundle).href);
  if (values.list) {
    for (const testCase of MODELING_CASES) {
      console.log(
        `${testCase.id}: ${testCase.expected.status}/${testCase.expected.blocker}`
      );
    }
  } else {
    if (!values.cli || !isAbsolute(values.cli)) {
      throw new Error(
        "--cli must be the absolute path to a native Copilot executable."
      );
    }
    const matrix = evaluationMatrix(MODELING_CASES, values.model, values.case);
    const guidanceFile = async (relativePath) =>
      values["guidance-ref"] ?
        historical(relativePath.replaceAll("\\", "/"))
      : readFile(join(root, relativePath), "utf8");
    const skillBase = "extensions/radius/skills/radius-app-bicep";
    const guidance = {
      skill: await guidanceFile(`${skillBase}/SKILL.md`),
      runtimeContract: await guidanceFile(
        `${skillBase}/references/runtime-contract.md`
      )
    };
    const guidanceHash = createHash("sha256")
      .update(guidance.skill)
      .update(guidance.runtimeContract)
      .digest("hex");
    const results = [];
    for (const { model, testCase, artifactId: caseId } of matrix) {
      const workspace = join(runDirectory, caseId);
      await mkdir(workspace);
      const evaluation = createModelingEvaluation(
        testCase,
        root,
        workspace,
        guidance
      );
      const server = await startEvaluationServer(evaluation);
      const started = Date.now();
      let stdout = "";
      let stderr = "";
      let failure;
      try {
        const ready = await fetch(server.url, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "readiness",
            method: "ping"
          })
        });
        if (!ready.ok || !(await ready.json()).result) {
          throw new Error("Evaluation MCP server failed its readiness check.");
        }
        const result = await promisify(execFile)(
          values.cli,
          agentArguments(evaluation.prompt, server.url, model),
          {
            cwd: workspace,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, COPILOT_AUTO_UPDATE: "false" }
          }
        );
        stdout = result.stdout;
        stderr = result.stderr;
        evaluation.assertExpected();
      } catch (error) {
        if (error && typeof error === "object") {
          stdout = typeof error.stdout === "string" ? error.stdout : stdout;
          stderr = typeof error.stderr === "string" ? error.stderr : stderr;
        }
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        await server.close();
      }
      const record = {
        model: model ?? "CLI default",
        guidanceCommit,
        guidanceHash,
        case: testCase.id,
        durationMs: Date.now() - started,
        passed: !failure,
        expected: testCase.expected,
        calls: evaluation.calls,
        failure,
        stdout,
        stderr
      };
      results.push(record);
      await writeFile(
        join(runDirectory, `${caseId}.json`),
        `${JSON.stringify(record, null, 2)}\n`
      );
      console.log(
        `${record.passed ? "PASS" : "FAIL"} ${record.model} / ${testCase.id}${failure ? `: ${failure}` : ""}`
      );
    }
    await writeFile(
      join(runDirectory, "summary.json"),
      `${JSON.stringify(
        {
          models: [
            ...new Set(matrix.map((entry) => entry.model ?? "CLI default"))
          ],
          guidanceRef: values["guidance-ref"] ?? "working tree",
          guidanceCommit,
          guidanceHash,
          results
        },
        null,
        2
      )}\n`
    );
    console.log(`Evaluation evidence: ${runDirectory}`);
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  }
} finally {
  await rm(join(runDirectory, "evaluation.mjs"), { force: true });
}
