import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  DATASET_PROMPT,
  MODELING_SKILL,
  cliVersionOf,
  collectEvidence,
  copilotArgs,
  ifMissing,
  isInside,
  modelingEnvironment,
  outcomeFailure,
  parseRunOptions,
  summaryMarkdown,
  writeSummary
} from "../../../../scripts/copilot-cli-modeling/run-modeling.mjs";
import { parseCaseYaml } from "../../../../scripts/copilot-cli-modeling/sample.mjs";
import { hashAppBicep } from "../../src/app-bicep-hash.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

const HARNESS_DIR = path.join(
  REPOSITORY_ROOT,
  "scripts",
  "copilot-cli-modeling"
);

const CASES_DIR = path.join(HARNESS_DIR, "cases");

/** A value that the tests seed as a secret. It is not shaped like a token. */
const SECRET = "seeded-secret-value";

/** The `app.origin.json` that the skill writes when it publishes `model`. */
const origin = (model) => JSON.stringify({ appBicepHash: hashAppBicep(model) });

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "copilot-cli-modeling-"));
  temporaryDirectories.push(directory);

  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("run options", () => {
  const argv = [
    "--case",
    "/t/case.yaml",
    "--work-dir",
    "/t/work",
    "--output-dir",
    "/t/out"
  ];

  const env = { COPILOT_GITHUB_TOKEN: "ghs_x" };

  it("uses the CLI's default model and effort and a home inside the work directory", () => {
    expect(parseRunOptions(argv, env)).toMatchObject({
      model: undefined,
      reasoningEffort: undefined,
      token: "ghs_x",
      home: path.join(path.resolve("/t/work"), "home")
    });
    expect(
      parseRunOptions([...argv, "--model", " ", "--reasoning-effort", " "], env)
    ).toMatchObject({ model: undefined, reasoningEffort: undefined });
  });

  it("reads the requested model and reasoning effort", () => {
    expect(
      parseRunOptions(
        [...argv, "--model", " gpt-6.1-sol ", "--reasoning-effort", " medium "],
        env
      )
    ).toMatchObject({ model: "gpt-6.1-sol", reasoningEffort: "medium" });
  });

  it.each([
    ["no token", argv, {}, /COPILOT_GITHUB_TOKEN/],
    [
      "nested directories",
      ["--case", "c", "--work-dir", "/t", "--output-dir", "/t/out"],
      env,
      /separate/
    ],
    ["a missing case", argv.slice(2), env, /--case/],
    ["an unknown option", [...argv, "--prompt", "x"], env, /--prompt/]
  ])("rejects %s", (_name, args, runEnv, message) => {
    expect(() => parseRunOptions(args, runEnv)).toThrow(message);
  });

  it("keeps secrets and the runner's configuration away from the CLI", () => {
    const cliEnv = modelingEnvironment(
      {
        PATH: "/usr/bin",
        CI: "true",
        HOME: "/home/runner",
        XDG_CONFIG_HOME: "/home/runner/.config",
        COPILOT_GITHUB_TOKEN: "ghs_x",
        GITHUB_TOKEN: "ghs_x",
        GH_TOKEN: "x",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
        AZURE_CLIENT_SECRET: "x",
        npm_config_password: "x"
      },
      "/t/work/home"
    );

    expect(cliEnv).toMatchObject({
      PATH: "/usr/bin",
      CI: "true",
      HOME: "/t/work/home",
      XDG_CONFIG_HOME: path.join("/t/work/home", ".config"),
      COPILOT_AUTO_UPDATE: "false"
    });

    for (const name of [
      "COPILOT_GITHUB_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "AZURE_CLIENT_SECRET",
      "npm_config_password"
    ])
      expect(cliEnv).not.toHaveProperty(name);
  });

  it("runs the CLI with the app's session settings", () => {
    expect(
      copilotArgs({
        model: "model-a",
        reasoningEffort: "medium",
        logDir: "/t/logs"
      })
    ).toEqual([
      "--prompt",
      DATASET_PROMPT,
      "--model",
      "model-a",
      "--reasoning-effort",
      "medium",
      "--autopilot",
      "--allow-all",
      "--experimental",
      "--no-auto-update",
      "--secret-env-vars=COPILOT_GITHUB_TOKEN",
      "--log-dir",
      "/t/logs"
    ]);
    const defaults = copilotArgs({
      model: undefined,
      reasoningEffort: undefined,
      logDir: "/t/logs"
    });
    expect(defaults).not.toContain("--model");
    expect(defaults).not.toContain("--reasoning-effort");
  });

  it("checks containment by path segment", () => {
    expect(isInside("/t/work", "/t/work/home")).toBe(true);
    expect(isInside("/t/work", "/t/work")).toBe(false);
    expect(isInside("/t/work", "/t/workspace")).toBe(false);
    expect(isInside("/t/work", "/t")).toBe(false);
  });

  it("reads the version from the CLI's --version output", () => {
    expect(
      cliVersionOf(
        "GitHub Copilot CLI 1.0.99-2.\nRun 'copilot update' to check for updates."
      )
    ).toBe("1.0.99-2");
    expect(cliVersionOf("GitHub Copilot CLI 1.0.103.")).toBe("1.0.103");
    expect(cliVersionOf("no version")).toBeUndefined();
  });

  const summary = {
    result: "succeeded",
    repo: "https://github.com/sosedoff/pgweb",
    commit: "c".repeat(40),
    samplePath: undefined,
    prompt: DATASET_PROMPT,
    cliVersion: "1.0.99-2",
    requestedModel: "model-a",
    requestedReasoningEffort: "medium",
    sessionId: "s1",
    models: ["model-a"],
    skills: ["radius-app-bicep"],
    tools: { view: 2, bash: 1 },
    usage: {
      calls: 3,
      inputTokens: 49501,
      outputTokens: 47,
      cacheReadTokens: 32884,
      cacheWriteTokens: 16608,
      reasoningTokens: 0,
      apiDurationMs: 4556
    },
    finalReply: "Done.",
    appBicepWritten: true,
    sessionDurationSeconds: 59,
    durationSeconds: 3725
  };

  it("renders the step summary with the CLI version, model, and app.bicep", () => {
    const markdown = summaryMarkdown(summary, "extension radius\n");
    expect(markdown).toContain("| Result | succeeded |");
    expect(markdown).toContain(`| Prompt | ${DATASET_PROMPT} |`);
    expect(markdown).toContain("| Copilot CLI | 1.0.99-2 |");
    expect(markdown).toContain("| Requested model | model-a |");
    expect(markdown).toContain("| Requested reasoning effort | medium |");
    expect(markdown).toContain("| Tools | bash (1), view (2) |");
    expect(markdown).toContain("| app.bicep | written |");
    expect(markdown).toContain("| Model calls | 3 |");
    expect(markdown).toContain(
      "| Tokens | 49,501 input (32,884 cache read, 16,608 cache write), 47 output (0 reasoning) |"
    );
    expect(markdown).toContain("| Model API time | 5 s |");
    expect(markdown).toContain("| Session duration | 59 s |");
    expect(markdown).toContain("| Total duration | 1 h 2 min 5 s |");
    expect(markdown).toContain("```bicep\nextension radius\n```");
    expect(markdown).not.toContain("last reply");
  });

  it("shows the failure and the agent's last reply when app.bicep is missing", () => {
    const markdown = summaryMarkdown(
      {
        ...summary,
        result: "failed",
        failure: "a | b",
        cliVersion: undefined,
        requestedModel: undefined,
        requestedReasoningEffort: undefined,
        usage: undefined,
        finalReply: "I could not\nfinish.",
        appBicepWritten: false,
        sessionDurationSeconds: undefined,
        durationSeconds: 120
      },
      undefined
    );

    expect(markdown).toContain("| Result | failed: a \\| b |");
    expect(markdown).toContain("| Copilot CLI | unknown |");
    expect(markdown).toContain("| Requested model | CLI default |");
    expect(markdown).toContain("| Requested reasoning effort | CLI default |");
    expect(markdown).toContain("| app.bicep | missing |");
    expect(markdown).toContain("| Model calls | unknown |");
    expect(markdown).toContain("| Tokens | unknown |");
    expect(markdown).toContain("| Model API time | unknown |");
    expect(markdown).toContain("| Session duration | unknown |");
    expect(markdown).toContain("| Total duration | 2 min 0 s |");
    expect(markdown).toContain("> I could not\n> finish.");
  });
});

