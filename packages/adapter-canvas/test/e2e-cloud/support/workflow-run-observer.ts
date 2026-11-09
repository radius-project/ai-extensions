import { redactCredentials } from "../../../src/credential-redaction.js";
import { expectSuccess, type CloudCommandPort } from "./cloud-command-port.js";
import { parseJsonPayload } from "./create-environment-journey.js";
import { readWorkflowRunIds } from "./workflow-run-discovery.js";

type ObservationKind =
  "dispatch" | "operation" | "command" | "lookup" | "run-timing" | "failure";

interface WorkflowRunObserverPorts {
  readonly commands: Pick<CloudCommandPort, "runGh">;
  readonly now: () => Date;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly credentials: readonly (string | undefined)[];
}

/**
 * Collects test evidence without changing the product's operation result.
 * The only reconnectable commands here are read-only GitHub run queries.
 */
export function createWorkflowRunObserver(
  repository: string,
  ports: WorkflowRunObserverPorts
) {
  const observations: {
    at: string;
    kind: ObservationKind;
    details: unknown;
  }[] = [];

  const record = (kind: ObservationKind, details: unknown): void => {
    observations.push({ at: ports.now().toISOString(), kind, details });
  };

  const read = async (args: readonly string[]): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      const started = ports.now().getTime();
      const result = await ports.commands.runGh(args);
      record("command", {
        args,
        attempt,
        durationMs: ports.now().getTime() - started,
        code: result.code,
        timedOut: result.timedOut === true,
        stderr: result.stderr
      });
      if (result.timedOut)
        throw new Error(
          `The workflow observation timed out: gh ${args.join(" ")}`
        );
      if (
        result.code > 0 &&
        result.code < 128 &&
        attempt < 3 &&
        /connection reset by peer/i.test(result.stderr)
      ) {
        await ports.wait(attempt * 2_000);
        continue;
      }
      return parseJsonPayload(
        expectSuccess(result, `gh ${args.join(" ")}`).stdout,
        "workflow observation"
      );
    }
  };

  return {
    record,
    serialize: (): string =>
      redactCredentials(
        JSON.stringify({ repository, observations }, null, 2),
        ports.credentials
      ),
    listRunIds: async (workflow: string): Promise<ReadonlySet<string>> => {
      const payload = await read([
        "run",
        "list",
        "--repo",
        repository,
        "--workflow",
        workflow,
        "--event",
        "workflow_dispatch",
        "--limit",
        "100",
        "--json",
        "databaseId,displayTitle,status,conclusion,createdAt,startedAt,updatedAt,url"
      ]);
      record("lookup", { workflow, runs: payload });
      return readWorkflowRunIds(payload);
    },
    readRunTiming: async (runId: string): Promise<void> => {
      if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId)))
        throw new Error("Workflow timing requires an exact positive run id.");
      const payload = await read([
        "run",
        "view",
        runId,
        "--repo",
        repository,
        "--json",
        "databaseId,url,status,conclusion,createdAt,startedAt,updatedAt,jobs"
      ]);
      if (!readWorkflowRunIds([payload]).has(runId))
        throw new Error(
          `Workflow timing returned a different run than the owned run ${runId}.`
        );
      record("run-timing", payload);
    }
  };
}
