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
const DATABASE_CPU_REQUEST =
  /--set\s+database\.resources\.requests\.cpu=(\S+)/u;

function millicores(value) {
  return value.endsWith("m") ?
      Number(value.slice(0, -1))
    : Number(value) * 1000;
}

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
    (channel, file, source) => {
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

      // The complete install unit belongs only under plugins/<name>. Publishing
      // the same tree under extensions/<name> creates nested extensions, skills,
      // and workflows directories that are not release-root components.
      expect(commitScript).not.toContain("PLUGIN_PUBLISH_DIR");
      expect(commitScript).toContain('--path "$PLUGIN_DIST=$PLUGIN_DIR"');
      expect(commitScript).toContain('--path "$MANIFEST"');
      if (channel === "stable") {
        expect(commitScript).toContain('--arg path "$PLUGIN_DIR"');
        expect(commitScript).toContain(".source.path = $path");
      }
    }
  );

  it("re-baselines edge when a reachable source is no longer in main history", () => {
    const workflow = parseYaml(
      readFileSync(
        join(REPO_ROOT, ".github", "workflows", "publish.yml"),
        "utf8"
      )
    );
    const publishScript = runScripts(workflow).find((script) =>
      script.includes("Published edge source")
    );

    expect(publishScript).toContain(
      'git fetch --no-tags origin "+refs/heads/main:refs/remotes/origin/main"'
    );
    expect(publishScript).toContain(
      '! git merge-base --is-ancestor "$current_source" refs/remotes/origin/main'
    );
    expect(publishScript).toContain(
      'if [ "$GITHUB_SHA" != "$(git rev-parse refs/remotes/origin/main)" ]; then'
    );
  });

  // GitHub gives a standard runner 2 vCPU in a private or internal repository
  // and 4 vCPU in a public one. The chart requests 2 CPUs for the
  // control-plane PostgreSQL, so on the private-repository runner it can never
  // be scheduled once BuildKit and the k3s system pods have taken their share.
  // PostgreSQL stays pending, UCP never becomes available, and the install
  // times out. Every install that enables the database has to request less
  // than the remaining budget. See radius-project/ai-extensions#794.
  it("requests little enough CPU to schedule the database on a 2-vCPU runner", () => {
    const RUNNER_MILLICORES = 2000;
    const COMPETING_REQUESTS = 200 + 100 + 100; // buildkit, CoreDNS, metrics-server

    const installs = filesUnder(EXTENSION_ROOT)
      .filter((path) => /\.ya?ml$/u.test(path))
      .flatMap((path) =>
        runScripts(parseYaml(readFileSync(path, "utf8")))
          .filter((script) => script.includes("rad install kubernetes"))
          .map((script) => ({ path, script }))
      );

    expect(installs.length).toBeGreaterThan(0);

    // Counted so that renaming the flag cannot make this test vacuously pass.
    let guarded = 0;
    for (const { path, script } of installs) {
      if (!script.includes("--set database.enabled=true")) continue;
      guarded++;
      const override = DATABASE_CPU_REQUEST.exec(script);
      expect(override, path).not.toBeNull();
      expect(millicores(override[1]), path).toBeLessThanOrEqual(
        RUNNER_MILLICORES - COMPETING_REQUESTS
      );
    }

    expect(guarded).toBeGreaterThan(0);
  });

  it("uses the completed pre-canonical release as the verification cutover", () => {
    const workflow = parseYaml(
      readFileSync(
        join(REPO_ROOT, ".github", "workflows", "release.yml"),
        "utf8"
      )
    );
    const completionScripts = runScripts(workflow).filter((script) =>
      script.includes("verified-git.mjs verify-completion")
    );
    const previousReleaseScript = workflow.jobs.prepare.steps.find(
      (step) => step.name === "Verify the previous release is complete"
    ).run;
    const cutover = 'if [ "${plugin}@${version}" = "radius@0.1.0" ]; then';

    expect(completionScripts).toHaveLength(3);
    expect(previousReleaseScript).toContain(cutover);
    expect(previousReleaseScript).toContain(
      "completion verification starts with its successor"
    );
    expect(previousReleaseScript.indexOf(cutover)).toBeLessThan(
      previousReleaseScript.indexOf("verified-git.mjs verify-completion")
    );
    expect(previousReleaseScript).toMatch(
      /if ! node scripts\/verified-git\.mjs verify-completion \\\n\s+--plugin "\$plugin" --version "\$version" >\/dev\/null 2>&1; then/u
    );
  });
});
