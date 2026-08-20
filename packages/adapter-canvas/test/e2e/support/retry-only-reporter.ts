import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult
} from "@playwright/test/reporter";

interface RetryOnlyReporterOptions {
  outputFile?: string;
}

interface RetryOnlyPass {
  project: string;
  retry: number;
  title: string;
}

export default class RetryOnlyReporter implements Reporter {
  private readonly outputFile: string;
  private readonly passes: RetryOnlyPass[] = [];

  constructor(options: RetryOnlyReporterOptions = {}) {
    const packageRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../.."
    );
    this.outputFile = path.resolve(
      packageRoot,
      options.outputFile ?? "test-results/retry-only-passes.json"
    );
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== "passed" || result.retry === 0) return;
    this.passes.push({
      project: test.parent.project()?.name ?? "",
      retry: result.retry,
      title: test.titlePath().join(" > ")
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    await fs.mkdir(path.dirname(this.outputFile), { recursive: true });
    await fs.writeFile(
      this.outputFile,
      `${JSON.stringify(this.passes, null, 2)}\n`,
      "utf8"
    );
    console.log(`Retry-only passes: ${this.passes.length}`);
    await this.annotate();
  }

  private async annotate(): Promise<void> {
    if (this.passes.length === 0) return;
    for (const pass of this.passes) {
      const message = `${pass.title} passed on retry ${pass.retry}`
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.log(`::warning title=Retry-only pass::${message}`);
    }
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryFile) return;
    const rows = this.passes
      .map((pass) => `| ${pass.project} | ${pass.title} | ${pass.retry} |`)
      .join("\n");
    await fs.appendFile(
      summaryFile,
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
