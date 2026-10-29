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

For a service-principal creation failure, read the terminal operation's `failure.message` in the Playwright trace. While the create outcome is unknown, the browser does not receive the diagnostic. The server calls `/api/azure-auto-setup` itself, so the trace has no `202` body. Radius shows the diagnostic in `failure.message` only when reconciliation ends. Radius preserves the command exit code, timeout flag, and available error output, even if later reads find no principal. It redacts credentials and limits each saved diagnostic to 2,000 characters, plus a truncation marker. Diagnostic text alone never authorizes a retry. Runs recorded before this fix can contain only the generic service-principal error; that missing output cannot be recovered from the trace.

After an uncertain service-principal create, Radius makes up to six reads with bounded delays. A not-found response can reflect directory propagation, so it does not prove the create failed. If the outcome stays unknown, Radius neither repeats the create nor starts cleanup. Only a definite temporary rejection, such as throttling or an application-not-found rejection, permits another create, with at most six create attempts. Stop is checked before and after each retry delay. Failure cleanup uses the operation's selected GitHub account for variable rollback, environment identity checks, and deletion. A missing account, an unreadable identity, or a replacement environment cannot authorize deletion.

Federated credential creation uses the same six-attempt Azure budget. After a definite propagation or throttling rejection, Radius uses default delays of 2, 4, 6, 8, then 10 seconds between attempts. It honors `Retry-After` values up to 10 seconds; a longer value ends the retry rather than sending a request too early. Stop is checked before the delay and before the next write. A lost or uncertain response must be reconciled first; a later not-found read alone does not authorize another write. An authorization rejection ends setup without a retry. The terminal operation retains the final Azure error if all attempts fail.

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

| Symptom                                                                                    | Likely cause                                                                    | First thing to do                                                                                                                                          |
|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Graph rejects the application or federated credential the product created                  | A request shape changed - a field name, an audience, a subject claim            | Open the trace, find the request, compare it to the Graph API reference                                                                                    |
| The deploy workflow exists as a pull request rather than on the default branch             | A protected-branch-style direct commit failed after the token was minted        | Inspect the direct-commit 403 or 409. A missing `workflows: write` grant fails token creation or workflow publication instead of activating this fallback. |
| Role assignment succeeds but the deployment is denied                                      | Scope or role definition changed                                                | `az role assignment list --scope /subscriptions/<sub>/resourceGroups/<configured-resource-group>`                                                          |
| The environment exists but a variable is absent or wrong                                   | The product's variable-writing path changed                                     | `gh api repos/<fixture>/environments/radtest-<uid>/variables`                                                                                              |
| Deploy reaches `failed` instead of terminal state `complete`                               | The real dispatcher or Azure deploy workflow rejected the request               | Open the reported workflow run and use the final deploy log lines to find the first failing product command                                                |
| Deploy reaches `complete` but no ready labelled workload exists on AKS                     | The workflow went green without landing a runnable Radius application           | Fetch a fresh explicit kubeconfig with `az aks get-credentials --file <path>`, then query `radapp.io/application=<app>` with `kubectl --kubeconfig <path>` |
| The environments page never shows the environment stage one created                        | `/api/list-environments` stopped reporting it, so nothing can be deleted        | `gh api repos/<fixture>/environments` - if GitHub has it and the page does not, the regression is in the product                                           |
| `/api/delete-environment` does not answer 409 `app-deployed` for the live app              | `resolveEnvDeployment` failed to recognize the real deployment record           | Check the response's `code`, `app`, and message, then inspect `gh api repos/<fixture>/deployments`                                                         |
| `/api/delete-environment` answers 503                                                      | The deployment check threw, so the handler failed closed - by design            | The 503 body carries the underlying error. This is correct behaviour for an unreadable state, not a bug in itself                                          |
| A deleted deployment remains in Canvas or leaves labelled workloads on AKS                 | The delete workflow or deployment resolver reported completion too early        | Compare `/api/list-deployments?fresh=1` with the independent `kubectl get deployments` result                                                              |
| Deployment deletion removes the GitHub Environment or product-created identity             | The delete crossed the deployment/environment ownership boundary                | Inspect the Environment variables and Entra application before attempting the final environment deletion                                                   |
| The delete returns 202 but the Environment is still on GitHub                              | The handler accepted the operation without the `gh api --method DELETE` landing | `gh api repos/<fixture>/environments/radtest-<uid>` - a 200 from GitHub after the product's 202 is a real regression                                       |
| A `Refusing to assert that ... is absent` error                                            | An absence assertion ran without the matching presence assertion                | Not a product failure. Stage one did not reach the presence assertion; fix that failure first and re-read this run                                         |
| The signed-out probe does not fail with `az-subscription-set-failed` or `az-not-logged-in` | The product no longer checks the Azure CLI sign-in before it acts               | Open the trace and find the first Azure CLI command the product ran after Create                                                                           |
| The foreign app probe does not fail with `app-registration-not-owned`                      | The product reused or changed an app registration that it does not own          | Compare the seeded app's owners, tags, and federated credentials with the values in the test failure                                                       |
| The orphan app probe does not fail with `app-registration-radius-orphaned`                 | The product no longer reads the Radius tags on an app that it does not own      | Check the seed's tags first (see [Seeded app registrations](#seeded-app-registrations)); the probe stops early if they are wrong                           |
| A refusal probe leaves a GitHub Environment behind                                         | The product wrote to GitHub before it checked Azure                             | `gh api repos/<fixture>/environments/<probe-name>`. Delete it, then find the write that moved before the check                                             |
| The second create makes a new app registration                                             | The product no longer finds the app registration that it made in stage one      | `az ad app list --filter "displayName eq 'radius-deploy-<owner>-<name>'"`. More than one match is the regression                                           |

