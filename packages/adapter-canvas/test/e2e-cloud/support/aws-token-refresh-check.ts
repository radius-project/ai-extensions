// The 15-minute check: an EKS token lasts 15 minutes, so a deploy whose last
// Kubernetes write comes more than 15 minutes after its first token proves
// the token refresher works. Both times come from the deploy run's job log,
// where GitHub prefixes every line with an ISO timestamp.
//
// The clock starts at the refresher's first line. run-rad-commands starts
// refresh-aws-tokens.sh with --prepare, which mints the first EKS token for
// Radius's pods and prints "AWS tokens refreshed."; the watcher then prints
// the same line after each refresh.
//
// Which deploy log line shows a Kubernetes write: `rad deploy` prints no line
// per resource when its output is not a terminal (its progress listener does
// nothing then), so in a workflow log the only line after Radius's last
// Kubernetes write is its completion text, "Deployment Complete". Radius
// prints it only after every resource, including the fixture's late
// Kubernetes resource, succeeded on the cluster. It can come later than the
// write itself, so the fixture keeps its late write the last resource to
// finish. The markers are data, so the local run can add a better one.

export const AWS_TOKEN_REFRESH_LINE = "AWS tokens refreshed.";
export const EKS_TOKEN_LIFETIME_MINUTES = 15;

export interface KubernetesWriteMarker {
  readonly pattern: RegExp;
  readonly meaning: string;
  // Whether the line's time is the write's own. A line printed after the
  // write, such as a completion line, gives only an upper bound.
  readonly exact: boolean;
}

export const KUBERNETES_WRITE_MARKERS: readonly KubernetesWriteMarker[] = [
  {
    pattern: /^Deployment Complete$/,
    meaning: "rad deploy finished, after Radius's last Kubernetes write",
    exact: false
  }
];

export interface JobLogLine {
  readonly at: number;
  readonly timestamp: string;
  readonly text: string;
}

export interface TokenRefreshGap {
  readonly firstRefreshAt: string;
  readonly lastWriteAt: string;
  readonly lastWriteLine: string;
  readonly gapMinutes: number;
  // False when the write line came after the write, so the gap is at most
  // gapMinutes.
  readonly exact: boolean;
  readonly exceedsTokenLifetime: boolean;
  readonly report: string;
}

// `gh run view --log` adds "job<TAB>step<TAB>" before the timestamp; the
// job logs API doesn't. GitHub writes seven fractional digits.
const LINE_PATTERN =
  /^(?:[^\t]*\t[^\t]*\t)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z ?(.*)$/;

/** The timestamped lines of a GitHub Actions job log, in order. */
export function readJobLogLines(log: string): JobLogLine[] {
  const lines: JobLogLine[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const match = LINE_PATTERN.exec(raw);
    if (!match) continue;
    const [, seconds, fraction = "", text] = match;
    const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
    lines.push({
      at: Date.parse(`${seconds}.${milliseconds}Z`),
      timestamp: `${seconds}Z`,
      text: text.trim()
    });
  }
  return lines;
}

/**
 * The gap between the refresher's first line and the last Kubernetes write,
 * with a sentence saying whether it proves token refresh. Throws when either
 * line is missing.
 */
export function measureTokenRefreshGap(
  log: string,
  markers: readonly KubernetesWriteMarker[] = KUBERNETES_WRITE_MARKERS
): TokenRefreshGap {
  const lines = readJobLogLines(log);
  const refresh = lines.find((line) => line.text === AWS_TOKEN_REFRESH_LINE);
  if (!refresh)
    throw new Error(
      `The deploy log has no "${AWS_TOKEN_REFRESH_LINE}" line, so the AWS token refresher never started.`
    );
  let write: { line: JobLogLine; marker: KubernetesWriteMarker } | undefined;
  for (const line of [...lines].reverse()) {
    const marker = markers.find((item) => item.pattern.test(line.text));
    if (marker) {
      write = { line, marker };
      break;
    }
  }
  if (!write)
    throw new Error(
      `The deploy log has no line that follows a Kubernetes write (${markers.map((marker) => marker.meaning).join("; ")}).`
    );
  const { line, marker } = write;
  const gapMinutes = Math.round((line.at - refresh.at) / 6_000) / 10;
  const exceedsTokenLifetime = gapMinutes > EKS_TOKEN_LIFETIME_MINUTES;
  const timing =
    marker.exact ?
      `The last Kubernetes write ("${line.text}" at ${line.timestamp}) came ${gapMinutes} minutes after the first AWS token refresh (${refresh.timestamp})`
    : `"${line.text}" (${line.timestamp}), which comes after the last Kubernetes write, came ${gapMinutes} minutes after the first AWS token refresh (${refresh.timestamp}), so the last write came at most ${gapMinutes} minutes after it`;
  let verdict: string;
  if (!exceedsTokenLifetime)
    verdict = `within the ${EKS_TOKEN_LIFETIME_MINUTES}-minute EKS token lifetime, so this deploy doesn't prove token refresh. The fixture app needs a Kubernetes write later in the deploy.`;
  else if (marker.exact)
    verdict = `past the ${EKS_TOKEN_LIFETIME_MINUTES}-minute EKS token lifetime, so the refreshed token kept the deploy signed in.`;
  else
    verdict = `which may be past the ${EKS_TOKEN_LIFETIME_MINUTES}-minute EKS token lifetime. The log can't show the exact time of the write, so this doesn't prove token refresh on its own; check the write's time on the cluster.`;
  return {
    firstRefreshAt: refresh.timestamp,
    lastWriteAt: line.timestamp,
    lastWriteLine: line.text,
    gapMinutes,
    exact: marker.exact,
    exceedsTokenLifetime,
    report: `${timing}, ${verdict}`
  };
}
