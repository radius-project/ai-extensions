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

The environment tools and Canvas wizard share one operation owner: collect the environment's cloud settings, create and verify a dedicated private/internal GHCR state package with the selected GitHub account, write the package path and cloud settings as GitHub Environment variables, then commit and dispatch the provider's verification workflow. A package bootstrap, visibility, or repository-linkage failure stops setup before verification. Setup is verify-only: successful verification never deploys an application. Deployment requires a separate explicit action.

### AWS

1. **Form inputs**: env name, IAM Role ARN, AWS region, account ID, EKS cluster name, optional VPC + subnet IDs (required if the app uses `Radius.Data/mySqlDatabases`). These are written as GitHub Environment variables.
2. **Credential + cluster verification**: commits/updates `.github/workflows/verify-aws.yml` and dispatches it. The workflow logs into AWS via OIDC and runs `aws sts get-caller-identity`, then runs `aws eks update-kubeconfig` for the EKS cluster and `kubectl cluster-info` to confirm cluster access. Status is polled and shown live in the canvas.

### Azure

1. **Form inputs**: env name, AAD App (client) ID, tenant ID, subscription ID, resource group, AKS cluster name. These are written as GitHub Environment variables.
2. **Credential + cluster verification**: commits/updates `.github/workflows/verify-azure.yml` and dispatches it. The workflow runs `azure/login` via OIDC and `az account show`, then `az aks get-credentials` + `kubelogin convert-kubeconfig` + `kubectl cluster-info` to confirm AKS access. Status is polled and shown live in the canvas.

## How to invoke

Use `radius_setup_environment` to start setup without opening a panel. Supply `repo`, `environment`, `provider`, and the provider's required fields. Azure requires `tenantId`, `subscriptionId`, `resourceGroup` and `cluster`; an optional `clientId` uses an existing credential identity, otherwise the existing application selection/creation flow applies. AWS requires `roleArn`, `accountId`, `region` and `cluster`; optional subnet IDs remain a comma-separated string. Namespace defaults to `default`. An omitted branch means the current worktree branch only for the session repository; another repository requires an explicit branch.

The advertised SDK schemas are flat objects for provider compatibility, but accepted inputs remain conditional: do not mix Azure-only and AWS-only fields. Only `resume` accepts and requires `interactionId`, `provider`, `checkpoint` and `answer`; other controls reject those fields. The handler enforces these stricter rules even if the host only validates common required fields.

Setup trims leading and trailing whitespace from the environment name before admission. Poll `radius_environment_status` with the returned `operationId`, `repo` and canonical `environment`; for example, setup input `" dev "` returns `"dev"`. Status and control require that exact saved target rather than accepting a padded alias. `accepted` means the operation was admitted, not that verification succeeded. Status is read-only except for recording observed progress: it never deploys, redispatches, repairs or authorizes cleanup. Treat `unknown`, `expired`, `refused` and `unavailable` as explicit limitations, not permission to retry mutations.

Use `radius_environment_control` only for an action returned as eligible. `continue`, `verify`, `retry-setup`, `retry-cleanup`, `cancel-workflow`, `rollback`, `exit`, `abandon` and `bypass-verification` use the saved operation and its account. `stop` is a local, operation-bound safety request: it does not require fresh GitHub readiness or available credentials, so it can be admitted while setup holds the account lease. It remains subject to target, eligibility, currentness and durable-persistence checks. Stop is cooperative: an already-started write may settle before execution stops at its safe boundary; cancelling the exact saved workflow is a separate command. Rollback only removes proven-owned setup artifacts, not an arbitrary existing environment. Tool bypass requires a positively classified permissions failure.

For a supported Azure input prompt, pass `action: "resume"`, the current `interactionId`, `provider: "azure"`, `checkpoint`, and the typed `answer`. A service-management-reference answer contains its prompt `code` and `serviceManagementReference`. An application-selection answer contains its prompt `code` and either `createNew: true`, or `createNew: false` with `appId`. A replaced or consumed prompt cannot be reused.

