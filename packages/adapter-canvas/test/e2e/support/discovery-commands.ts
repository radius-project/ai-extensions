import { createHash } from "node:crypto";
import type { FakeCliCommand } from "./canvas-harness.js";

export function discoveryReadCommands(
  repo: string,
  branch: string,
  credentialProfile: string
): FakeCliCommand[] {
  const commit = "c".repeat(40);
  const tree = "d".repeat(40);
  const bytes = Buffer.from(
    "resource app 'Applications.Core/applications@2023-10-01-preview' = { name: 'radius-app' }\n"
  );
  const sha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  const get = (path: string, value: unknown): FakeCliCommand => ({
    tool: "gh",
    args: ["api", "--hostname", "github.com", "--method", "GET", path],
    stdout: JSON.stringify(value)
  });
  const query = (
    path: string,
    expression: string,
    stdout: string
  ): FakeCliCommand => ({
    tool: "gh",
    args: [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      path,
      "--jq",
      expression
    ],
    stdout
  });
  return [
    get(`/repos/${repo}`, { full_name: repo }),
    ...[encodeURIComponent(branch), commit].map((ref) =>
      get(`/repos/${repo}/commits/${ref}`, {
        sha: commit,
        commit: { tree: { sha: tree } }
      })
    ),
    get(`/repos/${repo}/git/trees/${tree}?recursive=1`, {
      sha: tree,
      truncated: false,
      tree: [
        { path: ".radius", type: "tree", mode: "040000", sha: "e".repeat(40) },
        {
          path: ".radius/app.bicep",
          type: "blob",
          mode: "100644",
          sha,
          size: bytes.length
        }
      ]
    }),
    get(`/repos/${repo}/contents/.radius/app.bicep?ref=${commit}`, {
      sha,
      encoding: "base64",
      content: bytes.toString("base64")
    }),
    get(`/repos/${repo}/environments?per_page=100&page=1`, {
      environments: [{ id: 101, name: "fixture-environment" }]
    }),
    get(`/repos/${repo}/environments/fixture-environment`, {
      id: 101,
      name: "fixture-environment",
      protection_rules: []
    }),
    get(
      `/repos/${repo}/environments/fixture-environment/variables?per_page=100`,
      {
        variables: [
          { name: "RADIUS_MANAGED", value: "true" },
          { name: "AZURE_SUBSCRIPTION_ID", value: "fixture-subscription" },
          { name: "AZURE_CLIENT_ID", value: "fixture-client-id" },
          { name: "RADIUS_CREDENTIAL_PROFILE", value: credentialProfile }
        ]
      }
    ),
    query(
      `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
      '.workflow_runs[] | (.id|tostring) + "\\t" + (.status // "") + "\\t" + (.conclusion // "")',
      ""
    ),
    query(
      `/repos/${repo}/deployments?environment=fixture-environment&per_page=10`,
      ".[].id",
      "dep-1\n"
    ),
    query(
      `/repos/${repo}/deployments/dep-1/statuses?per_page=1`,
      '.[0].log_url // .[0].target_url // ""',
      `https://github.com/${repo}/actions/runs/1`
    )
  ];
}
