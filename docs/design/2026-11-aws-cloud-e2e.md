# AWS in the Cloud E2E tests

- **Author**: Karishma Chawla (@kachawla)
- **Date**: 2026-11

This amends the [Cloud E2E environment lifecycle](./2026-08-cloud-e2e-environment-lifecycle.md) design, and fills in the cloud end-to-end tests in the test plan of the AWS and EKS canvas support design.

## Current state

The Cloud E2E tests run once a day against real Azure and real GitHub. They create an environment in the canvas, deploy the fixture app to a shared AKS cluster, delete everything, and check that nothing is left. AWS has no such test. The AWS path (setup, deploy, delete) is on `main` behind the `RADIUS_CANVAS_AWS=1` developer switch. It is covered only by unit and server tests that use a fake `aws` CLI.

A fake CLI can't show that AWS accepts the IAM, EKS, and RDS calls the product makes, that a pod can reach the database a recipe created, or that delete leaves nothing behind. Without a live test, a change that breaks AWS setup or delete reaches users silently, and a leak keeps billing until someone notices.

## Proposal

Add an AWS job to the daily Cloud E2E workflow. It runs the AWS journey in the canvas against the Radius project's existing AWS functional-test account, `radius-test`, on two shared EKS clusters an account administrator creates once, in regions Radius's own tests don't use. It uses a new long-lived fixture repository, and the cleanup workflow gets an AWS sweep that can only touch this test's resources.

## Objectives

### Goals

1. The AWS journey runs once a day and on manual dispatch, and never on pull requests.
2. The run creates two environments in two regions on one deploy identity.
3. The run deploys MySQL on Amazon RDS and a container that connects to it, in a deploy longer than 15 minutes.
4. A pod can reach every managed service the `aws-eks` recipe pack has.
5. The connection check fails, naming the service, from nodes that aren't in the cluster security group.
6. A deploy that fails shows the failed resource in the deployed graph.
7. After delete, only the deploy identity and the GitHub identity provider are left. The final RDS snapshot is expected, checked, and deleted.
8. The cleanup workflow removes what a failed run leaves behind.
9. Neither Radius's purge job nor this test's cleanup can delete the other's resources.

### Non-goals

