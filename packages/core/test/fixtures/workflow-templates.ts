// Upstream workflow templates, in the shape core fetches from
// radius-project/radius/.github/extension. Trimmed to the placeholders and the
// job structure the generators are contracted to fill and preserve, so the
// fixtures stay readable while remaining valid GitHub Actions YAML.

const DISPATCH_HEADER = `on:
  workflow_dispatch:
    inputs:
      environment:
        description: Deploy environment
        required: true
        default: "{{ENV}}"
`;

export const VERIFY_TEMPLATE = (
  provider: string
): string => `name: Verify ${provider} credentials
${DISPATCH_HEADER}
jobs:
  verify:
    runs-on: ubuntu-latest
    environment: \${{ inputs.environment }}
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: radius-project/radius/.github/actions/verify-ghcr-push@{{RADIUS_REF}}
`;

export const DEPLOY_DISPATCHER_TEMPLATE = `name: Deploy application
${DISPATCH_HEADER}
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      provider: \${{ steps.detect.outputs.provider }}
    steps:
      - id: detect
        run: echo "provider=azure" >> "$GITHUB_OUTPUT"
  azure:
    needs: detect
    if: needs.detect.outputs.provider == 'azure'
    uses: ./.github/workflows/run-rad-commands-azure.yml
    with:
      app_file: "{{APP_FILE}}"
  aws:
    needs: detect
    if: needs.detect.outputs.provider == 'aws'
    uses: ./.github/workflows/run-rad-commands-aws.yml
    with:
      app_file: "{{APP_FILE}}"
`;

export const DEPLOY_PROVIDER_TEMPLATE = (
  provider: string
): string => `name: Deploy on ${provider}
on:
  workflow_call:
    inputs:
      app_file:
        type: string
        required: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: "{{ENV}}"
    steps:
      - uses: actions/checkout@v4
      - uses: radius-project/radius/.github/actions/rad-install@{{RADIUS_REF}}
      - name: Build images
        env:
          ARCH_MODE: "{{TARGET_CLUSTER_ARCH_MODE}}"
          PLATFORMS: "{{TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS}}"
        run: rad deploy "\${{ inputs.app_file }}"
`;

export const DELETE_DISPATCHER_TEMPLATE = `name: Delete application
${DISPATCH_HEADER}
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      provider: \${{ steps.detect.outputs.provider }}
    steps:
      - id: detect
        run: echo "provider=azure" >> "$GITHUB_OUTPUT"
  azure:
    needs: detect
    if: needs.detect.outputs.provider == 'azure'
    uses: ./.github/workflows/delete-azure.yml
  aws:
    needs: detect
    if: needs.detect.outputs.provider == 'aws'
    uses: ./.github/workflows/delete-aws.yml
`;

export const DELETE_PROVIDER_TEMPLATE = (
  provider: string
): string => `name: Delete on ${provider}
on:
  workflow_call:
jobs:
  delete:
    runs-on: ubuntu-latest
    environment: "{{ENV}}"
    steps:
      - uses: radius-project/radius/.github/actions/delete-resource@{{RADIUS_REF}}
`;

// The environment-delete dispatcher and its Azure provider are static
// ai-extensions assets (not fetched from radius-project/radius), so the fixtures
// mirror their shape: the dispatcher only fills `{{ENV}}`, and the provider
// carries the ai-extensions-owned guard step alongside a `{{RADIUS_REF}}`-pinned
// composite action.
export const DELETE_ENV_DISPATCHER_TEMPLATE = `name: Delete environment
${DISPATCH_HEADER}
jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      provider: \${{ steps.detect.outputs.provider }}
    steps:
      - id: detect
        run: echo "provider=azure" >> "$GITHUB_OUTPUT"
  azure:
    needs: detect
    if: needs.detect.outputs.provider == 'azure'
    uses: ./.github/workflows/delete-environment-azure.yml
`;

export const DELETE_ENV_PROVIDER_TEMPLATE = `name: Delete environment on Azure
on:
  workflow_call:
jobs:
  delete:
    runs-on: ubuntu-latest
    environment: "{{ENV}}"
    steps:
      - uses: radius-project/radius/.github/extension/actions/delete-resource@{{RADIUS_REF}}
      - name: Guard - environment has no deployed applications
        run: rad application list --output json
`;
