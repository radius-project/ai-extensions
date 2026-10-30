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

  it("requests 500m CPU for the control-plane database", () => {
    const action = parseYaml(
      readFileSync(
        join(EXTENSION_ROOT, "actions", "setup-control-plane", "action.yml"),
        "utf8"
      )
    );
    const installStep = action.runs.steps.find(
      (step) => step.name === "Install Radius on control plane"
    );

    expect(installStep).toBeDefined();
    expect(
      installStep.run.match(
        /--set database\.resources\.requests\.cpu=[^\s\\]+/gu
      ) ?? []
    ).toEqual(["--set database.resources.requests.cpu=500m"]);
  });

  it("installs the pinned Radius release instead of edge", () => {
    const action = parseYaml(
      readFileSync(
        join(EXTENSION_ROOT, "actions", "setup-control-plane", "action.yml"),
        "utf8"
      )
    );
    const installStep = action.runs.steps.find(
      (step) => step.name === "Install Radius CLI"
    );

    expect(installStep).toBeDefined();
    expect(installStep.run).toContain(
      'bash "${GITHUB_ACTION_PATH}/install-radius.sh"'
    );
    expect(action.inputs["release-override"]).toMatchObject({
      required: false,
      default: ""
    });
    expect(installStep.env.RADIUS_RELEASE_OVERRIDE).toBe(
      "${{ inputs.release-override }}"
    );
    expect(installStep.env.RADIUS_INSTALL_REF).toMatch(/^v\d+\.\d+\.\d+$/u);
  });

  it("passes the selected environment's release override to every control-plane action", () => {
    const callers = readdirSync(EXTENSION_ROOT)
      .filter((file) => /\.ya?ml$/u.test(file))
      .flatMap((file) => {
        const workflow = parseYaml(
          readFileSync(join(EXTENSION_ROOT, file), "utf8")
        );
        return Object.values(workflow.jobs ?? {}).flatMap((job) =>
          (job.steps ?? [])
            .filter((step) =>
              step.uses?.startsWith(`${INTERNAL_PREFIX}setup-control-plane@`)
            )
            .map((step) => ({ file, job, step }))
        );
      });

    expect(callers.map(({ file }) => file).sort()).toEqual([
      "delete-aws.yml",
      "delete-azure.yml",
      "delete-environment-azure.yml",
      "run-rad-commands-aws.yml",
      "run-rad-commands-azure.yml"
    ]);
    for (const { file, job, step } of callers) {
      expect(job.environment, file).toBe("${{ inputs.environment }}");
      expect(step.with?.["release-override"], file).toBe(
        "${{ vars.RADIUS_RELEASE_OVERRIDE }}"
      );
    }
  });

  // A `workflow_dispatch` boolean input is a real boolean in the `inputs`
  // context, but older runners and `github.event.inputs` carry the string
  // "true"/"false" (actions/runner#1483). Comparing only to 'true' turns a real
  // `true` into false, so a forwarded value must accept both forms, e.g.
  // `${{ inputs.force == true || inputs.force == 'true' }}`.
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
          if (
            !value.includes(`inputs.${named} == true`) ||
            !value.includes(`inputs.${named} == 'true'`)
          ) {
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
