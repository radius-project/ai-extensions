import { describe, expect, it } from "vitest";
import { FakeGhRuns } from "./fake-gh-runs.js";

function json(result: { code: number | string; stdout: string }) {
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Array<Record<string, unknown>>;
}

const LIST = [
  "run",
  "list",
  "--repo",
  "o/r",
  "--workflow",
  "delete-application.yml"
];

describe("FakeGhRuns", () => {
  it("returns only the JSON fields asked for, and refuses an unknown one", () => {
    const gh = new FakeGhRuns();
    gh.add({ displayTitle: "a", status: "completed", conclusion: "success" });
    expect(json(gh.run([...LIST, "--json", "databaseId,status"]))).toEqual([
      { databaseId: 1, status: "completed" }
    ]);
    expect(json(gh.run([...LIST, "--json", "displayTitle"]))).toEqual([
      { displayTitle: "a" }
    ]);
    const unknown = gh.run([...LIST, "--json", "databaseId,state"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('Unknown JSON field: "state"');
    expect(() => gh.run(LIST)).toThrow("only `--json` output");
  });

  it("filters by status or conclusion, workflow, and event, newest first, 20 by default", () => {
    const gh = new FakeGhRuns();
    gh.add({
      displayTitle: "done",
      status: "completed",
      conclusion: "failure"
    });
    gh.add({ displayTitle: "going", status: "in_progress" });
    gh.add({ displayTitle: "push", status: "queued", event: "push" });
    gh.add({
      displayTitle: "deploy",
      status: "queued",
      workflow: "deploy.yml"
    });
    const titles = (extra: string[]) =>
      json(gh.run([...LIST, ...extra, "--json", "displayTitle"])).map(
        (run) => run.displayTitle
      );
    expect(titles([])).toEqual(["push", "going", "done"]);
    expect(titles(["--status", "in_progress"])).toEqual(["going"]);
    expect(titles(["--status", "failure"])).toEqual(["done"]);
    expect(titles(["--event", "workflow_dispatch"])).toEqual(["going", "done"]);
    expect(titles(["--limit", "1"])).toEqual(["push"]);
    const bad = gh.run([...LIST, "--status", "running", "--json", "status"]);
    expect(bad.stderr).toContain('invalid argument "running"');
    for (let index = 0; index < 30; index += 1)
      gh.add({ displayTitle: `x${index}`, status: "queued" });
    expect(titles([])).toHaveLength(20);
  });

  it("titles a dispatched run as delete-application.yml does, and lists it late", () => {
    const gh = new FakeGhRuns();
    gh.onDispatch({ appearAfterLists: 2 });
    expect(
      gh.run([
        "workflow",
        "run",
        "delete-application.yml",
        "--ref",
        "main",
        "-f",
        "environment=e",
        "-f",
        "application=a",
        "-f",
        "correlation_id=c-1"
      ]).code
    ).toBe(0);
    const list = () => json(gh.run([...LIST, "--json", "displayTitle"]));
    expect(list()).toEqual([]);
    expect(list()).toEqual([]);
    expect(list()).toEqual([
      { displayTitle: "Radius - Delete e [radius:v1 app=a] c-1" }
    ]);
    expect(
      gh.run(["workflow", "run", "deploy.yml", "-f", "environment=e"]).stderr
    ).toContain("could not find any workflows named deploy.yml");
  });

  it("moves a dispatched run through its states as it is viewed, and keeps the last", () => {
    const gh = new FakeGhRuns();
    gh.run(["workflow", "run", "delete-application.yml"]);
    const view = (id: string) =>
      gh.run(["run", "view", id, "--json", "status,conclusion"]);
    expect(JSON.parse(view("1").stdout)).toEqual({
      status: "queued",
      conclusion: ""
    });
    for (const _ of [1, 2])
      expect(JSON.parse(view("1").stdout)).toEqual({
        status: "completed",
        conclusion: "success"
      });
    expect(view("9").stderr).toBe("HTTP 404: Not Found");
    // A run added as it is stays as it is.
    gh.add({ displayTitle: "old", status: "in_progress" });
    expect(JSON.parse(view("2").stdout)).toEqual({
      status: "in_progress",
      conclusion: ""
    });
    expect(gh.run(["run", "view", "1", "--json", "phase"]).code).toBe(1);
    expect(() => gh.run(["run", "rerun", "1"])).toThrow(
      "doesn't answer gh run rerun 1"
    );
  });

  it("calls back after each list with the status it filtered on", () => {
    const gh = new FakeGhRuns();
    const seen: Array<string | undefined> = [];
    gh.afterList = (status) => seen.push(status);
    gh.run([...LIST, "--json", "status"]);
    gh.run([...LIST, "--status", "queued", "--json", "status"]);
    expect(seen).toEqual([undefined, "queued"]);
  });
});
