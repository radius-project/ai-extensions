// Pure rules for the modeling stage: the agent prompt, the session dialog
// parser, the ready signal for the generated model, and the publication plan.

import { parseAppOrigin } from "@radius-project/core";
import { hashAppBicep } from "../../../src/app-bicep-hash.js";

export const MODEL_FILES = [
  ".radius/app.bicep",
  ".radius/bicepconfig.json",
  ".radius/app.origin.json"
] as const;

export type ModelFile = (typeof MODEL_FILES)[number];

const APPLICATION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The prompt that the suite sends to the agent. The production fixture has no
 * model. The suite removes the old model before sending this prompt.
 * The application name is fixed because the cleanup code owns that name.
 */
export function cloudModelingPrompt(applicationName: string): string {
  if (!APPLICATION_NAME_PATTERN.test(applicationName))
    throw new Error(
      `The application name is not a valid Radius name: "${applicationName}".`
    );
  return [
    "The test has removed the old .radius folder. Do not restore it from Git.",
    "Use the radius-app-bicep skill to generate a new Radius application model in .radius/app.bicep.",
    `Name the Radius application "${applicationName}".`,
    "Do not commit, push, or deploy. Stop when the model files are written."
  ].join(" ");
}

export interface SessionInfo {
  readonly branch: string;
  readonly baseBranch: string;
  readonly path: string;
  readonly sessionId: string;
}

const SESSION_FIELDS = ["branch", "base branch", "path", "session ID"] as const;

/**
 * Reads the session information dialog. Each copy button has the accessible
 * name "Copy <field>, <value>".
 */
export function parseSessionInfo(labels: readonly string[]): SessionInfo {
  const fields = new Map<string, string>();
  for (const label of labels) {
    const match = /^Copy (branch|base branch|path|session ID), (.+)$/.exec(
      label.trim()
    );
    if (match?.[1] && match[2]?.trim()) fields.set(match[1], match[2].trim());
  }
  const missing = SESSION_FIELDS.filter((field) => !fields.has(field));
  if (missing.length > 0)
    throw new Error(
      `The session information dialog did not show: ${missing.join(", ")}. ` +
        `Labels seen: ${labels.join(" | ") || "<none>"}`
    );
  const read = (field: (typeof SESSION_FIELDS)[number]): string =>
    fields.get(field) ?? "";
  return {
    branch: read("branch"),
    baseBranch: read("base branch"),
    path: read("path"),
    sessionId: read("session ID")
  };
}

