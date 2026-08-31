---
name: radius-delete
description: Delete a Radius application deployment, or delete a deploy environment and clean up its cloud state (Radius environment, Azure federated credential, GitHub environment, and private GHCR state package), via the Radius canvas. Use when the user asks to delete, remove, or tear down a deployed Radius application or a deploy environment.
---

# Radius — Delete a Deployment or Environment

Two distinct teardown flows are available from the Radius canvas:

- **Delete a deployment** dispatches the committed `delete-application.yml` GitHub Actions workflow, which spins up an ephemeral k3d Radius control plane, connects to the target AKS cluster, restores persisted state, runs `rad app delete`, and persists the updated state again before tearing the control plane down. Deleting the deployment also deletes that application's resources (running their recipes' delete path against the target cluster and cloud).
- **Delete an environment** is a tracked async operation that tears down the cloud state behind the environment, not just the GitHub record. It (1) dispatches the Azure-only `delete-environment` workflow to delete the Radius environment on the cluster **while the federated credential still exists** (the workflow authenticates with it), (2) removes the per-environment Azure federated credential only when immutable Radius provenance and immediate live revalidation prove that deletion is safe, (3) deletes the **GitHub deploy environment** (its stored variables and secrets) via the GitHub API, and (4) deletes the environment's dedicated private/internal GHCR state package after validating its repository linkage. The Microsoft Entra **app registration is left in place** because it can be shared; the completion acknowledgement links inline to the Azure Portal if it is no longer needed. The flow refuses to start while an application is still deployed, and only **Azure-backed** environments can be deleted today.

## When to use this skill

- "Delete my app" / "Remove application X from env Y" / "Tear down the deployment"
- "Delete the environment" / "Remove the dev environment"
- "Retry the environment deletion"

## Prerequisites

Before invoking this skill:

1. A GitHub deploy environment configured with cloud credentials → use the `radius-environment` skill if missing.
2. For a deployment delete: the application was deployed to that environment at least once (the delete restores persisted state to know what to remove).
3. Authenticated `gh` CLI access to dispatch workflows. The extension shells out to `gh`, which uses your stored GitHub credential (the keyring credential from `gh auth token`) and falls back to it when an injected token lacks the `workflow` scope — there is no separate extension-managed PAT to configure.

## How to invoke

Open the canvas hub and use the deployed-application view:

1. Reuse the existing Radius canvas instanceId when one is open; otherwise use `radius-panel`: `open_canvas({ canvasId: "radius", instanceId: "<radius-instance>", input: { page: "environment", repo: "<owner/repo>" } })`
2. Select the environment (and, for a deployment delete, the deployed application).
3. Click **Delete Deployment** to tear down the app, or use **Delete Env** to run the tracked environment cleanup. Live status streams until success / failure / timeout.

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

Deleting an environment runs as a tracked operation through the same progress panel as environment creation. Only Azure-backed environments are supported; deleting an AWS (or any non-Azure) environment is refused up front with a clear message and nothing is torn down. Any AWS-related deletion code is unsupported framework scaffolding, not a compatibility contract, and may change or be removed when AWS support is designed.

- Refuses to proceed while an application is still deployed to the environment (its cloud resources would be orphaned), and points you at the deployment-delete flow first.
- **Stage 1 — Radius environment:** dispatches the Azure-only `delete-environment` workflow, which connects to the target AKS cluster and runs `rad env delete`. This runs first, while the federated credential still exists, because the workflow authenticates with it. If this cannot be confirmed (dispatch failed, run not found, timeout, or a non-guard failure), the whole deletion **stops fail-closed** and is reported as a retryable partial failure — the credential and GitHub environment a retry needs are left in place.
- **Stage 2 — federated credential:** removes the per-environment Azure federated credential only after immutable tenant, application-object, credential-object, repository, subject-configuration, issuer, and audience evidence proves Radius created it for this consumer and immediate live revalidation still matches. Reused, shared, unproven, changed, or insufficiently scoped custom credentials are retained with guidance; a confirmed-missing credential is an idempotent success.
- **Stage 3 — GitHub environment:** deletes the GitHub deploy environment (its variables and secrets) via the GitHub API.
- **Stage 4 — GHCR state package:** derives the environment-exclusive package path, verifies that the package is private/internal and linked to the target repository, deletes it through the GitHub Packages API, and confirms it is absent. Missing `delete:packages` access stops the operation as a retryable partial failure only after the earlier teardown has completed; grant the scope and retry, or delete the named package manually and retry. Every attempt reloads the active GitHub CLI package credential, so retry uses the token updated by `gh auth refresh` rather than the failed attempt's cached token. An already-absent package is idempotent success.
- **Stage 5 — app registration:** leaves the app registration in place. Radius never deletes a Microsoft Entra app registration; it records an informational step and, after a concluded deletion, includes an inline Azure Portal link in the acknowledgement if the registration is no longer needed.

