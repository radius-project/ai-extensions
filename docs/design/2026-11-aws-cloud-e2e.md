# AWS in the Cloud E2E tests

- **Author**: Karishma Chawla (@kachawla)
- **Date**: 2026-11

This amends the [Cloud E2E environment lifecycle](./2026-08-cloud-e2e-environment-lifecycle.md) design, and fills in the cloud end-to-end tests in the test plan of the AWS and EKS canvas support design.

## Current state

The Cloud E2E tests run once a day against real Azure and real GitHub. They create an environment in the canvas, deploy the fixture app to a shared AKS cluster, delete everything, and check that nothing is left. AWS has no such test. The AWS path (setup, deploy, delete) is on `main` behind the `RADIUS_CANVAS_AWS=1` developer switch, and only unit and server tests with a fake `aws` CLI cover it. Setup creates one IAM role per repository that the repository's GitHub deploy workflows sign in to, called the deploy role, and each environment adds its own permissions to it.

A fake CLI can't show that AWS accepts the IAM, EKS, and RDS calls the product makes, that a pod can reach the database a recipe created, or that delete leaves nothing behind. Without a live test, a change that breaks AWS setup or delete reaches users silently, and a leak keeps billing until someone notices.

## Proposal

Add an AWS job to the daily Cloud E2E workflow. It drives the canvas through AWS setup, deploy, and delete in the Radius project's AWS functional-test account, `radius-test`, on two shared EKS clusters created once ahead of time, in regions Radius's own tests don't use. It uses a new long-lived fixture repository, and the cleanup workflow gets an AWS sweep that can only touch this test's resources.

## Objectives

### Goals

- The AWS test runs in Cloud E2E once a day and on manual dispatch, and never on pull requests.
- A pod can reach every managed service in the `aws-eks` recipe pack, and the check catches nodes that can't.
- Deleting both environments leaves only the deploy role and the GitHub identity provider.
- Cleanup removes what a failed run leaves behind, without touching Radius's own test resources.

### Non-goals

- Running the AWS test in the GitHub Copilot app host: the harness host already proves the cloud calls.
- Creating or deleting EKS clusters in the test: the canvas only discovers clusters, the same as for AKS.
- Testing first-time creation of the deploy role in CI: the test role can't create roles in the shared account, so server tests and local runs cover it.

## Design

Each day, the AWS job signs in to `radius-test`, uses the canvas to set up two environments, deploy, and delete, and then checks that nothing is left. The sections below cover where it runs, the two AWS roles it uses, what the test does step by step, and how cleanup works.

### Where it runs

These choices decide where the test runs, and why.

| What               | Choice                                                                          | Why                                                                                                                                                      |
|--------------------|---------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| AWS account        | `radius-test`, the Radius project's AWS functional-test account                 | Azure Cloud E2E already reuses the Radius test subscription. The account already has billing and the GitHub identity provider                            |
| Regions            | `us-east-2` for the main environment, `us-west-1` for the second                | Radius's tests use only `us-west-2`. Neither is `us-east-1`, where IAM and other global services sign their requests                                     |
| Clusters           | One shared EKS cluster in each region, created once by an account administrator | The canvas never creates clusters. A cluster per run adds time, rights, and leak risk                                                                    |
| Fixture repository | New, private, long-lived `radius-project/ai-extensions-fixture-aws`             | The AWS app is different from the Azure app, and a separate repository lets the two clouds run in parallel                                               |
| Workflow           | A second job, `cloud-e2e-aws`, in `cloud-e2e.yml`                               | Same schedule and never-on-pull-request rule. The workflow's concurrency group, shared with `cloud-e2e-cleanup.yml`, keeps cleanup out while a test runs |

AWS can't be added to the Azure job, because that job's 340-minute timeout is already close to GitHub's 6-hour limit. The two jobs share no state: different clouds, fixture repositories, and deploy identities.

### The fixture repository

The fixture repository is the GitHub repository the test runs the canvas against. It holds a ready-made app, and setup commits its workflows there, the same as in a user's repository. Azure uses `radius-project/ai-extensions-fixture`. AWS gets a new private one, `radius-project/ai-extensions-fixture-aws`.

