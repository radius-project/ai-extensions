---
name: radius-deploy
description: Deploy a Radius application to a configured environment via the auto-generated GitHub Actions workflow. Use when the user asks to deploy, redeploy, trigger a deployment, or troubleshoot a failed Radius deploy.
---

# Radius — Deploy Application

Trigger the `Radius - Run rad Commands` workflow which spins up an ephemeral k3d Radius control plane, connects to the target AKS/EKS cluster, registers the right recipes for the env's provider, restores persisted state from the environment's private GHCR package, runs the requested `rad` commands (deploying by default), and persists state again before tearing the control plane down. `run-rad-commands.yml` is a dispatcher: it detects the environment's provider and calls the matching reusable workflow (`run-rad-commands-azure.yml` / `run-rad-commands-aws.yml`), and the provider workflows reference shared composite actions hosted in `radius-project/radius`.

## When to use this skill

- "Deploy my app"
- "Redeploy to the test environment"
- "Trigger a deploy"
- "Why did my deploy fail?"
- "Deploy app X to env Y"

## Prerequisites

Before invoking this skill, all of these must exist:
1. A GitHub Environment configured with cloud credentials → use the `radius-environment` skill if missing.
2. A `.radius/app.bicep` file → use the `radius-app-bicep` skill if missing.
3. The user's PAT in the extension's storage (auto-seeded from `gh auth token`).

## How to invoke

1. `open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "environment", repo: "<owner/repo>" } })`
2. In the hub:
   - **Applications ▾**: pick the bicep app file (auto-selected if only one)
   - **Envs ▾**: pick the target env (tagged with AWS / AZURE)
   - Click **Deploy**
3. The canvas immediately triggers the workflow (no intermediate form). Live status streams in until success / failure / timeout.

Programmatic alternative: directly trigger the deploy workflow via the GitHub API:
```
POST /repos/{owner}/{repo}/actions/workflows/run-rad-commands.yml/dispatches
{ "ref": "main", "inputs": { "environment": "<env-name>" } }
```

## What the workflow does

1. Commits/updates the deploy workflow files if they've changed — the `run-rad-commands.yml` dispatcher plus the `run-rad-commands-azure.yml` / `run-rad-commands-aws.yml` provider workflows (fetched from `radius-project/radius@main` at commit time, with a bundled fallback).
2. The dispatcher detects the environment's provider (from `AZURE_CLIENT_ID` / `AWS_ROLE_ARN`) and calls the matching provider workflow, which authenticates to that cloud via OIDC.
3. Fetches a kubeconfig for the target cluster into `RADIUS_TARGET_KUBECONFIG` (EKS via `aws eks describe-cluster` + a static bearer-token kubeconfig; AKS via `az aks get-credentials`).
4. Installs `k3d`, creates the ephemeral `radius-cp` cluster, and installs the `rad` CLI (edge) and Terraform.
5. When a target kubeconfig exists, creates the `target-kubeconfig` secret and installs Radius with `--set global.targetCluster.enabled=true` (plus `--set database.enabled=true` for state backup/restore and `--set dynamicrp.buildkit.enabled=true` for in-pod image builds). The chart mounts the secret into `applications-rp`, `dynamic-rp`, and `bicep-de` and sets `RADIUS_TARGET_KUBECONFIG` so recipes and directly-rendered resources target the external cluster. Without a target kubeconfig, resources deploy to the k3d control plane. The Terraform state backend stays on the control plane.
6. Projects GitHub OIDC tokens into the pods and registers the cloud identity with `rad credential register` (`aws irsa` / `azure wi`), then refreshes the (short-lived EKS) target token, updates the `target-kubeconfig` secret, and restarts the recipe-executing pods so they re-read it.
7. Authenticates to GHCR with the repository `GITHUB_TOKEN`, exports environment-scoped `RADIUS_STATE_BACKEND`, `RADIUS_STATE_REGISTRY`, and `RADIUS_STATE_ARCHIVE`, creates the CLI workspace/group, then runs `rad startup` to restore the control-plane databases and Terraform recipe-state Secrets saved by the previous run (a no-op on the first run). The `Radius.Compute/containerImages` type ships with the published `radius` Bicep extension, so no resource-type registration or local Bicep-extension build happens at deploy time.
8. Deploys a `Radius.Core/environments` resource and recipe pack from the app file's directory (e.g. `.radius/`) so the repo's own `bicepconfig.json` resolves the `radius` extension. **Azure** downloads the `azure-avm` pack from `radius-project/resource-types-contrib`; **AWS** generates an inline pack bundling the Kubernetes recipes (`containers`, `containerImages`, `persistentVolumes`, `routes`, `postgreSqlDatabases`, `secrets`) plus a provider-gated `mySqlDatabases` recipe (AWS RDS).
9. Creates registry credentials for image builds, then runs `rad deploy` on `.radius/app.bicep` (passing the `image` parameter, and any application parameters from the `RADIUS_DEPLOY_PARAMS` secret when set). Afterwards `rad shutdown` (`if: always()`) backs the control-plane databases and Terraform recipe-state Secrets up to the GHCR repository in `RADIUS_STATE_REGISTRY` under the default `radius-state` tag. On failure, logs are uploaded as the `radius-logs` artifact; the k3d cluster is always deleted.

