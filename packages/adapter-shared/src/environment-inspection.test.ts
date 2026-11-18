import { expect, it } from "vitest";
import {
  inspectEnvironments,
  type EnvironmentInspectionRead
} from "./environment-inspection.js";

const repo = "octo/app";
const runs = `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`;
const names = `/repos/${repo}/environments?per_page=100`;
const status = (id: number) =>
  `/repos/${repo}/deployments/${id}/statuses?per_page=1`;
const runDetails = `/repos/${repo}/actions/runs/42`;
const verificationPath = ".github/workflows/radius-verify-credentials.yml";
const variables = (env: string) =>
  `/repos/${repo}/environments/${env}/variables?per_page=100`;
const deployments = (env: string) =>
  `/repos/${repo}/deployments?environment=${env}&per_page=10`;

function fakeRead(replies: Record<string, string | { error: string }>) {
  return async (args: string[]): Promise<EnvironmentInspectionRead> => {
    const path = args.find((arg) => arg.startsWith("/repos/"));
    const reply = path ? replies[path] : undefined;
    if (reply === undefined)
      throw new Error(`Unexpected read: ${args.join(" ")}`);
    return typeof reply === "string" ?
        { ok: true, stdout: reply }
      : { ok: false, error: reply.error };
  };
}

it("keeps provider fallback and unavailable verification separate from other environments' results", async () => {
  const result = await inspectEnvironments(
    repo,
    fakeRead({
      [runs]: "42\tcompleted\tfailure",
      [names]: "7\tprod\nstaging\nunmanaged",
      [variables("prod")]:
        "RADIUS_MANAGED\ttrue\nAWS_ROLE_ARN\tdeployment-role\nAWS_REGION\tus-west-2",
      [variables("staging")]: "RADIUS_MANAGED\ttrue",
      [variables("unmanaged")]: { error: "unreadable variables" },
      [deployments("prod")]: "10",
      [deployments("staging")]: "11",
      [deployments("unmanaged")]: "",
      [status(10)]: `https://github.com/${repo}/actions/runs/42`,
      [status(11)]: { error: "GitHub API unavailable" }
    })
  );
  expect(result).toMatchObject({
    kind: "listed",
    hadRows: true,
    environments: [
      {
        name: "prod",
        provider: "aws",
        status: "failed",
        config: { region: "us-west-2" }
      },
      { name: "staging", provider: "", status: "pending" }
    ]
  });
});

it("does not mistake a failed repository listing for an empty one", async () => {
  await expect(
    inspectEnvironments(
      repo,
      fakeRead({
        [runs]: "",
        [names]: { error: "access denied" }
      })
    )
  ).resolves.toEqual({ kind: "unavailable", error: "access denied" });
  await expect(
    inspectEnvironments(
      repo,
      fakeRead({
        [runs]: "",
        [names]: ""
      })
    )
  ).resolves.toEqual({ kind: "listed", environments: [], hadRows: false });
});

it.each([
  [
    "wrong workflow",
    JSON.stringify({ path: ".github/workflows/deploy.yml" }),
    "unknown"
  ],
  ["malformed JSON", "{", "pending"],
  ["missing workflow identity", "null", "pending"],
  [
    "missing status",
    JSON.stringify({ path: verificationPath, conclusion: null }),
    "pending"
  ],
  [
    "invalid conclusion",
    JSON.stringify({
      path: verificationPath,
      status: "completed",
      conclusion: 123
    }),
    "pending"
  ],
  [
    "queued verification",
    JSON.stringify({
      path: verificationPath,
      status: "queued",
      conclusion: null
    }),
    "pending"
  ],
  [
    "successful verification",
    JSON.stringify({
      path: verificationPath,
      status: "completed",
      conclusion: "success"
    }),
    "success"
  ],
  [
    "matching failed verification",
    JSON.stringify({
      path: verificationPath,
      status: "completed",
      conclusion: "failure"
    }),
    "bypassed"
  ]
])(
  "resolves an older exact verification run once across environments: %s",
  async (_label, payload, expected) => {
    const vars = "RADIUS_MANAGED\nRADIUS_VERIFICATION_BYPASSED\t42";
    const read = fakeRead({
      [runs]: "",
      [names]: "7\tprod\n8\tstaging",
      [variables("prod")]: vars,
      [variables("staging")]: vars,
      [deployments("prod")]: "10\n12",
      [deployments("staging")]: "11",
      [status(10)]: "no run here",
      [status(11)]: `https://github.com/${repo}/actions/runs/42`,
      [status(12)]: `https://github.com/${repo}/actions/runs/42`,
      [runDetails]: payload
    });
    let detailReads = 0;
    await expect(
      inspectEnvironments(repo, (args) => {
        if (args.includes(runDetails)) detailReads++;
        return read(args);
      })
    ).resolves.toMatchObject({
      kind: "listed",
      environments: [{ status: expected }, { status: expected }]
    });
    expect(detailReads).toBe(1);
  }
);

it("stays pending when verification history is unavailable", async () => {
  await expect(
    inspectEnvironments(
      repo,
      fakeRead({
        [runs]: { error: "history unavailable" },
        [names]: "prod",
        [variables("prod")]: "RADIUS_MANAGED\ttrue",
        [deployments("prod")]: "10"
      })
    )
  ).resolves.toMatchObject({
    kind: "listed",
    environments: [{ status: "pending" }]
  });
});
