---
name: radius-deploy
description: Deploy a Radius application to a configured environment via the auto-generated GitHub Actions workflow. Use when the user asks to deploy, redeploy, trigger a deployment, or troubleshoot a failed Radius deploy.
---

# Radius — Deploy Application

Trigger the `Radius - Deploy Application` workflow which spins up an ephemeral k3d Radius control plane, connects to the target AKS/EKS cluster, registers the right recipes for the env's provider, and runs `rad deploy`.

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
POST /repos/{owner}/{repo}/actions/workflows/radius-deploy.yml/dispatches
{ "ref": "main", "inputs": { "environment": "<env-name>" } }
```

## What the workflow does

1. Commits/updates `.github/workflows/radius-deploy.yml` if the extension's template has changed.
2. Logs into AWS (OIDC) **or** Azure (OIDC) based on which `vars.*` are set.
3. Connects to the target cluster (EKS via `aws eks describe-cluster` + static token, or AKS via `az aks get-credentials`).
4. Spins up `k3d` cluster `radius-cp`, installs the Radius control plane on it.
5. Patches `dynamic-rp` to mount Docker socket + repo source so Terraform recipes that build images work.
7. Clones `radius-project/resource-types-contrib@main` (or the ref in `RESOURCE_TYPES_CONTRIB_REF`) and registers resource types + terraform recipes — provider-gated for `mySqlDatabases` (AWS RDS recipe vs Azure Flexible Server recipe).
9. Runs `rad graph build --orphan-branch radius-graph --source-branch <branch>` so the app graph skill can render the result.

## Common failure modes

- **`RecipeDeploymentFailed` with `the resource with id '/planes/aws/aws/providers/System.AWS/credentials/default' was not found`**
  → The mySqlDatabases recipe was registered for the wrong provider. Fix is already in `DEPLOY_WORKFLOW`: AWS env uses `recipes/aws/terraform`, Azure env uses `recipes/azure/terraform`. If you see this error, the committed workflow is stale — re-trigger the deploy from the canvas so `triggerDeploy` re-commits the updated workflow.

- **`RecipeDownloadFailed` with `subdir not found`**
  → The recipe path doesn't exist on the configured `RESOURCE_TYPES_CONTRIB_REF` branch. Check the actual layout in `radius-project/resource-types-contrib` for that branch. `mySqlDatabases` specifically has **no** `recipes/kubernetes/terraform` directory — only aws, azure, and a kubernetes/bicep variant.

- **Workflow runs but pod never reaches Ready**
  → Look at the `Patch dynamic-rp with Docker support` and `Configure external deployment target` steps in the run logs. Usually a target cluster kubeconfig issue (expired EKS token, AKS network restriction).

- **"Deployment timed out"** in the canvas after ~5 minutes
  → The deploy is still running on GitHub; the canvas just stopped polling. Open the workflow run URL shown in the status to follow it live, and click **Back to overview** to return to the hub.

## After a successful deploy

- Tell the user the deploy succeeded and include the workflow run URL.
- Suggest opening the **App Graph** view (`radius-app-graph` skill) to see the deployed resources.

## Related files

- `plugins/radius/extensions/radius/extension.mjs` — deploy workflow template generation (`generateDeployWorkflow`) and repo commit to `.github/workflows/radius-deploy.yml`
- `plugins/radius/extensions/radius/extension.mjs` — deploy dispatch + run polling (uses `gh workflow run radius-deploy.yml` and `gh run list`)
- Workflow lives in user repo at `.github/workflows/radius-deploy.yml`
