import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS,
  DEFAULT_TARGET_CLUSTER_ARCH_MODE,
  DEPLOY_AWS_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS,
  DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE,
  RADIUS_BUILD_ARCH_MODE_VAR,
  RADIUS_BUILD_PLATFORMS_VAR,
  RADIUS_REF,
  RADIUS_WORKFLOW_DIR,
  RADIUS_WORKFLOW_REPO,
  defaultDeployTemplateVars,
  generateDeployWorkflow
} from "./deploy.js";

const BASE_TEMPLATES = {
  [DEPLOY_DISPATCHER_FILE]: `name: deploy
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
  [DEPLOY_AZURE_FILE]: `name: deploy-azure
env:
  APP_FILE: "{{APP_FILE}}"
jobs:
  deploy:
    steps:
      - uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}
`,
  [DEPLOY_AWS_FILE]: `name: deploy-aws
env:
  APP_FILE: "{{APP_FILE}}"
jobs:
  deploy:
    steps:
      - uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}
`
};

const EXTRA_VAR_TEMPLATES = {
  ...BASE_TEMPLATES,
  [DEPLOY_DISPATCHER_FILE]: `name: deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        default: "{{ENV}}"
jobs:
  detect:
    env:
      TARGET_CLUSTER_ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"
      TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}"
    steps:
      - run: echo \
          \${{ github.sha }}
`,
  [DEPLOY_AZURE_FILE]: `name: deploy-azure
env:
  APP_FILE: "{{APP_FILE}}"
  TARGET_CLUSTER_ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"
  TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}"
jobs:
  deploy:
    steps:
      - uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}
