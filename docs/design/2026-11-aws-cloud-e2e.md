# AWS in the Cloud E2E tests

- **Author**: Karishma Chawla (@kachawla)
- **Date**: 2026-11

This amends the [Cloud E2E environment lifecycle](./2026-08-cloud-e2e-environment-lifecycle.md) design: the fixture repository gets a second pinned app, the Cloud E2E job runs AWS after Azure, and cleanup handles both clouds. It also fills in the cloud end-to-end tests in the test plan of the AWS and EKS canvas support design.

## Current state

The Cloud E2E tests run the canvas against real Azure once a day: create an environment, deploy, delete, and check that nothing is left. AWS setup, deploy, and delete are on `main` behind the `RADIUS_CANVAS_AWS=1` developer switch, but only tests with a fake `aws` CLI cover them. Setup creates one IAM role per repository, called the deploy role, that the repository's GitHub deploy workflows sign in to, and each environment adds its own permissions to it.

A fake CLI can't show that AWS accepts the product's calls, that a pod can reach the database a recipe created, or that delete leaves nothing behind. A change that breaks AWS would reach users silently, and a leak would keep billing until someone noticed.

## Proposal

Run AWS in the daily Cloud E2E job right after Azure, in the Radius project's AWS test account, on two shared EKS clusters created ahead of time, in regions Radius's own tests don't use. It shares the Azure fixture repository with its own pinned app, and the cleanup workflow gets an AWS sweep that can only touch this test's resources.

## Objectives

### Goals

- The AWS test runs in Cloud E2E once a day and on manual dispatch, and never on pull requests.
- The AWS test runs on both canvas hosts, the same as Azure: the default harness, and the opt-in GitHub Copilot app host, where the Radius agent also models the fixture's app.
- A pod can reach every managed service in the `aws-eks` recipe pack, and the check catches nodes that can't.
- Deleting both environments leaves only the deploy role and the GitHub identity provider.
- Cleanup removes what a failed run leaves behind, without touching Radius's own test resources.

### Non-goals

- Creating or deleting EKS clusters in the test: the canvas only discovers clusters, the same as for AKS.
- Testing first-time creation of the deploy role in CI: the test role can't create roles in the shared account, so server tests and local runs cover it.

## Design

Each day, the AWS job signs in to `radius-test`, uses the canvas to set up two environments, deploy, and delete, and then checks that nothing is left.

### Where it runs

| What        | Choice                                                           | Why                                                                                                                                          |
|-------------|------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| AWS account | `radius-test`, the Radius project's AWS functional-test account  | Azure Cloud E2E already reuses the Radius test subscription. The account already has billing and the GitHub identity provider                |
| Regions     | `us-east-2` for the main environment, `us-west-1` for the second | Radius's tests use only `us-west-2`. Neither is `us-east-1`, where IAM and other global services sign their requests                         |
| Workflow    | New steps after Azure's in the existing `cloud-e2e.yml` job      | One run tests both clouds one after the other, which also tests the extension switching between them. It's the smallest change to start with |

Azure runs much faster than its limits allow. Of the last 40 `cloud-e2e.yml` runs, the ones that passed took 28 to 35 minutes, and the longest run took 72 minutes. So AWS fits in the same job:

- The AWS steps run after Azure's, even if Azure fails, so one cloud's failure doesn't hide the other's result.
- They have their own step names, `Run Azure Cloud E2E` and `Run AWS Cloud E2E`. The run summary and the scheduled failure issue name the cloud that failed.
- The AWS steps run on the same host as Azure. On the app host, the agent models the AWS app too, from source in the AWS baseline.

This changes `cloud-e2e.yml`: the job gets the AWS sign-in, test, and diagnostics steps, its timeout goes from 340 to 360 minutes, and Azure's test time limits come down (see [Time budget](#time-budget)). Moving AWS into its own chained job later is a small change, if time or clarity calls for it.

### The fixture repository

The fixture repository is the GitHub repository the test runs the canvas against. It holds a ready-made app, and setup commits its workflows there, the same as in a user's repository. AWS reuses Azure's, `radius-project/ai-extensions-fixture`, because setting up a fixture repository and its GitHub App isn't simple, and one repository is one thing to maintain.

The AWS app gets its own baseline commit in that repository, with a `.radius/` directory produced by the real modeling flow, and two resources:

- A `Radius.Data/mySqlDatabases` resource, which the `aws-eks` pack deploys on Amazon RDS.
- A `Radius.Compute/containers` resource that signs in to the database over TLS and runs `SELECT 1` in a loop, and is ready only after that query succeeds.

The database password is a fixed test value in the private fixture model. The instance is private to the cluster's VPC and lives for less than an hour.