## Common failure modes

- **`RecipeDeploymentFailed` with `the resource with id '/planes/aws/aws/providers/System.AWS/credentials/default' was not found`**
  → The `mySqlDatabases` recipe was registered for the wrong provider. The fix lives in the `Create Radius environment and recipe pack` step: an AWS env uses the inline `recipes/aws/terraform` recipe, an Azure env uses the `azure-avm` pack. If you see this error, the committed workflow is stale — re-trigger the deploy from the canvas so the updated workflow is re-committed.

- **`RecipeDownloadFailed` with `subdir not found`**
  → The recipe path doesn't exist on the configured `RESOURCE_TYPES_CONTRIB_REF` branch (AWS) or `RECIPE_PACK_REF` (Azure AVM pack). Check the actual layout in `radius-project/resource-types-contrib` for that branch. `mySqlDatabases` specifically has **no** `recipes/kubernetes/terraform` directory — only aws, azure, and a kubernetes/bicep variant.

- **Workflow runs but pod never reaches Ready**
  → Look at the `Install Radius on control plane` and `Refresh external deployment target credentials` steps in the run logs. Usually a target cluster kubeconfig issue (expired EKS token, AKS network restriction).

- **"Deployment timed out"** in the canvas after ~5 minutes
  → The deploy is still running on GitHub; the canvas just stopped polling. Open the workflow run URL shown in the status to follow it live, and click **Back to overview** to return to the hub.

- **`OCI archive repository is not configured` or GHCR authentication/visibility errors**
  → Recreate or update the GitHub Environment so `RADIUS_STATE_BACKEND=oci`, package-only `RADIUS_STATE_REGISTRY`, and `RADIUS_STATE_ARCHIVE=radius-state` are present. Confirm the run workflow logs in to `ghcr.io` before `rad startup`, has `packages: write`, and that the state package is private or internal.

## After a successful deploy

- Tell the user the deploy succeeded and include the workflow run URL.
- Suggest opening the **App Graph** view (`radius-app-graph` skill) to see the deployed resources.

## Related files

- `.github/radius/extension.mjs` — deploy workflow template generation (`generateDeployWorkflow`) and repo commit of the dispatcher + provider workflows to `.github/workflows/`.
- `.github/radius/extension.mjs` — deploy dispatch + run polling (uses `gh workflow run run-rad-commands.yml` and `gh run list`).
- The deploy workflow templates are canonical in `radius-project/radius` at `.github/extension/` — `run-rad-commands.yml` (dispatcher), `run-rad-commands-{azure,aws}.yml` (provider `workflow_call` workflows), and `actions/*` (shared composite actions: `setup-control-plane`, `restore-state`, `run-rad-commands`, `teardown`). The extension fetches these from `radius-project/radius@main` at commit time (with a bundled fallback) and commits the dispatcher + provider workflows into the user repo at `.github/workflows/`; the composite actions are referenced in place from `radius-project/radius`, not copied.