Only a supported `setup-input` interaction ID is a runtime-held answer handle. IDs on unsupported account-selection, reauthorization, confirmation or other manual requirements are informational: satisfy the requirement through the trusted host or external flow, then invoke the tool again. Those IDs are never consent tokens and cannot be used to resume a setup prompt.

**Do not supply credentials, account proofs, panel selection handles or a `confirmed` boolean.** Multiple eligible GitHub accounts require a trusted host choice. Cleanup, abandonment, workflow cancellation and verification bypass require trusted host confirmation where applicable. Login/consent requirements still need the external authentication flow and subsequent service evidence; a dialog is not proof that authentication succeeded. If the result contains `interaction_required` or an unsupported interaction, follow its manual guidance. Do not automatically open a panel, switch accounts, assume consent or silently substitute another account.

If the user prefers the visual wizard, open Canvas explicitly:

```javascript
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "environment", repo: "<owner/repo>" }
})
```

For credentials/OIDC setup:

```javascript
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "credentials", repo: "<owner/repo>" }
})
```

The panel lands directly on the create-environment form. Closing it detaches the view without cancelling shared setup work.

> **Canvas not opening?** If the Radius panel does not appear even though this skill and the Radius plugin are installed, reload extensions (or restart the app) and try again.

## Required variables on the GitHub Environment

The verification workflow reads only GitHub Actions **variables** (`vars`), never secrets. OIDC eliminates the need to store long-lived cloud credentials.

**Common**

- `RADIUS_STATE_BACKEND` — explicitly set to `oci`.
- `RADIUS_STATE_REGISTRY` — package-only, per-environment GHCR path used by `rad startup` and `rad shutdown`, for example `ghcr.io/example/my-app-radius-state-production-1a2b3c4d5e6f`. It does not include `:radius-state`; the extension derives this value and each GitHub Environment receives a different package.
- `RADIUS_STATE_ARCHIVE` — the separate OCI state tag, set to `radius-state`.

**Optional route Gateway policy**

- `RADIUS_ROUTES_EXPOSURE` — applies only to the Radius-managed shared Gateway. Leave unset (or set `private`) for the safe default `ClusterIP` Service with no public IP. Set `public` only after the user explicitly asks and acknowledges that every routes app in this Radius environment will be exposed through the shared `LoadBalancer`.
- `RADIUS_ROUTES_GATEWAY_NAME` — selects a user-managed Gateway instead of the Radius-managed stack. When set, the deploy workflow validates the existing Gateway infrastructure and compatible listeners for all declared route kinds but never installs, changes, or adopts it.
- `RADIUS_ROUTES_GATEWAY_NAMESPACE` — namespace of the user-managed Gateway. Configure it together with `RADIUS_ROUTES_GATEWAY_NAME`.

Do not set `RADIUS_ROUTES_EXPOSURE` together with a user-managed Gateway. New environments do not need an exposure variable: absence intentionally means private. Application evidence such as a source `LoadBalancer` Service does not change this environment policy.

The managed Contour Gateway supports HTTP and TLS routes. TCP and UDP routes require a compatible user-managed Gateway. When multiple repositories target one cluster, exactly one repository should own the managed Gateway lifecycle; configure the others with `RADIUS_ROUTES_GATEWAY_NAME=radius` and `RADIUS_ROUTES_GATEWAY_NAMESPACE=radius-system` so they use it as validation-only BYO infrastructure.

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

- `extension.mjs` — the registered environment tools and Canvas use operation-owned direct services, verification workflow generation (`generateVerifyWorkflow`), and environment variable writes via `gh variable set ... --env`. Use the tools or wizard rather than calling private setup endpoints.
- The verification workflow templates are the canonical `verify-aws.yml` / `verify-azure.yml` (both named `Radius - Verify Credentials`) hosted in `radius-project/ai-extensions` at `.github/extension/`. The released extension fetches the matching provider template at the full source commit baked into its build, fills the `verify-ghcr-push` action reference with that same immutable SHA, commits it into the target user repo at `.github/workflows/verify-<provider>.yml`, then dispatches it. A fetch failure is a hard error; no generated verification workflow follows a mutable release ref.