A second commit carries the app for the failed deploy: one resource that fails in Kubernetes before any AWS call, and no AWS resources.

Both commits are pinned in `fixture-repository.ts` next to `FIXTURE_BASELINE_SHA`, so a change to either shows up in a code review. A branch, `baselines/aws`, keeps them reachable, because cleanup force-resets `main` and would otherwise leave them unreferenced.

Today a run requires `main` to be at the Azure baseline before it starts. With two baselines, a run starts in this order:

1. Takes the fixture's lease, as today.
2. Checks `main` and everything else the clean-slate check covers. `main` is clean at either pinned baseline; anything else fails the run and leaves `main` as it is, so the dirty state and any workflows a retry needs stay in place.
3. Only then moves `main` to its own baseline.

Its teardown leaves `main` at its own baseline. Cleanup resets a dirty `main` to the Azure baseline, so its reset doesn't depend on which cloud runs next.

### How the test signs in to AWS

The test uses two IAM roles, because it plays two parts: the developer who runs setup in the canvas, and the GitHub workflows that deploy the app.

| Role                                                              | Who uses it                                                                                | What it stands in for                                                                                         |
|-------------------------------------------------------------------|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| Test role, `ai-extensions-cloud-e2e`                              | The Cloud E2E job in this repository, to run setup in the canvas and to check and clean up | The developer's own AWS sign-in                                                                               |
| Deploy role, `radius-deploy-radius-project-ai-extensions-fixture` | The deploy workflows that setup commits to the fixture repository                          | The role setup creates for each repository in real use, which the AWS canvas design calls the deploy identity |

An account administrator creates both once.

**The test role.** The Cloud E2E job signs in to it with GitHub's OIDC token. It trusts only `repo:radius-project/ai-extensions:ref:refs/heads/main`, so no pull request or branch can use it. The job doesn't use a GitHub environment, because that would change the subject GitHub sends. The role can:

- Read EKS, EC2, and RDS, and run `kubectl` on the two clusters.
- Scale and update the two node groups on the main cluster.
- Change only the deploy role's trust policy and inline policies, its lock policy, and access entries on the two clusters.
- Delete only RDS instances, groups, and snapshots named `mysql-*` and `rds-snapshot-*`.

Everything except IAM is limited to the two regions. The test role can't create or delete roles, change a permissions boundary, or create an identity provider. Its session lasts 6 hours, as long as the job, because AWS's default is 1 hour and the job signs in only once.

**The deploy role.** Setup gives it permissions by writing inline policies on it, so whoever runs setup controls what it can do. In an account shared with Radius's tests, that must be capped, so the administrator creates it ahead of time with:

- The tags setup puts on a role it creates, so setup reuses it instead of creating one.
- The trust policy setup leaves when no environment uses the role: one deny statement, `RadiusNoTrustedEnvironments`.
- A permissions boundary, which is the most a role can ever do, whatever its own policies say. It allows only the services the recipes use (Cloud Control, RDS, and a few EKS and EC2 reads), only in the two regions. It denies IAM, account settings, and `s3:PutAccountPublicAccessBlock`. Each new recipe adds its service.

The boundary lists services instead of allowing everything in the two regions, because a region condition limits where a request is sent, not what it changes. For example, `s3:PutAccountPublicAccessBlock` sent to `us-east-2` turns off S3 Block Public Access for every bucket in the account, including Radius's.

The deploy role can't create service-linked roles. RDS's already exists; a new service's recipe may need an administrator to create one. If the deploy role is missing, setup stops and changes nothing, because the test role can't create roles.

### The clusters

The main cluster, in `us-east-2`, has two node groups. The default one has up to two `t3.medium` nodes. The isolated one has one `t3.small` node whose launch template sets its own security group, so EKS doesn't add it to the cluster security group, and nothing allows TCP 3306 from it. A taint keeps app pods off it.

The second cluster, in `us-west-1`, has no nodes. The run only creates an environment on it, deploys an app that fails before any pod is scheduled, and deletes it.

Both clusters use authentication mode `API` and a public endpoint, so GitHub-hosted runners can reach them. Nodes use public subnets, so no NAT gateway is needed, and RDS uses private subnets.

Both node groups stay at zero nodes between runs. The test scales them up at the start and back to zero at the end, even when the run fails, and cleanup scales them down if a run was cut off. This adds about 5 minutes to a run.

The ai-extensions maintainers own both clusters, and upgrades are automated. Each cluster's upgrade policy is `STANDARD`, so when its Kubernetes version leaves EKS standard support, AWS upgrades the control plane itself instead of moving it to extended support, which costs six times as much. Managed node groups don't upgrade themselves, so the test updates a node group to the control plane's version while it's still at zero nodes. Each run records the cluster's version, so a failure right after an automatic upgrade is easy to trace.

