// Runs Copilot CLI on one case from `cases/` with the Radius plugin built
// from this checkout. It sends the dataset prompt and checks that the agent
// loads the `radius-app-bicep` skill and publishes `.radius/app.bicep`.
//
// The CLI runs with the settings that the GitHub Copilot app uses: the CLI
// version that the app bundles, Autopilot, and all permissions allowed. See
// README.md.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { isMainModule } from "../module-entry.mjs";
import {
  PLUGIN_NAME,
  PLUGIN_SOURCE,
  stageMarketplace
} from "./marketplace.mjs";
import { isJsonObject, parseJson } from "./json.mjs";
import {
  BINARY_WITH_SECRET,
  copyRedacted,
  copyRedactedDirectory,
  redactSecrets
} from "./redact.mjs";
import { retry } from "./retry.mjs";
import {
  checkoutCommands,
  excludeTargets,
  parseCaseYaml,
  repositoryName,
  sessionRoot
} from "./sample.mjs";
import { summarizeSessionEvents } from "./session.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** The dataset prompt. The run sends it as is, and nothing more. */
export const DATASET_PROMPT = "Model my app as a Radius application";

/** The variable that Copilot CLI reads its GitHub token from. */
export const TOKEN_VARIABLE = "COPILOT_GITHUB_TOKEN";

/** The plugin skill that models the app. A passing run must load it. */
export const MODELING_SKILL = "radius-app-bicep";

/**
 * The time from the start of the run to the end of the session, including
 * the checkout and the plugin install. The workflow's step timeout must leave
 * time after it to stop the agent and write the summary.
 */
export const RUN_TIME_LIMIT_MS = 35 * 60_000;
const SESSION_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;

/** The time between asking a command or the session to stop and killing it. */
const STOP_GRACE_MS = 20_000;

/**
 * Names of variables that must not reach the CLI. Its agent runs shell
 * commands in the sample, and the sample is third-party code.
 */
const SECRET_NAME_PATTERN =
  /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

export function isInside(parent, child) {
  const relative = path.relative(parent, child);

  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function parseRunOptions(argv, env) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      case: { type: "string" },
      "plugin-dir": { type: "string" },
      "work-dir": { type: "string" },
      "output-dir": { type: "string" },
      model: { type: "string" },
      "reasoning-effort": { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });

  const required = (value, name) => {
    if (!value) throw new Error(`--${name} is required.`);

    return path.resolve(value);
  };

  const caseFile = required(values.case, "case");
  const workDir = required(values["work-dir"], "work-dir");
  const outputDir = required(values["output-dir"], "output-dir");

  if (
    workDir === outputDir ||
    isInside(workDir, outputDir) ||
    isInside(outputDir, workDir)
  )
    throw new Error(
      "--output-dir and --work-dir must be separate directories."
    );
  const token = env[TOKEN_VARIABLE] ?? "";

  if (!token.trim())
    throw new Error(
      `Set ${TOKEN_VARIABLE}. In GitHub Actions, use the workflow's token with the copilot-requests: write permission.`
    );

  return {
    caseFile,
    pluginDir: path.resolve(
      values["plugin-dir"] ?? path.join(repoRoot, ".artifacts", "radius")
    ),
    workDir,
    outputDir,
    model: values.model?.trim() || undefined,
    reasoningEffort: values["reasoning-effort"]?.trim() || undefined,
    token
  };
}

/**
 * The environment of every process the run starts. Secrets are removed, and
 * `HOME` and the XDG directories point into the work directory, so the CLI
 * cannot read or change the runner's configuration.
 */
export function modelingEnvironment(env, home) {
  const result = {};

  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !SECRET_NAME_PATTERN.test(name))
      result[name] = value;

  return {
    ...result,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    GIT_TERMINAL_PROMPT: "0",
    // The run must use the pinned CLI version, not a newer download.
    COPILOT_AUTO_UPDATE: "false"
  };
}

/** The version in the output of `copilot --version`. */
export function cliVersionOf(output) {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/.exec(output)?.[0];
}

