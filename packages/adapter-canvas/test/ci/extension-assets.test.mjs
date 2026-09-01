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
    }
  );
});
