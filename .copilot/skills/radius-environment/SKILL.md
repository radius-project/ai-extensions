---
name: radius-environment
description: Create and verify a Radius deploy environment (AWS or Azure) for a GitHub repository. Works both inside the Radius canvas extension and headlessly via the CLI. Use when the user asks to set up, configure, verify, or troubleshoot a Radius environment, cloud credentials, or the OIDC trust between GitHub Actions and AWS/Azure.
---

# Radius — Environment Setup

Create a GitHub Environment configured with the cloud credentials (variables + secrets) Radius needs to deploy applications. Supports AWS (OIDC via IAM Role) and Azure (OIDC via Workload Identity).

This skill is a convenience wrapper over the prose walkthrough in [`contributing-deploy-environments.md`](https://github.com/radius-project/radius/blob/main/docs/contributing/contributing-deploy-environments.md) in `radius-project/radius`. Follow that doc directly when neither the canvas nor this skill is available.

## Two ways to run this skill

This skill supports **two execution modes**. Pick one based on where you are running:

| | **Canvas extension** (interactive) | **CLI** (headless) |
| --- | --- | --- |
| **Choose when** | You are operating inside the Radius Copilot canvas and want a guided per-provider wizard with live verification status. | You are running headless — automation, scripts, CI, or an agent with no canvas — and want to set the environment variables and dispatch verification directly. |
| **How you set variables** | Fill the create-environment form; the canvas writes them as GitHub Environment variables. | `gh variable set <NAME> --env <env-name> --body <value>` for each variable below. |
| **How you verify** | The canvas commits `.github/workflows/verify-<provider>.yml` and dispatches it, streaming status live. | Ensure `verify-<provider>.yml` is committed, then `gh workflow run verify-<provider>.yml` and follow with `gh run watch`. |
| **Auth** | Uses the user's PAT in the extension's storage (auto-seeded from `gh auth token`); needs `workflow` scope to commit the verify workflow. | A logged-in `gh` CLI / token with `actions: write` **and** `workflow` scope to push the verify workflow. |

Both modes produce the **same** result: a GitHub Environment carrying the provider variables, verified end-to-end by the provider's `Radius - Verify Credentials` workflow. Only the data entry and dispatch differ.

## When to use this skill

- "Create a new Radius environment named X"
- "Set up Azure credentials for deploys"
- "Configure AWS for my Radius app"
- "Verify my deploy environment works"
- "Why is the verification workflow failing?"
- "Add a new environment 'staging' pointing at my AKS cluster"

## Flow

Per provider: collect the environment's cloud settings as GitHub Actions variables, then commit and dispatch the provider's verification workflow to confirm they work end to end.

### AWS

1. **Inputs**: env name, IAM Role ARN, AWS region, account ID, EKS cluster name, optional VPC + subnet IDs (required if the app uses `Radius.Data/mySqlDatabases`). Written as GitHub Environment variables (canvas form, or `gh variable set`).
2. **Credential + cluster verification**: commits/updates `.github/workflows/verify-aws.yml` and dispatches it. The workflow logs into AWS via OIDC and runs `aws sts get-caller-identity`, then runs `aws eks update-kubeconfig` for the EKS cluster and `kubectl cluster-info` to confirm cluster access. Status is polled and shown live in the canvas (or followed with `gh run watch` in CLI mode).

### Azure

1. **Inputs**: env name, AAD App (client) ID, tenant ID, subscription ID, resource group, AKS cluster name. Written as GitHub Environment variables (canvas form, or `gh variable set`).
2. **Credential + cluster verification**: commits/updates `.github/workflows/verify-azure.yml` and dispatches it. The workflow runs `azure/login` via OIDC and `az account show`, then `az aks get-credentials` + `kubelogin convert-kubeconfig` + `kubectl cluster-info` to confirm AKS access. Status is polled and shown live in the canvas (or followed with `gh run watch` in CLI mode).

## How to invoke

### Canvas extension

When the user asks to create or set up a Radius environment, **open the canvas straight to the environment wizard**:

```text
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "environment", repo: "<owner/repo>" }
})
```

For credentials/OIDC setup:

```text
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "credentials", repo: "<owner/repo>" }
})
```

The popup lands directly on the create-environment form for the chosen provider. No navigation needed. Always use `instanceId: "radius-panel"` so only one Radius panel is ever open.

### CLI

Set the environment variables (see the lists below) and dispatch the verification workflow. Example for AWS:

```bash
gh variable set AWS_ROLE_ARN --env <env-name> --body <role-arn>
gh variable set AWS_REGION --env <env-name> --body <region>
gh variable set AWS_EKS_CLUSTER_NAME --env <env-name> --body <cluster>
# ...plus AWS_ACCOUNT_ID, RADIUS_VPC_ID, RADIUS_SUBNET_IDS as needed

gh workflow run verify-aws.yml -f environment=<env-name>
gh run watch
```

The `verify-<provider>.yml` workflow must already be committed to `.github/workflows/` (the canvas path commits it for you). Pushing it requires a token with `workflow` scope.

## Required variables on the GitHub Environment

The verification workflow reads only GitHub Actions **variables** (`vars`), never secrets. OIDC eliminates the need to store long-lived cloud credentials.

**AWS** — read by `verify-aws.yml`:

- `AWS_ROLE_ARN` — ARN of the IAM role the runner assumes via OIDC
- `AWS_REGION` — AWS region (e.g. `us-west-2`)
- `AWS_EKS_CLUSTER_NAME` — name of the EKS cluster the workflow verifies access to

**AWS** — also set from the form for deploys (not read by verification):

- `AWS_ACCOUNT_ID`, `RADIUS_VPC_ID`, `RADIUS_SUBNET_IDS`

**Azure** — read by `verify-azure.yml`:

- `AZURE_CLIENT_ID` — AAD application (client) ID
- `AZURE_TENANT_ID` — Azure tenant ID
- `AZURE_SUBSCRIPTION_ID` — Azure subscription ID
- `AZURE_RESOURCE_GROUP` — resource group holding the AKS cluster
- `AZURE_AKS_CLUSTER_NAME` — name of the AKS cluster the workflow verifies access to

The OIDC trust must already exist on the cloud side before the workflow can authenticate (see Prerequisites below).

## Prerequisites on the cloud side

- **Azure:** a federated credential on the AAD app whose subject is exactly `repo:<owner>/<repo>:environment:<environment-name>`, audience `api://AzureADTokenExchange`.
- **AWS:** an IAM role trust policy that allows `sts:AssumeRoleWithWebIdentity` from `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` and subject `repo:<owner>/<repo>:environment:<environment-name>`.

## Common errors and fixes

- **`refusing to allow an OAuth App to create or update workflow .github/workflows/verify-<provider>.yml without 'workflow' scope`** — the PAT lacks `workflow` scope. Run `gh auth refresh -s workflow` (the extension auto-prefers a `gh auth token` over `$GITHUB_TOKEN`). Applies to both modes, since both push the verify workflow.
- **"Workflow dispatch accepted, but no new run appeared after 30s"** — usually means GitHub hasn't indexed the just-pushed workflow yet. The extension already retries dispatch with backoff; in CLI mode, wait a few seconds and re-run `gh workflow run`, or check the Actions tab.
- **Azure OIDC fails with `AADSTS70021: No matching federated identity record found`** — the federated credential subject on the AAD app doesn't match. Subject must be exactly `repo:<owner>/<repo>:environment:<env-name>`.
- **AWS OIDC fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`** — IAM role trust policy missing or wrong audience. Audience should be `sts.amazonaws.com`, condition on `token.actions.githubusercontent.com:sub == repo:<owner>/<repo>:environment:<env-name>`.

## Verifying after creation

- **Canvas:** after the canvas reports success, the new env appears in the **Envs ▾** dropdown tagged with its provider (AWS/AZURE). The hub's deploy button enables once both an Application and Environment are selected.
- **CLI:** confirm the run succeeded (`gh run watch` / the run URL) and that `gh variable list --env <env-name>` shows the expected variables.

## Related files

- `.github/radius/extension.mjs` — environment creation (`/api/create-environment`), verification workflow generation (`generateVerifyWorkflow`), and environment variable writes via `gh variable set ... --env`.
- The verification workflow templates are the canonical `verify-aws.yml` / `verify-azure.yml` (both named `Radius - Verify Credentials`) hosted in `radius-project/radius` at `.github/extension/`. The extension fetches the matching provider template from there at commit time (with a bundled fallback) and commits it into the target user repo at `.github/workflows/verify-<provider>.yml`, then dispatches it.
- The template directory and the contract between the workflow and the canvas are documented canonically in `radius-project/radius` at [`.github/extension/README.md`](https://github.com/radius-project/radius/blob/main/.github/extension/README.md).
