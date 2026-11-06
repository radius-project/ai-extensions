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
jobs:
  run:
    runs-on: ubuntu-latest
`;

export const deploymentTemplates: Readonly<Record<string, string>> = {
  [DEPLOY_DISPATCHER_FILE]: `name: "{{ENV}}/{{APP_FILE}}"
on:
  workflow_dispatch:
    inputs:
      environment: {}
  workflow_run:
    workflows: [verify]
jobs:
  azure:
    uses: ./.github/workflows/${DEPLOY_AZURE_FILE}
  aws:
    uses: ./.github/workflows/${DEPLOY_AWS_FILE}
`,
  [DEPLOY_AZURE_FILE]: provider,
  [DEPLOY_AWS_FILE]: provider
};