describe("the pass rule", () => {
  const PLUGIN_SKILL = `radius:${MODELING_SKILL}`;

  const session = (skills, state = { kind: "completed" }) => ({
    state,
    models: [],
    skills,
    tools: {},
    finalReply: undefined
  });

  // The origin hash covers the normalized model, so line endings and trailing
  // spaces do not change it.
  const appBicep = "extension radius  \r\nparam environment string\r\n";
  const published = { appBicep, appOrigin: origin(appBicep) };

  it("passes when the agent loads the plugin's skill and publishes app.bicep", () => {
    expect(
      outcomeFailure({
        session: session(["git-commit", PLUGIN_SKILL]),
        ...published
      })
    ).toBeUndefined();
  });

  it.each([
    ["no skill", []],
    ["only other skills", ["git-commit"]],
    ["a skill with the same name from the project", [MODELING_SKILL]],
    ["the same skill name from another plugin", ["other:radius-app-bicep"]]
  ])("fails when the agent writes app.bicep but loads %s", (_name, skills) => {
    expect(outcomeFailure({ session: session(skills), ...published })).toBe(
      "The agent wrote .radius/app.bicep without loading the radius-app-bicep skill from the radius plugin."
    );
  });

  it("fails when app.bicep is empty", () => {
    expect(
      outcomeFailure({
        session: session([PLUGIN_SKILL]),
        appBicep: " \n",
        appOrigin: origin(" \n")
      })
    ).toBe("The agent wrote an empty .radius/app.bicep.");
  });

  it.each([
    ["is missing", undefined],
    ["is not JSON", "{"],
    ["has no hash", "{}"],
    ["describes another model", origin("extension other")]
  ])("fails when app.origin.json %s", (_name, appOrigin) => {
    expect(
      outcomeFailure({ session: session([PLUGIN_SKILL]), appBicep, appOrigin })
    ).toBe(
      "The agent wrote .radius/app.bicep without a matching .radius/app.origin.json, so the radius-app-bicep skill did not publish it."
    );
  });

  it("fails when the run finds no session events to check", () => {
    expect(outcomeFailure({ session: undefined, ...published })).toBe(
      "The run found no session events, so it cannot tell whether the agent loaded the radius-app-bicep skill."
    );
  });

  it.each([
    ["a session", session([])],
    ["no session events", undefined]
  ])(
    "reports a missing app.bicep before a missing skill, with %s",
    (_name, summary) => {
      expect(
        outcomeFailure({
          session: summary,
          appBicep: undefined,
          appOrigin: undefined
        })
      ).toBe("The agent finished without writing .radius/app.bicep.");
    }
  );

  it("reports a session error first", () => {
    expect(
      outcomeFailure({
        session: session([PLUGIN_SKILL], {
          kind: "failed",
          error: "Quota exceeded"
        }),
        ...published
      })
    ).toBe("The session failed: Quota exceeded");
  });
});

