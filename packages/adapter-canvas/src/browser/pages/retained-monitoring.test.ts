import { expect, it } from "vitest";
import { readRetainedMonitoring } from "./retained-monitoring.js";

const record = {
  repo: "owner/repo",
  application: "app",
  environment: "dev",
  runId: 7,
  resources: [
    {
      id: "web",
      name: "web",
      type: "Radius.Compute/containers",
      deployStatus: "failed"
    },
    {
      id: "db",
      name: "db",
      type: "Radius.Data/sqlDatabases",
      deployStatus: "success"
    }
  ]
};
const payload = {
  unavailable: true,
  reason: "RESULT_UNAVAILABLE",
  retainedMonitoring: record
};
const read = (value: unknown) =>
  readRetainedMonitoring(value, "OWNER/REPO", "APP", "DEV");
it("reads explicitly labeled monitoring evidence independently of a deployed graph", () => {
  expect(read(payload)).toMatchObject({
    runId: 7,
    resources: [{ id: "web" }, { id: "db" }]
  });
});
it.each([
  null,
  {},
  { ...payload, unavailable: false },
  { ...payload, reason: "FORBIDDEN" },
  { ...payload, stale: true },
  { ...payload, retainedMonitoring: null }
])(
  "rejects missing, stale or unauthorized monitoring envelopes %j",
  (value) => {
    expect(read(value)).toBeNull();
  }
);
it.each([
  { runId: "7" },
  { runId: 0 },
  { runId: -1 },
  { runId: 0.5 },
  { repo: "other/repo" },
  { application: "other" },
  { environment: "other" },
  { resources: [] },
  { resources: [{ id: "web", deployStatus: "in_progress" }] },
  { resources: [{ deployStatus: "success" }] }
])("rejects invalid or wrong-selection monitoring records %j", (patch) => {
  expect(
    read({ ...payload, retainedMonitoring: { ...record, ...patch } })
  ).toBeNull();
});
it.each([
  ["", "app", "dev"],
  ["owner/repo", "", "dev"],
  ["owner/repo", "app", ""]
])("requires all selected identity fields (%s/%s/%s)", (repo, app, env) => {
  expect(readRetainedMonitoring(payload, repo, app, env)).toBeNull();
});
