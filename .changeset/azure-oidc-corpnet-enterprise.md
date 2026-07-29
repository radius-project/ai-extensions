---
"@radius-project/core": patch
"@radius-project/canvas": patch
---

Make Azure OIDC deploy work end-to-end from locked-down enterprise
environments (e.g. Microsoft Corpnet):

- Strip `COPILOT_AGENT_SESSION_ID` from every child CLI (`az`/`aws`/`gh`/
  `kubectl`) invocation. Azure CLI's "agentic session" tagging injects a
  `client_session` claims challenge that bypasses the token cache and forces a
  fresh ESTS fetch, which locked-down tenants reject with `AADSTS901001` —
  breaking discovery, app-registration, and role-assignment calls. The canvas
  runs `az` as the signed-in human for infra setup, so the tag is stripped.

- Compute the GitHub Actions federated-credential `subject` from what GitHub
  actually mints instead of assuming `repo:{owner}/{repo}:...`. A new pure
  `buildOidcSubject` reads the repo's OIDC subject customization
  (`use_default` / `include_claim_keys`) and supports GitHub's immutable
  subject rollout (`repo:{owner}@{ownerId}/{repo}@{repoId}:...`). For the
  default (uncustomized) case both the mutable and immutable federated
  credentials are created so whichever token GitHub presents matches; a
  customized subject builds the single exact value and fails loud on an
  unknown claim key rather than emitting a wrong subject (which fails
  deploy-time login with `AADSTS700213`).

- Support enterprise Entra tenants that require a Service Management Reference
  on new App Registrations: `az ad app create` is attempted without one first
  and, only if tenant policy rejects it, the user is prompted for the SMR
  (for Microsoft-internal tenants, the Service Tree ID GUID) and the create is
  retried.

- Resolve the deploy App Registration idempotently (lookup-then-create, scoped
  to apps the signed-in user owns) instead of creating a new app on every run,
  preventing tenant sprawl and orphaned `AZURE_CLIENT_ID`s. Federated
  credentials are deduplicated by subject to stay under Azure's per-app cap.

- Preflight repository access and admin permission before any Azure/GitHub
  mutation, turning GitHub's bare `HTTP 404`s into actionable guidance
  (wrong active `gh` account vs. insufficient permission), and surface the
  Entra enterprise-claim rejection (`AADSTS7002381`) with a tenant-agnostic
  explanation when a personal-account repo cannot satisfy the policy.

- Validate every value that reaches an `az`/`gh` argv (repo slug, resource
  group, cluster, tenant/subscription/SMR GUIDs, App Registration name) and
  surface real discovery failures instead of a misleading "Found 0".

- Act on GitHub as the identity the user sees. The host injects a
  `GH_TOKEN`, but the previous heuristic stripped it whenever any stored
  keyring login existed, silently switching setup to the keyring-active
  account (e.g. an enterprise/EMU login) that may lack access to the target
  repo or Azure tenant. The token is now kept when it already carries the
  `workflow` scope, and stripped only when it genuinely lacks it and a keyring
  login has it. The Create Environment dialog shows which account setup will
  act as, warns on a mismatch or a missing `workflow` scope, and offers an
  account switcher (`gh auth switch`). The private GHCR state package is now
  bootstrapped with credentials pinned to that same acting account (via
  `gh auth token --user`) instead of whatever keyring account is active, so a
  container-registry push no longer fails with "As an Enterprise Managed User,
  you cannot access this content" when an EMU account is the active login.

- Reframe the Create Environment dialog around the GitHub↔cloud OIDC
  connection it actually sets up. The form is now four numbered steps — name
  the environment, connect a GitHub account to a cloud credential profile,
  choose the deploy identity (Entra app), and pick the landing zone — with a
  GitHub→cloud connection visual and copy that attributes each action to the
  correct side (the GitHub account commits the workflow and publishes the state
  package; the cloud profile creates the Entra app, OIDC trust, and role
  assignment). The credential-profile picker now surfaces the verified
  subscription and signed-in identity, and profiles persist the friendly
  `subscriptionName`/`tenantName` so the destination reads as a name rather
  than a bare GUID.

- Grant the deploy identity data-plane access on AKS clusters that use Azure
  RBAC for Kubernetes (the default for AKS Automatic). Contributor on the
  resource group is management-plane only, so `kubectl`/data-plane calls fail
  with "User does not have access to the resource in Azure". Setup now also
  assigns the "Azure Kubernetes Service RBAC Cluster Admin" role scoped to the
  target cluster (best-effort and non-fatal, since it is a no-op on clusters
  that do not use Azure RBAC).
