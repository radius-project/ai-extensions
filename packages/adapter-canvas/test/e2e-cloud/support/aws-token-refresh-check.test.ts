import { describe, expect, it } from "vitest";
import {
  AWS_TOKEN_REFRESH_LINE,
  measureTokenRefreshGap,
  readJobLogLines
} from "./aws-token-refresh-check.js";

// A deploy job's log as the jobs API returns it: seven fractional digits,
// then the line. The refresher's watcher repeats its line every two minutes,
// and `rad deploy` prints its completion text when every resource is done.
function deployLog(completeAt: string, extra: string[] = []): string {
  return [
    "2026-11-17T05:00:00.1000000Z ##[group]Run rad commands",
    "2026-11-17T05:00:01.0000000Z Generating fresh EKS token...",
    `2026-11-17T05:00:02.5000000Z ${AWS_TOKEN_REFRESH_LINE}`,
    "2026-11-17T05:00:03.0000000Z ##[group]rad deploy .radius/app.bicep --environment radtest-aws-run1-main",
    "2026-11-17T05:00:04.0000000Z Building .radius/app.bicep...",
    "2026-11-17T05:00:05.0000000Z Deployment In Progress...",
    `2026-11-17T05:02:02.5000000Z ${AWS_TOKEN_REFRESH_LINE}`,
    ...extra,
    `${completeAt} Deployment Complete`,
    `${completeAt} ##[endgroup]`,
    "2026-11-17T05:30:00.0000000Z ✅ Deployment complete."
  ].join("\n");
}

describe("readJobLogLines", () => {
  it("reads API and `gh run view --log` lines, and skips lines without a timestamp", () => {
    expect(
      readJobLogLines(
        [
          "2026-11-17T05:00:02.5000000Z AWS tokens refreshed.\r",
          "deploy\tRun rad commands\t2026-11-17T05:00:03Z Deployment Complete",
          "a continuation line",
          ""
        ].join("\n")
      )
    ).toEqual([
      {
        at: Date.parse("2026-11-17T05:00:02.500Z"),
        timestamp: "2026-11-17T05:00:02Z",
        text: "AWS tokens refreshed."
      },
      {
        at: Date.parse("2026-11-17T05:00:03.000Z"),
        timestamp: "2026-11-17T05:00:03Z",
        text: "Deployment Complete"
      }
    ]);
  });
});

describe("measureTokenRefreshGap", () => {
  it("doesn't claim proof from a completion line that comes after the write", () => {
    expect(
      measureTokenRefreshGap(deployLog("2026-11-17T05:16:20.5000000Z"))
    ).toEqual({
      firstRefreshAt: "2026-11-17T05:00:02Z",
      lastWriteAt: "2026-11-17T05:16:20Z",
      lastWriteLine: "Deployment Complete",
      gapMinutes: 16.3,
      exact: false,
      exceedsTokenLifetime: true,
      report:
        "\"Deployment Complete\" (2026-11-17T05:16:20Z), which comes after the last Kubernetes write, came 16.3 minutes after the first AWS token refresh (2026-11-17T05:00:02Z), so the last write came at most 16.3 minutes after it, which may be past the 15-minute EKS token lifetime. The log can't show the exact time of the write, so this doesn't prove token refresh on its own; check the write's time on the cluster."
    });
  });

  it("passes a write line more than 15 minutes after the first refresh", () => {
    const log = deployLog("2026-11-17T05:10:00.0000000Z").concat(
      "\n2026-11-17T05:16:20.5000000Z deployment.apps/late configured"
    );
    expect(
      measureTokenRefreshGap(log, [
        { pattern: /configured$/, meaning: "kubectl configured", exact: true }
      ])
    ).toMatchObject({
      exact: true,
      exceedsTokenLifetime: true,
      report:
        'The last Kubernetes write ("deployment.apps/late configured" at 2026-11-17T05:16:20Z) came 16.3 minutes after the first AWS token refresh (2026-11-17T05:00:02Z), past the 15-minute EKS token lifetime, so the refreshed token kept the deploy signed in.'
    });
  });

  it("reports, rather than passes, a deploy that finished inside the token lifetime", () => {
    const gap = measureTokenRefreshGap(
      deployLog("2026-11-17T05:15:02.5000000Z")
    );
    expect(gap.gapMinutes).toBe(15);
    expect(gap.exceedsTokenLifetime).toBe(false);
    expect(gap.report).toBe(
      '"Deployment Complete" (2026-11-17T05:15:02Z), which comes after the last Kubernetes write, came 15 minutes after the first AWS token refresh (2026-11-17T05:00:02Z), so the last write came at most 15 minutes after it, within the 15-minute EKS token lifetime, so this deploy doesn\'t prove token refresh. The fixture app needs a Kubernetes write later in the deploy.'
    );
  });

  it("uses the last matching line, and markers the caller adds", () => {
    const log = deployLog("2026-11-17T05:10:00.0000000Z", [
      "2026-11-17T05:05:00.0000000Z Deployment Complete"
    ]).concat("\n2026-11-17T05:20:00.0000000Z deployment.apps/late configured");
    expect(measureTokenRefreshGap(log).lastWriteAt).toBe(
      "2026-11-17T05:10:00Z"
    );
    expect(
      measureTokenRefreshGap(log, [
        {
          pattern: /configured$/,
          meaning: "kubectl configured an object",
          exact: true
        }
      ])
    ).toMatchObject({ lastWriteAt: "2026-11-17T05:20:00Z", gapMinutes: 20 });
  });

  it("fails when the refresher or a Kubernetes write is missing", () => {
    expect(() =>
      measureTokenRefreshGap("2026-11-17T05:00:00.0000000Z Deployment Complete")
    ).toThrow(
      'The deploy log has no "AWS tokens refreshed." line, so the AWS token refresher never started.'
    );
    expect(() =>
      measureTokenRefreshGap(
        `2026-11-17T05:00:00.0000000Z ${AWS_TOKEN_REFRESH_LINE}\n2026-11-17T05:20:00.0000000Z Deployment failed`
      )
    ).toThrow(
      "The deploy log has no line that follows a Kubernetes write (rad deploy finished, after Radius's last Kubernetes write)."
    );
  });
});