### What the test does

Each step runs in the canvas, in order, with the AWS switch on.

1. **Preflight.** The account, both clusters, and the isolated node group are as expected, and both clusters' upgrade policy is `STANDARD`. Nothing from an earlier run is left. The node groups are updated if needed and scaled up.
2. **Create the main environment.** Setup reuses the deploy role, and adds one trust subject, one inline policy, and one access entry. Verify succeeds.
3. **Create the second environment.** It uses the same deploy role, which now has two of each.
4. **Failed deploy.** The failing app, deployed to the second environment, shows its resource as failed in the deployed graph. Nothing is created in AWS.
5. **Deploy.** The baseline app deploys to the main environment, and a Kubernetes write happens more than 15 minutes after the deploy got its first EKS token.
6. **Connection check.** The app's container is ready. A probe pod on the default nodes signs in to each managed service. The same probe on the isolated node times out, and the check names the service.
7. **Delete the apps.** The RDS instance and its groups are gone, and exactly one final RDS snapshot exists. The test deletes it.
8. **Delete the second environment.** Its subject, policy, and access entry are removed, and the main environment still passes verify.
9. **Delete the main environment** the same way.
10. **Leftovers.** Only the deploy role, with no policies or trusted subjects, and the GitHub identity provider are left.

Why some steps work the way they do:

- **15 minutes:** an EKS token lasts 15 minutes, so a later Kubernetes write proves token refresh works. The clock starts at the refresher's first log line. RDS create time varies, so the fixture app forces a Kubernetes write at least 16 minutes into the deploy, for example with a resource that waits on the container, whose readiness is held back. The exact resource is picked during the local run.
- **Failed deploy on the second environment:** the failing app fails in Kubernetes before any AWS call. It runs on the second environment because after a failed redeploy, Radius loses track of what it created, a known Radius issue, so the failure runs where there's no database to lose. The exact resource is picked during the local run.
- **Final snapshot:** AWS Cloud Control always takes one when it deletes an RDS instance, also a known Radius issue. The recipe commit the canvas pins doesn't copy the app's tags to it yet, so the test finds it by instance name, and checks the tags once the pin moves.
- **Radius build:** the AWS workflows use Radius `edge` on purpose, because no Radius release has the fixes AWS needs yet. A planned change moves AWS to that release before AWS ships. Each run records the Radius versions it used.
- **Probe pods:** Kubernetes Jobs in the app's namespace with the app's Radius labels, so the lifecycle design's cleanup rule covers them. A probe that can't start fails the test instead of passing as a timeout.

Each managed service in the pack gets a row in the connection check and a resource in the fixture app, added by the recipe that adds the service.

### Cleanup

Sharing the fixture with Azure changes `cloud-e2e-cleanup.yml` in two ways. Its 02:23 UTC schedule, two hours before the 04:23 run, covers both clouds, and its 6-hour age cutoff still works: even a run that takes the full 360 minutes ends 16 hours before the next cleanup.

**Every selection belongs to one cloud.** AWS environment names start with `radtest-aws-`. Today the Azure job selects every `radtest-` environment, and also the app deletes, GHCR state packages, and deployment records that go with them. Each of these now takes only its own cloud's environments, so neither job can delete the other's retry inputs. Fallback branches and pull requests can't be tied to one cloud, so the final step below handles them.

**One final step resets the fixture.** Today the Azure job checks for leftovers and resets `main` at its end. That moves to a final job that runs after both clouds' jobs. It checks for leftovers from both clouds, then resets `main` once. If either cloud's job failed, it keeps `main` and its workflows, so the next run can retry.

For each AWS test environment, the AWS job follows the same order as the Azure job:

1. Asks the product to delete the app, and waits.
2. Sweeps the environment's leftover RDS and Kubernetes resources.
3. Checks nothing is left.
4. Only then removes the environment's trust subject, inline policy, access entry, GitHub environment, and state.

If any of steps 1 to 3 fails, it keeps everything in step 4, so the next run can retry, and the job fails. This is the lifecycle design's rule that cleanup never removes what a retry needs. The AWS job also scales the node groups to zero if a run left them up.

It deletes an AWS resource only if it's in one of the two regions, named the way the MySQL recipe names it, tagged with a test environment, and in one of the clusters' VPCs. Kubernetes workloads follow the lifecycle design's label rule. It never deletes the roles, the identity provider, a cluster, or a VPC, and a failed read stops that sweep without deleting.

Like the Azure sweep, which also deletes in a subscription shared with Radius, it has no dry run. Its rules are unit-tested against resources shaped like Radius's.

### Radius's cleanup job

