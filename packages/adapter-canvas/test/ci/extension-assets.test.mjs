import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../..");
const EXTENSION_ROOT = join(REPO_ROOT, ".github", "extension");
const INTERNAL_PREFIX =
  "radius-project/ai-extensions/.github/extension/actions/";
const EXTENSION_ACTION_PATH = "/.github/extension/actions/";
const FULL_SHA_REFERENCE = /^[^@\s]+@[0-9a-f]{40}$/;

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function usesReferences(value, references = []) {
  if (Array.isArray(value)) {
    for (const child of value) usesReferences(child, references);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "uses" && typeof child === "string") references.push(child);
      usesReferences(child, references);
    }
  }
  return references;
}

function runScripts(value, scripts = []) {
  if (Array.isArray(value)) {
    for (const child of value) runScripts(child, scripts);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "run" && typeof child === "string") scripts.push(child);
      runScripts(child, scripts);
    }
  }
  return scripts;
}

describe(".github/extension release assets", () => {
  it("pins every remote action to a commit or the source-build placeholder", () => {
    const workflows = filesUnder(EXTENSION_ROOT).filter((path) =>
      /\.ya?ml$/u.test(path)
    );
    const references = workflows.flatMap((path) =>
      usesReferences(parseYaml(readFileSync(path, "utf8"))).map((uses) => ({
        path,
        uses
      }))
    );

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      if (reference.uses.startsWith("./")) continue;
      if (reference.uses.includes(EXTENSION_ACTION_PATH)) {
        expect(reference.uses, reference.path).toMatch(
          /^radius-project\/ai-extensions\/\.github\/extension\/actions\//u
        );
      }
      if (reference.uses.startsWith(INTERNAL_PREFIX)) {
        expect(reference.uses).toMatch(/@\{\{RADIUS_REF\}\}$/u);
      } else {
        expect(reference.uses, reference.path).toMatch(FULL_SHA_REFERENCE);
      }
    }
  });

  // A `workflow_dispatch` boolean input arrives as the string "true"/"false"
  // (including its declared default), so handing it straight to a reusable
  // workflow's `type: boolean` input passes a string where a boolean is
  // declared — on every run, not only the ones that set it. Each such value has
  // to be coerced, e.g. `${{ inputs.force == 'true' }}`. See actions/runner#1483.
  it("coerces every dispatch boolean it forwards to a reusable workflow", () => {
    const workflows = filesUnder(EXTENSION_ROOT).filter((path) =>
      /\.ya?ml$/u.test(path)
    );
    const uncoerced = [];
    let forwarded = 0;
    for (const path of workflows) {
      const workflow = parseYaml(readFileSync(path, "utf8"));
      const inputs = workflow?.on?.workflow_dispatch?.inputs ?? {};
      const booleans = Object.entries(inputs)
        .filter(([, spec]) => spec?.type === "boolean")
        .map(([name]) => name);
      if (booleans.length === 0) continue;
      for (const job of Object.values(workflow?.jobs ?? {})) {
        if (typeof job?.uses !== "string") continue;
        for (const [input, value] of Object.entries(job.with ?? {})) {
          if (typeof value !== "string") continue;
          const named = booleans.find((name) =>
            value.includes(`inputs.${name}`)
          );
          if (!named) continue;
          forwarded++;
          if (!value.includes(`inputs.${named} ==`)) {
            uncoerced.push(`${path}: ${input}: ${value}`);
          }
        }
      }
    }

    expect(forwarded).toBeGreaterThan(0);
    expect(uncoerced).toEqual([]);
  });

  it.each([
    ["edge", "publish.yml", "$GITHUB_SHA"],
    ["stable", "release.yml", "$SOURCE_SHA"]
  ])(
    "publishes the complete tree and validates the %s source",
    (_channel, file, source) => {
      const workflow = parseYaml(
        readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8")
      );
      const scripts = runScripts(workflow);
      const commitScript = scripts.find((script) =>
        script.includes("verified-git.mjs commit")
      );
      const validationScript = scripts.find((script) =>
        script.includes("validate-plugin-dist.mjs")
      );

      expect(commitScript).toContain('--path ".github/extension"');
      expect(validationScript).toContain(`--source "${source}"`);

      // Every release branch has the same shape, whichever plugin it carries:
      // the install unit, the plugin metadata beside it, and the catalog.
      expect(commitScript).toContain(
        '--path "$PLUGIN_DIST=$PLUGIN_PUBLISH_DIR"'
      );
      expect(commitScript).toContain(
        '--path "$PLUGIN_DIST/plugin.json=$PLUGIN_DIR/plugin.json"'
      );
      expect(commitScript).toContain(
        '--path "$PLUGIN_DIST/README.md=$PLUGIN_DIR/README.md"'
      );
      expect(commitScript).toContain('--path "$MANIFEST"');
    }
  );
});