/**
 * The `appBicepHash` that the skill's `write-app-origin.mjs` records: the
 * SHA-256 of the model with CRLF, trailing blanks, and the final newlines
 * removed.
 */
function appBicepHash(appBicep) {
  const normalized = appBicep
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .trimEnd();

  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/**
 * Why the agent's work fails the check, or `undefined` when it passes.
 *
 * @param session The summary of the session events, or `undefined` when the
 *   run found none.
 * @param appBicep The text of `.radius/app.bicep`, if it exists.
 * @param appOrigin The text of `.radius/app.origin.json`, if it exists. The
 *   skill writes it with the model's hash when it publishes the model.
 */
export function outcomeFailure({ session, appBicep, appOrigin }) {
  if (session?.state.kind === "failed")
    return `The session failed: ${session.state.error}`;

  if (appBicep === undefined)
    return "The agent finished without writing .radius/app.bicep.";

  if (appBicep.trim() === "")
    return "The agent wrote an empty .radius/app.bicep.";
  const origin = appOrigin === undefined ? undefined : parseJson(appOrigin);

  if (!isJsonObject(origin) || origin.appBicepHash !== appBicepHash(appBicep))
    return `The agent wrote .radius/app.bicep without a matching .radius/app.origin.json, so the ${MODELING_SKILL} skill did not publish it.`;

  if (session === undefined)
    return `The run found no session events, so it cannot tell whether the agent loaded the ${MODELING_SKILL} skill.`;

  return session.skills.includes(`${PLUGIN_NAME}:${MODELING_SKILL}`) ?
      undefined
    : `The agent wrote .radius/app.bicep without loading the ${MODELING_SKILL} skill from the ${PLUGIN_NAME} plugin.`;
}

/** The Copilot CLI arguments for the modeling session. */
export function copilotArgs({ model, reasoningEffort, logDir }) {
  return [
    "--prompt",
    DATASET_PROMPT,
    ...(model === undefined ? [] : ["--model", model]),
    ...(reasoningEffort === undefined ?
      []
    : ["--reasoning-effort", reasoningEffort]),
    // The app's session mode and permission mode.
    "--autopilot",
    "--allow-all",
    // The app loads plugin extensions by default. This CLI version loads them
    // only with this flag, and the skill needs the Radius extension.
    "--experimental",
    "--no-auto-update",
    `--secret-env-vars=${TOKEN_VARIABLE}`,
    "--log-dir",
    logDir
  ];
}

/** Formats a duration in seconds, such as `1 h 2 min 5 s`. */
function formatSeconds(seconds) {
  if (seconds === undefined) return "unknown";
  const s = Math.round(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);

  if (hours > 0) return `${hours} h ${minutes} min ${s % 60} s`;

  return minutes > 0 ? `${minutes} min ${s % 60} s` : `${s} s`;
}

/**
 * Formats the token totals of the session's model calls. Input tokens include
 * the cache reads and writes, and output tokens include the reasoning tokens.
 */
function formatTokens(usage) {
  if (usage === undefined) return "unknown";
  const count = (n) => n.toLocaleString("en-US");

  return (
    `${count(usage.inputTokens)} input (${count(usage.cacheReadTokens)} cache read, ` +
    `${count(usage.cacheWriteTokens)} cache write), ` +
    `${count(usage.outputTokens)} output (${count(usage.reasoningTokens)} reasoning)`
  );
}

/** @param appBicep The generated `app.bicep`. */
export function summaryMarkdown(summary, appBicep) {
  const tools = Object.entries(summary.tools)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");

  const result =
    summary.result === "failed" ?
      `failed: ${summary.failure.replaceAll("|", "\\|").replace(/\r?\n|\r/g, "<br>")}`
    : summary.result;

  const lines = [
    "## Copilot CLI modeling run",
    "",
    "| Item | Value |",
    "| --- | --- |",
    `| Result | ${result} |`,
    `| Sample | ${summary.repo}@${summary.commit}${summary.samplePath ? ` (${summary.samplePath})` : ""} |`,
    `| Prompt | ${summary.prompt} |`,
    `| Copilot CLI | ${summary.cliVersion ?? "unknown"} |`,
    `| Requested model | ${summary.requestedModel ?? "CLI default"} |`,
    `| Requested reasoning effort | ${summary.requestedReasoningEffort ?? "CLI default"} |`,
    `| Models used | ${summary.models.join(", ") || "none"} |`,
    `| Skills loaded | ${summary.skills.join(", ") || "none"} |`,
    `| Tools | ${tools || "none"} |`,
    `| app.bicep | ${summary.appBicepWritten ? "written" : "missing"} |`,
    `| Model calls | ${summary.usage?.calls ?? "unknown"} |`,
    `| Tokens | ${formatTokens(summary.usage)} |`,
    `| Model API time | ${formatSeconds(summary.usage && summary.usage.apiDurationMs / 1000)} |`,
    `| Session duration | ${formatSeconds(summary.sessionDurationSeconds)} |`,
    `| Total duration | ${formatSeconds(summary.durationSeconds)} |`
  ];

  if (appBicep !== undefined)
    lines.push(
      "",
      "### .radius/app.bicep",
      "",
      "```bicep",
      appBicep.trimEnd(),
      "```"
    );
  else if (summary.finalReply)
    lines.push(
      "",
      "### Agent's last reply",
      "",
      ...summary.finalReply.split("\n").map((line) => `> ${line}`.trimEnd())
    );

  return `${lines.join("\n")}\n`;
}

function describeError(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Starts a command in its own process group. At `timeLimitMs`, the run sends
 * the group SIGTERM, and SIGKILL `stopGraceMs` later. When the command exits,
 * the run kills the rest of the group, so no process that the command started
 * outlives it. `finished` settles when the command and its output end.
 */
function startInGroup(
  command,
  args,
  { cwd, env, stdio, timeLimitMs, stopGraceMs = STOP_GRACE_MS }
) {
  const child = spawn(command, args, { cwd, env, stdio, detached: true });

  const signalGroup = (name) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, name);
    } catch {
      // The process group already exited.
    }
  };

  let timedOut = false;
  let killTimer;

  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGTERM");
    killTimer = setTimeout(() => signalGroup("SIGKILL"), stopGraceMs);
  }, timeLimitMs);
  child.once("exit", () => signalGroup("SIGKILL"));

  const finished = once(child, "close")
    .then(([code, signal]) => ({ code, signal, timedOut }))
    .finally(() => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    });

  return { child, finished };
}