describe("ifMissing", () => {
  const failure = (code) =>
    Promise.reject(Object.assign(new Error(code), { code }));

  it("returns the fallback only when the path does not exist", async () => {
    expect(await ifMissing(failure("ENOENT"), [])).toEqual([]);
    expect(await ifMissing(failure("ENOTDIR"), undefined)).toBeUndefined();
    expect(await ifMissing(Promise.resolve("value"), "")).toBe("value");
    await expect(ifMissing(failure("EACCES"), [])).rejects.toThrow("EACCES");
  });
});

describe("the run output", () => {
  it("copies the evidence with secrets removed and skips symbolic links", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const sessionDir = path.join(home, ".copilot", "session-state", "s1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "events.jsonl"),
      `${JSON.stringify({
        type: "skill.invoked",
        data: { name: MODELING_SKILL, pluginName: "radius", note: SECRET }
      })}\n`
    );
    const logDir = path.join(root, "logs");
    await mkdir(logDir);
    await writeFile(path.join(logDir, "copilot-output.log"), `log ${SECRET}\n`);
    const sample = path.join(root, "sample");
    const radiusDir = path.join(sample, ".radius");
    await mkdir(path.join(radiusDir, "types"), { recursive: true });
    const model = `extension radius // ${SECRET}\n`;
    await writeFile(path.join(radiusDir, "app.bicep"), model);
    await writeFile(path.join(radiusDir, "app.origin.json"), origin(model));
    await writeFile(path.join(radiusDir, "types", "t.yaml"), SECRET);
    await writeFile(path.join(root, "outside.txt"), SECRET);
    await symlink(
      path.join(root, "outside.txt"),
      path.join(radiusDir, "link.txt")
    );
    const outputDir = path.join(root, "out");

    const evidence = await collectEvidence({
      home,
      outputDir,
      logDir,
      root: sample,
      secrets: [SECRET]
    });

    expect(evidence).toMatchObject({
      sessionId: "s1",
      session: { skills: [`radius:${MODELING_SKILL}`] },
      appBicep: model,
      appOrigin: origin(model)
    });
    expect((await readdir(outputDir, { recursive: true })).sort()).toEqual(
      [
        "logs",
        "logs/copilot-output.log",
        "radius",
        "radius/app.bicep",
        "radius/app.origin.json",
        "radius/types",
        "radius/types/t.yaml",
        "session-events.jsonl"
      ].map((name) => name.split("/").join(path.sep))
    );

    for (const file of [
      "session-events.jsonl",
      "logs/copilot-output.log",
      "radius/app.bicep",
      "radius/types/t.yaml"
    ])
      expect(await readFile(path.join(outputDir, file), "utf8")).toContain(
        "[REDACTED]"
      );
  });

  it("finds no evidence in an empty home", async () => {
    const root = await temporaryDirectory();

    expect(
      await collectEvidence({
        home: path.join(root, "home"),
        outputDir: path.join(root, "out"),
        logDir: path.join(root, "logs"),
        root: undefined,
        secrets: []
      })
    ).toEqual({
      sessionId: undefined,
      session: undefined,
      appBicep: undefined,
      appOrigin: undefined
    });
  });

  it("writes the summary files and the step summary with secrets removed", async () => {
    const outputDir = await temporaryDirectory();
    const stepSummaryFile = path.join(outputDir, "step-summary.md");
    await writeFile(stepSummaryFile, "earlier\n");

    await writeSummary({
      outputDir,
      summary: {
        result: "failed",
        failure: `stopped at ${SECRET}`,
        repo: "https://github.com/sosedoff/pgweb",
        commit: "c".repeat(40),
        prompt: DATASET_PROMPT,
        models: [],
        skills: [],
        tools: {},
        finalReply: `I saw ${SECRET}.`,
        appBicepWritten: true,
        durationSeconds: 1
      },
      appBicep: `// ${SECRET}\n`,
      secrets: [SECRET],
      stepSummaryFile
    });

    const files = ["summary.json", "summary.md", "step-summary.md"];

    for (const file of files) {
      const text = await readFile(path.join(outputDir, file), "utf8");
      expect(text, file).not.toContain(SECRET);
      expect(text, file).toContain("[REDACTED]");
    }

    expect(
      JSON.parse(await readFile(path.join(outputDir, "summary.json"), "utf8"))
    ).toMatchObject({ finalReply: "I saw [REDACTED]." });
    expect(await readFile(stepSummaryFile, "utf8")).toMatch(
      /^earlier\n## Copilot CLI modeling run/
    );
  });
});