- Running the AWS journey in the GitHub Copilot app host: the harness host proves the cloud calls, and the app host adds no AWS-specific coverage.
- Creating or deleting EKS clusters in the test: the canvas only discovers clusters, so the test uses clusters created ahead of time, the same as for AKS.
- Testing first-time creation of the deploy identity in CI: see [The deploy identity](#the-deploy-identity) for why CI reuses one, and where creation is tested instead.

## Design

### Where it runs

| What               | Choice                                                                          | Why                                                                                                                                                                      |
|--------------------|---------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| AWS account        | The Radius project's AWS functional-test account, `radius-test`                 | Azure Cloud E2E already reuses the Radius test subscription, and the account already has billing and the GitHub identity provider, `token.actions.githubusercontent.com` |
| Regions            | `us-east-2` for the main environment, `us-east-1` for the second                | Radius's functional tests and its purge job use only `us-west-2`, so the two never share a region                                                                        |
| Clusters           | One shared EKS cluster in each region, created once by an account administrator | The canvas discovers clusters and never creates them, and a cluster per run adds time, rights, and leak risk                                                             |
| Fixture repository | New private, long-lived `radius-project/ai-extensions-fixture-aws`              | The AWS app is different from the Azure app, and a separate repository lets the two clouds run in parallel                                                               |
| Workflow           | A second job, `cloud-e2e-aws`, in `cloud-e2e.yml`                               | Same schedule, same never-on-pull-request rule, and the same concurrency group keeps cleanup from running during a test                                                  |

The Azure job's 340-minute timeout is already close to GitHub's 6-hour limit, so AWS can't be added to the same job. The two jobs run in parallel within one workflow run. They share no state: different clouds, different fixture repositories, different deploy identities. The workflow-level concurrency group, which `cloud-e2e-cleanup.yml` also uses, still keeps cleanup out while either job runs.

### The fixture repository

This keeps the lifecycle design's choice of one long-lived repository per test, with per-run isolation from environment names, and adds a second repository for AWS. The lifecycle design rejected a repository per run because it needs organization-wide rights to create repositories. A second long-lived repository needs none: the existing Cloud E2E GitHub App is installed on one more repository, with the same permissions.

Sharing the Azure fixture repository was considered and rejected; see [Alternatives considered](#alternatives-considered).

The baseline commit carries a `.radius/` directory produced by the real modeling flow, as in the Azure fixture:

- A `Radius.Data/mySqlDatabases` resource, which the `aws-eks` pack deploys on Amazon RDS.
- A `Radius.Compute/containers` resource that connects to the database. Its command runs `mysqladmin ping` over TLS in a loop and logs `connected mysql` on success, and its readiness probe runs the same check. The container is ready only after it has connected.

The database password is a fixed test value in the private fixture model. The instance is private to the cluster's VPC and lives for less than an hour.

A second pinned commit carries the variant used for the failed deploy: an app with one resource that fails in Kubernetes before any AWS call, and no AWS resources. Both commits are pinned in source, the same way `FIXTURE_BASELINE_SHA` is, and the run resets `main` to the baseline before and after.

### The CI identity

An account administrator creates an IAM role, `ai-extensions-cloud-e2e`, that GitHub Actions assumes with OIDC. It trusts only `repo:radius-project/ai-extensions:ref:refs/heads/main` with audience `sts.amazonaws.com`, the same as the Azure credential, so no pull request or branch can get it. The AWS job doesn't use a GitHub environment, because that would change the subject GitHub sends.

The role acts as the developer in the journey, and also checks and cleans up. Every action except IAM is limited to the two regions by the `aws:RequestedRegion` condition, so the role can't read or change anything in `us-west-2`.

| Need                        | Actions                                                                                                                                                                                                                  | Limited to                                                                   |
|-----------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| Account check               | `sts:GetCallerIdentity`                                                                                                                                                                                                  | None                                                                         |
| Discovery                   | `eks:List*`, `eks:Describe*`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `ec2:DescribeRouteTables`, `ec2:DescribeAvailabilityZones`, `ec2:DescribeSecurityGroups`, `ec2:DescribeLaunchTemplateVersions`                  | The two regions                                                              |
| GitHub identity provider    | `iam:ListOpenIDConnectProviders`, `iam:GetOpenIDConnectProvider`                                                                                                                                                         | Read only. The provider already exists                                       |
| Deploy identity             | `iam:GetRole`, `iam:ListRoles`, `iam:ListRoleTags`, `iam:UpdateAssumeRolePolicy`, `iam:PutRolePolicy`, `iam:GetRolePolicy`, `iam:ListRolePolicies`, `iam:DeleteRolePolicy`, `iam:ListAttachedRolePolicies`               | Writes only on `role/radius-deploy-radius-project-ai-extensions-fixture-aws` |
| Deploy identity lock        | `iam:CreatePolicy`, `iam:GetPolicy`, `iam:DeletePolicy`                                                                                                                                                                  | `policy/radius-lock-radius-deploy-radius-project-ai-extensions-fixture-aws`  |
| Cluster access              | `eks:CreateAccessEntry`, `eks:DescribeAccessEntry`, `eks:ListAccessEntries`, `eks:DeleteAccessEntry`, `eks:AssociateAccessPolicy`, `eks:DisassociateAccessPolicy`, `eks:ListAssociatedAccessPolicies`, `eks:TagResource` | The two clusters                                                             |
| Leftover checks and cleanup | `rds:Describe*`, `rds:ListTagsForResource`, `tag:GetResources`, `rds:DeleteDBInstance`, `rds:DeleteDBSubnetGroup`, `rds:DeleteDBParameterGroup`, `rds:DeleteDBSnapshot`                                                  | The two regions, and names `mysql-*` and `rds-snapshot-*`                    |

The role is explicitly denied `iam:CreateRole`, `iam:DeleteRole`, `iam:PutRolePermissionsBoundary`, `iam:DeleteRolePermissionsBoundary`, and `iam:CreateOpenIDConnectProvider`. The administrator also gives the role an EKS access entry with `AmazonEKSClusterAdminPolicy` on both clusters, so the test can run `kubectl`.

### The deploy identity

The product's deploy identity gets its permissions from inline policies that setup writes, so whoever can run setup can change what the role is allowed to do. In a dedicated account that is acceptable. In an account shared with Radius's tests, it must be capped.

An account administrator creates the deploy identity once, `radius-deploy-radius-project-ai-extensions-fixture-aws`, with:

- The tags the product puts on a role it owns: `radius-managed=true` and `radius-repository=radius-project/ai-extensions-fixture-aws`. Setup then reuses it, the same as it reuses a role it created on an earlier run.
- The trust policy the product leaves when no environment uses the role: one deny statement, `RadiusNoTrustedEnvironments`, for the GitHub identity provider.
- A permissions boundary, `ai-extensions-cloud-e2e-deploy-boundary`, that allows the actions in `PowerUserAccess`, limited to the two regions. A permissions boundary is the most a role can ever do, whatever its own policies say. So even if the role's inline policies were changed, it still couldn't act in `us-west-2` or change IAM.

Because CI can't create roles, a run that finds the role missing stops at setup with the product's "not permitted to create IAM roles" message and changes nothing. Creating the role for the first time is covered by the server tests and by local runs in a developer's own account.

### The clusters

| Cluster                        | Region      | Nodes                                                                                 | Subnets                                                                    |
|--------------------------------|-------------|---------------------------------------------------------------------------------------|----------------------------------------------------------------------------|
| `ai-extensions-e2e-aws`        | `us-east-2` | A managed node group of two `t3.medium`, and an isolated node group of one `t3.small` | Two public subnets for nodes and two private subnets for RDS, in two zones |
| `ai-extensions-e2e-aws-second` | `us-east-1` | None                                                                                  | Two private subnets in two zones                                           |

Both clusters use authentication mode `API` and a public endpoint, because GitHub-hosted runners reach them over the internet. Nodes use public subnets so they can pull images without a NAT gateway. RDS uses the private subnets, which the canvas selects by default.

The isolated node group's launch template sets its own security group, so EKS doesn't add its nodes to the cluster security group. That group allows the traffic EKS needs between nodes and the control plane, and nothing on TCP 3306. Its nodes have the label `radius-cloud-e2e/node-group=isolated` and the taint `radius-cloud-e2e/isolated=true:NoSchedule`, so app pods never run there.

The main cluster also has an empty namespace, `radius-cloud-e2e-probes`, for the connection check's probe pods. The test never creates or deletes it.

The second cluster needs no nodes. The run only creates an environment on it, deploys an app that fails in Kubernetes before any pod is scheduled, and deletes it.

Both clusters must stay on a Kubernetes version in EKS standard support. A cluster on extended support costs six times as much.

### The journey

Each step runs in the canvas, in the order below, as one serial suite with the AWS switch on.

| Step                          | What the test checks                                                                                                                                                                                                                                                                          |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Preflight                     | The account matches. Both clusters are `ACTIVE` with mode `API`. The isolated node group exists and its security group isn't the cluster security group. The probe namespace exists. Nothing from an earlier run is left (see [Leftovers](#leftovers)).                                       |
| Create the main environment   | Setup reuses the deploy identity, and adds one subject, one inline policy, and one access entry. Verify succeeds.                                                                                                                                                                             |
| Create the second environment | Same deploy identity. It now has two subjects, two inline policies, and an access entry on each cluster.                                                                                                                                                                                      |
| Failed deploy                 | Deploys the failing variant to the second environment. The deployed graph shows the resource as failed. Nothing is created in AWS.                                                                                                                                                            |
| Deploy                        | Deploys the baseline app to the main environment. The deploy takes more than 15 minutes, and the container's Kubernetes Deployment is created more than 15 minutes after the deploy workflow started. The RDS instance has the app's `radapp.io/*` tags and no `RadiusCreationTimestamp` tag. |
| Connection check              | The app's container is ready and has logged `connected mysql`. A probe pod on the default nodes reaches each managed service. The same probe on the isolated nodes fails with a connection timeout, and the check's message names the service.                                                |
| Delete the apps               | Both apps are deleted. The RDS instance, subnet group, and parameter group are gone. Exactly one final snapshot, `rds-snapshot-*`, exists for the instance, with the app's tags. The test deletes it and waits until it's gone.                                                               |
| Delete the second environment | Its subject, policy, and access entry are removed. The main environment still passes verify.                                                                                                                                                                                                  |
| Delete the main environment   | Its subject, policy, and access entry are removed.                                                                                                                                                                                                                                            |
| Leftovers                     | See [Leftovers](#leftovers).                                                                                                                                                                                                                                                                  |

The 15-minute rule exists because an EKS token lasts 15 minutes. A Kubernetes write after that only works if the deploy workflow's token refresh works.

The failed deploy goes to the second environment, before anything else is deployed there, and contains no AWS resource. After a failed redeploy, Radius loses track of the resources it created, a known Radius issue. A failed redeploy over the database would leave the instance behind.

The final snapshot is expected because AWS Cloud Control always takes one when it deletes an RDS instance, also a known Radius issue. The test expects exactly one. The Radius release is pinned, so this changes only when someone bumps Radius on purpose, and that bump updates the expectation.

Each managed service in the `aws-eks` pack has one row in the connection check: its resource type, the fixture resource, and the probe command. Each recipe that adds a service also adds its row and its fixture resource.

The probe pods are Kubernetes Jobs that the test creates in `radius-cloud-e2e-probes`. Each has the label `radius-cloud-e2e/run-id=<run id>` and a 5-minute deadline, and Kubernetes removes it 10 minutes after it finishes. The probe exits with a different code when it can't resolve the host or can't start, so an image pull failure fails the test instead of counting as the expected network failure.

### Leftovers

After delete, the test checks AWS and GitHub.

| Thing                                                                                      | Expected                                                                                    |
|--------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| GitHub identity provider                                                                   | Present, unchanged                                                                          |
| Deploy identity                                                                            | Present, with no inline policies and only the `RadiusNoTrustedEnvironments` trust statement |
| Deploy identity lock                                                                       | Absent                                                                                      |
| Access entries for the deploy identity                                                     | None on either cluster                                                                      |
| RDS instances, subnet groups, and parameter groups with the run's environment tags         | None in either region                                                                       |
| RDS snapshots with the run's environment tags                                              | None                                                                                        |
| Kubernetes workloads with the run's application label, and probe Jobs with the run's label | None                                                                                        |
| GitHub environments, deployment records, and GHCR state packages for the run               | None, the same as for Azure                                                                 |

### Cleanup

`cloud-e2e-cleanup.yml` gets a second job, `purge-aws`, that runs only when the AWS fixture variables are set. Like the Azure job, it first asks the product to delete each expired test environment's app by dispatching the fixture repository's delete workflow, then sweeps what's left. It deletes a resource only when every rule for its kind matches:

| Kind                                        | Rules                                                                                                                                                                                                                             |
|---------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| RDS instance, subnet group, parameter group | In one of the two regions, named `mysql-*`, tagged `radapp.io/environment` with a `radtest-` environment, in one of the two clusters' VPCs, and older than the cutoff                                                             |
| RDS snapshot                                | In one of the two regions, named `rds-snapshot-*`, made from an instance named `mysql-*`, in one of the two clusters' VPCs, and older than the cutoff. Tags aren't required, because one review saw a final snapshot without them |
| Inline policy on the deploy identity        | Named for a `radtest-` environment that no longer exists in the AWS fixture repository                                                                                                                                            |
| Trust subject on the deploy identity        | Names the AWS fixture repository, in the name or ID form, and a `radtest-` environment that no longer exists                                                                                                                      |
| Deploy identity lock                        | Older than the cutoff                                                                                                                                                                                                             |
| Access entry                                | For the deploy identity, tagged `radius-managed=true`, on one of the two clusters, when no `radtest-` environment uses that cluster                                                                                               |
| Kubernetes workloads                        | The lifecycle design's rule: only workloads with a registered application label. Probe Jobs only by their run label, and only in `radius-cloud-e2e-probes`                                                                        |

It never deletes the deploy identity, the GitHub identity provider, a cluster, a node group, a VPC, or anything in another region. A read that fails stops that kind's sweep without deleting.

`us-east-2` already holds manual RDS snapshots from older sample apps. None of them matches the snapshot rule, because their source instances aren't named `mysql-*` and they are in other VPCs.

The job has a `dry-run` input that lists what it would delete and deletes nothing. The cleanup workflow has no dry run today. The AWS sweep adds one because it deletes in an account shared with another project, so its first run on `main` should show what it selects before it deletes anything.

### Radius's purge job

Radius's `purge-aws-test-resources.yaml` runs every day in the same account. It deletes RDS instances, subnet groups, S3 buckets, and log groups in `us-west-2` that are tagged `RadiusCreationTimestamp` with a time more than 6 hours ago.

| Question                                             | Answer | Why                                                                                                                                                                                                        |
|------------------------------------------------------|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Can Radius's purge delete a running test's database? | No     | It looks only in `us-west-2`, and only at the `RadiusCreationTimestamp` tag, which the MySQL recipe doesn't set. The deploy step checks that the tag is absent. The AWS job also times out before 6 hours. |
| Can our cleanup delete Radius's test resources?      | No     | The CI role can't act in `us-west-2`, and the sweep also requires our name pattern, our environment tag, and our cluster VPC.                                                                              |
| Can our deploy identity touch Radius's resources?    | No     | Its permissions boundary allows only the two regions, and no IAM changes.                                                                                                                                  |

### Configuration

Repository secrets: `AWS_CLOUD_E2E_ROLE_ARN` and `AWS_CLOUD_E2E_ACCOUNT_ID`.

Repository variables:

| Variable                                      | Value                                      |
|-----------------------------------------------|--------------------------------------------|
| `AIEXT_CLOUD_E2E_AWS_FIXTURE_REPOSITORY`      | `radius-project/ai-extensions-fixture-aws` |
| `AIEXT_CLOUD_E2E_AWS_REGION`                  | `us-east-2`                                |
| `AIEXT_CLOUD_E2E_AWS_EKS_CLUSTER_NAME`        | `ai-extensions-e2e-aws`                    |
| `AIEXT_CLOUD_E2E_AWS_SECOND_REGION`           | `us-east-1`                                |
| `AIEXT_CLOUD_E2E_AWS_SECOND_EKS_CLUSTER_NAME` | `ai-extensions-e2e-aws-second`             |

When the fixture variable is unset, the AWS job and the AWS sweep skip and say why, following the lifecycle design's rule for an unpublished fixture. As in that rule, the skip is removed once the variables are set.

### Rollout

1. This amendment is reviewed.
2. An administrator of `radius-test` creates the AWS resources above. An organization administrator creates the AWS fixture repository and installs the Cloud E2E GitHub App on it, and an `ai-extensions` administrator adds the secrets and variables.
3. The AWS sweep lands first, so the scheduled AWS run never runs without cleanup.
4. The AWS journey lands. Before merge, it runs locally from the branch against the developer's own AWS account and their fork of the AWS fixture repository, which the lifecycle design already allows.
5. On `main`, in order: cleanup in dry run, cleanup, then a manual Cloud E2E dispatch. The daily schedule starts once all three pass.

### Cost

Approximate on-demand prices in `us-east-2` and `us-east-1`.

| Item                                                                    | Per month      |
|-------------------------------------------------------------------------|----------------|
| Main cluster control plane                                              | $73            |
| Two `t3.medium` nodes                                                   | $61            |
| One `t3.small` isolated node                                            | $15            |
| Node disks and public IPv4 addresses                                    | $16            |
| Second cluster control plane, no nodes                                  | $73            |
| RDS `db.t3.micro` for about an hour a day, and its snapshot for minutes | $1             |
| **Total**                                                               | **About $240** |

A NAT gateway instead of public node subnets would add about $33. One `t3.medium` instead of two saves about $30. A cluster on EKS extended support costs $438 instead of $73.

## Error handling

| Situation                                                                                      | What happens                                                                                                                |
|------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| Signing in to AWS fails                                                                        | The job fails before the journey. The runbook points to the role's trust policy, which accepts only `main`.                 |
| Account, cluster status, authentication mode, isolated node group, or probe namespace is wrong | Preflight fails before any write, reported as an infrastructure failure.                                                    |
| Something from an earlier run is left                                                          | Preflight fails, names what's left, and points to the cleanup workflow. The run doesn't delete it.                          |
| The deploy identity is missing                                                                 | Setup stops with the product's "not permitted to create IAM roles" message. Nothing changes.                                |
| The deploy is shorter than 15 minutes                                                          | The deploy step fails, because the token refresh wasn't tested.                                                             |
| The probe can't start or resolve the host                                                      | The connection check fails as a test error, not as the expected network failure.                                            |
| The isolated probe connects                                                                    | The connection check fails, because the isolated node group no longer tests a missing network rule.                         |
| No final snapshot, more than one, or one without the app's tags                                | The delete step fails and names the instance.                                                                               |
| A step fails part way                                                                          | The fixture's teardown removes what the run registered. The cleanup workflow removes the rest on its next run.              |
| A cleanup read fails                                                                           | That kind isn't swept, and the job fails after the other kinds.                                                             |
| A cleanup delete fails                                                                         | It retries a bounded number of times, then the job fails and doesn't reset the fixture branch, the same as the Azure sweep. |

## Test plan

- **Unit tests**
  - The cleanup rules for each kind, including resources shaped like Radius's tests: in `us-west-2`, tagged `RadiusCreationTimestamp`, or without our tags. None of them is selected.
  - A dry run selects the same resources and makes no delete call.
  - The connection check: success, a timeout that names the service, and a probe that didn't start.
  - The final snapshot check: one tagged snapshot, none, two, and one without tags.
  - The 15-minute check from deploy timestamps.
  - The AWS time budget fits under the job timeout.
- **Workflow tests**: the AWS job never runs on pull requests, has the repository guard, uses no GitHub environment, shares the concurrency group, and skips when the fixture variable is unset. The cleanup job follows the same rules.
- **Local run**: the full journey from the branch, in the developer's own AWS account, with their own clusters and their fork of the AWS fixture repository.
- **On `main`**: the rollout order above.

## Open questions

1. **Will the Radius maintainers who own `radius-test` accept about $240 a month, and who keeps the clusters on a supported Kubernetes version?** About a third of the cost is the second cluster, which exists only to test a second region.
2. **Does one RDS create make the deploy longer than 15 minutes every time?** If the local run shows it doesn't, the fixture app adds a second database that is created after the first.
3. **Does the final snapshot get the instance's tags?** The recipe sets `CopyTagsToSnapshot`, but one review saw a snapshot without tags. The local run answers this. The sweep doesn't depend on it, because it matches snapshots by name and VPC.
4. **Which resource fails in Kubernetes, before any AWS call, every time?** The local run picks it, and the failing variant is pinned once it's chosen.

## Alternatives considered

- **A new AWS account only for these tests.** Cleaner isolation, but someone with organization rights has to create it. Separate regions and a permissions boundary give enough separation in the shared account.
- **Running in `us-west-2` with Radius's tests.** Rejected: the two would share regional quotas and the purge job's region.
- **A cluster per run.** About $25 a month instead of $165 for the main cluster. Rejected: it adds 30 to 40 minutes a run, needs rights to create clusters, VPCs, and IAM roles, and a leaked cluster costs $73 a month until someone finds it.
- **Reusing the Azure fixture repository with a second baseline.** Rejected: AWS would wait for Azure, a broken fixture or lease would stop both, and cleanup would have to tell the two clouds' environments apart.
- **Letting the product create the deploy identity in CI.** Rejected for the shared account: the CI role could then create a role with any permissions. Pre-creating it with a permissions boundary caps it.
- **Trusting a protected GitHub environment so branches can run the AWS job before merge.** Rejected: it adds a permanent second way to get the CI credential. Local runs cover the journey before merge.
