import type { ComputePlatform } from "../platforms/index.js";

/** Generate the credential-verification GitHub Actions workflow YAML. */
export function generateVerifyWorkflow(env: string, platform: ComputePlatform): string {
  const steps = platform.verifyWorkflowSteps;
  const providerId = platform.id;
  return `name: Radius - Verify Credentials
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Environment to verify'
        required: true
        default: '${env}'

permissions:
  id-token: write
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment }}
    steps:
      - uses: actions/checkout@v4
${steps}
      - name: Summary
        run: |
          echo "## ✅ Credentials Verified" >> \$GITHUB_STEP_SUMMARY
          echo "Environment: \${{ inputs.environment }}" >> \$GITHUB_STEP_SUMMARY
          echo "Provider: ${providerId}" >> \$GITHUB_STEP_SUMMARY
`;
}
