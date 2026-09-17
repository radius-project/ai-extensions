import { describe, expect, it } from "vitest";
import { azure } from "../platforms/azure.js";
import { aws } from "../platforms/aws.js";
import { RADIUS_REF } from "./deploy.js";
import { generateVerifyWorkflow, verifyTemplateFile } from "./verify.js";

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
