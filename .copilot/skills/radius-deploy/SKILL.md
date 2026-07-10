---
name: radius-deploy
description: Deploy a Radius application to a configured environment via the auto-generated GitHub Actions workflow. Works both inside the Radius canvas extension and headlessly via the CLI. Use when the user asks to deploy, redeploy, trigger a deployment, or troubleshoot a failed Radius deploy.
---

# Radius — Deploy Application

Trigger the `Radius - Run rad Commands` workflow which spins up an ephemeral k3d Radius control plane, connects to the target AKS/EKS cluster, registers the right recipes for the env's provider, restores persisted state, runs the requested `rad` commands (deploying by default), and persists state again before tearing the control plane down. `run-rad-commands.yml` is a dispatcher: it detects the environment's provider and calls the matching reusable workflow (`run-rad-commands-azure.yml` / `run-rad-commands-aws.yml`), and the provider workflows reference shared composite actions hosted in `radius-project/radius`.

## Two ways to run this skill

This skill supports **two execution modes**. Pick one based on where you are running:

| | **Canvas extension** (interactive) | **CLI** (headless) |
| --- | --- | --- |
| **Choose when** | You are operating inside the Radius Copilot canvas and want a visual, one-click deploy with live status. | You are running headless — automation, scripts, CI, or an agent with no canvas — or the deploy workflow is already committed and you just need to trigger it. |
| **How you trigger** | `open_canvas` → **Deploy** button. | `gh workflow run run-rad-commands.yml` (or the REST dispatch API). |
| **Workflow files** | The extension commits/updates the dispatcher + provider workflows for you (fetched from `radius-project/radius@main`, bundled fallback). | The workflow files **must already be committed** to `.github/workflows/`. If missing, run the canvas path once (or commit them manually) first. |
| **Auth** | Uses the user's PAT in the extension's storage (auto-seeded from `gh auth token`). | A logged-in `gh` CLI, or a token with `actions: write` on the repo. |
| **Status** | Live status streams in the canvas until success / failure / timeout. | Follow with `gh run watch` or the run URL. |

Both modes dispatch the **same** `run-rad-commands.yml` workflow and do the same work on the runner — only the trigger and status-reporting differ. The token only triggers the run; it is never passed into the workflow.

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
3. Auth for the chosen mode (see the table above): the extension's stored PAT for the **canvas** path, or a logged-in `gh` CLI / `actions: write` token for the **CLI** path.
4. **CLI mode only:** the deploy workflow files must already be committed to `.github/workflows/`. The canvas path commits them automatically; the CLI path does not.

## How to invoke

### Canvas extension

1. `open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "environment", repo: "<owner/repo>" } })`
2. In the hub:
   - **Applications ▾**: pick the bicep app file (auto-selected if only one)
   - **Envs ▾**: pick the target env (tagged with AWS / AZURE)
   - Click **Deploy**
3. The canvas immediately triggers the workflow (no intermediate form). Live status streams in until success / failure / timeout.

### CLI

Directly trigger the deploy workflow via `gh` (or the GitHub API). Omit `image` to run the default `rad deploy` of `.radius/app.bicep`:

```bash
gh workflow run run-rad-commands.yml -f environment=<env-name> [-f image=<optional-image>]
```

```text
POST /repos/{owner}/{repo}/actions/workflows/run-rad-commands.yml/dispatches
{ "ref": "main", "inputs": { "environment": "<env-name>", "image": "<optional-image>" } }
```

Then follow the run (`gh run watch` or the run URL) until it succeeds, fails, or times out.

## What the workflow does

The steps below run identically regardless of which mode triggered the dispatch. Step 1 (committing the workflow files) only happens in the **canvas** path; in the **CLI** path the files are already committed.