describe("the Copilot CLI Modeling workflow", () => {
  const workflowFile = path.join(
    REPOSITORY_ROOT,
    ".github",
    "workflows",
    "copilot-cli-modeling.yml"
  );

  const load = async () => parse(await readFile(workflowFile, "utf8"));

  const allSteps = (workflow) =>
    Object.values(workflow.jobs).flatMap((job) => job.steps);

  const step = (job, name) =>
    job.steps.find((candidate) => candidate.name === name);

  it("runs daily and by hand, with no default token permissions", async () => {
    const workflow = await load();
    expect(Object.keys(workflow.on)).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.model.permissions).toEqual({
      contents: "read",
      "copilot-requests": "write"
    });
    expect(workflow.jobs["notify-scheduled-result"].permissions).toEqual({
      issues: "write"
    });
  });

  it("gives each case a model, and a manual run can choose one for every case", async () => {
    const workflow = await load();
    expect(workflow.on.workflow_dispatch.inputs.model).toMatchObject({
      type: "string",
      default: ""
    });
    expect(workflow.jobs.model.env.MODEL).toBe(
      "${{ inputs.model || matrix.model }}"
    );

    for (const entry of workflow.jobs.model.strategy.matrix.include)
      expect(entry.model).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });

  it("passes the reasoning effort explicitly, and a manual run can choose any CLI level", async () => {
    const workflow = await load();
    const input = workflow.on.workflow_dispatch.inputs["reasoning-effort"];
    expect(input).toMatchObject({ type: "choice", default: "medium" });
    expect(input.options).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max"
    ]);
    expect(workflow.env.REASONING_EFFORT).toBe(
      `\${{ inputs.reasoning-effort || '${input.default}' }}`
    );
    expect(
      step(workflow.jobs.model, "Model the sample with Copilot CLI").run
    ).toContain('--reasoning-effort "$REASONING_EFFORT"');
  });

  it("runs every case in its own job, and one failure does not cancel another", async () => {
    const strategy = (await load()).jobs.model.strategy;
    expect(strategy["fail-fast"]).toBe(false);
    expect(strategy.matrix.include.map((entry) => entry.case).sort()).toEqual(
      (await readdir(CASES_DIR)).sort()
    );
  });

  it("restores no dependency cache, because the agent runs sample code with every permission", async () => {
    const steps = (await load()).jobs.model.steps;

    for (const candidate of steps)
      expect(candidate.with?.cache, candidate.name).toBeUndefined();

    const setupNode = steps.find((candidate) =>
      candidate.uses?.startsWith("actions/setup-node@")
    );

    expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
  });

  it("pins every action to a commit and does not keep checkout credentials", async () => {
    const steps = allSteps(await load());

    for (const candidate of steps)
      if (candidate.uses)
        expect(candidate.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);

    const checkout = steps.find((candidate) =>
      candidate.uses?.startsWith("actions/checkout@")
    );

    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("passes inputs and tokens to scripts only through the environment", async () => {
    for (const candidate of allSteps(await load()))
      if (candidate.run) expect(candidate.run).not.toMatch(/\$\{\{/);
  });

  it("uses no secrets and gives the workflow token only to the modeling step", async () => {
    expect(await readFile(workflowFile, "utf8")).not.toContain("secrets.");

    const holders = (await load()).jobs.model.steps.filter((candidate) =>
      Object.values(candidate.env ?? {}).some((value) =>
        value.includes("github.token")
      )
    );

    expect(holders).toMatchObject([
      {
        name: "Model the sample with Copilot CLI",
        env: { COPILOT_GITHUB_TOKEN: "${{ github.token }}" },
        run: expect.stringContaining(
          "scripts/copilot-cli-modeling/run-modeling.mjs"
        )
      }
    ]);
  });

  it("installs the Copilot CLI version that the README documents", async () => {
    const install = step((await load()).jobs.model, "Install Copilot CLI");
    const version = /^@github\/copilot@(\d+\.\d+\.\d+(?:-\d+)?)$/.exec(
      install.env.CLI_PACKAGE
    )?.[1];

    expect(version).toBeDefined();
    expect(install.run).toContain(
      'npm install --global --no-audit --no-fund "$CLI_PACKAGE"'
    );

    const readme = await readFile(path.join(HARNESS_DIR, "README.md"), "utf8");
    expect(readme).toContain(`npm install --global @github/copilot@${version}`);
    expect(/^\| CLI version +\| `([^`]+)`/m.exec(readme)?.[1]).toBe(version);
  });

  it("uploads each case's output even when a step fails or times out", async () => {
    const job = (await load()).jobs.model;

    const upload = job.steps.find((candidate) =>
      candidate.uses?.startsWith("actions/upload-artifact@")
    );

    expect(upload?.if).toBe("always()");
    expect(upload?.with?.name).toContain("${{ matrix.case }}");
    const install = step(job, "Install Copilot CLI")["timeout-minutes"];
    const modeling = step(job, "Model the sample with Copilot CLI")[
      "timeout-minutes"
    ];
    // The harness stops the session after 30 minutes and must give up before
    // the step does. The job outlasts both steps, so the upload runs.
    expect(modeling).toBeGreaterThan(30);
    expect(job["timeout-minutes"]).toBeGreaterThan(install + modeling);
  });
});

describe("the modeling cases", () => {
  it("has only case files that parse, so no expected model is public", async () => {
    const names = await readdir(CASES_DIR);
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      // The workflow uses the name in the case path and the artifact name.
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,99}$/);
      expect(await readdir(path.join(CASES_DIR, name))).toEqual(["case.yaml"]);

      const text = await readFile(
        path.join(CASES_DIR, name, "case.yaml"),
        "utf8"
      );

      expect(() => parseCaseYaml(text), name).not.toThrow();
    }
  });
});