The last of these is the failure mode with the most expensive false negative. Missing `workflows: write` fails token creation or workflow publication, while another protected-branch-style direct-commit failure can still create a fallback pull request. A journey that only checked "a workflow file exists" could therefore pass while the product never wrote to the default branch. The spec asserts the files are **on the default branch** precisely so this fails loudly. If you are tempted to relax that assertion, do not.

**Fix it in the product, with a hermetic test that would have caught it** where one can exist. A regression that can only be caught by a nightly cloud run is one nobody sees for a day.

## Infrastructure failure

The product is not implicated. Establish that, then decide whether to re-run or wait.

| Symptom                                          | Cause                                                                         | What to do                                                                                                                                                                                                                                          |
|--------------------------------------------------|-------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| The configured AKS cluster cannot be read        | The cluster was removed, renamed, stopped, or the runner lost access          | Verify `AIEXT_CLOUD_E2E_RESOURCE_GROUP` and `AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME`, then run `az aks show` with the workflow identity                                                                                                                   |
| The configured AKS location does not match       | `AIEXT_CLOUD_E2E_AZURE_LOCATION` disagrees with the live cluster              | Set the variable to the cluster's canonical Azure location, such as `centralus`, not its display name                                                                                                                                               |
| A Graph read finds nothing that was just written | Entra propagation delay                                                       | Nothing. The product retries and the fixture polls. If it fails anyway, the bound is too tight - widen it, do not add a sleep                                                                                                                       |
| `azure/login` fails                              | The federated credential does not match, or the identity was changed upstream | Compare `az-account.json` against the identity `radius-project/wellknown` publishes. The credential is federated on the default branch only                                                                                                         |
| The job is cancelled at 340 minutes              | The run genuinely hung                                                        | This should not happen: Playwright caps each test at 55 minutes and the whole suite at 274 (329 with the Copilot app host), writing the trace first. If GitHub cancelled first, the ordering is broken - see the timeout comment in `cloud-e2e.yml` |

**Re-run rather than investigate** when the error is clearly Azure's and the same run passed yesterday. **Do not re-run repeatedly** to make a red run green: the shared cluster may retain evidence from the failed deployment, and a run that only passes sometimes is telling you something.

## Leaked state

A previous run did not clean up, so this one refused to start rather than asserting against someone else's leftovers. This is the failure the clean-slate probe exists to produce, and it is working correctly when you see it.

