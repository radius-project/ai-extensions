import {
  classifyLifecycleConclusion,
  lifecycleOutcomeMessage,
  stateSaveFailureWarning,
  type LifecycleOutcome
} from "@radius-project/core";
import { describeStateSaveFailure } from "../../state-save-diagnostics.js";
import type { StateSaveFailure } from "../../state-save-diagnostics.js";

export const ABANDONED_DEPLOYMENT_DESCRIPTION =
  "Tracking abandoned in Radius Canvas; cloud resources were not deleted.";

// Exception 7.1: a single-resource cleanup is a destructive operation against a
// still-deployed application. It is not an application delete — the row keeps
// naming the application, and the application is never treated as gone — but
// while it runs nothing else may mutate that deployment, so it carries a status
// of its own that blocks mutation.
export const RESOURCE_DELETING_STATUS = "resource-deleting";

const RESOURCE_DELETING_DETAIL =
  "Removing a resource from this application. The application itself stays deployed.";

const RESOURCE_CLEANUP_LABEL = "Removing a resource from this application";

const OUTCOME_LABELS: Readonly<Record<LifecycleOutcome, string>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "was cancelled",
  timed_out: "timed out",
  unknown: "did not report an outcome"
};

export interface DeploymentRow {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
  // The workflow run behind this row, when it has one. The client tracks a
  // delete it dispatched by run identity, so a row that reports a terminal
  // outcome for a DIFFERENT run can be recognised as the older attempt it is
  // rather than mistaken for the answer.
  runId?: string;
  // Part 8 failure parity: a delete that did not succeed reports WHICH terminal
  // outcome it had ("Deletion cancelled", "Deletion timed out", …) plus any
  // orphan guidance, rather than collapsing every case into "Delete failed".
  statusDetail?: string;
}

interface DeploymentRecord {
  id: string;
  state: string;
  description: string;
  runUrl: string;
  runId: string;
  workflow: "deploy" | "delete" | "resource-delete" | "unrelated" | "unknown";
  runStatus: string;
  runConclusion: string;
  runAttempt: string;
}

interface DeployStatusRecord {
  runConclusion?: string;
  runStatus?: string;
  state?: string;
}

export interface DeploymentResolverDependencies {
  ghOrThrow(args: string[]): Promise<string>;
  deployWorkflowFile: string;
  deleteWorkflowFile: string;
  // The single-resource cleanup dispatcher. It binds the same GitHub
  // Environment, so GitHub creates a deployment record for it too — but
  // deleting one resource is not deleting the application, so a record produced
  // by this workflow must never retire the application's row.
  deleteResourceWorkflowFile: string;
  maxParallelRecords: number;
  // Exception 5.4 parity for deletes: the teardown diagnostic for a delete run
  // attempt. Read only for a terminal delete, so a healthy listing costs no
  // extra request.
  readStateSaveFailure(
    repo: string,
    runId: string,
    runAttempt: string
  ): Promise<StateSaveFailure | null>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A run is still going when GitHub has reported no conclusion for it and its
// status is not `completed`. Both halves matter: a queued run has no status
// worth trusting either, and a completed run with an empty conclusion is over
// however unhelpful its verdict is.
function isRunning(record: {
  runStatus: string;
  runConclusion: string;
}): boolean {
  return !record.runConclusion && record.runStatus !== "completed";
}

export function resolveDeployStatus(rec: DeployStatusRecord): string {
  if (rec.runConclusion === "success") return "success";
  if (rec.runConclusion) return "failed";
  if (rec.runStatus && rec.runStatus !== "completed") return "pending";
  if (rec.state === "success") return "success";
  if (rec.state === "failure" || rec.state === "error") return "failed";
  return "pending";
}

export async function resolveEnvironmentDeployment(
  repo: string,
  environment: string,
  appName: string,
  dependencies: DeploymentResolverDependencies
): Promise<DeploymentRow | null> {
  const resolvedAppName = appName || repo.slice(repo.lastIndexOf("/") + 1);
  let provider = "";
  try {
    const varsRaw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/environments/${encodeURIComponent(
        environment
      )}/variables?per_page=100`,
      "--jq",
      ".variables[].name"
    ]);
    if (/AZURE_/.test(varsRaw)) provider = "azure";
    else if (/AWS_/.test(varsRaw)) provider = "aws";
  } catch {
    provider = "";
  }

  const idsRaw = await dependencies.ghOrThrow([
    "api",
    `/repos/${repo}/deployments?per_page=100&environment=${encodeURIComponent(
      environment
    )}`,
    "--jq",
    ".[].id"
  ]);
  const ids = idsRaw ? idsRaw.split("\n").filter(Boolean) : [];
  const deployWorkflow = new RegExp(
    `(^|/)${escapeRegExp(dependencies.deployWorkflowFile)}$`
  );
  const deleteWorkflow = new RegExp(
    `(^|/)${escapeRegExp(dependencies.deleteWorkflowFile)}$`
  );
  const deleteResourceWorkflow = new RegExp(
    `(^|/)${escapeRegExp(dependencies.deleteResourceWorkflowFile)}$`
  );

  const resolveRecord = async (id: string): Promise<DeploymentRecord> => {
    const latestStatusRaw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/deployments/${id}/statuses?per_page=1`,
      "--jq",
      '(.[0].state // "") + "\\t" + (.[0].log_url // .[0].target_url // "") + "\\t" + (.[0].description // "")'
    ]);
    const [state = "", latestLogUrl = "", description = ""] =
      latestStatusRaw.split("\t");
    if (
      state === "inactive" &&
      description === ABANDONED_DEPLOYMENT_DESCRIPTION
    ) {
      return {
        id,
        state,
        description,
        runUrl: "",
        runId: "",
        workflow: "unknown",
        runStatus: "",
        runConclusion: "",
        runAttempt: ""
      };
    }
    let logUrl = latestLogUrl;
    if (!logUrl) {
      logUrl = await dependencies.ghOrThrow([
        "api",
        `/repos/${repo}/deployments/${id}/statuses?per_page=100`,
        "--jq",
        '[.[] | (.log_url // .target_url // "") | select(. != "")][0] // ""'
      ]);
    }
    let runUrl = "";
    const match = /actions\/runs\/(\d+)/.exec(logUrl);
    if (match) {
      runUrl = `https://github.com/${repo}/actions/runs/${match[1]}`;
    } else if (/^https?:\/\//.test(logUrl)) {
      runUrl = logUrl;
    }

