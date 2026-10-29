import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  AWS_RADIUS_RELEASE,
  AWS_RADIUS_RELEASE_OVERRIDE
} from "./aws-radius-release.js";
import {
  DEPLOY_AWS_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE,
  generateDeployWorkflow
} from "./deploy.js";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AWS_FILE,
  DELETE_AZURE_FILE,
  DELETE_ENV_AWS_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  generateDeleteWorkflow
} from "./delete.js";

const template = (file: string): string =>
  readFileSync(
    new URL(`../../../../.github/extension/${file}`, import.meta.url),
    "utf8"
  );

const templates = (files: readonly string[]): Record<string, string> =>
  Object.fromEntries(files.map((file) => [file, template(file)]));

const deploy = generateDeployWorkflow(
  "prod",
  ".radius/app.bicep",
  templates([DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE])
);
const remove = generateDeleteWorkflow(
  "prod",
  templates([
    DELETE_APP_DISPATCHER_FILE,
    DELETE_ENV_DISPATCHER_FILE,
    DELETE_ENV_AZURE_FILE,
    DELETE_AZURE_FILE,
    DELETE_ENV_AWS_FILE,
    DELETE_AWS_FILE
  ])
);
const generated: Record<string, string> = { ...deploy, ...remove };

// The `release-override` each setup-control-plane step in a generated file passes.
function releaseOverrides(file: string): unknown[] {
  const workflow = parseYaml(generated[file] ?? "") as {
    jobs?: Record<
      string,
      { steps?: { uses?: string; with?: Record<string, unknown> }[] }
    >;
  };
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? [])
      .filter((step) => step.uses?.includes("/setup-control-plane@"))
      .map((step) => step.with?.["release-override"])
  );
}

// GitHub's `a || 'b'` yields `a` when it is a non-empty string and `b`
// otherwise. Evaluate the one shape the AWS workflows use.
function evaluate(expression: string, variable: string | undefined): string {
  const match =
    /^\$\{\{ vars\.RADIUS_RELEASE_OVERRIDE \|\| '((?:[^']|'')*)' \}\}$/u.exec(
      expression
    );
  if (!match) throw new Error(`unexpected expression ${expression}`);
  return variable || (match[1] ?? "").replaceAll("''", "'");
}

describe("the AWS Radius runtime default", () => {
  it("is edge at a full commit and installer checksum that install-radius.sh accepts", () => {
    expect(AWS_RADIUS_RELEASE.tag).toBe("edge");
    expect(AWS_RADIUS_RELEASE.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(AWS_RADIUS_RELEASE.checksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.parse(AWS_RADIUS_RELEASE_OVERRIDE)).toEqual(AWS_RADIUS_RELEASE);
    // It is embedded in a single-quoted expression literal on one line.
    expect(AWS_RADIUS_RELEASE_OVERRIDE).not.toMatch(/['\n]/u);
  });

  it.each([DEPLOY_AWS_FILE, DELETE_AWS_FILE, DELETE_ENV_AWS_FILE])(
    "is what %s installs unless the environment sets RADIUS_RELEASE_OVERRIDE",
    (file) => {
      const overrides = releaseOverrides(file);
      expect(overrides).toHaveLength(1);
      const [expression] = overrides as string[];
      expect(JSON.parse(evaluate(expression ?? "", undefined))).toEqual(
        AWS_RADIUS_RELEASE
      );
      expect(evaluate(expression ?? "", "")).toBe(AWS_RADIUS_RELEASE_OVERRIDE);
      const chosen = '{"tag":"v0.63.0","commit":"c","checksum":"d"}';
      expect(evaluate(expression ?? "", chosen)).toBe(chosen);
    }
  );

  it.each([DEPLOY_AZURE_FILE, DELETE_AZURE_FILE, DELETE_ENV_AZURE_FILE])(
    "leaves %s on the shared release default",
    (file) => {
      expect(releaseOverrides(file)).toEqual([
        "${{ vars.RADIUS_RELEASE_OVERRIDE }}"
      ]);
      expect(generated[file]).not.toContain(AWS_RADIUS_RELEASE.commit);
    }
  );

  it("cannot be replaced by caller template vars", () => {
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      {
        [DEPLOY_DISPATCHER_FILE]: "a",
        [DEPLOY_AZURE_FILE]: "b",
        [DEPLOY_AWS_FILE]: "release: '{{AWS_RADIUS_RELEASE_OVERRIDE}}'\n"
      },
      { templateVars: { AWS_RADIUS_RELEASE_OVERRIDE: "{}" } }
    );
    expect(files[DEPLOY_AWS_FILE]).toBe(
      `release: '${AWS_RADIUS_RELEASE_OVERRIDE}'\n`
    );
  });
});