The cleanup workflow runs automatically once daily, two hours before the scheduled Cloud E2E run. For each expired test environment, it first dispatches the fixture repository's `delete-application.yml` workflow and waits for Radius to delete the Kubernetes and Azure resources in the application, including the Azure-backed PostgreSQL resource. If the dispatcher is missing or fails, cleanup independently sweeps the fixture-labelled Kubernetes workloads and stale resources in the shared Azure resource group. It may continue with identity and GitHub recovery only after either the Radius delete workflow succeeds or both independent resource sweeps succeed. It deletes the run's Entra identity, Azure role assignments, GitHub deployment records, GitHub Environment, GHCR state package, and generated workflow branches, but resets the fixture default branch only after every preceding recovery sweep succeeds. It also retains the legacy sweep for tagged per-run resource groups created by older workflow revisions. The sweep explicitly excludes `AIEXT_CLOUD_E2E_RESOURCE_GROUP`, even if that group later matches the legacy prefix and tags. It never deletes the configured shared resource group or AKS cluster. **Run it by hand rather than deleting things yourself**:

```bash
gh workflow run cloud-e2e-cleanup.yml --repo radius-project/ai-extensions
```

By default, cleanup deletes only state that is older than 6 hours. To delete all leaked state, whatever its age, set `max_age_hours` to `0`. Do this only when no Cloud E2E run is in progress. The value must be a whole number from 0 to 720:

```bash
gh workflow run cloud-e2e-cleanup.yml --repo radius-project/ai-extensions -f max_age_hours=0
```

Cleanup verifies each delete:

| Delete                                  | Verification                                       | Timeout     |
|-----------------------------------------|----------------------------------------------------|-------------|
| Radius workloads on the shared cluster  | The labelled workloads are gone                    | 180 seconds |
| `default-cloud-e2e` namespace           | The namespace is gone                              | 120 seconds |
| Resources in the shared resource group  | Only the AKS cluster remains                       | 300 seconds |
| Entra service principal                 | Microsoft Graph returns `Request_ResourceNotFound` | 60 seconds  |
| Entra application                       | Microsoft Graph returns `Request_ResourceNotFound` | 60 seconds  |
| GitHub deployment record                | The REST API returns `404`                         | 60 seconds  |
| Radius environment (GitHub Environment) | The REST API returns `404`                         | 60 seconds  |
| GHCR state package                      | The package cannot be read                         | 12 seconds  |
| Fallback pull request and branch        | The pull request is closed and the branch is gone  | 60 seconds  |

Each check call gets only the time that remains before its timeout. If a call stalls, cleanup stops it and its child processes, and the wait between calls never passes the timeout.

A failure that a retry cannot fix stops the step at once. Examples are HTTP `400`, `401`, `403`, `405`, `409`, `410`, or `422` from GitHub (but not a rate limit), `Forbidden` from Kubernetes, `AuthorizationFailed` from Azure, and `Authorization_RequestDenied` from Microsoft Graph. A `422` from the `delete-application.yml` dispatch means that the workflow is not on the fixture default branch, for example after a reset. In that case, Radius cannot delete the application, so the independent Kubernetes and Azure sweeps must reclaim the resources. Recovery takes two cleanup runs. In the first run, the dispatch fails, so the GHCR state step does not run and the branch is not reset. If the Kubernetes and Azure sweeps pass, the later steps still delete the environment, its Entra identity, and its deployment records. The second run finds no environment to dispatch for, so it can delete the remaining state and reset the branch. Do not delete the environment by hand.

Before cleanup resets the fixture default branch, a final step checks for leaked state of any age: GitHub Environments with the test prefix, the Entra application, labelled cluster workloads, the `default-cloud-e2e` namespace, and GHCR state packages. It finds the Entra application by name, also when it has no Radius tags, and it finds a state package also when its update time cannot be read. If it finds any, cleanup does not reset the branch. A reset removes the generated `delete-application.yml`, so a reset while an environment remains makes that environment harder to delete. Run cleanup again with `max_age_hours=0` to clear recent state.

The Cloud E2E run also stops at once on leaked state of any age. For example, if an earlier environment still owns the `default` namespace, the create wizard refuses the request, and the test fails at once instead of waiting for its timeout.

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