    let runPath = "";
    let runStatus = "";
    let runConclusion = "";
    let runAttempt = "";
    if (match) {
      const runInfo = await dependencies.ghOrThrow([
        "api",
        `/repos/${repo}/actions/runs/${match[1]}`,
        "--jq",
        '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "") + "\\t" + ((.run_attempt // 1) | tostring)'
      ]);
      [runPath = "", runStatus = "", runConclusion = "", runAttempt = ""] =
        runInfo.split("\t");
    }
    const workflow =
      !match || !runPath ? "unknown"
      : deployWorkflow.test(runPath) ? "deploy"
      : deleteResourceWorkflow.test(runPath) ? "resource-delete"
      : deleteWorkflow.test(runPath) ? "delete"
      : "unrelated";

    return {
      id,
      state,
      description,
      runUrl,
      runId: match?.[1] ?? "",
      workflow,
      runStatus,
      runConclusion,
      runAttempt: runAttempt.trim()
    };
  };

  // Exception 5.4: the teardown diagnostic for one delete run attempt, or null
  // when the run saved its state (or published nothing readable).
  const readDeleteStateWarning = async (
    record: DeploymentRecord
  ): Promise<string | null> => {
    if (!record.runId) return null;
    let failure: StateSaveFailure | null;
    try {
      failure = await dependencies.readStateSaveFailure(
        repo,
        record.runId,
        record.runAttempt
      );
    } catch {
      // A diagnostic that cannot be read is reported as "no diagnostic": the
      // delete outcome itself must still reach the listing.
      return null;
    }
    if (!failure) return null;
    return stateSaveFailureWarning(
      "deletion",
      describeStateSaveFailure(failure)
    );
  };

  // Part 8 failure parity. A delete that ended in a non-success conclusion is
  // classified with the same vocabulary as a deploy, and a delete run whose
  // teardown could not persist state carries the orphan-recovery guidance —
  // the delete case where orphans are most likely.
  const describeDeleteOutcome = async (
    record: DeploymentRecord
  ): Promise<string> => {
    const outcome = classifyLifecycleConclusion(record.runConclusion);
    const message = lifecycleOutcomeMessage("deletion", outcome);
    const warning = await readDeleteStateWarning(record);
    return warning ? `${message}\n\n${warning}` : message;
  };

  // A successful whole-application delete normally retires the row. It must not
  // do so silently when the run could not persist Radius state: that is exactly
  // the case where cloud resources are left behind, and a row that disappears
  // takes the only place the warning could be shown with it.
  const DELETED = "deleted" as const;

  const decide = (
    record: DeploymentRecord
  ): DeploymentRow | "skip" | typeof DELETED | null => {
    if (
      record.state === "inactive" &&
      record.description === ABANDONED_DEPLOYMENT_DESCRIPTION
    ) {
      return null;
    }
    if (record.workflow === "unknown") {
      throw new Error(
        `Could not identify GitHub deployment ${record.id} for environment ${environment}.`
      );
    }
    if (record.workflow === "unrelated") return "skip";
    // Exception 7.1: deleting one resource inside an application leaves the
    // application deployed, so a terminal cleanup record says nothing about the
    // application's deployment state and falls through to the record that does.
    // An IN-PROGRESS one is different: it is a destructive operation running
    // against this very deployment right now, and every mutation guard —
    // including the ones in another canvas instance or browser session — reads
    // this row. Reporting the application's old status here would let a second
    // destructive operation start on top of it.
    if (record.workflow === "resource-delete") {
      return isRunning(record) ?
          {
            app: resolvedAppName,
            environment,
            provider,
            status: RESOURCE_DELETING_STATUS,
            deploymentId: record.id,
            runUrl: record.runUrl,
            runId: record.runId,
            statusDetail: RESOURCE_DELETING_DETAIL
          }
        : "skip";
    }
    if (record.workflow === "delete" && record.runConclusion === "success") {
      return DELETED;
    }
    return {
      app: resolvedAppName,
      environment,
      provider,
      status:
        record.workflow === "delete" ?
          record.runConclusion ?
            "delete-failed"
          : "deleting"
        : resolveDeployStatus(record),
      deploymentId: record.id,
      runUrl: record.runUrl,
      runId: record.runId
    };
  };

  // Only a terminal delete needs the extra classification, so a healthy listing
  // performs no additional reads.
  const describe = async (
    record: DeploymentRecord,
    decision: DeploymentRow | typeof DELETED
  ): Promise<DeploymentRow | null> => {
    if (decision === DELETED) {
      const warning = await readDeleteStateWarning(record);
      if (!warning) return null;
      return {
        app: resolvedAppName,
        environment,
        provider,
        status: "deleted-state-warning",
        deploymentId: record.id,
        runUrl: record.runUrl,
        runId: record.runId,
        statusDetail: `${lifecycleOutcomeMessage(
          "deletion",
          "succeeded"
        )}\n\n${warning}`
      };
    }
    return decision.status === "delete-failed" ?
        { ...decision, statusDetail: await describeDeleteOutcome(record) }
      : decision;
  };

  // A cleanup that did not simply succeed is reported on the application's own
  // row — the application is still deployed, so nothing here blocks or retires
  // it, but the failed removal, or a removal whose run could not persist Radius
  // state, would otherwise vanish without a trace.
  let cleanupNote: string | null = null;
  const noteTerminalCleanup = async (
    record: DeploymentRecord
  ): Promise<void> => {
    // First wins: the newest cleanup is the one worth reporting, and stacking
    // several notes onto one row would bury it.
    if (cleanupNote) return;
    const outcome = classifyLifecycleConclusion(record.runConclusion);
    // Exception 5.4 for a per-resource cleanup: the run may have deleted the
    // resource and then failed to persist the state that records it. That is
    // read for a SUCCESSFUL cleanup too — success is precisely the case whose
    // record is otherwise skipped, so the listing would show nothing at all
    // about the orphans it may have left behind.
    const warning = await readDeleteStateWarning(record);
    if (outcome === "succeeded" && !warning) return;
    const headline =
      outcome === "succeeded" ?
        `${RESOURCE_CLEANUP_LABEL} succeeded. The application is still deployed.`
      : `${RESOURCE_CLEANUP_LABEL} ${OUTCOME_LABELS[outcome]}. The application is still deployed; see the workflow run for details.`;
    // The row's own `runUrl` is the application's deploy or delete run, so the
    // cleanup's run has to be named explicitly or it cannot be found from here.
    // A resource-delete record is only ever classified as one BECAUSE its run
    // was resolved, so there is always a run to name.
    cleanupNote =
      `${headline}${warning ? `\n\n${warning}` : ""}` +
      `\nCleanup run: ${record.runUrl}`;
  };
  const annotate = (row: DeploymentRow | null): DeploymentRow | null => {
    if (!row || !cleanupNote) return row;
    return {
      ...row,
      statusDetail:
        row.statusDetail ? `${row.statusDetail}\n\n${cleanupNote}` : cleanupNote
    };
  };

  // One decision step, shared by the parallel batch and the sequential tail so
  // the two paths can never drift into different answers.
  const step = async (
    record: DeploymentRecord
  ): Promise<{ done: false } | { done: true; row: DeploymentRow | null }> => {
    const deployment = decide(record);
    if (deployment === "skip") {
      if (record.workflow === "resource-delete") {
        await noteTerminalCleanup(record);
      }
      return { done: false };
    }
    if (deployment === null) return { done: true, row: null };
    return { done: true, row: annotate(await describe(record, deployment)) };
  };

  const batch = ids.slice(0, dependencies.maxParallelRecords);
  const resolved = await Promise.allSettled(batch.map(resolveRecord));
  for (const result of resolved) {
    if (result.status === "rejected") throw result.reason;
    const outcome = await step(result.value);
    if (outcome.done) return outcome.row;
  }
  for (const id of ids.slice(dependencies.maxParallelRecords)) {
    const outcome = await step(await resolveRecord(id));
    if (outcome.done) return outcome.row;
  }
  return null;
}
