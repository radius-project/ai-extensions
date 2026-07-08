---
name: radius-deploy
description: Deploy a Radius application to a configured environment via the auto-generated GitHub Actions workflow. Use when the user asks to deploy, redeploy, trigger a deployment, or troubleshoot a failed Radius deploy.
---

# Radius — Deploy Application

Trigger the `Radius - Run rad Commands` workflow which spins up an ephemeral k3d Radius control plane, connects to the target AKS/EKS cluster, creates the environment + recipe pack, and runs `rad deploy`. Provider-agnostic phases run from shared composite actions hosted in `radius-project/radius`; only the cloud login, cluster connection, credential registration, and recipe-pack creation are provider-specific.

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

1. Commits/updates the deploy workflow files (`run-rad-commands.yml` dispatcher + `run-rad-commands-azure.yml` / `run-rad-commands-aws.yml` provider workflows) if the extension's templates have changed.
2. The dispatcher's `detect` job binds the GitHub Environment, reads `AZURE_CLIENT_ID` / `AWS_ROLE_ARN`, and routes to the matching provider workflow.
3. Logs into AWS (OIDC) **or** Azure (OIDC) and connects to the target cluster (EKS via `aws eks` + static token, or AKS via `az aks get-credentials`).
4. Spins up `k3d` cluster `radius-cp` and installs the Radius control plane on it with `--set dynamicrp.buildkit.enabled=true` so the `containerImages` recipe builds images with the in-pod BuildKit (no Docker socket).
5. Registers the cloud identity with `rad credential register` (`aws irsa` / `azure wi`).
6. Runs `rad startup` to restore control-plane databases + Terraform recipe-state Secrets from the previous run. The `Radius.Compute/containerImages` type ships with the published `radius` Bicep extension, so no resource-type registration happens at deploy time.
7. Creates the environment + recipe pack by deploying `radius-env.bicep` from the app file's directory (e.g. `.radius/`) so the repo's own `bicepconfig.json` resolves the `radius` extension. **Azure** downloads the `azure-avm` pack from `radius-project/resource-types-contrib`; **AWS** generates an inline pack with a provider-gated `mySqlDatabases` recipe (AWS RDS).
8. Provisions registry credentials, then runs `rad deploy` on `.radius/app.bicep` (passing `image` and any `RADIUS_DEPLOY_PARAMS`). `rad shutdown` (`if: always()`) backs state up to the `radius-state` orphan branch; on failure logs upload as the `radius-logs` artifact and the k3d cluster is always deleted.

## Common failure modes

- **`RecipeDeploymentFailed` with `the resource with id '/planes/aws/aws/providers/System.AWS/credentials/default' was not found`**
  → The `mySqlDatabases` recipe was registered for the wrong provider. Fix lives in the `Create Radius environment and recipe pack` step: an AWS env uses the inline `recipes/aws/terraform` recipe, an Azure env uses the `azure-avm` pack. If you see this error, the committed workflow is stale — re-trigger the deploy from the canvas so the updated workflow is re-committed.

- **`RecipeDownloadFailed` with `subdir not found`**
  → The recipe path doesn't exist on the configured `RESOURCE_TYPES_CONTRIB_REF` branch (AWS) or `RECIPE_PACK_REF` (Azure AVM pack). Check the actual layout in `radius-project/resource-types-contrib` for that branch.

- **Workflow runs but pod never reaches Ready**
  → Look at the `setup-control-plane` and target-cluster connection steps in the run logs. Usually a target cluster kubeconfig issue (expired EKS token, AKS network restriction).

- **"Deployment timed out"** in the canvas after ~5 minutes
  → The deploy is still running on GitHub; the canvas just stopped polling. Open the workflow run URL shown in the status to follow it live, and click **Back to overview** to return to the hub.

## After a successful deploy

- Tell the user the deploy succeeded and include the workflow run URL.
- Suggest opening the **App Graph** view (`radius-app-graph` skill) to see the deployed resources.

## Related files

- `.github/radius/extension.mjs` — deploy workflow template generation (`generateDeployWorkflow`) and repo commit of the dispatcher + provider workflows to `.github/workflows/`
- `.github/radius/extension.mjs` — deploy dispatch + run polling (uses `gh workflow run run-rad-commands.yml` and `gh run list`)
- Workflows live in the user repo at `.github/workflows/run-rad-commands.yml` (dispatcher) and `.github/workflows/run-rad-commands-{azure,aws}.yml` (provider workflows); shared composite actions are referenced from `radius-project/radius/.github/extension/actions/*`