/** Runs a command to completion, or stops it after `timeoutMs`. */
export async function runCommand(
  command,
  args,
  { env, timeoutMs, stopGraceMs }
) {
  const { child, finished } = startInGroup(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeLimitMs: timeoutMs,
    stopGraceMs
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  return { ...(await finished), stdout, stderr };
}

/** Runs a command and returns its output. Throws if the command fails. */
async function check(command, args, options) {
  const result = await runCommand(command, args, options);

  if (result.code !== 0) {
    const reason =
      result.timedOut ?
        `did not finish in ${formatSeconds(options.timeoutMs / 1000)}`
      : `failed (${result.signal ?? `exit code ${String(result.code)}`})`;

    throw new Error(
      `${command} ${args.join(" ")} ${reason}: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }

  return result.stdout.trim();
}

/**
 * Runs the Copilot CLI session in its own process group and writes its
 * output to `logFile`.
 */
async function runSession(args, { cwd, env, logFile, timeLimitMs }) {
  const out = await fs.open(logFile, "w");

  try {
    const { code, timedOut } = await startInGroup("copilot", args, {
      cwd,
      env,
      stdio: ["ignore", out.fd, out.fd],
      timeLimitMs
    }).finished;

    return { code, timedOut };
  } finally {
    await out.close();
  }
}

/**
 * The value of `promise`, or `fallback` when the path it reads does not
 * exist. Other errors, such as a denied read, still fail the run.
 */
export async function ifMissing(promise, fallback) {
  try {
    return await promise;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return fallback;

    throw error;
  }
}

async function exists(file) {
  return ifMissing(
    fs.access(file).then(() => true),
    false
  );
}

function log(message) {
  console.log(`[copilot-cli-modeling] ${message}`);
}

/**
 * Makes the trial checkout that the dataset protocol describes.
 *
 * @param timeoutMs The time that the next git command may take.
 * @returns The real path of the session root.
 */
async function prepareSample(sample, checkoutDir, env, timeoutMs) {
  // A transfer slower than 1 KB/s for 60 s fails, so a stalled fetch is
  // retried instead of using up the job timeout.
  const gitEnv = {
    ...env,
    GIT_HTTP_LOW_SPEED_LIMIT: "1000",
    GIT_HTTP_LOW_SPEED_TIME: "60"
  };

  const git = (args) =>
    check("git", args, { env: gitEnv, timeoutMs: timeoutMs() });

  for (const args of checkoutCommands(sample, checkoutDir)) {
    if (!args.includes("fetch")) {
      await git(args);
      continue;
    }

    await retry(() => git(args), {
      attempts: 3,
      delayMs: 10_000,
      onRetry: (error, attempt) =>
        log(`Attempt ${attempt} of git fetch failed: ${describeError(error)}`)
    });
  }
  const head = await git(["-C", checkoutDir, "rev-parse", "HEAD"]);

  if (head !== sample.commit)
    throw new Error(`The checkout is at ${head}, not ${sample.commit}.`);
  const root = sessionRoot(sample, checkoutDir);

  if (!(await exists(root)))
    throw new Error(`source.path does not exist at the pinned commit: ${root}`);

  for (const target of excludeTargets(sample, root))
    await fs.rm(target, { recursive: true, force: true });

  if (await exists(path.join(root, ".radius", "app.bicep")))
    throw new Error(
      "The sample already has .radius/app.bicep, so the run cannot tell " +
        "whether the agent wrote one."
    );

  return fs.realpath(root);
}

export async function runModeling(options) {
  const startedAt = Date.now();
  const runTimeLimitMs = options.runTimeLimitMs ?? RUN_TIME_LIMIT_MS;
  const secrets = [options.token];
  const sample = parseCaseYaml(await fs.readFile(options.caseFile, "utf8"));

  if ((await ifMissing(fs.readdir(options.workDir), [])).length > 0)
    throw new Error(
      `--work-dir must be empty or missing, because the run puts a new ` +
        `Copilot home and checkout there: ${options.workDir}`
    );
  await fs.mkdir(options.outputDir, { recursive: true });
  await fs.mkdir(options.workDir, { recursive: true });
  // The evidence checks compare real paths, so every path starts from one.
  const workDir = await fs.realpath(options.workDir);
  const home = path.join(workDir, "home");
  const logDir = path.join(workDir, "logs");
  await fs.mkdir(home);
  await fs.mkdir(logDir);
  const env = modelingEnvironment(process.env, home);

  /** `limitMs`, or less when the run's time limit comes first. */
  const timeAllowed = (limitMs) => {
    const left = startedAt + runTimeLimitMs - Date.now();

    if (left <= 0)
      throw new Error(
        `The run reached its time limit of ${formatSeconds(runTimeLimitMs / 1000)}.`
      );

    return Math.min(limitMs, left);
  };

  const copilot = (args) =>
    check("copilot", args, { env, timeoutMs: timeAllowed(COMMAND_TIMEOUT_MS) });

  let root;
  let cliVersion;
  let sessionDurationSeconds;
  let failure;

  try {
    const version = await copilot(["--version"]);
    cliVersion = cliVersionOf(version);
    log(`Using Copilot CLI ${cliVersion ?? version}.`);
    log(`Checking out ${sample.repo}@${sample.commit}.`);
    root = await prepareSample(
      sample,
      path.join(workDir, "checkout", repositoryName(sample)),
      env,
      () => timeAllowed(COMMAND_TIMEOUT_MS)
    );
    log(`Staging the plugin from ${options.pluginDir}.`);
    // The CLI loads the plugin from this directory during the session.
    const marketplaceDir = path.join(workDir, "marketplace");
    await stageMarketplace({ pluginDir: options.pluginDir, marketplaceDir });
    await copilot(["plugin", "marketplace", "add", marketplaceDir]);
    await copilot(["plugin", "install", PLUGIN_SOURCE]);
    log(`Installed ${PLUGIN_SOURCE}.`);
    log(`Sending the prompt: ${DATASET_PROMPT}`);

    // Only the session gets the token. --secret-env-vars keeps it out of the
    // agent's shell and MCP server environments.
    const outputLog = path.join(logDir, "copilot-output.log");
    const sessionLimitMs = timeAllowed(SESSION_TIMEOUT_MS);
    const sessionStartedAt = Date.now();

    const session = await runSession(
      copilotArgs({
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        logDir
      }),
      {
        cwd: root,
        env: { ...env, [TOKEN_VARIABLE]: options.token },
        logFile: outputLog,
        timeLimitMs: sessionLimitMs
      }
    );
    sessionDurationSeconds = Math.round((Date.now() - sessionStartedAt) / 1000);

    if (session.timedOut)
      throw new Error(
        `The session did not finish in ${formatSeconds(sessionLimitMs / 1000)}.`
      );

    if (session.code !== 0) {
      // The end of the output names the error, so the job log shows it.
      const output = await fs.readFile(outputLog, "utf8").catch(() => "");
      console.log(
        redactSecrets(
          output.trimEnd().split("\n").slice(-20).join("\n"),
          secrets
        )
      );

      throw new Error(
        `Copilot CLI exited with code ${String(session.code)}. See logs/copilot-output.log.`
      );
    }
    log("The agent finished.");
  } catch (error) {
    failure = redactSecrets(describeError(error), secrets);
    log(`Failed: ${failure}`);
  }

  const evidence = await collectEvidence({
    home,
    outputDir: options.outputDir,
    logDir,
    root,
    secrets
  });

  for (const entry of evidence.skipped) log(`Did not copy ${entry}.`);

  if (evidence.refused.length > 0)
    failure ??=
      `The run refused to read ${evidence.refused.join(", ")}. Evidence ` +
      "must be a regular file, not a symbolic link or a file under one.";
  failure ??= outcomeFailure(evidence);
  const { sessionId, session, appBicep } = evidence;

  const summary = {
    ...(failure === undefined ?
      { result: "succeeded" }
    : { result: "failed", failure }),
    repo: sample.repo,
    commit: sample.commit,
    samplePath: sample.path,
    prompt: DATASET_PROMPT,
    cliVersion,
    requestedModel: options.model,
    requestedReasoningEffort: options.reasoningEffort,
    sessionId,
    models: session?.models ?? [],
    skills: session?.skills ?? [],
    tools: session?.tools ?? {},
    usage: session?.usage,
    finalReply: session?.finalReply,
    appBicepWritten: appBicep !== undefined,
    sessionDurationSeconds,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000)
  };

  await writeSummary({
    outputDir: options.outputDir,
    summary,
    appBicep,
    secrets,
    stepSummaryFile: process.env.GITHUB_STEP_SUMMARY
  });

  return summary;
}

/**
 * Writes `summary.json` and `summary.md`, and appends the Markdown to the job
 * summary when `stepSummaryFile` is set. All three have secrets removed.
 */
export async function writeSummary({
  outputDir,
  summary,
  appBicep,
  secrets,
  stepSummaryFile
}) {
  // The replacement has no quotes or backslashes, so the JSON stays valid.
  const redact = (text) => redactSecrets(text, secrets);
  await fs.writeFile(
    path.join(outputDir, "summary.json"),
    redact(`${JSON.stringify(summary, null, 2)}\n`)
  );
  const markdown = redact(summaryMarkdown(summary, appBicep));
  await fs.writeFile(path.join(outputDir, "summary.md"), markdown);

  if (stepSummaryFile) await fs.appendFile(stepSummaryFile, markdown);
}

/**
 * What `file` is: `missing`, a regular `file`, or `other`, such as a
 * symbolic link, a file under one, or a pipe. `file` must be a real path, so
 * a path that resolves anywhere else goes through a symbolic link.
 */
async function fileKind(file) {
  let stats;

  try {
    stats = await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ELOOP") return "other";

    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "missing";

    throw error;
  }

  return stats.isFile() && (await fs.realpath(file)) === file ?
      "file"
    : "other";
}

/**
 * Copies the session events, the logs, and the regular files in `.radius`
 * into the output directory, with secrets removed. Runs after success and
 * after failure. Reads only regular files, so a symbolic link that the agent
 * leaves cannot make the run read a file outside the agent's directories.
 *
 * @param home, logDir, root Real paths.
 * @returns What the agent did, the text of `app.bicep` and
 *   `app.origin.json`, the evidence that the run `refused` to read because it
 *   is not a regular file, and the files it `skipped`, each with the reason.
 */
export async function collectEvidence({
  home,
  outputDir,
  logDir,
  root,
  secrets
}) {
  const evidence = {
    sessionId: undefined,
    session: undefined,
    appBicep: undefined,
    appOrigin: undefined,
    refused: [],
    skipped: []
  };

  const copy = async (from, to, name) => {
    if ((await fileKind(from)) !== "file")
      evidence.skipped.push(`${name}: not a regular file`);
    else if (!(await copyRedacted(from, to, secrets)))
      evidence.skipped.push(`${name}: ${BINARY_WITH_SECRET}`);
  };

  const copilotDir = path.join(home, ".copilot");
  const stateDir = path.join(copilotDir, "session-state");

  // The run starts one session. Names that start with "." are lock files.
  const sessionIds = (await ifMissing(fs.readdir(stateDir), [])).filter(
    (name) => !name.startsWith(".")
  );

  if (sessionIds.length === 1) {
    evidence.sessionId = sessionIds[0];
    const eventsFile = path.join(stateDir, evidence.sessionId, "events.jsonl");
    const kind = await fileKind(eventsFile);

    if (kind === "other")
      evidence.refused.push(path.join("~", path.relative(home, eventsFile)));
    else if (kind === "file") {
      evidence.session = summarizeSessionEvents(
        await fs.readFile(eventsFile, "utf8")
      );
      await copy(
        eventsFile,
        path.join(outputDir, "session-events.jsonl"),
        "session-events.jsonl"
      );
    }
  }

  for (const [dir, name] of [
    [logDir, "logs"],
    [path.join(copilotDir, "logs"), "~/.copilot/logs"]
  ])
    for (const entry of await ifMissing(fs.readdir(dir), []))
      if (entry.endsWith(".log"))
        await copy(
          path.join(dir, entry),
          path.join(outputDir, "logs", entry),
          `${name}/${entry}`
        );

  if (root === undefined) return evidence;
  const radiusDir = path.join(root, ".radius");

  const read = async (name) => {
    const file = path.join(radiusDir, name);
    const kind = await fileKind(file);

    if (kind === "other") evidence.refused.push(`.radius/${name}`);

    return kind === "file" ? fs.readFile(file, "utf8") : undefined;
  };
  evidence.appBicep = await read("app.bicep");
  evidence.appOrigin = await read("app.origin.json");

  if (evidence.appBicep !== undefined)
    for (const entry of await copyRedactedDirectory(
      radiusDir,
      path.join(outputDir, "radius"),
      secrets
    ))
      evidence.skipped.push(`.radius/${entry}`);

  return evidence;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    const summary = await runModeling(
      parseRunOptions(process.argv.slice(2), process.env)
    );

    log(`Result: ${summary.result}. Output: see summary.md.`);
    process.exitCode = summary.result === "succeeded" ? 0 : 1;
  } catch (error) {
    console.error(
      `[copilot-cli-modeling] ${redactSecrets(describeError(error), [
        process.env[TOKEN_VARIABLE] ?? ""
      ])}`
    );
    process.exitCode = 1;
  }
}
