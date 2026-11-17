import {
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE
} from "@radius-project/core";

const provider = `name: "{{ENV}}"
on:
  workflow_call:
    inputs:
      environment: {}
      app_file:
        type: string
        required: false
        default: ''
      application:
        type: string
        default: unknown
env:
  APP_FILE: \${{ inputs.app_file || '{{APP_FILE}}' }}
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@fixture
      - id: identity
        uses: radius-project/ai-extensions/.github/extension/actions/validate-deployment-identity@{{RADIUS_REF}}
        with:
          application: \${{ inputs.application || 'unknown' }}
          app-file: \${{ env.APP_FILE }}
          rad-commands: \${{ inputs.rad_commands || vars.RADIUS_RAD_COMMANDS }}
      - uses: radius-project/ai-extensions/.github/extension/actions/run-rad-commands@{{RADIUS_REF}}
        with:
          app-file: \${{ env.APP_FILE }}
`;

export const deploymentTemplates: Readonly<Record<string, string>> = {
  [DEPLOY_DISPATCHER_FILE]: `name: "{{ENV}}/{{APP_FILE}}"
run-name: Radius - Deploy \${{ inputs.environment }} [radius:v1 app=\${{ inputs.application || 'unknown' }}] \${{ inputs.correlation_id }}
on:
  workflow_dispatch:
    inputs:
      environment: {}
      correlation_id:
        type: string
        required: false
        default: ''
      application:
        type: string
        default: unknown
      app_file:
        type: string
        required: false
        default: ''
  workflow_run:
    workflows: [verify]
jobs:
  azure:
    uses: ./.github/workflows/${DEPLOY_AZURE_FILE}
    with:
      app_file: \${{ inputs.app_file }}
      application: \${{ inputs.application || 'unknown' }}
  aws:
    uses: ./.github/workflows/${DEPLOY_AWS_FILE}
    with:
      app_file: \${{ inputs.app_file }}
      application: \${{ inputs.application || 'unknown' }}
`,
  [DEPLOY_AZURE_FILE]: provider,
  [DEPLOY_AWS_FILE]: provider
};