- **The shared AKS cluster is fixture scaffolding, not disposable test output.** CI requires the cluster to report provisioning state `Succeeded` and power state `Running`, then uses it for discovery and deployment. Neither fixture teardown nor scheduled cleanup deletes it. Radius application deletion removes the application's Azure and Kubernetes resources first. A label-scoped Kubernetes deletion then removes residual application workloads from the shared `default` workload namespace without deleting that namespace or unrelated workloads. After workload reclamation, cleanup deletes the separate fixture-owned `default-cloud-e2e` namespace that Radius reserves for the `cloud-e2e` application.
- **The Entra application is repository-scoped, not run-scoped.** The product derives its name from the repository alone, with no per-run uniqueness. That is why both workflows share one `concurrency` group with `cancel-in-progress: false`: two concurrent runs would contend for one Entra object, and a cancelled run strands cloud state that turns into tomorrow's leaked-state failure.
- **Product deletion and fixture reclamation own different artifacts.** Deployment deletion preserves the GitHub Environment, its variables, the repository-scoped Entra application, its federated credentials, and its role assignments so the environment can deploy again. Final environment deletion removes the GitHub Environment and its per-environment federated credentials, as implemented by `radius-project/ai-extensions#398`, while deliberately retaining the shared Entra application and role assignments. After assertions, `reclaimLeakedProductArtifacts()` runs Radius application deletion before removing identity or recovery state, then removes only the three expected assignments for the product-created service principal at the configured resource-group and AKS scopes.
- **A deployment record outlives the environment that names it.** GitHub links a deployment to its environment by name rather than by id, so deleting the environment strands its records instead of removing them, and the product never deletes them — to it, a deployment record is history, not an owned resource. Only the suite that created them can, so both fixture teardown and scheduled cleanup delete them explicitly, before the environment. Each deletion is two calls: mark the record `inactive`, then `DELETE` it. GitHub rejects deleting an active record, and a record whose job never reported a status is active by default. If any record cannot be reclaimed, both paths hold the environment back rather than deleting it, so the next sweep can still find the records by name and retry.
- **Cleanup fails closed.** If Radius application deletion fails and either independent Kubernetes or Azure recovery also fails, cleanup preserves the Entra identity, role assignments, GitHub Environment, GHCR state package, generated delete workflow, and repository state so a developer can retry or investigate. If the independent sweeps prove the workload and Azure resources are gone, cleanup can reclaim the remaining identity and GitHub artifacts even when a prior teardown removed the dispatcher. If a role assignment is unexpected or cannot be removed, cleanup preserves both the service principal and its parent application registration; deleting the application would cascade-delete the principal and leave an orphaned role assignment. A successful delete command is treated as a request rather than proof: teardown and scheduled recovery poll Entra until the application registration is absent, and retry by application/client ID when deletion by object ID reports resource-not-found. GHCR cleanup likewise verifies that a package is unreadable after deletion; a DELETE `404` while the same credential can still read the package is reported as insufficient effective `delete:packages` access. Exact-name, age-qualified orphan packages may have no repository association after their source environment or repository metadata disappears, but a non-empty association to another repository is always refused.

## When a run is cancelled

Do not cancel a Cloud E2E run. Cancelling mid-flight can strand a deployment, an Entra application, and GitHub state, converting one slow run into a failure on the next one. The workflow is configured never to cancel itself for this reason. If a CI run must be stopped, dispatch the cleanup workflow after cancellation completes. If cleanup reports that Radius deletion failed, do not remove its retained identity or GitHub state manually; those are the recovery inputs needed to retry deletion. Cleanup always preserves the shared resource group and AKS cluster.

## Select a Radius version

Set the optional `radius-version` dispatch input to an exact published Radius tag. Stable releases and release candidates are supported:

```bash
gh workflow run cloud-e2e.yml --repo radius-project/ai-extensions -f radius-version=v0.63.0-rc.1
```

Omit the input, or leave it blank, to use the checked-in Radius pin. Scheduled runs keep that pin. Combine `radius-version` with `canvas-host=copilot-app` to test the same version in the desktop app.

