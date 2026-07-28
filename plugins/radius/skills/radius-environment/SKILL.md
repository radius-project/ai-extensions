---
name: radius-environment
description: Create and verify a Radius deploy environment (AWS or Azure) for a GitHub repository. Use when the user asks to set up, configure, verify, or troubleshoot a Radius environment, cloud credentials, or the OIDC trust between GitHub Actions and AWS/Azure.
---

# Radius — Environment Setup

Create a GitHub Environment configured with the cloud credentials and private GHCR state package Radius needs to deploy applications across ephemeral workflow runs. Supports AWS (OIDC via IAM Role) and Azure (OIDC via Workload Identity).

## When to use this skill

- "Create a new Radius environment named X"
- "Set up Azure credentials for deploys"
- "Configure AWS for my Radius app"
- "Verify my deploy environment works"
- "Why is the verification workflow failing?"
- "Add a new environment 'staging' pointing at my AKS cluster"

## Flow

The canvas drives a short wizard per provider: collect the environment's cloud settings, create and verify a dedicated private/internal GHCR state package with the user's stored GitHub CLI credential, write the package path and cloud settings as GitHub Environment variables, then commit and dispatch the provider's verification workflow. A package bootstrap, visibility, or repository-linkage failure stops setup before verification or automatic deployment.

### AWS
1. **Form inputs**: env name, IAM Role ARN, AWS region, account ID, EKS cluster name, optional VPC + subnet IDs (required if the app uses `Radius.Data/mySqlDatabases`). These are written as GitHub Environment variables.
2. **Credential + cluster verification**: commits/updates `.github/workflows/verify-aws.yml` and dispatches it. The workflow logs into AWS via OIDC and runs `aws sts get-caller-identity`, then runs `aws eks update-kubeconfig` for the EKS cluster and `kubectl cluster-info` to confirm cluster access. Status is polled and shown live in the canvas.

### Azure
1. **Form inputs**: env name, AAD App (client) ID, tenant ID, subscription ID, resource group, AKS cluster name. These are written as GitHub Environment variables.
2. **Credential + cluster verification**: commits/updates `.github/workflows/verify-azure.yml` and dispatches it. The workflow runs `azure/login` via OIDC and `az account show`, then `az aks get-credentials` + `kubelogin convert-kubeconfig` + `kubectl cluster-info` to confirm AKS access. Status is polled and shown live in the canvas.

## How to invoke

When the user asks to create or set up a Radius environment, **open the canvas straight to the environment wizard**:

```
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "environment", repo: "<owner/repo>" }
})
```

For credentials/OIDC setup:

```
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "credentials", repo: "<owner/repo>" }
})
```

The popup lands directly on the create-environment form for the chosen provider. No navigation needed.

> **Canvas not opening?** If the Radius panel does not appear even though this skill and the Radius plugin are installed, the canvas may not be registered due to a known GitHub Copilot app bug. Run the `radius-fix-canvas-installation` skill to repair it, then reload extensions (or restart the app) and try again.

## Required variables on the GitHub Environment

The verification workflow reads only GitHub Actions **variables** (`vars`), never secrets. OIDC eliminates the need to store long-lived cloud credentials.

**Common**
- `RADIUS_STATE_BACKEND` — explicitly set to `oci`.
- `RADIUS_STATE_REGISTRY` — package-only, per-environment GHCR path used by `rad startup` and `rad shutdown`, for example `ghcr.io/example/my-app-radius-state-production-1a2b3c4d5e6f`. It does not include `:radius-state`; the extension derives this value and each GitHub Environment receives a different package.
- `RADIUS_STATE_ARCHIVE` — the separate OCI state tag, set to `radius-state`.

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

- **Local GitHub authentication:** `gh` must have a stored keyring login with `read:packages` and `write:packages`. The extension deliberately ignores ambient `GH_TOKEN` / `GITHUB_TOKEN` for package creation. If needed, run `gh auth refresh -s read:packages -s write:packages`.
- **Azure:** a federated credential on the AAD app whose subject is exactly `repo:<owner>/<repo>:environment:<environment-name>`, audience `api://AzureADTokenExchange`.
- **AWS:** an IAM role trust policy that allows `sts:AssumeRoleWithWebIdentity` from `token.actions.githubusercontent.com` with audience `sts.amazonaws.com` and subject `repo:<owner>/<repo>:environment:<environment-name>`.

## Common errors and fixes

- **`refusing to allow an OAuth App to create or update workflow .github/workflows/verify-<provider>.yml without 'workflow' scope`** — the PAT lacks `workflow` scope. Run `gh auth refresh -s workflow` (the extension auto-prefers a `gh auth token` over `$GITHUB_TOKEN`).
- **"Workflow dispatch accepted, but no new run appeared after 30s"** — usually means GitHub hasn't indexed the just-pushed workflow yet. The extension already retries dispatch with backoff; if it still fails, check the Actions tab in the browser.
- **Azure OIDC fails with `AADSTS70021: No matching federated identity record found`** — the federated credential subject on the AAD app doesn't match. Subject must be exactly `repo:<owner>/<repo>:environment:<env-name>`.
- **AWS OIDC fails with `Not authorized to perform sts:AssumeRoleWithWebIdentity`** — IAM role trust policy missing or wrong audience. Audience should be `sts.amazonaws.com`, condition on `token.actions.githubusercontent.com:sub == repo:<owner>/<repo>:environment:<env-name>`.
- **GHCR package bootstrap fails** — refresh the stored `gh` credential with `read:packages` and `write:packages`. The extension pushes a harmless retained `bootstrap` artifact with an `org.opencontainers.image.source` annotation, then requires the package to be private/internal and linked to the target repository. It never uses a public repository's `GITHUB_TOKEN` to create the package because that can make the package public.

## Verifying after creation

After the canvas reports success, the new env appears in the **Envs ▾** dropdown tagged with its provider (AWS/AZURE). Its three state variables select OCI, point to a private/internal GHCR package isolated from every other GitHub Environment, and select that package's `radius-state` tag. The package retains the harmless `bootstrap` tag so later workflow runs can add and remove `radius-state` versions without deleting the configured package. The hub's deploy button enables once both an Application and Environment are selected.

## Related files

- `plugins/radius/extension.mjs` — environment creation (`/api/create-environment`), verification workflow generation (`generateVerifyWorkflow`), and environment variable writes via `gh variable set ... --env`.
- The verification workflow templates are the canonical `verify-aws.yml` / `verify-azure.yml` (both named `Radius - Verify Credentials`) hosted in `radius-project/radius` at `.github/extension/`. The extension fetches the matching provider template from there at commit time (with a bundled fallback) and commits it into the target user repo at `.github/workflows/verify-<provider>.yml`, then dispatches it.
