import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RetryOnlyPassReport } from "./retry-only-reporter.js";

const temporaryDirectories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "radius-retry-only-reporter-")
  );
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.rm(directory, { force: true, recursive: true })
    )
  );
  temporaryDirectories.clear();
});

describe("RetryOnlyPassReport", () => {
  it("rejects a relative output path", () => {
    expect(
      () => new RetryOnlyPassReport({ outputFile: "test-results/report.json" })
    ).toThrow("outputFile must be absolute");
  });

  it("records only retry passes and writes annotations and a job summary", async () => {
    const directory = await temporaryDirectory();
    const outputFile = path.join(directory, "retry-only.json");
    const summaryFile = path.join(directory, "summary.md");
    const logs: string[] = [];
    const report = new RetryOnlyPassReport({
      outputFile,
      summaryFile,
      log: (message) => logs.push(message)
    });

    report.record({
      project: "canvas",
      retry: 0,
      status: "passed",
      title: "first-attempt pass"
    });
    report.record({
      project: "canvas",
      retry: 1,
      status: "failed",
      title: "failed retry"
    });
    report.record({
      project: "canvas",
      retry: 1,
      status: "passed",
      title: "retry 100%\npass"
    });

    await report.write();

    expect(JSON.parse(await fs.readFile(outputFile, "utf8"))).toEqual([
      {
        project: "canvas",
        retry: 1,
        title: "retry 100%\npass"
      }
    ]);
    expect(logs).toEqual([
      "Retry-only passes: 1",
      "::warning title=Retry-only pass::retry 100%25%0Apass passed on retry 1"
    ]);
    expect(await fs.readFile(summaryFile, "utf8")).toContain(
      "| canvas | retry 100%<br>pass | 1 |"
    );
  });

  it("writes an empty report without creating a job summary", async () => {
    const directory = await temporaryDirectory();
    const outputFile = path.join(directory, "retry-only.json");
    const summaryFile = path.join(directory, "summary.md");
    const logs: string[] = [];
    const report = new RetryOnlyPassReport({
      outputFile,
      summaryFile,
      log: (message) => logs.push(message)
    });

    await report.write();

    expect(await fs.readFile(outputFile, "utf8")).toBe("[]\n");
    await expect(fs.stat(summaryFile)).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(logs).toEqual(["Retry-only passes: 0"]);
  });
});
