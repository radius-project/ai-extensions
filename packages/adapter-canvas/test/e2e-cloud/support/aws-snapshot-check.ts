import {
  awsDetail,
  awsError,
  readAws,
  selectFinalSnapshots,
  succeeded,
  waitFor,
  type AwsRdsScope
} from "./aws-cloud-cleanup.js";
import {
  asRecord,
  list,
  text,
  type AwsJourneyPorts
} from "./aws-journey-support.js";
import {
  AWS_RDS_POLL_MS,
  AWS_SNAPSHOT_GONE_TIMEOUT_MS,
  AWS_SNAPSHOT_READY_TIMEOUT_MS
} from "./aws-timeout-budget.js";

// After the app delete, AWS Cloud Control has taken a final snapshot of the
// MySQL recipe's DB instance, a known Radius issue. The pinned recipe copies
// the app's tags to it. The check finds exactly one manual `rds-snapshot-*`
// snapshot of that instance carrying those tags, waits while it is being
// created, deletes it, and confirms it is gone. The cleanup's own selector
// limits the search to the test's region, VPCs, and environments.

/** The tags the MySQL recipe puts on the app's resources. */
export const APP_TAG_KEYS = [
  "radapp.io/application",
  "radapp.io/environment",
  "radapp.io/resource"
] as const;

export interface FinalSnapshotInput {
  readonly scope: AwsRdsScope;
  readonly instanceId: string;
  // Each of APP_TAG_KEYS with the value the snapshot must carry.
  readonly tags: Readonly<Record<string, string>>;
}

export interface FinalSnapshotCheck {
  // The snapshot that was found, or null when there wasn't exactly one.
  readonly snapshot: string | null;
  readonly failures: string[];
}

interface Candidate {
  readonly id: string;
  readonly status: string;
  readonly instanceId: string;
  readonly tags: ReadonlyMap<string, string>;
}

async function readCandidates(
  ports: Pick<AwsJourneyPorts, "runAws">,
  scope: AwsRdsScope
): Promise<Candidate[]> {
  const payload = await readAws(ports, [
    "rds",
    "describe-db-snapshots",
    "--region",
    scope.region,
    "--snapshot-type",
    "manual"
  ]);
  const raw = new Map(
    list(asRecord(payload)?.DBSnapshots).map((entry) => {
      const item = asRecord(entry);
      return [text(item?.DBSnapshotIdentifier), item] as const;
    })
  );
  return selectFinalSnapshots(payload, scope).tagged.map((snapshot) => {
    const item = raw.get(snapshot.id);
    const tags = new Map<string, string>();
    for (const tag of list(item?.TagList).map(asRecord))
      tags.set(text(tag?.Key), text(tag?.Value));
    return {
      id: snapshot.id,
      status: snapshot.status,
      instanceId: text(item?.DBInstanceIdentifier),
      tags
    };
  });
}

function describeTags(tags: ReadonlyMap<string, string>): string {
  return APP_TAG_KEYS.map((key) => `${key}=${tags.get(key) ?? "(none)"}`).join(
    ", "
  );
}

/**
 * Check the app delete left exactly one final snapshot of the instance with
 * the app's tags, then delete it. Throws only when a read fails.
 */
export async function checkAndDeleteFinalSnapshot(
  ports: AwsJourneyPorts,
  input: FinalSnapshotInput
): Promise<FinalSnapshotCheck> {
  const missing = APP_TAG_KEYS.filter((key) => !input.tags[key]);
  if (missing.length > 0)
    throw new Error(
      `The snapshot check needs the app's ${missing.join(", ")} tag values.`
    );
  const { region } = input.scope;
  const where = `RDS DB instance ${input.instanceId} in ${region}`;
  const fromInstance = (await readCandidates(ports, input.scope)).filter(
    (item) => item.instanceId === input.instanceId
  );
  const ours = fromInstance.filter((item) =>
    APP_TAG_KEYS.every((key) => item.tags.get(key) === input.tags[key])
  );
  const [snapshot, ...extra] = ours;
  if (!snapshot || extra.length > 0) {
    const others = fromInstance
      .filter((item) => !ours.includes(item))
      .map(
        (item) => ` ${item.id} is from it, but has ${describeTags(item.tags)}.`
      )
      .join("");
    return {
      snapshot: null,
      failures: [
        !snapshot ?
          `No final snapshot of ${where} carries the app's tags. Cloud Control takes one when it deletes the instance, and the MySQL recipe copies the app's tags to it.${others}`
        : `${where} has ${ours.length} final snapshots with the app's tags (${ours.map((item) => item.id).join(", ")}), not one. None was deleted; the Cloud E2E cleanup workflow removes them.`
      ]
    };
  }
  const fail = (line: string): FinalSnapshotCheck => ({
    snapshot: snapshot.id,
    failures: [line]
  });
  const status = async () =>
    (await readCandidates(ports, input.scope)).find(
      (item) => item.id === snapshot.id
    )?.status ?? "gone";

  let current = snapshot.status;
  if (current === "creating") {
    const ready = await waitFor(
      ports,
      AWS_SNAPSHOT_READY_TIMEOUT_MS,
      AWS_RDS_POLL_MS,
      async () => (current = await status()) !== "creating"
    );
    if (!ready)
      return fail(
        `Final snapshot ${snapshot.id} of ${where} was still being created after ${AWS_SNAPSHOT_READY_TIMEOUT_MS / 60_000} minutes.`
      );
  }
  if (current !== "available")
    return fail(
      `Final snapshot ${snapshot.id} of ${where} is ${current}, and only an available snapshot can be deleted. The Cloud E2E cleanup workflow removes it.`
    );
  const result = await ports.runAws([
    "rds",
    "delete-db-snapshot",
    "--region",
    region,
    "--db-snapshot-identifier",
    snapshot.id
  ]);
  if (!succeeded(result) && !awsError(result, "DBSnapshotNotFound"))
    return fail(
      `Deleting final snapshot ${snapshot.id} of ${where} failed: ${awsDetail(result)}`
    );
  const gone = await waitFor(
    ports,
    AWS_SNAPSHOT_GONE_TIMEOUT_MS,
    AWS_RDS_POLL_MS,
    async () => (await status()) === "gone"
  );
  if (!gone)
    return fail(
      `Final snapshot ${snapshot.id} of ${where} was still there ${AWS_SNAPSHOT_GONE_TIMEOUT_MS / 60_000} minutes after it was deleted.`
    );
  return { snapshot: snapshot.id, failures: [] };
}
