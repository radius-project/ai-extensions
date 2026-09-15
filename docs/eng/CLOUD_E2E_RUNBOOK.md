# Cloud E2E runbook

The short version, for whoever picks up a red **Cloud E2E** run. The [design note](../design/2026-08-cloud-e2e-environment-lifecycle.md) explains why the tier exists and how it is built; this page is only what you do.

## Read this before you read the log

A red run here is one of three completely different things, and they need three different responses:

| Class                      | What it means                                                                           | Who fixes it                              |
|----------------------------|-----------------------------------------------------------------------------------------|-------------------------------------------|
| **Product regression**     | The product issued a command that real Azure, Entra, or GitHub rejected                 | The author of the change                  |
| **Infrastructure failure** | The cloud, the identity, or the runner did not cooperate; the product is not implicated | Whoever is on call; often nobody - re-run |
| **Leaked state**           | An earlier run did not clean up, so this one refused to start                           | Cleanup, not the product                  |

**Classify before you debug.** Every other tier in this repository is hermetic, so a red run there means exactly one thing. This one does not, and the failure text of all three looks like "the cloud test failed". Treating an Azure capacity error as a product regression wastes a day; treating a real regression as flake ships the bug. If you take nothing else from this page, take the first triage step below.

## First triage step

Open the run, open the failing step, and answer one question: **did the product's own command fail, or did something around it?**

