import { promises as fs } from "node:fs";
import path from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

interface RetryOnlyReporterOptions {
  outputFile: string;
}

interface RetryOnlyPass {
  project: string;
  retry: number;
  title: string;
}

interface RetryOnlyResult {
  project: string;
  retry: number;
  status: TestResult["status"];
  title: string;
}

interface RetryOnlyPassReportOptions {
  log?: (message: string) => void;
  outputFile: string;
  summaryFile?: string;
}

function annotationMessage(pass: RetryOnlyPass): string {
  return `${pass.title} passed on retry ${pass.retry}`
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

export class RetryOnlyPassReport {
  private readonly log: (message: string) => void;
  private readonly outputFile: string;
  private readonly passes: RetryOnlyPass[] = [];
  private readonly summaryFile: string | undefined;

  constructor(options: RetryOnlyPassReportOptions) {
    if (!path.isAbsolute(options.outputFile)) {
      throw new Error("Retry-only reporter outputFile must be absolute.");
    }
    this.outputFile = options.outputFile;
    this.summaryFile = options.summaryFile;
    this.log = options.log ?? console.log;
  }

  record(result: RetryOnlyResult): void {
    if (result.status !== "passed" || result.retry === 0) return;
    this.passes.push({
      project: result.project,
      retry: result.retry,
      title: result.title
    });
  }

  async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
    await fs.writeFile(
      this.outputFile,
      `${JSON.stringify(this.passes, null, 2)}\n`,
      "utf8"
    );
    this.log(`Retry-only passes: ${this.passes.length}`);
    if (this.passes.length === 0) return;

    for (const pass of this.passes) {
      this.log(`::warning title=Retry-only pass::${annotationMessage(pass)}`);
    }
    if (!this.summaryFile) return;

    const rows = this.passes
      .map(
        (pass) =>
          `| ${tableCell(pass.project)} | ${tableCell(pass.title)} | ${pass.retry} |`
      )
      .join("\n");
    await fs.appendFile(
      this.summaryFile,
      [
        `### Retry-only passes (${this.passes.length})`,
        "",
        "| Project | Test | Retry |",
        "|---------|------|-------|",
        rows,
        ""
      ].join("\n"),
      "utf8"
    );
  }
}

export default class RetryOnlyReporter implements Reporter {
  private readonly report: RetryOnlyPassReport;

  constructor(options: RetryOnlyReporterOptions) {
    this.report = new RetryOnlyPassReport({
      outputFile: options.outputFile,
      summaryFile: process.env.GITHUB_STEP_SUMMARY
    });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.report.record({
      project: test.parent.project()?.name ?? "",
      retry: result.retry,
      status: result.status,
      title: test.titlePath().join(" > ")
    });
  }

  async onEnd(): Promise<void> {
    await this.report.write();
  }
}
