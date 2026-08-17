import { describe, expect, it } from "vitest";
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
});