`
};

describe("generateDeployWorkflow", () => {
  it("fills the reserved placeholders in every workflow", () => {
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      BASE_TEMPLATES
    );

    expect(files[DEPLOY_DISPATCHER_FILE]).toContain('default: "prod"');
    expect(files[DEPLOY_AZURE_FILE]).toContain('APP_FILE: ".radius/app.bicep"');
    expect(files[DEPLOY_AWS_FILE]).toContain(
      `radius-project/radius/.github/extension/actions/run-rad-commands@${RADIUS_REF}`
    );
  });

  it("fills caller supplied extra template vars", () => {
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      EXTRA_VAR_TEMPLATES,
      {
        templateVars: {
          [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE]: "multi_arch_only",
          [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS]:
            "linux/arm64"
        }
      }
    );

    expect(files[DEPLOY_DISPATCHER_FILE]).toContain(
      'TARGET_CLUSTER_ARCH_MODE: "multi_arch_only"'
    );
    expect(files[DEPLOY_AZURE_FILE]).toContain(
      'TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "linux/arm64"'
    );
    expect(files[DEPLOY_DISPATCHER_FILE]).toContain("${{ github.sha }}");
  });

  it("fills default architecture template vars with runtime GitHub variable expressions", () => {
    // Derive the expected expressions from the exported constants so this test
    // fails if the runtime template expressions ever drift from the documented
    // defaults / override-variable names.
    const modeExpr = `\${{ vars.${RADIUS_BUILD_ARCH_MODE_VAR} || '${DEFAULT_TARGET_CLUSTER_ARCH_MODE}' }}`;
    const platformsExpr = `\${{ vars.${RADIUS_BUILD_PLATFORMS_VAR} || '${DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}' }}`;
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      EXTRA_VAR_TEMPLATES
    );

    expect(defaultDeployTemplateVars()).toEqual({
      [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE]: modeExpr,
      [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS]:
        platformsExpr
    });
    expect(files[DEPLOY_DISPATCHER_FILE]).toContain(
      `TARGET_CLUSTER_ARCH_MODE: "${modeExpr}"`
    );
    expect(files[DEPLOY_AZURE_FILE]).toContain(
      `TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "${platformsExpr}"`
    );
  });

  it("does not let caller supplied vars override reserved placeholders", () => {
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      EXTRA_VAR_TEMPLATES,
      {
        templateVars: {
          ENV: "staging",
          APP_FILE: "override.bicep",
          RADIUS_REF: "feature/ref",
          [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE]: "single_arch_only",
          [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS]:
            "linux/arm64"
        }
      }
    );

    expect(files[DEPLOY_DISPATCHER_FILE]).toContain('default: "prod"');
    expect(files[DEPLOY_AZURE_FILE]).toContain('APP_FILE: ".radius/app.bicep"');
    expect(files[DEPLOY_AZURE_FILE]).toContain(
      `radius-project/radius/.github/extension/actions/run-rad-commands@${RADIUS_REF}`
    );
    expect(files[DEPLOY_DISPATCHER_FILE]).toContain(
      'TARGET_CLUSTER_ARCH_MODE: "single_arch_only"'
    );
  });

  it("fails when an unrelated template placeholder remains unresolved", () => {
    const templates = {
      ...EXTRA_VAR_TEMPLATES,
      [DEPLOY_AZURE_FILE]: `${EXTRA_VAR_TEMPLATES[DEPLOY_AZURE_FILE]}env2:\n  EXTRA_FLAG: "{{EXTRA_FLAG}}"\n`
    };

    expect(() =>
      generateDeployWorkflow("prod", ".radius/app.bicep", templates)
    ).toThrow(/Unresolved template placeholder\(s\).*\{\{EXTRA_FLAG\}\}/);
  });

  it("exports the documented architecture defaults", () => {
    expect(DEFAULT_TARGET_CLUSTER_ARCH_MODE).toBe("detect");
    expect(DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS).toBe(
      "linux/amd64,linux/arm64"
    );
  });

  it.each([DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE])(
    "fails closed when the %s template is missing",
    (missing) => {
      const templates: Record<string, string> = { ...BASE_TEMPLATES };
      delete templates[missing];

      expect(() =>
        generateDeployWorkflow("prod", ".radius/app.bicep", templates)
      ).toThrow(new RegExp(`Missing deploy template "${missing}"`));
    }
  );

  it("fails closed when a supplied template body is empty", () => {
    const templates = { ...BASE_TEMPLATES, [DEPLOY_AZURE_FILE]: "" };

    expect(() =>
      generateDeployWorkflow("prod", ".radius/app.bicep", templates)
    ).toThrow(/Missing deploy template "run-rad-commands-azure\.yml"/);
  });

  it("names the upstream template source and ref in the missing-template error", () => {
    expect(() =>
      generateDeployWorkflow("prod", ".radius/app.bicep", {})
    ).toThrow(
      new RegExp(
        `${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR} at "${RADIUS_REF}"`
      )
    );
  });

  it("does not mutate the supplied templates or caller template vars", () => {
    const templates = { ...BASE_TEMPLATES };
    const templateVars = {
      [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE]: "x"
    };
    const templatesSnapshot = JSON.stringify(templates);

    generateDeployWorkflow("prod", ".radius/app.bicep", templates, {
      templateVars
    });

    expect(JSON.stringify(templates)).toBe(templatesSnapshot);
    expect(templateVars).toEqual({
      [DEPLOY_TEMPLATE_VAR_TARGET_CLUSTER_ARCH_MODE]: "x"
    });
  });
});

// Fixtures that FAITHFULLY MIRROR the quoting of the real radius-project/radius
// deploy templates (`.github/extension/run-rad-commands*.yml`), unlike the
// inline fixtures above which use double quotes throughout. Reproducing the real
// mix is what lets these tests catch the issue #407 class of bug:
//   - plain values are injected into SINGLE-quoted scalars (`APP_FILE`, `ENV`)
//     and into unquoted GHA expressions (`APP_IMAGE`, dispatcher `environment`);
//   - the arch placeholders are injected into DOUBLE-quoted scalars, because the
//     value core injects is itself a GHA expression whose default is
//     single-quoted (`${{ vars.X || 'detect' }}`). A single-quoted scalar there
//     nests the quotes and produces invalid YAML (the #407 regression).
const REALISTIC_TEMPLATES = {
  [DEPLOY_DISPATCHER_FILE]: `name: deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        default: '{{ENV}}'