An incomplete deletion exposes only **Retry deletion**. Retry reopens the same durable operation, preserves succeeded stages, resets unresolved stages, and resumes through the idempotent runner. Delete operations are not pausable and never expose the create flow's **Stop setup**, Continue setup, rollback, or exit controls. While deletion is in progress, **Delete Env** is disabled and the environment cannot be selected for deployment.

## After a successful delete

- Tell the user it succeeded and include the workflow run URL (for a deployment delete).
- Note that deleting a deployment removed the app's resources. For environment deletion, report the operation's actual steps: the Radius environment, GitHub deploy environment, and private GHCR state package were removed; a proven-safe credential was removed or a retained credential was explained; and the Entra app registration was left in place with the acknowledgement's Azure Portal link.

## Common failure modes

- **`OCI archive repository is not configured` or GHCR authentication/visibility errors**
  → Recreate or update the deploy environment so `RADIUS_STATE_BACKEND=oci`, package-only `RADIUS_STATE_REGISTRY`, and `RADIUS_STATE_ARCHIVE=radius-state` are present. Confirm the delete workflow logs in to `ghcr.io` before `rad startup`, has `packages: write`, and that the state package is private or internal.

- **Environment deletion cannot delete the GHCR state package**
  → Refresh the active GitHub CLI credential with `gh auth refresh --hostname github.com --scopes delete:packages`, then use **Retry deletion**. Earlier teardown stages are not replayed. Alternatively, delete the package named in the failure manually in GitHub Packages and retry so Radius can confirm it is absent.

- **`The target resource is in progress state: Updating` (409 Conflict) on delete**
  → A resource was stranded in a non-terminal state by a prior run whose control plane was torn down before its async operation finished. The persisted state restores it still `Updating`, and no operation completes it, so every delete 409s. Force the resource to a terminal state (or remove its record) on a running control plane, then persist state, before retrying the delete.

- **Environment deletion stopped partway** → Use **Retry deletion** in the progress panel. Do not start a second deletion or look for **Stop setup**; the existing durable operation resumes only unresolved stages and keeps successful work.

## Related files

- The delete workflow templates are canonical in `radius-project/radius` at `.github/extension/` — `delete-application.yml` (dispatcher), `delete-azure.yml` / `delete-aws.yml` (provider `workflow_call` workflows), and `actions/*` (shared composite actions: `setup-control-plane`, `restore-state`, `delete-resource`, `teardown`). These landed in radius-project/radius PR #12367 and are now on `main`, so the extension fetches them at the delete ref (`DELETE_RADIUS_REF`, which defaults to the shared `RADIUS_REF` = `@main` and is overridable via `RADIUS_DELETE_REF`); it commits the dispatcher + the Azure provider workflow into the user repo at `.github/workflows/`, and the composite actions are referenced in place from `radius-project/radius`.
- Environment deletion orchestration lives in `packages/adapter-canvas/src/server/services/environment-deletion.ts`; operation retry/control policy lives in `packages/adapter-canvas/src/operations.ts` and `packages/adapter-canvas/src/server/routes/operations-control.ts`.
- The implemented safety and sharing boundaries are documented in `docs/design/2026-08-environment-deletion-cloud-cleanup.md`.