1. *(Canvas only)* Commits/updates the deploy workflow files if they've changed — the `run-rad-commands.yml` dispatcher plus the `run-rad-commands-azure.yml` / `run-rad-commands-aws.yml` provider workflows (fetched from `radius-project/radius@main` at commit time, with a bundled fallback).
2. The dispatcher detects the environment's provider (from `AZURE_CLIENT_ID` / `AWS_ROLE_ARN`) and calls the matching provider workflow, which authenticates to that cloud via OIDC.
3. Fetches a kubeconfig for the target cluster into `RADIUS_TARGET_KUBECONFIG` (EKS via `aws eks describe-cluster` + a static bearer-token kubeconfig; AKS via `az aks get-credentials`).
4. Installs `k3d`, creates the ephemeral `radius-cp` cluster, and installs the `rad` CLI (edge) and Terraform.
5. When a target kubeconfig exists, creates the `target-kubeconfig` secret and installs Radius with `--set global.targetCluster.enabled=true` (plus `--set database.enabled=true` for state backup/restore and `--set dynamicrp.buildkit.enabled=true` for in-pod image builds). The chart mounts the secret into `applications-rp`, `dynamic-rp`, and `bicep-de` and sets `RADIUS_TARGET_KUBECONFIG` so recipes and directly-rendered resources target the external cluster. Without a target kubeconfig, resources deploy to the k3d control plane. The Terraform state backend stays on the control plane.
6. Projects GitHub OIDC tokens into the pods and registers the cloud identity with `rad credential register` (`aws irsa` / `azure wi`), then refreshes the (short-lived EKS) target token, updates the `target-kubeconfig` secret, and restarts the recipe-executing pods so they re-read it.
7. Creates the CLI workspace/group, then runs `rad startup` to restore the control-plane databases and Terraform recipe-state Secrets saved by the previous run (a no-op on the first run). The `Radius.Compute/containerImages` type ships with the published `radius` Bicep extension, so no resource-type registration or local Bicep-extension build happens at deploy time.
8. Deploys a `Radius.Core/environments` resource and recipe pack from the app file's directory (e.g. `.radius/`) so the repo's own `bicepconfig.json` resolves the `radius` extension. **Azure** downloads the `azure-avm` pack from `radius-project/resource-types-contrib`; **AWS** generates an inline pack bundling the Kubernetes recipes (`containers`, `containerImages`, `persistentVolumes`, `routes`, `postgreSqlDatabases`, `secrets`) plus a provider-gated `mySqlDatabases` recipe (AWS RDS).
9. Creates registry credentials for image builds, then runs `rad deploy` on `.radius/app.bicep` (passing the `image` parameter, and any application parameters from the `RADIUS_DEPLOY_PARAMS` secret when set). Afterwards `rad shutdown` (`if: always()`) backs the control-plane databases and Terraform recipe-state Secrets up to the `radius-state` git orphan branch. On failure, logs are uploaded as the `radius-logs` artifact; the k3d cluster is always deleted.

## Common failure modes

- **`RecipeDeploymentFailed` with `the resource with id '/planes/aws/aws/providers/System.AWS/credentials/default' was not found`**
  → The `mySqlDatabases` recipe was registered for the wrong provider. The fix lives in the `Create Radius environment and recipe pack` step: an AWS env uses the inline `recipes/aws/terraform` recipe, an Azure env uses the `azure-avm` pack. If you see this error, the committed workflow is stale. **Canvas:** re-trigger the deploy so the updated workflow is re-committed. **CLI:** re-commit the updated workflow files yourself, then re-run `gh workflow run`.

- **`RecipeDownloadFailed` with `subdir not found`**
  → The recipe path doesn't exist on the configured `RESOURCE_TYPES_CONTRIB_REF` branch (AWS) or `RECIPE_PACK_REF` (Azure AVM pack). Check the actual layout in `radius-project/resource-types-contrib` for that branch. `mySqlDatabases` specifically has **no** `recipes/kubernetes/terraform` directory — only aws, azure, and a kubernetes/bicep variant.

- **Workflow runs but pod never reaches Ready**
  → Look at the `Install Radius on control plane` and `Refresh external deployment target credentials` steps in the run logs. Usually a target cluster kubeconfig issue (expired EKS token, AKS network restriction).

- **"Deployment timed out"** in the canvas after ~5 minutes *(canvas only)*
  → The deploy is still running on GitHub; the canvas just stopped polling. Open the workflow run URL shown in the status to follow it live, and click **Back to overview** to return to the hub. In CLI mode there is no polling timeout — `gh run watch` follows the run to completion.

## After a successful deploy

- Tell the user the deploy succeeded and include the workflow run URL.
- **Canvas:** suggest opening the **App Graph** view (`radius-app-graph` skill) to see the deployed resources.

## Related files

- `.github/radius/extension.mjs` — deploy workflow template generation (`generateDeployWorkflow`) and repo commit of the dispatcher + provider workflows to `.github/workflows/` (canvas path), plus deploy dispatch + run polling (uses `gh workflow run run-rad-commands.yml` and `gh run list`).
- The deploy workflow templates are canonical in `radius-project/radius` at `.github/extension/` — `run-rad-commands.yml` (dispatcher), `run-rad-commands-{azure,aws}.yml` (provider `workflow_call` workflows), and `actions/*` (shared composite actions: `setup-control-plane`, `restore-state`, `run-rad-commands`, `teardown`). The extension fetches these from `radius-project/radius@main` at commit time (with a bundled fallback) and commits the dispatcher + provider workflows into the user repo at `.github/workflows/`; the composite actions are referenced in place from `radius-project/radius`, not copied.
- The workflow contract (trigger/inputs, required `vars`, secrets, and prerequisites) is documented canonically in `radius-project/radius` at [`.github/extension/README.md`](https://github.com/radius-project/radius/blob/main/.github/extension/README.md).