The lifecycle design uses one long-lived fixture repository, with each run kept apart by its environment names. AWS keeps that model with a second repository. The lifecycle design rejected a repository per run because it needs organization-wide rights to create repositories; a second long-lived repository needs none, only the existing Cloud E2E GitHub App installed on it.

Its baseline commit carries a `.radius/` directory produced by the real modeling flow, with two resources:

- A `Radius.Data/mySqlDatabases` resource, which the `aws-eks` pack deploys on Amazon RDS.
- A `Radius.Compute/containers` resource that signs in to the database over TLS and runs `SELECT 1` in a loop, and is ready only after that query succeeds. A query is needed because `mysqladmin ping` succeeds even when MySQL refuses the sign-in.

The database password is a fixed test value in the private fixture model. The instance is private to the cluster's VPC and lives for less than an hour.

A second pinned commit carries the app for the failed deploy: one resource that fails in Kubernetes before any AWS call, and no AWS resources.

### How the test signs in to AWS

The test uses two IAM roles, because it plays two parts: the developer who runs setup in the canvas, and the GitHub workflows that deploy the app.

| Role                                                                  | Who uses it                                                                                | What it stands in for                                                                                         |
|-----------------------------------------------------------------------|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------|
| Test role, `ai-extensions-cloud-e2e`                                  | The Cloud E2E job in this repository, to run setup in the canvas and to check and clean up | The developer's own AWS sign-in                                                                               |
| Deploy role, `radius-deploy-radius-project-ai-extensions-fixture-aws` | The deploy workflows that setup commits to the fixture repository                          | The role setup creates for each repository in real use, which the AWS canvas design calls the deploy identity |

An account administrator creates both once.

**The test role.** The Cloud E2E job signs in to it with GitHub's OIDC token. It trusts only `repo:radius-project/ai-extensions:ref:refs/heads/main`, so no pull request or branch can use it. The job doesn't use a GitHub environment, because that would change the subject GitHub sends. The role can:

- Read EKS, EC2, and RDS, and run `kubectl` on the two clusters.
- Change only the deploy role's trust policy and inline policies, its lock policy, and access entries on the two clusters.
- Delete only RDS instances, groups, and snapshots named `mysql-*` and `rds-snapshot-*`.

Everything except IAM is limited to the two regions. The test role can't create or delete roles, change a permissions boundary, or create an identity provider. Its session lasts 6 hours, as long as the job, because AWS's default is 1 hour and the job signs in only once.

**The deploy role.** Setup gives it permissions by writing inline policies on it, so whoever runs setup controls what it can do. In an account shared with Radius's tests, that must be capped, so the administrator creates it ahead of time with:

- The tags setup puts on a role it creates, so setup reuses it instead of creating one.
- The trust policy setup leaves when no environment uses the role: one deny statement, `RadiusNoTrustedEnvironments`.
- A permissions boundary, which is the most a role can ever do, whatever its own policies say. It allows only the services the recipes use (Cloud Control, RDS, and a few EKS and EC2 reads), only in the two regions. It denies IAM, account settings, and `s3:PutAccountPublicAccessBlock`. Each new recipe adds its service.

The boundary lists services instead of allowing everything in the two regions, because a region condition limits where a request is sent, not what it changes. For example, `s3:PutAccountPublicAccessBlock` sent to `us-east-2` turns off S3 Block Public Access for every bucket in the account, including Radius's.

The deploy role can't create service-linked roles. RDS's already exists in the account; a recipe for a new service may need an administrator to create one first.

Because the test role can't create roles, a run that finds the deploy role missing stops at setup and changes nothing. Creating it for the first time is covered by server tests and by local runs in a developer's own account.

### The clusters

The main cluster, in `us-east-2`, has two node groups. The default one has two `t3.medium` nodes. The isolated one has one `t3.small` node whose launch template sets its own security group, so EKS doesn't add it to the cluster security group, and nothing allows TCP 3306 from it. A taint keeps app pods off it.

The second cluster, in `us-west-1`, has no nodes. The run only creates an environment on it, deploys an app that fails before any pod is scheduled, and deletes it.

