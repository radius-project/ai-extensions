import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AWS_FILE,
  DELETE_AZURE_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_GUARD_STEP_NAME,
  DELETE_RADIUS_REF,
  RADIUS_REF,
  generateDeleteWorkflow
} from "./delete.js";

// Minimal stand-ins for the delete templates the generator fills. The
// application-delete templates are fetched from radius-project/radius; the
// environment-delete templates (dispatcher + provider) are static ai-extensions
// assets. The dispatchers only use the workflow_dispatch `{{ENV}}` default; the
// provider workflows also pin their composite actions to `{{RADIUS_REF}}`, and
// the environment provider additionally carries the ai-extensions-owned guard
// step whose name is a load-bearing contract.
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
  [DELETE_ENV_DISPATCHER_FILE]: `name: delete-environment
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
  [DELETE_ENV_AZURE_FILE]: `name: delete-environment-azure
on:
  workflow_call:
env:
  ENVIRONMENT: "{{ENV}}"
jobs:
  delete:
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
      - name: ${DELETE_ENV_GUARD_STEP_NAME}
        run: rad application list --output json
`,
  [DELETE_AZURE_FILE]: `name: delete-azure
on:
  workflow_call:
env:
  ENVIRONMENT: "{{ENV}}"
jobs:
  delete:
    steps:
      - uses: radius-project/ai-extensions/.github/extension/actions/delete-resource@{{RADIUS_REF}}
`,
  [DELETE_AWS_FILE]: `name: delete-aws
on:
  workflow_call:
env:
  ENVIRONMENT: "{{ENV}}"
jobs:
  delete:
    steps:
      - uses: radius-project/ai-extensions/.github/extension/actions/delete-resource@{{RADIUS_REF}}
`
};

const ALL_FILES = [
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE
];

// `delete.ts` resolves DELETE_RADIUS_REF at module load, so the tests that
// exercise it reload the module under a stubbed environment. Cleanup is
// file-scoped so no suite can leak a stubbed var or a reset module registry
// into the next one.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("delete workflow constants", () => {
  it("names the committed dispatcher and provider workflow files", () => {
    expect(DELETE_APP_DISPATCHER_FILE).toBe("delete-application.yml");
    expect(DELETE_AZURE_FILE).toBe("delete-azure.yml");
    expect(DELETE_AWS_FILE).toBe("delete-aws.yml");
    expect(DELETE_ENV_DISPATCHER_FILE).toBe("delete-environment.yml");
    expect(DELETE_ENV_AZURE_FILE).toBe("delete-environment-azure.yml");
  });

  it("keeps the environment guard step name a stable contract", () => {
    expect(DELETE_ENV_GUARD_STEP_NAME).toBe(
      "Guard - environment has no deployed applications"
    );
  });

  it("defaults the delete template ref to the shared radius ref", async () => {
    // Loaded with RADIUS_DELETE_REF explicitly cleared rather than trusting the
    // ambient environment: `delete.ts` reads the var at module load, and its own
    // comment invites developers to export it, which would otherwise turn this
    // into a spurious failure on their machine.
    vi.stubEnv("RADIUS_DELETE_REF", undefined);
    vi.resetModules();

    const reloaded = await import("./delete.js");

    expect(reloaded.DELETE_RADIUS_REF).toBe(reloaded.RADIUS_REF);
  });
});

describe("DELETE_RADIUS_REF override", () => {
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
  it("emits both dispatchers plus every provider workflow", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    expect(Object.keys(files).sort()).toEqual([...ALL_FILES].sort());
  });

  it("fills the environment placeholder in every file", () => {
    const files = generateDeleteWorkflow("staging", BASE_TEMPLATES);

    expect(files[DELETE_APP_DISPATCHER_FILE]).toContain('default: "staging"');
    expect(files[DELETE_ENV_DISPATCHER_FILE]).toContain('default: "staging"');
    expect(files[DELETE_ENV_DISPATCHER_FILE]).not.toContain("{{ENV}}");
    expect(files[DELETE_AZURE_FILE]).toContain('ENVIRONMENT: "staging"');
    expect(files[DELETE_AWS_FILE]).toContain('ENVIRONMENT: "staging"');
  });

  it("pins each provider workflow's composite action to the delete ref", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    for (const file of [
      DELETE_AZURE_FILE,
      DELETE_AWS_FILE,
      DELETE_ENV_AZURE_FILE
    ]) {
      expect(files[file]).toContain(
        `radius-project/ai-extensions/.github/extension/actions/delete-resource@${DELETE_RADIUS_REF}`
      );
      expect(files[file]).not.toContain("{{RADIUS_REF}}");
    }
  });

  it("fills the environment-delete provider and keeps the guard step name", () => {
    const files = generateDeleteWorkflow("prod", BASE_TEMPLATES);

    expect(files[DELETE_ENV_AZURE_FILE]).toContain(
      `delete-resource@${DELETE_RADIUS_REF}`
    );
    expect(files[DELETE_ENV_AZURE_FILE]).not.toContain("{{RADIUS_REF}}");
    expect(files[DELETE_ENV_AZURE_FILE]).toContain(
      `name: ${DELETE_ENV_GUARD_STEP_NAME}`
    );
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

  it.each(ALL_FILES)(
    "fails closed when the %s template is missing",
    (missing) => {
      const templates: Record<string, string> = { ...BASE_TEMPLATES };
      delete templates[missing];

      expect(() => generateDeleteWorkflow("prod", templates)).toThrow(
        `Missing delete template "${missing}"`
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
      `radius-project/ai-extensions/.github/extension at "${DELETE_RADIUS_REF}"`
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