jobs:
  detect:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment || '{{ENV}}' }}
    env:
      TARGET_CLUSTER_ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"
      TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}"
    steps:
      - run: echo \${{ github.sha }}
`,
  [DEPLOY_AZURE_FILE]: `name: deploy-azure
env:
  APP_FILE: '{{APP_FILE}}'
  APP_IMAGE: \${{ inputs.image || github.sha || 'latest' }}
  TARGET_CLUSTER_ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"
  TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}"
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}
`,
  [DEPLOY_AWS_FILE]: `name: deploy-aws
env:
  APP_FILE: '{{APP_FILE}}'
  APP_IMAGE: \${{ inputs.image || github.sha || 'latest' }}
  TARGET_CLUSTER_ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"
  TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS: "{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}"
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: radius-project/radius/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}
`
};

describe("generateDeployWorkflow YAML validity", () => {
  // Positive guard: with the real templates' quoting and the default arch vars
  // (single-quoted GHA expressions), every rendered file must parse as valid
  // YAML. Prior tests only did `.toContain(...)` substring checks and never
  // parsed the output, so they stayed green against invalid YAML.
  it("renders valid YAML for every file when arch scalars are double-quoted", () => {
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      REALISTIC_TEMPLATES
    );

    for (const [name, body] of Object.entries(files)) {
      expect(
        () => parseYaml(body),
        `${name} should parse as valid YAML`
      ).not.toThrow();
    }
  });

  // The injected GHA expression (with its single-quoted default) must survive
  // substitution intact inside the double-quoted scalar.
  it("preserves the injected GHA arch expressions as YAML string values", () => {
    const files = generateDeployWorkflow(
      "prod",
      ".radius/app.bicep",
      REALISTIC_TEMPLATES
    );
    const azure = parseYaml(files[DEPLOY_AZURE_FILE]) as {
      env: Record<string, string>;
    };

    expect(azure.env.TARGET_CLUSTER_ARCH_MODE).toBe(
      `\${{ vars.${RADIUS_BUILD_ARCH_MODE_VAR} || '${DEFAULT_TARGET_CLUSTER_ARCH_MODE}' }}`
    );
    expect(azure.env.TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS).toBe(
      `\${{ vars.${RADIUS_BUILD_PLATFORMS_VAR} || '${DEFAULT_TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}' }}`
    );
    // The plain single-quoted scalars stay intact too.
    expect(azure.env.APP_FILE).toBe(".radius/app.bicep");
  });

  // Negative regression guard: this is exactly the #407 bug. When the arch
  // scalar is SINGLE-quoted (as the radius templates were before #12721), the
  // single-quoted default inside the injected GHA expression nests and YAML
  // terminates the scalar early, so the rendered file is invalid YAML. This test
  // locks in WHY the scalar must be double-quoted: if someone reintroduces the
  // single-quoted scalar (or an injected value that nests quotes), it fails.
  it("produces invalid YAML when an arch scalar is single-quoted (issue #407)", () => {
    const broken = {
      ...REALISTIC_TEMPLATES,
      [DEPLOY_AZURE_FILE]: REALISTIC_TEMPLATES[DEPLOY_AZURE_FILE].replace(
        'TARGET_CLUSTER_ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"',
        "TARGET_CLUSTER_ARCH_MODE: '{{TARGET_CLUSTER_ARCH_MODE}}'"
      )
    };
    // Substitution still succeeds (no unresolved placeholder), so generation
    // does not throw — the breakage only surfaces when the YAML is parsed.
    const files = generateDeployWorkflow("prod", ".radius/app.bicep", broken);

    expect(() => parseYaml(files[DEPLOY_AZURE_FILE])).toThrow();
  });
});
