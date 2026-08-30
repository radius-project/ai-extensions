# Cloud E2E runbook

The short version, for whoever picks up a red **Cloud E2E** run. The design note `docs/design/2026-08-cloud-e2e-environment-lifecycle.md` explains why the tier exists and how it is built; this page is only what you do. That note is not on this branch yet - it lands with its own pull request - so the reference is by name rather than by link.

## Read this before you read the log

A red run here is one of three completely different things, and they need three different responses:

| Class                      | What it means                                                                           | Who fixes it                              |
|----------------------------|-----------------------------------------------------------------------------------------|-------------------------------------------|
| **Product regression**     | The product issued a command real Azure, Entra, or GitHub rejected                      | The author of the change                  |
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

That last one matters more than it looks. The product commits a deploy workflow to the fixture repository and dispatches it. That workflow runs *there*, not here, so its failure is invisible in this job's own log.

## Product regression

The thing the tier exists to catch: the product built a request real Azure, Entra, or GitHub rejected, and no hermetic test could have known.

| Symptom                                                                        | Likely cause                                                                 | First thing to do                                                                                                  |
|--------------------------------------------------------------------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| Graph rejects the application or federated credential the product created      | A request shape changed - a field name, an audience, a subject claim         | Open the trace, find the request, compare it to the Graph API reference                                            |
| The deploy workflow exists as a pull request rather than on the default branch | The App token lost `workflows: write`, so the product took its fallback path | Check the `Create a GitHub App token` step; a missing permission fails there, a *narrowed installation* does not   |
| Role assignment succeeds but the deployment is denied                          | Scope or role definition changed                                             | `az role assignment list --scope /subscriptions/<sub>/resourceGroups/radtest-canvas-<uid>`                         |
| The environment exists but a variable is absent or wrong                       | The product's variable-writing path changed                                  | `gh api repos/<fixture>/environments/radtest-<uid>/variables`                                                      |
| The environments page never shows the environment stage one created            | `/api/list-environments` stopped reporting it, so nothing can be deleted     | `gh api repos/<fixture>/environments` - if GitHub has it and the page does not, the regression is in the product   |
| `/api/delete-environment` answers 409 `app-deployed` on a free environment     | `resolveEnvDeployment` reports a stale or phantom active deployment          | Read the message: it names the application. Check `gh api repos/<fixture>/deployments` for a record left behind    |
| `/api/delete-environment` answers 503                                          | The deployment check threw, so the handler failed closed - by design         | The 503 body carries the underlying error. This is correct behaviour for an unreadable state, not a bug in itself  |
| The delete returns 200 but the Environment is still on GitHub                  | The handler reported success without the `gh api --method DELETE` landing    | `gh api repos/<fixture>/environments/radtest-<uid>` - a 200 here with a 200 from the product is a real regression  |
| A `Refusing to assert that ... is absent` error                                | An absence assertion ran without the matching presence assertion             | Not a product failure. Stage one did not reach the presence assertion; fix that failure first and re-read this run |

The last of these is the failure mode with the most expensive false negative. A token silently missing `workflows` scope sends the product down its pull-request fallback, and a journey that only checked "a workflow file exists" would pass while the product never wrote to the default branch at all. The spec asserts the files are **on the default branch** precisely so this fails loudly. If you are tempted to relax that assertion, do not.

**Fix it in the product, with a hermetic test that would have caught it** where one can exist. A regression that can only be caught by a nightly cloud run is one nobody sees for a day.

## Infrastructure failure

The product is not implicated. Establish that, then decide whether to re-run or wait.

| Symptom                                          | Cause                                                                         | What to do                                                                                                                                                                           |
|--------------------------------------------------|-------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| AKS provisioning fails or times out              | Regional capacity, quota, or a transient ARM fault                            | Read the `az` error verbatim. Capacity and quota are different problems - quota needs a request, capacity needs a different region or patience                                       |
| `az group create` rejects the location           | `AIEXT_CLOUD_E2E_AZURE_LOCATION` is set to something that is not a region     | The suite rejects a malformed value up front with a message naming it. Fix the variable                                                                                              |
| A Graph read finds nothing that was just written | Entra propagation delay                                                       | Nothing. The product retries and the fixture polls. If it fails anyway, the bound is too tight - widen it, do not add a sleep                                                        |
| `azure/login` fails                              | The federated credential does not match, or the identity was changed upstream | Compare `az-account.json` against the identity `radius-project/wellknown` publishes. The credential is federated on the default branch only                                          |
| The job is cancelled at 90 minutes               | The run genuinely hung                                                        | This should not happen: Playwright gives up at 45 minutes and writes the trace first. If GitHub cancelled first, the ordering is broken - see the timeout comment in `cloud-e2e.yml` |