The workflow resolves the tag to its commit, downloads the installer from that commit, and computes its SHA-256 checksum. A missing release, draft release, invalid tag, or failed download stops version selection. It does not fall back to another version. The run summary records the selected tag, commit, and checksum.

Selection changes only the runner checkout and the test environment. The local managed CLI uses the selected pin. After the product creates the GitHub Environment, the fixture adds `RADIUS_RELEASE_OVERRIDE` with the selected tag, commit, and checksum. The deploy and delete runners use that value to install the matching CLI and control plane, verify the installer checksum, and load the recipe catalog from the same commit. The fixture sets the value again after environment recreation. Environment deletion removes it. No repository-wide variable or source commit is changed.

The cloud workflow pins remote templates and actions to its own source commit, so both hosts use the matching workflow support. Older Radius versions must still support the commands, chart options, recipes, and application model used by the journey. Version selection does not add compatibility for removed or missing Radius features.

## Run the journey in the GitHub Copilot app

By default, the suite drives this checkout's canvas in headless Chromium on Linux. This is the production path. Scheduled runs use it unless the optional host variable selects the app. The workflow gives both hosts 340 minutes; the harness keeps its existing Playwright test and suite limits.

You can also drive the same journey through the GitHub Copilot desktop app on a disposable GitHub-hosted Windows runner. This host is opt-in. It adds one test that runs first. The test opens a preparation session and waits for an explicit Idle status. It verifies that the session belongs to the disposable profile, points to the fixture repository and baseline, and has no edits. It then removes the old `.radius` directory before sending the modeling prompt. The Radius agent generates a new model from source. The test requires stable files, an explicit Idle status, and a fresh origin record with the correct source commit and model hash. The suite publishes that model, then runs the lifecycle and edge-case tests in the app's Radius canvas. The signed-out probe skips on this host, because the product's Azure CLI runs in the app and not in the test process.

Use one of these methods to select the app host:

| Method          | How                                                                        |
|-----------------|----------------------------------------------------------------------------|
| Manual dispatch | Set the `canvas-host` input to `copilot-app`                               |
| Scheduled runs  | Set the repository variable `AIEXT_CLOUD_E2E_CANVAS_HOST` to `copilot-app` |

The dispatch input wins over the variable. An unset or blank value selects `harness`. An unknown value stops the suite before any test starts.

App mode must run without human approval. A stored GitHub CLI PAT and the token environment variables have not completed desktop authorization on the hosted runner. Until the app provides a supported unattended authentication interface, the fixture fails explicitly on a sign-in, device-authorization, or onboarding screen. It does not start interactive sign-in, print device codes, or wait for a person. The harness host remains the unattended default.

With the app host, the job runs on `windows-2025` and installs the app with `winget`. The test builds this checkout with `build.mjs --install` and installs its extension, skills, manifest, and workflow assets under a temporary profile's `.copilot/extensions/radius` directory. It sets `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `COPILOT_HOME`, the WebView2 data folder, and the Radius credential file to paths in that profile. The Azure CLI deliberately retains the disposable runner's `azure/login` configuration. Teardown stops the app before it removes the profile; a failed stop retains the profile for diagnosis.

Before app launch, the fixture runs `gh auth login --hostname github.com --git-protocol https --with-token` in the same disposable profile. It supplies the bot PAT through standard input, not command arguments. Login and verification omit token environment overrides so they use the stored account in that profile's `GH_CONFIG_DIR`. The fixture requires `gh auth status` to pass and the stored account login to match `CLOUD_E2E_PACKAGES_USER`; a mismatch stops app launch. The PAT needs the GitHub CLI login scopes (`repo`, `read:org`, and `gist`) as well as the app and package permissions described below. The credential store belongs to the disposable runner and is not copied from a developer machine.

