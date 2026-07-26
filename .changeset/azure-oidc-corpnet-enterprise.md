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