Both clusters use authentication mode `API` and a public endpoint, because GitHub-hosted runners reach them over the internet. Nodes use public subnets, so no NAT gateway is needed. RDS uses private subnets. Both clusters must stay on a Kubernetes version in EKS standard support, because extended support costs six times as much.

### What the test does

Each step runs in the canvas, in order, with the AWS switch on.

1. **Preflight.** The account, both clusters, and the isolated node group are as expected, and nothing from an earlier run is left.
2. **Create the main environment.** Setup reuses the deploy role, and adds one trust subject, one inline policy, and one access entry. Verify succeeds.
3. **Create the second environment.** It uses the same deploy role, which now has two of each.
4. **Failed deploy.** The failing app, deployed to the second environment, shows its resource as failed in the deployed graph. Nothing is created in AWS.
5. **Deploy.** The baseline app deploys to the main environment, and a Kubernetes write happens more than 15 minutes after the deploy got its first EKS token.
6. **Connection check.** The app's container is ready. A probe pod on the default nodes signs in to each managed service. The same probe on the isolated node times out, and the check names the service.
7. **Delete the apps.** The RDS instance and its groups are gone, and exactly one final RDS snapshot exists. The test deletes it.
8. **Delete the second environment.** Its subject, policy, and access entry are removed, and the main environment still passes verify.
9. **Delete the main environment.** Its subject, policy, and access entry are removed.
10. **Leftovers.** Only the deploy role, with no inline policies and the deny trust statement, and the GitHub identity provider are left. No RDS, Kubernetes, or GitHub resources from the run remain.

Why some steps work the way they do:

- **15 minutes:** an EKS token lasts 15 minutes, so a later Kubernetes write only works if the deploy's token refresh works. The start is the refresher's first log line, not the workflow's start. RDS create time varies, so the fixture app has a gate that forces a late write.
- **Failed deploy on the second environment:** after a failed redeploy, Radius loses track of the resources it created, a known Radius issue. Failing on an environment with no database avoids leaving one behind.
- **Final snapshot:** AWS Cloud Control always takes one when it deletes an RDS instance, also a known Radius issue. The recipe copies the app's tags to it on `resource-types-contrib`'s `main`, but the commit the canvas pins is older. Until the pin moves, the test finds the snapshot by the instance name it recorded; after that, it also checks the tags.
- **Radius build:** the AWS workflows use Radius `edge` on purpose, because no Radius release has the fixes AWS needs yet. A planned change moves AWS to that release before AWS ships. Each run records the Radius versions it used.
- **Probe pods:** they run as Kubernetes Jobs in the app's namespace, with the app's Radius labels, so the lifecycle design's cleanup rule covers them. A probe that can't start fails the test, instead of counting as the expected timeout.

Each managed service in the pack gets a row in the connection check and a resource in the fixture app, added by the recipe that adds the service.

### Cleanup

`cloud-e2e-cleanup.yml` gets an AWS job that runs when the AWS fixture variables are set. For each expired test environment, it follows the same order as the Azure job:

1. Asks the product to delete the app, and waits.
2. Sweeps the environment's leftover RDS and Kubernetes resources.
3. Checks nothing is left.
4. Only then removes the environment's trust subject, inline policy, access entry, GitHub environment, and state.

If any of steps 1 to 3 fails, it keeps everything in step 4, so the next run can retry, and the job fails. This is the lifecycle design's rule that cleanup never removes what a retry needs.

A resource is deleted only if it's in one of the two regions, named the way the MySQL recipe names it, tagged with an expired test environment, and in one of the two clusters' VPCs where the resource has one. Kubernetes workloads follow the lifecycle design's label rule. Cleanup never deletes the deploy role, the identity provider, a cluster, a node group, a VPC, or anything in another region. A read that fails stops that kind of sweep without deleting.

The sweep has no dry run, the same as the Azure sweep, which also deletes in a subscription shared with Radius. Its rules are unit-tested against resources shaped like Radius's, and the test role can't act in `us-west-2`.

### Radius's cleanup job

Radius's own daily job in the same account deletes RDS, S3, and log resources in `us-west-2` tagged `RadiusCreationTimestamp` and older than 6 hours. It can't delete this test's database: it looks only in `us-west-2`, the MySQL recipe doesn't set that tag, and the AWS job finishes in under 6 hours. This test can't delete Radius's resources either, because neither the test role nor the deploy role can act in `us-west-2`.