1. Read the top of the failure. `assertCleanSlate()` naming a leftover artifact is **leaked state** - stop, jump to [Leaked state](#leaked-state).
2. If the failure is an `az` or Graph error before the journey reaches the product, it is **infrastructure** - jump to [Infrastructure failure](#infrastructure-failure).
3. If the journey drove the product and an assertion about what the product produced failed, it is a **product regression** - jump to [Product regression](#product-regression).

Then download the `cloud-e2e-diagnostics` artifact. It is uploaded on success as well as failure, so a passing run's artifact is the baseline you read the failing one against.

| File                               | Answers                                                         |
|------------------------------------|-----------------------------------------------------------------|
| `test-results/cloud/`              | The Playwright trace. The single most useful file here          |
| `playwright-report-cloud/`         | The HTML report, if you would rather start there                |
| `az-account.json`                  | Which tenant and subscription the run actually authenticated to |
| `az-leftover-resource-groups.json` | Groups the run left behind                                      |
| `az-leftover-applications.json`    | Entra applications the run left behind                          |
| `gh-environments.json`             | Environments on the fixture repository                          |
| `gh-branches.json`                 | Whether the fixture branch is dirty                             |
| `gh-fixture-run-*.log`             | The **fixture repository's** failing workflow logs              |

That last one matters more than it looks. The product commits a deploy workflow to the fixture repository and dispatches it. That workflow runs _there_, not here, so its failure is invisible in this job's own log.

## Product regression

The thing the tier exists to catch: the product built a request that real Azure, Entra, or GitHub rejected, and no hermetic test could have known.

| Symptom                                                                        | Likely cause                                                                    | First thing to do                                                                                                                                          |
|--------------------------------------------------------------------------------|---------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Graph rejects the application or federated credential the product created      | A request shape changed - a field name, an audience, a subject claim            | Open the trace, find the request, compare it to the Graph API reference                                                                                    |
| The deploy workflow exists as a pull request rather than on the default branch | A protected-branch-style direct commit failed after the token was minted        | Inspect the direct-commit 403 or 409. A missing `workflows: write` grant fails token creation or workflow publication instead of activating this fallback. |
| Role assignment succeeds but the deployment is denied                          | Scope or role definition changed                                                | `az role assignment list --scope /subscriptions/<sub>/resourceGroups/<configured-resource-group>`                                                          |
| The environment exists but a variable is absent or wrong                       | The product's variable-writing path changed                                     | `gh api repos/<fixture>/environments/radtest-<uid>/variables`                                                                                              |
| Deploy reaches `failed` instead of terminal state `complete`                   | The real dispatcher or Azure deploy workflow rejected the request               | Open the reported workflow run and use the final deploy log lines to find the first failing product command                                                |
| Deploy reaches `complete` but no ready labelled workload exists on AKS         | The workflow went green without landing a runnable Radius application           | Fetch a fresh explicit kubeconfig with `az aks get-credentials --file <path>`, then query `radapp.io/application=<app>` with `kubectl --kubeconfig <path>` |
| The environments page never shows the environment stage one created            | `/api/list-environments` stopped reporting it, so nothing can be deleted        | `gh api repos/<fixture>/environments` - if GitHub has it and the page does not, the regression is in the product                                           |
| `/api/delete-environment` does not answer 409 `app-deployed` for the live app  | `resolveEnvDeployment` failed to recognize the real deployment record           | Check the response's `code`, `app`, and message, then inspect `gh api repos/<fixture>/deployments`                                                         |
| `/api/delete-environment` answers 503                                          | The deployment check threw, so the handler failed closed - by design            | The 503 body carries the underlying error. This is correct behaviour for an unreadable state, not a bug in itself                                          |
| A deleted deployment remains in Canvas or leaves labelled workloads on AKS     | The delete workflow or deployment resolver reported completion too early        | Compare `/api/list-deployments?fresh=1` with the independent `kubectl get deployments` result                                                              |
| Deployment deletion removes the GitHub Environment or product-created identity | The delete crossed the deployment/environment ownership boundary                | Inspect the Environment variables and Entra application before attempting the final environment deletion                                                   |
| The delete returns 202 but the Environment is still on GitHub                  | The handler accepted the operation without the `gh api --method DELETE` landing | `gh api repos/<fixture>/environments/radtest-<uid>` - a 200 from GitHub after the product's 202 is a real regression                                       |
| A `Refusing to assert that ... is absent` error                                | An absence assertion ran without the matching presence assertion                | Not a product failure. Stage one did not reach the presence assertion; fix that failure first and re-read this run                                         |

The last of these is the failure mode with the most expensive false negative. Missing `workflows: write` fails token creation or workflow publication, while another protected-branch-style direct-commit failure can still create a fallback pull request. A journey that only checked "a workflow file exists" could therefore pass while the product never wrote to the default branch. The spec asserts the files are **on the default branch** precisely so this fails loudly. If you are tempted to relax that assertion, do not.

**Fix it in the product, with a hermetic test that would have caught it** where one can exist. A regression that can only be caught by a nightly cloud run is one nobody sees for a day.

## Infrastructure failure

The product is not implicated. Establish that, then decide whether to re-run or wait.

| Symptom                                          | Cause                                                                         | What to do                                                                                                                                                                                                          |
|--------------------------------------------------|-------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| The configured AKS cluster cannot be read        | The cluster was removed, renamed, stopped, or the runner lost access          | Verify `AIEXT_CLOUD_E2E_RESOURCE_GROUP` and `AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME`, then run `az aks show` with the workflow identity                                                                                   |
| The configured AKS location does not match       | `AIEXT_CLOUD_E2E_AZURE_LOCATION` disagrees with the live cluster              | Set the variable to the cluster's canonical Azure location, such as `centralus`, not its display name                                                                                                               |
| A Graph read finds nothing that was just written | Entra propagation delay                                                       | Nothing. The product retries and the fixture polls. If it fails anyway, the bound is too tight - widen it, do not add a sleep                                                                                       |
| `azure/login` fails                              | The federated credential does not match, or the identity was changed upstream | Compare `az-account.json` against the identity `radius-project/wellknown` publishes. The credential is federated on the default branch only                                                                         |
| The job is cancelled at 235 minutes              | The run genuinely hung                                                        | This should not happen: Playwright caps each test at 55 minutes and the whole suite at 220, writing the trace first. If GitHub cancelled first, the ordering is broken - see the timeout comment in `cloud-e2e.yml` |

**Re-run rather than investigate** when the error is clearly Azure's and the same run passed yesterday. **Do not re-run repeatedly** to make a red run green: the shared cluster may retain evidence from the failed deployment, and a run that only passes sometimes is telling you something.

## Leaked state

A previous run did not clean up, so this one refused to start rather than asserting against someone else's leftovers. This is the failure the clean-slate probe exists to produce, and it is working correctly when you see it.

The cleanup workflow reclaims product-created Entra, Azure RBAC, and GitHub state automatically, twice daily. It also retains the legacy sweep for tagged per-run resource groups created by older workflow revisions. The sweep explicitly excludes `AIEXT_CLOUD_E2E_RESOURCE_GROUP`, even if that group later matches the legacy prefix and tags. It never deletes the configured shared resource group or AKS cluster. **Run it by hand rather than deleting things yourself**:

```bash
gh workflow run cloud-e2e-cleanup.yml --repo radius-project/ai-extensions
```

If you must inspect first:

```bash
# The Entra application - one per repository, not one per run
az ad app list --filter "displayName eq 'radius-deploy-<owner>-<name>'" \
  --query '[].{id:id,displayName:displayName,createdDateTime:createdDateTime}'

# Per-run environments on the fixture repository
gh api "repos/<fixture>/environments" --jq '.environments[].name'

# Legacy per-run resource groups created by older suite revisions
az group list --query "[?starts_with(name, 'radtest-canvas')].{name:name,tags:tags}"

# Whether the fixture branch is still at the pinned baseline
gh api "repos/<fixture>/git/ref/heads/<default-branch>" --jq .object.sha
```

Two boundaries worth knowing before you go looking for a gap:

- **The shared AKS cluster is fixture scaffolding, not disposable test output.** CI requires the cluster to report provisioning state `Succeeded` and power state `Running`, then uses it for discovery and deployment. Neither fixture teardown nor scheduled cleanup deletes it. Reclamation deletes only Kubernetes deployments and pods carrying this run's Radius application label; it does not delete the namespace or unrelated workloads.
- **The Entra application is repository-scoped, not run-scoped.** The product derives its name from the repository alone, with no per-run uniqueness. That is why both workflows share one `concurrency` group with `cancel-in-progress: false`: two concurrent runs would contend for one Entra object, and a cancelled run strands cloud state that turns into tomorrow's leaked-state failure.
- **Product deletion and fixture reclamation own different artifacts.** Deployment deletion preserves the GitHub Environment, its variables, the repository-scoped Entra application, its federated credentials, and its role assignments so the environment can deploy again. Final environment deletion removes the GitHub Environment and its per-environment federated credentials, as implemented by `radius-project/ai-extensions#398`, while deliberately retaining the shared Entra application and role assignments. After assertions, `reclaimLeakedProductArtifacts()` removes only the three expected assignments for the product-created service principal at the configured resource-group and AKS scopes. An unexpected role fails cleanup for manual investigation instead of being deleted.

## When a run is cancelled

Do not cancel a Cloud E2E run. Cancelling mid-flight can strand a deployment, an Entra application, and GitHub state, converting one slow run into a failure on the next one. The workflow is configured never to cancel itself for this reason. If a CI run must be stopped, dispatch the cleanup workflow after cancellation completes. Cleanup preserves the shared resource group and AKS cluster.

## Required configuration

The workflow reads these repository Actions variables:

| Variable                             | Current value                          | Purpose                                           |
|--------------------------------------|----------------------------------------|---------------------------------------------------|
| `AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY` | `radius-project/ai-extensions-fixture` | Confirms the repository pinned by the test source |
| `AIEXT_CLOUD_E2E_AZURE_LOCATION`     | `centralus`                            | Confirms the live cluster's Azure location        |
| `AIEXT_CLOUD_E2E_RESOURCE_GROUP`     | `ai_extensions_test`                   | Selects the precreated resource group             |
| `AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME`   | `ai_extensions_aks`                    | Selects the precreated AKS cluster                |

The fixture repository is pinned by [`FIXTURE_BASELINE_SHA`](../../packages/adapter-canvas/test/e2e-cloud/support/fixture-repository.ts). CI requires both cluster variables, verifies the cluster through `az aks show`, and fails before the product journey if either value is absent, malformed, inaccessible, in a different location, not fully provisioned, or stopped. Local runs may omit both variables to provision disposable infrastructure in the developer's own subscription.

The dedicated Cloud E2E GitHub App must remain installed only on the fixture repository with `actions: write`, `administration: read`, `contents: write`, `deployments: read`, `environments: write`, `pull_requests: write`, `secrets: write`, `variables: write`, and `workflows: write`. Store its client ID and private key as `CLOUD_E2E_BOT_CLIENT_ID` and `CLOUD_E2E_BOT_PRIVATE_KEY`.

The organization-level `GH_RAD_CI_BOT_PAT` secret is already visible to all organization repositories. It belongs to `rad-ci-bot` and needs `read:packages`, `write:packages`, and `delete:packages`. `CLOUD_E2E_PACKAGES_USER` stores only the account login. Repository and workflow APIs continue to use the short-lived fixture-scoped GitHub App token.

The first dispatched run reached Azure login and GitHub App token creation, then exposed a Playwright worker handoff defect before any lifecycle stage ran. That defect was corrected in #812. **Create, deploy, deployment deletion, and environment deletion still require a successful real-cloud run.**
