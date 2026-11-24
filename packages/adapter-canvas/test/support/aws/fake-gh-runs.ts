import type { CommandResult } from "../../e2e-cloud/support/aws-cloud-cleanup-ports.js";

// A stand-in for the GitHub CLI's workflow run calls the AWS cleanup port
// makes for delete-application.yml: `gh workflow run`, `gh run list`, and
// `gh run view`. It keeps the runs, so what a dispatch adds is what a later
// list sees, and each read honors the filters the real call does:
// https://cli.github.com/manual/gh_run_list
// - `--workflow` and `--event` keep matching runs only.
// - `--status` takes a status or a conclusion, and matches either.
// - `--limit` defaults to 20 and keeps the newest runs.
// - `--json` returns only the fields asked for, and refuses an unknown one.
// https://cli.github.com/manual/gh_run_view
// A new run isn't listed at once. How long that takes isn't documented, so a
// dispatched run is left out of `appearAfterLists` lists.

const RUN_FIELDS = new Set([
  "attempt",
  "conclusion",
  "createdAt",
  "databaseId",
  "displayTitle",
  "event",
  "headBranch",
  "headSha",
  "name",
  "number",
  "startedAt",
  "status",
  "updatedAt",
  "url",
  "workflowDatabaseId",
  "workflowName"
]);
const STATUS_FILTERS = new Set([
  "queued",
  "completed",
  "in_progress",
  "requested",
  "waiting",
  "pending",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out"
]);
const WORKFLOW = "delete-application.yml";

export interface FakeRunState {
  status: string;
  conclusion?: string;
}

export interface FakeRun {
  readonly databaseId: number;
  readonly displayTitle: string;
  readonly event: string;
  readonly workflow: string;
  status: string;
  conclusion: string;
  // States each `gh run view` moves it through; the last one stays.
  readonly states: FakeRunState[];
  // Lists left before it is listed.
  hiddenLists: number;
}

export interface DispatchOptions {
  // States its run moves through as it is viewed. Default: queued, then
  // succeeded.
  readonly states?: readonly FakeRunState[];
  // Lists that leave it out. Infinity for a run that never shows.
  readonly appearAfterLists?: number;
}

function ok(value: unknown): CommandResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function refused(message: string): CommandResult {
  return { code: 1, stdout: "", stderr: message };
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function input(args: readonly string[], name: string): string {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1)
    if (args[index] === "-f" && args[index + 1]?.startsWith(prefix))
      return args[index + 1]!.slice(prefix.length);
  return "";
}

export class FakeGhRuns {
  readonly runs: FakeRun[] = [];
  appearAfterLists = 1;
  // Called after each list, with the status it filtered on, if any.
  afterList: ((status: string | undefined) => void) | null = null;
  private nextId = 1;
  private nextDispatch: DispatchOptions = {};

  /** A run that exists before the test starts. */
  add(run: {
    displayTitle: string;
    status: string;
    conclusion?: string;
    event?: string;
    workflow?: string;
    databaseId?: number;
  }): FakeRun {
    const databaseId = run.databaseId ?? this.nextId;
    this.nextId = Math.max(this.nextId, databaseId) + 1;
    const added: FakeRun = {
      databaseId,
      displayTitle: run.displayTitle,
      event: run.event ?? "workflow_dispatch",
      workflow: run.workflow ?? WORKFLOW,
      status: run.status,
      conclusion: run.conclusion ?? "",
      states: [],
      hiddenLists: 0
    };
    this.runs.push(added);
    return added;
  }

  /** How the next dispatched run behaves. */
  onDispatch(options: DispatchOptions): void {
    this.nextDispatch = options;
  }

  run(args: readonly string[]): CommandResult {
    const [group, verb] = args;
    if (group === "workflow" && verb === "run") return this.dispatch(args);
    if (group === "run" && verb === "list") return this.list(args);
    if (group === "run" && verb === "view") return this.view(args);
    throw new Error(`The fake doesn't answer gh ${args.join(" ")}`);
  }

  // `gh workflow run delete-application.yml -f environment=... -f
  // application=... -f correlation_id=...`, titled as its run-name sets.
  private dispatch(args: readonly string[]): CommandResult {
    if (args[2] !== WORKFLOW)
      return refused(`could not find any workflows named ${args[2]}`);
    const options = this.nextDispatch;
    this.nextDispatch = {};
    const states = [
      ...(options.states ?? [
        { status: "queued" },
        { status: "completed", conclusion: "success" }
      ])
    ];
    const first = states[0]!;
    const run = this.add({
      displayTitle: `Radius - Delete ${input(args, "environment")} [radius:v1 app=${input(args, "application")}] ${input(args, "correlation_id")}`,
      status: first.status,
      conclusion: first.conclusion ?? ""
    });
    run.states.push(...states);
    run.hiddenLists = options.appearAfterLists ?? this.appearAfterLists;
    return { code: 0, stdout: "", stderr: "" };
  }

  private fields(args: readonly string[]): string[] | CommandResult {
    const json = flag(args, "--json");
    if (json === undefined)
      throw new Error("The fake answers only `--json` output.");
    const fields = json.split(",");
    const unknown = fields.find((field) => !RUN_FIELDS.has(field));
    return unknown === undefined ? fields : (
        refused(
          `Unknown JSON field: "${unknown}"\nAvailable fields:\n  ${[...RUN_FIELDS].join("\n  ")}`
        )
      );
  }

  private pick(run: FakeRun, fields: readonly string[]) {
    const all: Record<string, unknown> = {
      databaseId: run.databaseId,
      displayTitle: run.displayTitle,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      workflowName: "Radius - Delete Application"
    };
    return Object.fromEntries(fields.map((field) => [field, all[field]]));
  }

  private list(args: readonly string[]): CommandResult {
    const fields = this.fields(args);
    if (!Array.isArray(fields)) return fields;
    const status = flag(args, "--status");
    if (status !== undefined && !STATUS_FILTERS.has(status))
      return refused(
        `invalid argument "${status}" for "-s, --status" flag: valid values are {${[...STATUS_FILTERS].join("|")}}`
      );
    const workflow = flag(args, "--workflow");
    const event = flag(args, "--event");
    const limit = Number(flag(args, "--limit") ?? "20");
    const listed = this.runs
      .filter((run) => {
        if (run.hiddenLists > 0) {
          run.hiddenLists -= 1;
          return false;
        }
        return true;
      })
      .filter(
        (run) =>
          (workflow === undefined || run.workflow === workflow) &&
          (event === undefined || run.event === event) &&
          (status === undefined ||
            run.status === status ||
            run.conclusion === status)
      )
      .sort((a, b) => b.databaseId - a.databaseId)
      .slice(0, limit)
      .map((run) => this.pick(run, fields));
    this.afterList?.(status);
    return ok(listed);
  }

  private view(args: readonly string[]): CommandResult {
    const fields = this.fields(args);
    if (!Array.isArray(fields)) return fields;
    const run = this.runs.find((item) => String(item.databaseId) === args[2]);
    if (!run) return refused("HTTP 404: Not Found");
    const next = run.states.shift();
    if (next) {
      run.status = next.status;
      run.conclusion = next.conclusion ?? "";
      // The last state stays.
      if (run.states.length === 0) run.states.push(next);
    }
    return ok(this.pick(run, fields));
  }
}