### Time budget

The AWS suite has its own stage limits, about 230 minutes in total, under a 270-minute job timeout. Reusing the Azure limits would add up to about 370 minutes, over GitHub's 6-hour limit. The local run sets the limits from measured times.

### Rollout

1. This design is reviewed.
2. An administrator of `radius-test` creates the test role, the deploy role, and the clusters. An organization administrator creates the AWS fixture repository and installs the Cloud E2E GitHub App on it. An `ai-extensions` administrator adds the role and account secrets and the region and cluster variables.
3. The AWS sweep lands first, so the scheduled AWS run never runs without cleanup.
4. The AWS test lands. Before merge, it runs locally in the developer's own AWS account and their fork of the fixture repository, which the lifecycle design already allows.
5. On `main`, a manual cleanup run, then a manual Cloud E2E run. The daily schedule starts once both pass.

Until the fixture variable is set, the AWS job and sweep skip and say why, following the lifecycle design's rule for an unpublished fixture.

### Cost

About $240 a month: $165 for the main cluster and its nodes, $73 for the second cluster's control plane, and about $1 for RDS. Most of the cost is the shared clusters, which run all the time.

## Error handling

| Scenario                                          | What happens                                                                                            |
|---------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Signing in to AWS fails                           | The job fails before the test starts. The runbook points to the trust policy, which accepts only `main` |
| Preflight finds the account or clusters wrong     | The job fails before any write, reported as an infrastructure failure                                   |
| Preflight finds something from an earlier run     | The job fails and names it, and points to the cleanup workflow. It doesn't delete it                    |
| The deploy role is missing                        | Setup stops with the product's "not permitted to create IAM roles" message                              |
| No Kubernetes write after the first token expired | The deploy step fails, because token refresh wasn't tested                                              |
| The isolated probe connects                       | The connection check fails, because the isolated node no longer tests a missing network rule            |
| No final snapshot, or more than one               | The delete step fails and names the instance                                                            |
| A step fails part way                             | The fixture's teardown removes what the run registered, and cleanup removes the rest                    |

## Test plan

- **Unit tests:** the cleanup rules, including resources shaped like Radius's (in `us-west-2`, tagged `RadiusCreationTimestamp`, or without our tags), none of which is selected. Groups left without an instance. Cleanup keeping retry inputs when a step fails. The connection check, snapshot check, and 15-minute check. The stage limits fitting the job timeout.
- **Workflow tests:** the AWS job never runs on pull requests, has the repository guard, uses no GitHub environment, shares the concurrency group, and skips when the fixture variable is unset.
- **Local run:** the full test in the developer's own AWS account. It also checks that the deploy role's boundary refuses `s3:PutAccountPublicAccessBlock`, an IAM action, and an RDS call in `us-west-2`.

## Open questions

1. **Will the Radius maintainers who own `radius-test` accept about $240 a month, and who keeps the clusters on a supported Kubernetes version?** About a third of the cost is the second cluster, which exists only to test a second region.
2. **Which fixture gate forces a Kubernetes write at least 16 minutes into the deploy, every time?** For example, a resource that waits on the container, whose readiness is held back for 16 minutes. The local run picks it.
3. **Which resource fails in Kubernetes, before any AWS call, every time?** The local run picks it.

## Alternatives considered

- **A new AWS account only for these tests.** Cleaner, but needs someone with organization rights. Separate regions and a permissions boundary give enough separation.
- **Running in `us-west-2` with Radius's tests.** Rejected: shared regional quotas and Radius's cleanup region.
- **A cluster per run.** About $25 a month instead of $165. Rejected: 30 to 40 more minutes a run, rights to create clusters, VPCs, and roles, and a leaked cluster costs $73 a month until someone finds it.
- **Sharing the Azure fixture repository.** Rejected: AWS would wait behind Azure on the lease, and a broken fixture would stop both.
- **Letting the product create the deploy role in CI.** Rejected in a shared account: the test role could then create a role with any permissions.
- **Trusting a protected GitHub environment so branches can run the AWS job before merge.** Rejected: a permanent second way to get the CI credential. Local runs cover the test before merge.