Radius's daily cleanup job in the same account deletes RDS, S3, and log resources in `us-west-2` tagged `RadiusCreationTimestamp` and older than 6 hours. It can't touch this test: wrong region, a tag the MySQL recipe doesn't set, and a job that finishes in under 6 hours. This test can't touch Radius's resources either, because neither role can act in `us-west-2`.

### Time budget

Each test stage has a time limit, and the suite's limits must add up to less than the job's timeout, so Playwright stops first and saves its trace. A test in the repo checks this. GitHub allows at most 360 minutes per job, and Azure's limits add up to 274 minutes today (329 on the app host), so they come down to fit both clouds:

| Host     | Azure limits | AWS limits | Setup, teardown, and diagnostics | Job timeout |
|----------|--------------|------------|----------------------------------|-------------|
| Harness  | 150          | 180        | 25                               | 360         |
| App host | 130          | 150        | 40                               | 360         |

Azure's 150 minutes is still twice its longest recent run. The app host's limits are lower because it adds the app start once and a modeling stage per cloud. The local run sets AWS's limits from measured times.

### Rollout

1. This design is reviewed.
2. Administrators create the two roles and clusters in `radius-test`, and the `ai-extensions` secrets and variables. No repository or GitHub App install is needed.
3. The AWS cleanup lands first, so AWS never runs in the daily job without cleanup.
4. The AWS steps land in `cloud-e2e.yml`, with Azure's lower limits, after a local run in the developer's own AWS account and a fork of the fixture repository, as the lifecycle design allows.
5. On `main`, a manual cleanup run, then a manual Cloud E2E run on each host. Until the AWS variables are set, the AWS steps skip and the job runs Azure only.

Until the AWS variables are set, the AWS steps and cleanup skip and say why, as the lifecycle design does for an unpublished fixture.

### Cost

About $160 a month: $73 for each cluster's control plane, about $13 for nodes that run only during the test, and about $1 for RDS.

## Error handling

| Scenario                                      | What happens                                                                                            |
|-----------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Signing in to AWS fails                       | The job fails before the test starts. The runbook points to the trust policy, which accepts only `main` |
| Preflight finds the account or clusters wrong | The job fails before any write, reported as an infrastructure failure                                   |
| A cluster's upgrade policy isn't `STANDARD`   | Preflight fails and names the cluster, because it would move to extended support and cost more          |
| Nodes don't become ready after scaling up     | Preflight fails as an infrastructure failure, and the nodes are scaled back to zero                     |
| Preflight finds something from an earlier run | The job fails and names it, and points to the cleanup workflow. It doesn't delete it                    |
| The isolated probe connects                   | The connection check fails, because the isolated node no longer tests a missing network rule            |

## Test plan

- **Unit tests:** the cleanup rules, which never select resources shaped like Radius's. Cleanup keeping retry inputs when a step fails. The connection, snapshot, and 15-minute checks.
- **Workflow tests:** the AWS steps never run on pull requests, use no GitHub environment, run after Azure's even when Azure fails, and skip when the AWS variables are unset. Both suites' limits plus setup fit under the 360-minute job timeout on each host. The failure issue names the failed cloud. Cleanup's final job runs after both clouds' jobs.
- **Fixture and cleanup tests:** `main` at either pinned baseline is clean and anything else isn't. A dirty `main` fails the run before it moves. Each cloud's job selects only its own environments, app deletes, packages, and records. The final job resets `main` only when both clouds' jobs succeeded.
- **Local run:** the full test in the developer's own AWS account, plus a check that the deploy role's boundary refuses `s3:PutAccountPublicAccessBlock`, IAM, and RDS in `us-west-2`.

## Alternatives considered

- **A new AWS account only for these tests.** Cleaner, but needs someone with organization rights. Separate regions and a permissions boundary give enough separation.
- **Running in `us-west-2` with Radius's tests.** Rejected: shared regional quotas and Radius's cleanup region.
- **A cluster per run.** About $25 a month instead of about $160. Rejected: 30 to 40 more minutes a run, rights to create clusters, VPCs, and roles, and a leaked cluster costs $73 a month until someone finds it.
- **AWS in its own job, or its own workflow and schedule.** Each would give AWS its own 6-hour limit, result, and runner, and leave Azure's limits alone. Rejected for now: one job is the smallest change, and runs take far less than their limits. Moving AWS into a chained job later is simple.
- **A separate AWS fixture repository.** It would let the two clouds fail independently. Rejected: another repository and GitHub App install to set up and maintain. The cost of sharing is that a dirty fixture blocks both clouds until cleanup runs, which happens before each cloud's run.
- **Letting the product create the deploy role in CI.** Rejected in a shared account: the test role could then create a role with any permissions.
- **Trusting a protected GitHub environment so branches can run the AWS job before merge.** Rejected: a permanent second way to get the CI credential. Local runs cover the test before merge.
