---
name: radius-delete
description: Delete a Radius application deployment (or remove a GitHub deploy environment) via the Radius canvas. Use when the user asks to delete, remove, or tear down a deployed Radius application, or to remove a deploy environment.
---

# Radius — Delete a Deployment or Environment

Two distinct teardown flows are available from the Radius canvas:

- **Delete a deployment** dispatches the committed `delete-application.yml` GitHub Actions workflow, which spins up an ephemeral k3d Radius control plane, connects to the target AKS cluster, restores persisted state, runs `rad app delete`, and persists the updated state again before tearing the control plane down. Deleting the deployment also deletes that application's resources (running their recipes' delete path against the target cluster and cloud).
- **Delete an environment** is a tracked async operation that tears down the cloud state behind the environment, not just the GitHub record. It (1) dispatches the Azure-only `delete-environment` workflow to delete the Radius environment on the cluster **while the federated credential still exists** (the workflow authenticates with it), (2) removes the per-environment Azure federated credential (`repo:<owner>/<repo>:environment:<env>`) from the app registration, and (3) deletes the **GitHub deploy environment** (its stored variables and secrets) via the GitHub API. The Microsoft Entra **app registration is left in place** — it can be shared by other environments or callers — and you are reminded to remove it manually if unused. It is guarded so it refuses while an application is still deployed to that environment, and only **Azure-backed** environments can be deleted today: deleting an AWS (or any non-Azure) environment is refused up front, because the bundled env-delete workflow is Azure-only.

## When to use this skill

- "Delete my app" / "Remove application X from env Y" / "Tear down the deployment"
- "Delete the environment" / "Remove the dev environment"

## Prerequisites

Before invoking this skill:

1. A GitHub deploy environment configured with cloud credentials → use the `radius-environment` skill if missing.
2. For a deployment delete: the application was deployed to that environment at least once (the delete restores persisted state to know what to remove).
3. Authenticated `gh` CLI access to dispatch workflows. The extension shells out to `gh`, which uses your stored GitHub credential (the keyring credential from `gh auth token`) and falls back to it when an injected token lacks the `workflow` scope — there is no separate extension-managed PAT to configure.

## How to invoke

Open the canvas hub and use the deployed-application view:

1. `open_canvas({ canvasId: "radius", instanceId: "radius-panel", input: { page: "environment", repo: "<owner/repo>" } })`
2. Select the environment (and, for a deployment delete, the deployed application).
3. Click **Delete Deployment** to tear down the app, or use the environment's delete control to remove the GitHub environment. Live status streams until success / failure / timeout.

The extension keeps the committed delete workflow files current before dispatching, so a run never executes a drifted copy.

## What the deployment-delete workflow does

1. Commits/updates the application-delete workflow files if they've changed — the `delete-application.yml` dispatcher plus the `delete-azure.yml` provider workflow. The extension commits only the Azure provider workflow and strips the dispatcher's `aws:` job.
2. The dispatcher calls the Azure provider workflow, which authenticates to the cloud via OIDC and connects to the target AKS cluster.
3. Installs `k3d` + the `rad` CLI + Terraform and installs Radius on the ephemeral control plane wired to the target cluster (same setup as deploy).
4. Projects GitHub OIDC tokens into the pods and registers the cloud identity with `rad credential register`, so recipe deletes can reach the target cluster and cloud.
5. Authenticates to GHCR with the repository `GITHUB_TOKEN`, exports environment-scoped `RADIUS_STATE_BACKEND`, `RADIUS_STATE_REGISTRY`, and `RADIUS_STATE_ARCHIVE`, then runs `rad startup` to restore the control-plane databases and Terraform recipe-state Secrets persisted by the previous run — this is what tells the delete which environment, recipe packs, resources, and Terraform state exist. Unlike deploy, it does **not** recreate the environment, recipe pack, or registry credentials.
6. Runs `rad app delete <name> --yes --preview` (`--preview` switches the CLI to the deployed-application API path) via the `delete-resource` composite action, which writes a `rad-delete-result` artifact (JSON: `outcome`, `exitCode`, `resourceType`, `name`, `output`).
7. `rad shutdown` (`if: always()`) persists the post-delete control-plane databases and Terraform recipe-state Secrets back to the state archive — the OCI-backed archive by default (pushed to the GHCR repository in `RADIUS_STATE_REGISTRY` under the `RADIUS_STATE_ARCHIVE` tag, default `radius-state`), or the `radius-state` git orphan branch when `RADIUS_STATE_BACKEND=git`. On failure, logs are uploaded as the `radius-logs` artifact; the k3d cluster is always deleted.