/** Reads the session ID from an app URL such as `/workspaces/<id>`. */
export function sessionIdFromAppUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = /^\/workspaces\/([^/]+)\/?$/.exec(url.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Reads the status from a session tree entry name. Tree items use
 * "Model the app. Status: Idle. 2 minutes ago"; the session buttons in the
 * sidebar start with "Working " while the agent runs.
 */
export function parseSessionStatus(name: string): string | undefined {
  const status = /\bStatus: ([^.]+)\./.exec(name)?.[1]?.trim();
  if (status) return status;
  return /^Working\s/.test(name.trim()) ? "Working" : undefined;
}

/**
 * Reads the session title from the header button, whose accessible name is
 * "<title> · <branch>, session information".
 */
export function sessionTitleFromInfoLabel(label: string): string {
  const match = /^(.+?) · .+, session information$/.exec(label.trim());
  if (!match?.[1]?.trim())
    throw new Error(`The session header label has no title: "${label}".`);
  return match[1].trim();
}

/** File modification times in milliseconds; `undefined` when absent. */
export type ModelFileTimes = Readonly<Record<ModelFile, number | undefined>>;

export interface ModelReadinessInput {
  readonly model: string | undefined;
  readonly originText: string | undefined;
  readonly baselineSha: string;
  readonly times: ModelFileTimes;
  /** Time baseline removal completed, before the modeling prompt. */
  readonly startedAtMs: number;
  /** Times from the previous poll, used to see that the agent stopped writing. */
  readonly previousTimes: ModelFileTimes | undefined;
  /** Session status from the app; `undefined` when the app did not show one. */
  readonly sessionStatus: string | undefined;
}

export interface ModelReadiness {
  readonly ready: boolean;
  readonly missing: readonly ModelFile[];
  readonly stale: readonly ModelFile[];
  readonly changing: readonly ModelFile[];
  readonly sessionStatus: string | undefined;
  readonly originProblem: string | undefined;
}

/**
 * The model is ready when every model file exists, every file was written
 * after baseline removal, no file changed since the previous poll, and the session
 * explicitly reports idle. The origin must record this generation, source
 * commit, and normalized model hash; checkout timestamps alone are not evidence.
 */
export function classifyModelReadiness(
  input: ModelReadinessInput
): ModelReadiness {
  const missing: ModelFile[] = [];
  const stale: ModelFile[] = [];
  const changing: ModelFile[] = [];
  for (const file of MODEL_FILES) {
    const time = input.times[file];
    if (time === undefined) missing.push(file);
    else if (time < input.startedAtMs) stale.push(file);
    if (time !== input.previousTimes?.[file]) changing.push(file);
  }
  const idle = input.sessionStatus?.toLowerCase() === "idle";
  const origin = parseAppOrigin(input.originText);
  const generatedAt = origin ? Date.parse(origin.generatedAt) : Number.NaN;
  const originProblem =
    !origin ? "missing or invalid origin record"
    : !Number.isFinite(generatedAt) || generatedAt < input.startedAtMs ?
      "origin was not generated after model cleanup"
    : origin.sourceCommit !== input.baselineSha ?
      "origin names a different source commit"
    : (
      !input.model?.trim() || origin.appBicepHash !== hashAppBicep(input.model)
    ) ?
      "origin does not match the model"
    : undefined;
  return {
    ready:
      missing.length === 0 &&
      stale.length === 0 &&
      changing.length === 0 &&
      idle &&
      originProblem === undefined,
    missing,
    stale,
    changing,
    sessionStatus: input.sessionStatus,
    originProblem
  };
}

export function describeModelReadiness(readiness: ModelReadiness): string {
  if (readiness.ready) return "The model files are ready.";
  const parts: string[] = [];
  if (readiness.missing.length > 0)
    parts.push(`missing: ${readiness.missing.join(", ")}`);
  if (readiness.stale.length > 0)
    parts.push(`not rewritten yet: ${readiness.stale.join(", ")}`);
  if (readiness.changing.length > 0)
    parts.push(`still changing: ${readiness.changing.join(", ")}`);
  if (readiness.originProblem) parts.push(readiness.originProblem);
  if (readiness.sessionStatus?.toLowerCase() !== "idle")
    parts.push(`session status: ${readiness.sessionStatus ?? "unknown"}`);
  return `The model is not ready (${parts.join("; ")}).`;
}

export const MODEL_COMMIT_MESSAGE =
  "test(cloud-e2e): publish the agent-generated Radius model";

export type ModelPublicationPlan =
  { readonly action: "commit-and-push" } | { readonly action: "unchanged" };

/**
 * Decides how to publish the generated model to the fixture default branch.
 * The session branch must still be at the baseline: the agent must not commit,
 * and the cleanup can only restore the default branch to that baseline.
 */
export function planModelPublication(input: {
  readonly head: string;
  readonly baselineSha: string;
  readonly hasStagedChanges: boolean;
}): ModelPublicationPlan {
  if (input.head.trim() !== input.baselineSha)
    throw new Error(
      `The session branch is at ${input.head.trim() || "<unknown>"}, not at the ` +
        `fixture baseline ${input.baselineSha}. The agent must not commit.`
    );
  return input.hasStagedChanges ?
      { action: "commit-and-push" }
    : { action: "unchanged" };
}
