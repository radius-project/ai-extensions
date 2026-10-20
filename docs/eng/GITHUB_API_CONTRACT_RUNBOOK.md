# GitHub API contract suite

This small suite checks real GitHub permission responses against the Radius adapters. It is not a Cloud E2E journey or a general API CRUD suite. Fake-based tests remain the pull-request gate. The workflow runs by manual dispatch and, after explicit enablement, daily at 08:41 UTC. It never runs on pull requests, fork pull requests, pushes, or the merge queue.

## Contracts

| Contract                             | Real boundary                                                                                       | Required Radius result                                                                                                                         |
|--------------------------------------|-----------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Permission-masked Environment delete | Metadata-only App token attempts to delete a unique, existing Environment                           | Observe HTTP 404; the production deletion service returns `failed` and does not invalidate the list cache without readable evidence            |
| Missing workflows permission         | Contents-write token without workflows permission attempts a workflow write                         | Production workflow committer reports failure; the real diagnostic identifies workflows permission, not branch protection                      |
| Branch rules                         | Contents/workflows-write App token attempts a direct workflow write to the protected default branch | Production workflow committer classifies the refusal, writes to a unique fallback branch, and returns `viaPr: true`; no PR is opened or merged |
| Missing Actions write                | Actions-read token dispatches the preinstalled inert workflow                                       | Production verification dispatch service reads its real baseline, receives HTTP 403, and returns `rejected` without retry                      |

These are assertions, not claims that GitHub currently returns these responses. A different status or diagnostic fails the contract. The suite does not inject provider errors. A setup or selected-account identity failure is an infrastructure failure, not evidence that a contract passed.

## Required setup

Infrastructure changes require separate user approval. This PR does not create a repository, App, installation, ruleset, secret, or workflow in the sandbox.

Use a dedicated private repository, separate from this source repository and the Cloud E2E fixture. Install a dedicated GitHub App on that sandbox only. Grant repository Administration write, Contents write, Workflows write, and Actions read. Administration write is required to create and delete Environments; Actions read permits the Environment read/list and workflow-run baseline. The similarly named Environments permission covers Environment secrets and variables, not Environment creation or deletion. See GitHub's [App endpoint permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps). Do not grant Actions write or ruleset bypass. The three installation tokens are narrowed with explicit `permission-*` inputs to `actions/create-github-app-token`; unspecified permissions are not requested. Tokens are revoked by the action's post step.

The account's GitHub plan must support Environments and active rulesets on private repositories. A private repository on a plan without those features is not a suitable sandbox.

The sandbox must contain:

1. A default branch with an active ruleset that requires a pull request. The App must not bypass that rule. Do not restrict creation or deletion of `radius/setup-radius-contract-*` fallback branches.
2. A file named `.radius-github-contract-sandbox` on the default branch with exactly `radius-github-contract-sandbox-v1` followed by one LF newline.
3. `.github/workflows/radius-contract-dispatch.yml` on the default branch with exactly this content, including the final LF newline:

```yaml
name: Radius contract dispatch
on: workflow_dispatch
permissions: {}
jobs:
  inert:
    if: ${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: exit 0
```

Keep Actions enabled. Do not install other workflows that react to branch pushes or Environment changes. The inert dispatch target ensures that an unexpected permission grant cannot run deployment code.

Configure these source-repository Actions values:

| Kind     | Name                              | Value                                                        |
|----------|-----------------------------------|--------------------------------------------------------------|
| Variable | `GITHUB_CONTRACT_REPOSITORY`      | Dedicated `owner/name` sandbox                               |
| Variable | `GITHUB_CONTRACT_ALLOWLIST`       | The same `owner/name`, set explicitly                        |
| Variable | `GITHUB_CONTRACT_APP_LOGIN`       | Dedicated App bot login, such as `example-contract-app[bot]` |
| Variable | `GITHUB_CONTRACT_ENABLED`         | Set to `true` only after setup and a successful manual run   |
| Secret   | `GITHUB_CONTRACT_APP_CLIENT_ID`   | Dedicated App client ID                                      |
| Secret   | `GITHUB_CONTRACT_APP_PRIVATE_KEY` | Dedicated App private key                                    |

`AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY`, if configured, is used only to reject that repository as a target. It is not a fallback sandbox. Manual dispatch always attempts the suite and fails clearly if configuration is missing. Scheduled execution is disabled until `GITHUB_CONTRACT_ENABLED=true`; once enabled, missing configuration is a failure, not a skip.

## Execution and safety

Run the **GitHub API contracts** workflow by manual dispatch from trusted code. It has no trigger that runs untrusted pull-request code with App secrets. The job uses a single concurrency group, does not cancel an active run, and has a 15-minute limit. Commands have bounded timeouts. There is no fixed sleep or provider retry.

`pnpm run test:github-contract` is the dedicated command. Without `RUN_LIVE_GITHUB_API_TESTS=1`, the four live cases are skipped. With that flag, all required configuration and three explicit installation tokens are mandatory. This command must not use a developer token. CI supplies the tokens as `GITHUB_CONTRACT_SETUP_TOKEN`, `GITHUB_CONTRACT_MASKED_TOKEN`, and `GITHUB_CONTRACT_RESTRICTED_TOKEN`.

Each credential uses the production selected-account executor with an empty temporary `GH_CONFIG_DIR`. Ambient GitHub tokens, package credentials, host settings, and debug settings are removed for the executor's scope, then restored. Stored local login is not a permitted fallback. The production executor checks its App bot identity; an unsupported CLI or identity response fails rather than switching to a personal account.

Environment and workflow names include a UUID. Only resources named by this run are cleanup targets. Cleanup runs after success and failure. If cleanup also fails, an aggregate error retains the original failure. A hard runner termination can still leave resources behind. Inspect the exact resource names in the failed run; never bulk-delete existing sandbox resources. An unexpected successful default-branch write is reported with its exact path for manual review because branch rules can prevent automatic removal. The workflow committer creates a fallback branch but this suite never opens its suggested PR.

The hermetic pull-request tests cover configuration rejection, cleanup error handling, credential isolation, and workflow trigger/token wiring. They do not contact GitHub.

## GHCR limit

No GHCR contract is implemented or claimed. GitHub App installation tokens must not be assumed to authorize the container registry. The existing Cloud E2E package credential is separate infrastructure and is not reused here. This suite has no approved non-personal package credential, dedicated package target, or package lifecycle policy. A GHCR contract needs those decisions and user approval first; do not add a personal token or infer a credential scheme.

## Provisioning status

At implementation time, this source repository had no `GITHUB_CONTRACT_*` Actions variables or secrets. No live contract was exercised. A maintainer must approve and provision the dedicated sandbox, App installation, branch rules, marker, inert workflow, and configuration before the first live run. A 403 instead of the proposed Environment-delete 404 is a contract mismatch to investigate, not a reason to inject a 404 or report that contract as validated.
