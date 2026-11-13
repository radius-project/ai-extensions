import { describe, expect, it } from "vitest";
import { azure } from "../platforms/azure.js";
import { aws } from "../platforms/aws.js";
import { RADIUS_REF } from "./deploy.js";
import {
  VERIFY_AWS_FILE,
  VERIFY_AZURE_FILE,
  generateVerifyWorkflow,
  verifyTemplateFile
} from "./verify.js";
import {
  AKS_TOKEN_INPUTS,
  AKS_TOKEN_STEP,
  aksTokenAction,
  expectNoAksTokenHandling,
  readCommittedTemplate,
  stepNamed,
  workflowSteps
} from "../../test/support/committed-workflows.js";

// Minimal stand-ins for the upstream verify templates. They mirror the two
// placeholders the real templates use: the workflow_dispatch `{{ENV}}` default
// and the `{{RADIUS_REF}}` pinned into the verify-ghcr-push action reference.
const AZURE_TEMPLATE = `name: Verify Azure credentials
on:
  push:
    branches:
      - "radius/setup-**"
    paths:
      - ".github/workflows/radius-verify-credentials.yml"
  workflow_dispatch:
    inputs:
      environment:
        default: "{{ENV}}"
jobs:
  verify:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment || '{{ENV}}' }}
    steps:
      - uses: radius-project/ai-extensions/.github/extension/actions/verify-ghcr-push@{{RADIUS_REF}}
        with:
          registry: \${{ secrets.REGISTRY }}
`;

const AWS_TEMPLATE = AZURE_TEMPLATE.replace("Azure", "AWS");

describe("verifyTemplateFile", () => {
  it("maps azure and aws to their upstream file names", () => {
    expect(verifyTemplateFile(azure)).toBe("verify-azure.yml");
    expect(verifyTemplateFile(aws)).toBe("verify-aws.yml");
  });
});

describe("generateVerifyWorkflow", () => {
  for (const [name, platform, template] of [
    ["azure", azure, AZURE_TEMPLATE],
    ["aws", aws, AWS_TEMPLATE]
  ] as const) {
    describe(name, () => {
      it("fills ENV and RADIUS_REF and pins the action to the Radius ref", () => {
        const yaml = generateVerifyWorkflow("prod", platform, template);

        expect(yaml).toContain('default: "prod"');
        expect(yaml).toContain(
          "environment: ${{ inputs.environment || 'prod' }}"
        );
        expect(yaml).toContain('"radius/setup-**"');
        expect(yaml).toContain(
          '".github/workflows/radius-verify-credentials.yml"'
        );
        expect(yaml).toContain(
          `radius-project/ai-extensions/.github/extension/actions/verify-ghcr-push@${RADIUS_REF}`
        );
      });

      it("leaves no unresolved template placeholders", () => {
        const yaml = generateVerifyWorkflow("prod", platform, template);

        expect(yaml).not.toContain("{{RADIUS_REF}}");
        expect(yaml).not.toContain("{{ENV}}");
        expect(yaml).not.toMatch(/\{\{[A-Z_]+\}\}/);
      });

      it("preserves GitHub Actions expressions", () => {
        const yaml = generateVerifyWorkflow("prod", platform, template);

        expect(yaml).toContain("${{ secrets.REGISTRY }}");
      });
    });
  }

  it("throws when the template is missing or empty", () => {
    expect(() => generateVerifyWorkflow("prod", azure, "")).toThrow(
      /Missing verify template/
    );
    expect(() => generateVerifyWorkflow("prod", azure, "   ")).toThrow(
      /Missing verify template/
    );
  });

  it("fails when the template has an unfillable placeholder", () => {
    const template = `${AZURE_TEMPLATE}      token: "{{UNKNOWN_TOKEN}}"\n`;

    expect(() => generateVerifyWorkflow("prod", azure, template)).toThrow(
      /Unresolved template placeholder\(s\).*\{\{UNKNOWN_TOKEN\}\}/
    );
  });
});

describe("the committed verify templates", () => {
  it("verifies AKS access with the deploy workflows' credential, not kubelogin", () => {
    const workflow = generateVerifyWorkflow(
      "prod",
      azure,
      readCommittedTemplate(VERIFY_AZURE_FILE)
    );
    const steps = workflowSteps(workflow);
    const names = steps.map((step) => step.name);
    const credentials = names.indexOf("Get AKS credentials");

    expect(
      steps.filter(
        (step) =>
          step.uses?.includes("kubelogin") || step.run?.includes("kubelogin")
      )
    ).toEqual([]);
    expect(names.slice(credentials, credentials + 3)).toEqual([
      "Get AKS credentials",
      AKS_TOKEN_STEP,
      "Verify AKS Access"
    ]);
    expect(steps[credentials].run).toContain(
      '--file "$RADIUS_TARGET_KUBECONFIG"'
    );
    expect(stepNamed(steps, AKS_TOKEN_STEP)).toEqual({
      name: AKS_TOKEN_STEP,
      uses: aksTokenAction(RADIUS_REF),
      with: AKS_TOKEN_INPUTS
    });
    expect(stepNamed(steps, "Verify AKS Access").run).toContain(
      'kubectl --kubeconfig "$RADIUS_TARGET_KUBECONFIG" cluster-info'
    );
  });

  it("leaves the AWS verify workflow without AKS token handling", () => {
    expectNoAksTokenHandling(
      generateVerifyWorkflow(
        "prod",
        aws,
        readCommittedTemplate(VERIFY_AWS_FILE)
      )
    );
  });
});
