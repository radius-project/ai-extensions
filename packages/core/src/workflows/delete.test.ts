import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AWS_FILE,
  DELETE_AZURE_FILE,
  DELETE_RADIUS_REF,
  RADIUS_REF,
  generateDeleteWorkflow
} from "./delete.js";

const BASE_TEMPLATES = {
  [DELETE_APP_DISPATCHER_FILE]: `name: delete-application
on:
  workflow_dispatch:
    inputs:
      environment:
        default: "{{ENV}}"
jobs:
  detect:
    steps:
      - run: echo \
          \${{ github.sha }}
`,
  [DELETE_AZURE_FILE]: `name: delete-azure
on:
  workflow_call:
env:
  ENVIRONMENT: "{{ENV}}"
jobs:
  delete:
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
`,
  [DELETE_AWS_FILE]: `name: delete-aws
on:
  workflow_call:
env:
  ENVIRONMENT: "{{ENV}}"
jobs:
  delete:
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
`
};

describe("delete workflow constants", () => {
  it("names the committed dispatcher and provider workflow files", () => {
    expect(DELETE_APP_DISPATCHER_FILE).toBe("delete-application.yml");
    expect(DELETE_AZURE_FILE).toBe("delete-azure.yml");
    expect(DELETE_AWS_FILE).toBe("delete-aws.yml");
  });

  it("defaults the delete template ref to the shared radius ref", () => {
    // No RADIUS_DELETE_REF override is set in the test environment, so the
    // delete templates track the same ref the deploy templates are fetched at.
    expect(DELETE_RADIUS_REF).toBe(RADIUS_REF);
  });
});

describe("DELETE_RADIUS_REF override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("re-pins the delete templates from RADIUS_DELETE_REF", async () => {
    vi.stubEnv("RADIUS_DELETE_REF", "abc1234");
    vi.resetModules();

    const reloaded = await import("./delete.js");

    expect(reloaded.DELETE_RADIUS_REF).toBe("abc1234");
    const files = reloaded.generateDeleteWorkflow("prod", BASE_TEMPLATES);
    expect(files[DELETE_AZURE_FILE]).toContain("delete-resource@abc1234");
  });

  it("falls back to the shared radius ref when the override is blank", async () => {
    vi.stubEnv("RADIUS_DELETE_REF", "");
    vi.resetModules();

    const reloaded = await import("./delete.js");

    expect(reloaded.DELETE_RADIUS_REF).toBe(RADIUS_REF);
  });
});

describe("generateDeleteWorkflow", () => {
  it("returns exactly the dispatcher and both provider workflows", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    expect(Object.keys(files).sort()).toEqual(
      [DELETE_APP_DISPATCHER_FILE, DELETE_AWS_FILE, DELETE_AZURE_FILE].sort()
    );
  });

  it("fills the environment placeholder in every file", () => {
    const files = generateDeleteWorkflow("staging", BASE_TEMPLATES);

    expect(files[DELETE_APP_DISPATCHER_FILE]).toContain('default: "staging"');
    expect(files[DELETE_AZURE_FILE]).toContain('ENVIRONMENT: "staging"');
    expect(files[DELETE_AWS_FILE]).toContain('ENVIRONMENT: "staging"');
  });

  it("pins each provider workflow's composite action to the delete ref", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    for (const file of [DELETE_AZURE_FILE, DELETE_AWS_FILE]) {
      expect(files[file]).toContain(
        `radius-project/radius/.github/extension/actions/delete-resource@${DELETE_RADIUS_REF}`
      );
      expect(files[file]).not.toContain("{{RADIUS_REF}}");
    }
  });

  it("leaves GitHub Actions expressions in the dispatcher untouched", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    expect(files[DELETE_APP_DISPATCHER_FILE]).toContain("${{ github.sha }}");
  });

  it("renders valid YAML for every generated file", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    for (const [name, body] of Object.entries(files)) {
      const parsed = parseYaml(body) as Record<string, unknown>;
      expect(parsed, `${name} should parse as YAML`).toBeTruthy();
      expect(parsed.jobs).toBeDefined();
    }
  });

  it("accepts an empty environment name and still resolves the placeholder", () => {
    const files = generateDeleteWorkflow("", BASE_TEMPLATES);

    expect(files[DELETE_APP_DISPATCHER_FILE]).toContain('default: ""');
    expect(files[DELETE_AZURE_FILE]).not.toContain("{{ENV}}");
  });

  it.each([DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE, DELETE_AWS_FILE])(
    "fails closed when the %s template is missing",
    (missing) => {
      const templates: Record<string, string> = { ...BASE_TEMPLATES };
      delete templates[missing];

      expect(() => generateDeleteWorkflow("prod", templates)).toThrow(
        new RegExp(`Missing delete template "${missing}"`)
      );
    }
  );

  it("fails closed when a supplied template body is empty", () => {
    const templates = { ...BASE_TEMPLATES, [DELETE_AWS_FILE]: "" };

    expect(() => generateDeleteWorkflow("prod", templates)).toThrow(
      /Missing delete template "delete-aws\.yml"/
    );
  });

  it("names the upstream source in the missing-template error", () => {
    expect(() => generateDeleteWorkflow("prod", {})).toThrow(
      new RegExp(
        `radius-project/radius/\\.github/extension at "${DELETE_RADIUS_REF}"`
      )
    );
  });

  it("fails when an unrelated placeholder is left unresolved", () => {
    const templates = {
      ...BASE_TEMPLATES,
      [DELETE_AZURE_FILE]: `${BASE_TEMPLATES[DELETE_AZURE_FILE]}      registry: "{{REGISTRY}}"\n`
    };

    expect(() => generateDeleteWorkflow("prod", templates)).toThrow(
      /Unresolved template placeholder\(s\) \{\{REGISTRY\}\} remain in delete workflow "delete-azure\.yml"/
    );
  });

  it("does not fill RADIUS_REF in the dispatcher, which owns no composite action", () => {
    const templates = {
      ...BASE_TEMPLATES,
      [DELETE_APP_DISPATCHER_FILE]: `${BASE_TEMPLATES[DELETE_APP_DISPATCHER_FILE]}      ref: "{{RADIUS_REF}}"\n`
    };

    expect(() => generateDeleteWorkflow("prod", templates)).toThrow(
      /\{\{RADIUS_REF\}\} remain in delete workflow "delete-application\.yml"/
    );
  });

  it("does not mutate the supplied templates", () => {
    const templates = { ...BASE_TEMPLATES };
    const snapshot = JSON.stringify(templates);

    generateDeleteWorkflow("prod", templates);

    expect(JSON.stringify(templates)).toBe(snapshot);
  });
});