The hosted Windows runner starts the app with elevated rights. WebView2 150 and later ignore the debugging environment variable in an elevated process. The workflow therefore sets `HKLM\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`, with the value name `github.exe` and data `--remote-debugging-port=9222`. It refuses to replace an existing value. An always-run cleanup step removes only the value that this run created. The policy applies only to the app on the disposable runner, not to all WebView2 applications. Do not set it on a local or self-hosted machine. See the [WebView2 elevation requirement](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645#issuecomment-4934355430).

The CDP endpoint can answer before the app page leaves `about:blank`. After connecting, the fixture checks all browser contexts for up to three minutes until an app page is available. It then requires the signed-in shell without changing authentication or onboarding state. A page timeout reports the last target URLs; a lost browser connection stops the wait. Neither condition skips app cleanup, whose error message includes the failed cleanup operation's cause.

**Local and self-hosted app runs are refused before cloud setup.** The desktop can use Windows native storage paths that ignore environment overrides. `COPILOT_HOME` alone does not prove full desktop isolation. Until that boundary is qualified, use the existing harness locally and use a disposable GitHub-hosted Windows runner for app mode. The guard uses GitHub's built-in `GITHUB_ACTIONS` and `RUNNER_ENVIRONMENT` values; do not set these by hand to bypass it. The test also refuses to start if `github.exe` is already running.

The optional `AIEXT_CLOUD_E2E_CANVAS_HOST` variable is new; no new secret is required. App sign-in, extension discovery, loaded-bundle identity, and the project-add UI still need qualification on the runner. The suite uses UI controls for mutations, direct canvas navigation and API reads for assertions, and Git for model publication. A passing unit test or test-list command does not prove that desktop journey.

## Required configuration

The workflow reads these repository Actions variables:

| Variable                             | Current value                          | Purpose                                           |
|--------------------------------------|----------------------------------------|---------------------------------------------------|
| `AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY` | `radius-project/ai-extensions-fixture` | Confirms the repository pinned by the test source |
| `AIEXT_CLOUD_E2E_AZURE_LOCATION`     | `centralus`                            | Confirms the live cluster's Azure location        |
| `AIEXT_CLOUD_E2E_RESOURCE_GROUP`     | `ai_extensions_test`                   | Selects the precreated resource group             |
| `AIEXT_CLOUD_E2E_AKS_CLUSTER_NAME`   | `ai_extensions_aks`                    | Selects the precreated AKS cluster                |
| `AIEXT_CLOUD_E2E_FOREIGN_APP_NAME`   | Not set                                | Optional. Names the seeded foreign app            |
| `AIEXT_CLOUD_E2E_ORPHAN_APP_NAME`    | Not set                                | Optional. Names the seeded orphan app             |

The fixture repository is pinned by [`FIXTURE_BASELINE_SHA`](../../packages/adapter-canvas/test/e2e-cloud/support/fixture-repository.ts). CI requires both cluster variables, verifies the cluster through `az aks show`, and fails before the product journey if either value is absent, malformed, inaccessible, in a different location, not fully provisioned, or stopped. Local runs may omit both variables to provision disposable infrastructure in the developer's own subscription.

### Seeded app registrations

Two refusal probes need an Entra app registration that the CI identity does not own. CI cannot make these apps, because an app that the CI identity creates is owned by it. An administrator makes them one time. If a variable is not set, its probe skips and gives the reason. The other tests still run.

Use an identity that is **not** the CI service principal. That identity can stay the owner, or you can remove all owners. Do not add the CI service principal as an owner.

Before enabling either probe, an administrator must give the bootstrap identity Microsoft Graph **Application.Read.All** application permission and grant tenant admin consent. In Entra, open the app registration whose client ID is stored in `AZURE_CLIENT_ID`, then select **API permissions > Add a permission > Microsoft Graph > Application permissions > Application.Read.All** and grant admin consent. Keep `Application.ReadWrite.OwnedBy` for changes to apps that CI owns; do not grant `Application.ReadWrite.All`. The extra grant permits read-only snapshots of seed apps that CI does not own. This repository change does not apply that tenant grant.

1. Make the foreign app. Give it a unique name and no tags.

   ```bash
   az ad app create --display-name radius-cloud-e2e-foreign-app
   ```

2. Make the orphan app. Give it the tags that Radius writes for the fixture repository. Use an environment name that starts with `radtest-` and that no run uses.

   ```bash
   az ad app create --display-name radius-cloud-e2e-orphan-app
   az rest --method PATCH \
     --url "https://graph.microsoft.com/v1.0/applications(appId='<orphan-app-id>')" \
     --body '{"tags":["radius-managed","radius-repo:radius-project/ai-extensions-fixture","radius-environment:radtest-orphan-probe"]}'
   ```

3. Add a sentinel federated credential to **each** seed. Replace `<seed-app-id>` with the app's client ID and run this command once for each app.

   ```bash
   az rest --method POST \
     --url "https://graph.microsoft.com/v1.0/applications(appId='<seed-app-id>')/federatedIdentityCredentials" \
     --body '{"name":"radius-cloud-e2e-sentinel","issuer":"https://sentinel.invalid","subject":"radius-cloud-e2e:never-a-workflow","audiences":["api://AzureADTokenExchange"]}'
   ```

   The reserved `.invalid` issuer cannot issue real workflow tokens, and the subject is not a GitHub workflow subject. Do not replace these values with a real issuer or repository. This credential proves that refusal preserves an existing credential, not just an empty list.

4. With the bootstrap identity signed in, verify that `az ad app owner list --id <seed-app-id>` and `az ad app federated-credential list --id <seed-app-id>` succeed for each seed. If either command fails, correct the read grant before enabling the probes. Do not add CI as an owner.

5. Set `AIEXT_CLOUD_E2E_FOREIGN_APP_NAME` and `AIEXT_CLOUD_E2E_ORPHAN_APP_NAME` to the two display names.

Each probe reads its app before it starts. It stops with a clear message if the sentinel is missing or has different trust settings, if the CI identity owns the app, if the foreign app has the `radius-managed` tag, or if the orphan app does not have the correct tags. After the refusal, the probe reads the app again and fails if its tags, owners, or any credential's ID, name, issuer, subject, or audiences changed. The fixture registers a probe environment for teardown only after it verifies that the environment is absent, before submission. If a probe fails and leaves that environment behind, guarded teardown removes it. It does not register pre-existing environments or delete seeded Entra apps. The scheduled cleanup deletes apps only by the product's name, `radius-deploy-<owner>-<name>`, so it does not delete the seeded apps.

Credential checks can leave GitHub deployment records even when create is refused. For every registered probe name, teardown lists all pages of records, marks each record inactive, and deletes it before deleting the environment. It clears these records even when the environment is already absent. If listing, deactivation, or record deletion fails, teardown reports the failure and retains any existing environment for recovery. Other registered probes still receive cleanup.

The dedicated Cloud E2E GitHub App must remain installed only on the fixture repository with `actions: write`, `actions_variables: write`, `administration: write`, `contents: write`, `deployments: write`, `environments: write`, `pull_requests: write`, `secrets: write`, and `workflows: write`. Two of those are easy to get wrong. `administration: write` is what GitHub requires to create a deployment environment, so `read` is not enough. The API name for environment variable management is `actions_variables`, not `variables`. Grant no Packages permission: scheduled cleanup reaches GHCR through `GH_RAD_CI_BOT_PAT` instead, because the journey mints its token without permission inputs and would otherwise inherit package write. Store its client ID and private key as `CLOUD_E2E_BOT_CLIENT_ID` and `CLOUD_E2E_BOT_PRIVATE_KEY`.

The organization-level `GH_RAD_CI_BOT_PAT` secret is already visible to all organization repositories. It belongs to `rad-ci-bot` and needs `read:packages`, `write:packages`, and `delete:packages`. `CLOUD_E2E_PACKAGES_USER` stores only the account login. In harness mode, repository and workflow APIs use the short-lived fixture-scoped GitHub App token.

In app mode, that existing PAT also supplies `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` to the desktop and its extension. The account therefore also needs a Copilot entitlement and access to the fixture repository, environment management, and workflow publication and dispatch. Package scopes alone are not sufficient. The test runner still uses its renewable installation token for fixture setup, assertions, model publication, and cleanup. This is a different product authentication path from the harness; do not infer the PAT's permissions from its secret name.

The first dispatched run reached Azure login and GitHub App token creation, then exposed a Playwright worker handoff defect before any lifecycle stage ran. That defect was corrected in #812. **Create, deploy, deployment deletion, and environment deletion still require a successful real-cloud run.**