**Re-run rather than investigate** when the error is clearly Azure's and the same run passed yesterday. **Do not re-run repeatedly** to make a red run green: each attempt provisions a cluster, and a run that only passes sometimes is telling you something.

## Leaked state

A previous run did not clean up, so this one refused to start rather than asserting against someone else's leftovers. This is the failure the clean-slate probe exists to produce, and it is working correctly when you see it.

The cleanup workflow reclaims this automatically, twice daily, for anything older than six hours. **Run it by hand rather than deleting things yourself** - it deletes exactly what the suite creates, using the same pinned constants, and nothing else:

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

# Whether the fixture branch is still at the pinned baseline
gh api "repos/<fixture>/git/ref/heads/<default-branch>" --jq .object.sha
```

Two boundaries worth knowing before you go looking for a gap:

- **Resource groups are not swept by our cleanup, deliberately.** The Radius purge job already deletes groups matching `^radtest-` older than six hours, twice daily, in this subscription, and the per-run group is named `radtest-canvas-<uid>` so that job reclaims it for free. A second deleter on a shared subscription is a hazard, not a safety net. This is a cross-repository dependency: if that job stops, groups accumulate here silently.
- **The Entra application is repository-scoped, not run-scoped.** The product derives its name from the repository alone, with no per-run uniqueness. That is why both workflows share one `concurrency` group with `cancel-in-progress: false`: two concurrent runs would contend for one Entra object, and a cancelled run strands cloud state that turns into tomorrow's leaked-state failure.

- **A complete run still leaks Azure identity, and that is expected today.** Stage two deletes the GitHub Environment, which is all `handleDeleteEnvironment` does. The Entra application, its two federated credentials, and its role assignment survive, so `reclaimLeakedProductArtifacts()` removes them after the assertions. `radius-project/ai-extensions#398`, "Clean up cloud state on environment deletion", is what makes the product responsible for them; the fixture carries `assertAppRegistrationAbsent`, `assertFederatedCredentialAbsent`, and `assertRoleAssignmentAbsent`, unit-tested and deliberately uncalled, ready to assert it the day that merges. Do not read the current leak as a regression, and do not assert it as the contract.

## When a run is cancelled

Do not cancel a Cloud E2E run. Cancelling mid-flight strands a resource group, an AKS cluster, an Entra application, and a GitHub Environment, converting one slow run into a failure on the next one. The workflow is configured never to cancel itself for this reason. If a run must be stopped, run the cleanup workflow immediately afterwards.

## It has never run

**As of this writing, neither workflow has ever executed, and neither can.** Four prerequisites are outstanding, none of them in this repository:

1. `radius-project/wellknown#134` - the Terraform that publishes the identity and the Actions variables - is open and unmerged, and its own CI is paused on an environment approval gate.
2. A tenant admin must re-run `task bootstrap` and consent to Graph `AppRoleAssignment.ReadWrite.All`, or that Terraform apply fails `Authorization_RequestDenied`.
3. The `RADIUS_GHOPERATIONS_BOT` GitHub App must be installed on `radius-project/ai-extensions` with `metadata: read`, `secrets: write`, `variables: write`, and `administration: write`. Terraform cannot install an App, so that half is manual.
4. The fixture repository does not exist. `FIXTURE_BASELINE_SHA` in [`packages/adapter-canvas/test/e2e-cloud/support/fixture-repository.ts`](../../packages/adapter-canvas/test/e2e-cloud/support/fixture-repository.ts) is still forty zeros, and the `aiext_fixture_repository` tfvar is unset, so `AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY` is never published.

Until then a dispatched run reaches `pnpm test:cloud` and **skips with a specific reason** rather than passing hollowly, and the cleanup workflow no-ops on its provisioned check. That is the designed behaviour. What is verified today is the workflows' safety and wiring contracts, asserted in [`packages/adapter-canvas/test/ci/cloud-e2e-workflows.test.ts`](../../packages/adapter-canvas/test/ci/cloud-e2e-workflows.test.ts), and the journey's own decision logic, asserted in the `test/e2e-cloud/support/*.test.ts` unit suites. Nothing verifies that a real run succeeds. **No stage - create or delete - has ever executed against real cloud.**

When the prerequisites land, the first run is the interesting one. Expect it to fail, expect the failure to be infrastructure rather than product, and read this page from the top.
