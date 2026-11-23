// The AWS Cloud E2E suite's time limits, in one place so the local run's
// measurements change only this file. The stage limits are first estimates
// from the design's time budget; the local run replaces them with about three
// times each stage's measured time.

const MINUTE_MS = 60_000;

/** The ten stages of the AWS journey, in the order they run. */
export const AWS_STAGE_TIMEOUTS_MS = {
  // Account, clusters, deploy role, and leftovers, then the node group
  // version update and scale-up.
  preflight: 25 * MINUTE_MS,
  createMainEnvironment: 15 * MINUTE_MS,
  createSecondEnvironment: 15 * MINUTE_MS,
  failedDeploy: 15 * MINUTE_MS,
  // RDS create time varies, and the fixture app holds a Kubernetes write back
  // at least 16 minutes into the deploy.
  deploy: 50 * MINUTE_MS,
  connectionCheck: 10 * MINUTE_MS,
  // The app delete waits on the RDS delete, then the snapshot is deleted.
  deleteApplications: 25 * MINUTE_MS,
  deleteSecondEnvironment: 10 * MINUTE_MS,
  deleteMainEnvironment: 10 * MINUTE_MS,
  leftovers: 5 * MINUTE_MS
} as const;

export const AWS_SERIAL_TEST_TIMEOUT_BUDGET_MS = Object.values(
  AWS_STAGE_TIMEOUTS_MS
).reduce((total, limit) => total + limit, 0);

/** The AWS suite's share of the Cloud E2E job on the default harness. */
export const AWS_SUITE_TIMEOUT_MS = 180 * MINUTE_MS;

// Node groups: an update at zero nodes, then the scale-up until the pool's
// nodes are Ready.
export const AWS_NODE_GROUP_ACTIVE_TIMEOUT_MS = 15 * MINUTE_MS;
// The whole start, every update and wait included, so it ends inside the
// preflight stage with time left for the checks before it.
export const AWS_NODE_GROUP_START_TIMEOUT_MS = 20 * MINUTE_MS;
export const AWS_NODE_READY_TIMEOUT_MS = 10 * MINUTE_MS;
export const AWS_NODE_POLL_MS = 15_000;

// IAM and EKS are eventually consistent, so a check that reads just after a
// write gets this long to see it, as the cleanup's leftover check does.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html#troubleshoot_general_eventual-consistency
// https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html
export const AWS_SETTLE_MS = 2 * MINUTE_MS;
export const AWS_SETTLE_POLL_MS = 15_000;

// RDS: the final snapshot Cloud Control takes is ready in a few minutes.
export const AWS_SNAPSHOT_READY_TIMEOUT_MS = 20 * MINUTE_MS;
export const AWS_SNAPSHOT_GONE_TIMEOUT_MS = 10 * MINUTE_MS;
export const AWS_RDS_POLL_MS = 30_000;

// Connection probes run one at a time: each may take this long to start,
// then this long to finish. The TCP connect gives up after its own timeout,
// which is what the isolated probe expects.
export const AWS_PROBE_START_TIMEOUT_MS = 3 * MINUTE_MS;
export const AWS_PROBE_RUN_TIMEOUT_MS = 2 * MINUTE_MS;
export const AWS_PROBE_CONNECT_TIMEOUT_SECONDS = 10;
export const AWS_PROBE_POLL_MS = 5_000;