## What the environment-delete flow does

Deleting an environment runs as a tracked operation through the same progress panel as environment creation. Only Azure-backed environments are supported; deleting an AWS (or any non-Azure) environment is refused up front with a clear message and nothing is torn down.

- Refuses to proceed while an application is still deployed to the environment (its cloud resources would be orphaned), and points you at the deployment-delete flow first.
- **Stage 1 — Radius environment:** dispatches the Azure-only `delete-environment` workflow, which connects to the target AKS cluster and runs `rad env delete`. This runs first, while the federated credential still exists, because the workflow authenticates with it. If this cannot be confirmed (dispatch failed, run not found, timeout, or a non-guard failure), the whole deletion **stops fail-closed** and is reported as a retryable partial failure — the credential and GitHub environment a retry needs are left in place.
- **Stage 2 — federated credential:** removes the per-environment Azure federated credential from the app registration (provenance-gated; a confirmed-missing credential is an idempotent success).
- **Stage 3 — GitHub environment:** deletes the GitHub deploy environment (its variables and secrets) via the GitHub API.
- **App registration:** left in place. Radius never deletes a Microsoft Entra app registration; it records an informational step and, on a successful deletion, reminds you to remove it yourself in the Azure portal if it is no longer needed.

## After a successful delete

- Tell the user it succeeded and include the workflow run URL (for a deployment delete).
- Note that deleting a deployment removed the app's resources; deleting an environment tore down the Radius environment on the cluster, removed the per-environment Azure federated credential, and removed the GitHub deploy environment (its variables and secrets), leaving the Entra app registration in place (remove it manually in the Azure portal if it is no longer needed).

## Common failure modes

- **`OCI archive repository is not configured` or GHCR authentication/visibility errors**
  → Recreate or update the deploy environment so `RADIUS_STATE_BACKEND=oci`, package-only `RADIUS_STATE_REGISTRY`, and `RADIUS_STATE_ARCHIVE=radius-state` are present. Confirm the delete workflow logs in to `ghcr.io` before `rad startup`, has `packages: write`, and that the state package is private or internal.

- **`The target resource is in progress state: Updating` (409 Conflict) on delete**
  → A resource was stranded in a non-terminal state by a prior run whose control plane was torn down before its async operation finished. The persisted state restores it still `Updating`, and no operation completes it, so every delete 409s. Force the resource to a terminal state (or remove its record) on a running control plane, then persist state, before retrying the delete.

## Related files

- The delete workflow templates are canonical in `radius-project/radius` at `.github/extension/` — `delete-application.yml` (dispatcher), `delete-azure.yml` / `delete-aws.yml` (provider `workflow_call` workflows), and `actions/*` (shared composite actions: `setup-control-plane`, `restore-state`, `delete-resource`, `teardown`). These landed in radius-project/radius PR #12367 and are now on `main`, so the extension fetches them at the delete ref (`DELETE_RADIUS_REF`, which defaults to the shared `RADIUS_REF` = `@main` and is overridable via `RADIUS_DELETE_REF`); it commits the dispatcher + the Azure provider workflow into the user repo at `.github/workflows/`, and the composite actions are referenced in place from `radius-project/radius`.
