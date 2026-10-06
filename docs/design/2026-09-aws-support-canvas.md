# Functional Spec : AWS support for the Radius Canvas extension

- **Author**: Reshma Abdul Rahim (@reshrahim)
- **Date**: 2026-09

## Overview

The Radius Canvas extension gives a developer a guided path from source code to a running application: connect a cloud account, create an environment, model the application, deploy through GitHub Actions, inspect the application graph, and tear it down. That path exists today for Azure and AKS.

This spec defines the same capability for **AWS and Amazon EKS**. A developer on AWS completes the same journey through the same screens, in AWS-native terms: an account and region instead of a subscription, an IAM role instead of an Entra app registration, an EKS cluster with a VPC and subnets instead of a resource group and AKS cluster, and AWS managed services instead of Azure ones.

Three principles shape it.

**Passwordless by default.** No AWS credential is stored in the repository or in the extension. Discovery and verification run against the developer's own `aws` CLI session. Deployments authenticate through GitHub OIDC and short-lived role assumption. This is the trust model Azure already uses.

**Recipe-driven provisioning.** AWS resources are provisioned by Radius recipes, delivered as an AWS recipe pack committed to `radius-project/resource-types-contrib` alongside the Azure and Kubernetes packs already there. Authored using an alternative to Terraform due to licensing requirements.

**Parity with Azure.** Every capability the canvas offers an Azure developer has an AWS equivalent in AWS-native terms, or a recorded reason it does not. Each journey step below closes with a table setting what an Azure developer gets today against what the AWS experience requires.

## Terms and definitions

| Term | Definition |
| --- | --- |
| Access entry | The EKS object that grants an IAM principal access to a cluster. Radius creates one for the deploy identity. |
| Authentication mode | How an EKS cluster decides who may call it. `API` and `API_AND_CONFIG_MAP` accept access entries; the older `CONFIG_MAP` mode, configured through the `aws-auth` ConfigMap, does not. |
| Deploy identity | The identity GitHub Actions uses when deploying. On Azure an Entra app registration the workflow signs in as, holding Contributor on one resource group. On AWS an IAM role the workflow assumes, which cannot leave its account. |
| GitHub identity provider | The account-level object that lets AWS accept GitHub's OIDC tokens. One serves every repository in the account. |
| Recipe pack | The mapping from each Radius resource type to the recipe that provisions it. It decides whether a dependency becomes an AWS managed service or a workload on the cluster. The built-in packs are committed to `radius-project/resource-types-contrib`; a type no built-in pack covers gets a generated custom recipe, published to the repository's own GHCR registry instead. |
| Subject | The repository-and-environment string carried in a GitHub OIDC token, `repo:<owner>/<repo>:environment:<env>` by default. A deploy identity's trust policy lists the subjects it accepts. |
| Target cluster | The cluster the developer's applications run on. |
| Tier 1 catalog | The ranked set of backing services the built-in recipe pack covers on both clouds. |
| Trust policy | The document on an IAM role naming who may assume it. Radius lists the GitHub identity provider and the accepted subjects. |

## Objectives

> **Issue Reference:** [#83 — Feature: Add support for deployment of resources to AWS](https://github.com/radius-project/ai-extensions/issues/83)

### Goals

1. **A developer reaches a first deployment without opening the AWS console.** No hand-authored IAM, whether the canvas creates the deploy identity or the developer selects one their platform team already owns.
2. **What the canvas shows is what exists in AWS.** Planned and deployed graphs carry real AWS resource types, and resource nodes link to the AWS console.
3. **A developer can take it all back down.** Environments and deployments delete from the canvas, removing what Radius created and leaving alone what it did not.
4. **An application is not limited to a fixed catalog.** A dependency outside the built-in pack still deploys, through a type and recipe generated into the developer's repository.
5. **An Azure developer loses nothing.** Azure behavior, copy, and workflows are unchanged.

### Non-goals

None of the following is needed for Azure parity, so none is in scope.

- **Wiring an application to a backing service through a workload identity** rather than a returned credential. Radius supported this on `Applications.Core/containers`; the new types do not, on either cloud, so there is no Azure behavior to match.
- **Long-lived AWS access keys as a deploy credential.** Deployment authenticates over OIDC on both clouds, and a stored key would regress that.
- **Adding services beyond the Tier 1 catalog to the built-in pack.**
- **Compute outside Kubernetes**, including ECS and ECS on Fargate.
- **EKS Auto Mode.** A cluster in Auto Mode runs the same Kubernetes API, so discovery lists it and a developer can select it. Radius has not been tested against Auto Mode, so the core types are not guaranteed to work there.
- **Creating or reconfiguring infrastructure.** The canvas discovers EKS clusters, VPCs, and subnets; it does not create them or change how an existing cluster is configured. Azure does not create AKS clusters either.
- **Editing a saved credential profile.** Profiles are create-and-delete on Azure too.

### User scenarios

**Scenario 1 — Self-service onboarding.** Priya's team runs on EKS and she holds IAM permissions in a development account. From a repository with a Dockerfile she creates a credential profile from her CLI session, runs the environment wizard, and deploys. Radius creates the deploy identity and the cluster access it needs. She never opens the AWS console.

**Scenario 2 — Platform-governed identity.** Sam works where only the platform team creates IAM roles. He picks an existing role instead of letting Radius create one, and the canvas shows the repository trust, permissions, and cluster access it will add before he confirms. The role stays with its owners.

**Scenario 3 — Decommissioning.** Priya deletes her deployment, then her environment. The confirmation names what leaves her AWS account and what stays. The role is left in place either way — it serves every environment in the repository — and Priya is told to remove it in the console if nothing needs it.

### Dependencies

Error handling covers what the developer is told when one of these is missing.

| Dependency | Why it is needed |
| --- | --- |
| AWS CLI 2.15.3 or later, with a live session | Discovery, verification, and identity setup all run through it |
| A target EKS cluster the canvas may grant access to | Required to set up an environment on that cluster |
| A GitHub identity provider in the AWS account | Required for passwordless role assumption; one serves every repository in the account, so Radius creates it only if the account has none, and never removes it |
| An AWS recipe pack in `resource-types-contrib` | Provides the Tier 1 and Kubernetes catalog. `recipe-packs/` holds `azure-aks`, `azure-aci`, and `kubernetes` today; AWS needs its own. The deploy workflow applies it, so only deployment depends on it and environment creation is unaffected |

## User experience

A developer arrives with source code in a repository and no environment. What follows is every screen between that and a running application on AWS, in the order they meet them.

1. **Model the application** — turn what is in the repository into an application definition.
2. **Connect an AWS account** — create and verify a credential profile.
3. **Create an environment** — name it, pick the cluster and network, name the deploy identity, and watch setup run.
4. **Review the application graph** — what the recipes will create, and what they did.
5. **Deploy** — through GitHub Actions, over OIDC.
6. **Delete** — the deployment, then the environment, with cleanup stated before it happens.

The AWS experience follows the canvas's existing information architecture. The top-level navigation remains **Applications**, **Environments**, and **Deployments**. Provider-specific behavior appears only where the underlying cloud concepts genuinely differ.

### Step 1 · Model the application

The developer starts with a repository and no environment. The canvas reads it and produces the model: the containers to run and the services they depend on.

Nothing here is AWS-specific. A dependency resolves to a **Radius resource type**, such as `Radius.Data/mySqlDatabases` rather than Amazon RDS. The environment decides later which cloud service sits behind that type. Everything generated lands in the repository beside the application definition and is reviewed in the same pull request.

| Dependency found in the application | What the developer gets |
| --- | --- |
| Core primitive: container, container image, route, volume, secret | Standard core Radius type deployed to K8s |
| Tier 1 backing service | Standard Radius type, resolved at deploy to the cloud service in the catalog |
| A service AWS can provision | Generated custom type whose recipe provisions the managed AWS service |
| Anything else | Named during modeling in Copilot Chat, with nothing generated for it |

Generation is automatic rather than a path the developer chooses, and the type carries only the properties the application uses.

**Parity with Azure**

| Capability | Azure today | What AWS requires |
| --- | --- | --- |
| Dependency outside the built-in catalog | Generates a custom type, with an Azure Verified Module where one matches | The same, with a recipe declaring the AWS resource types directly, there being no verified-module equivalent |

### Step 2 · Connect an AWS account

A credential profile records the AWS account and region an environment deploys into, and confirms the developer can sign in to it.

Cloud accounts are managed on the **Credentials** sub-tab, and the same form opens from step 1 of the New Environment wizard.

![The Create Credential Profile form in step 1 of the New Environment wizard, with Provider set to AWS, GitHub Packages access verified, Account ID and Region filled in, and a green "Credentials verified" pill.](2026-09-aws-support-canvas/credential-profile-aws.png)

A profile says where resources live, not who may create them. It carries no deploy identity; who may deploy is settled when an environment is created.

**Verify Credentials** confirms an active CLI session and names the principal it found, as `✓ Credentials verified` with `Logged in as <user>`. If that session belongs to a different account than the one typed, verification fails and Save stays blocked, naming both the account the session is in and the one typed. With no session, the canvas offers `Sign in to AWS CLI`, which runs `aws sso login` on confirmation and notes that a machine using static credentials should run `aws configure` instead.

Saving unlocks once both the cloud session and GitHub Packages access are verified. Packages access is checked because Radius keeps each repository's environment state in a private package there, and publishes generated custom recipes to the same registry.

**Parity with Azure**

| Capability | Azure today | What AWS requires |
| --- | --- | --- |
| What the profile scopes to | Tenant and subscription | Account and region |
| Signing in from the canvas | Azure CLI login remediation | `Sign in to AWS CLI`, which runs `aws sso login` |
| Wrong account detected | Rejects a tenant mismatch, blocking Save | Rejects an account mismatch the same way, naming both accounts |

### Step 3 · Create an environment

An environment is the deployment target: the cluster the application runs on, the network its services sit in, and the identity allowed to create them. Creating one is a two-step wizard. Wizard step 1, `Cloud credentials`, is provider-neutral. The developer selects a verified profile from the **Credential profile** menu, or creates one inline.

Wizard step 2, `Environment`, has four sections:

1. **`Name this environment`** — names the environment. Identical across clouds.
2. **`Connect GitHub to a cloud`** — states the trust model rather than offering a choice: GitHub and the cloud credentials are the two ends of one trust, not alternatives. Identical across clouds.
3. **`Deploy identity`** — Radius proposes the role GitHub Actions will assume, or the developer picks one that already exists, and agrees to what it can do. AWS-specific.
4. **`Infrastructure`** — the cluster the application runs on and the network its services reach. AWS-specific.

![Step 2 of the environment wizard for an AWS credential profile, showing all four sections: the environment name, the GitHub-to-cloud trust, the IAM role prefilled with the proposed name and a `use an existing role…` link, and the discovered AWS infrastructure with two private subnets selected across separate availability zones.](2026-09-aws-support-canvas/wizard-step-2-environment-aws.png)

> **Note:** The screenshot covers the basic scenario. Advanced scenarios are not drawn here; we will work through them together during implementation.

Section 3 has a single field, **IAM role**. Radius proposes the name `radius-deploy-<owner>-<repo>` (truncated to the 64-character IAM role name limit) and creates the role. The developer can rename it, or pick a role a platform team already owns. The picker mirrors Azure's `use an existing application…` dialog, with AWS roles in place of App Registrations. Picking a role fills the name field and disables it.

The help text under the field states what the role will get — `PowerUserAccess` limited to the profile's region, `cluster-admin` on the target cluster, and a trust limited to this repository — and that a failed setup removes what it created. [What happens when you click Create Environment](#what-happens-when-you-click-create-environment) covers the model.

Section 4 reports what discovery found and offers a refresh. The selectors populate from the profile's account and region, and the namespace accepts a typed value instead. All four are required. Setup records the namespace on the GitHub environment rather than creating it on the cluster; a typed value is accepted whether or not it exists yet, and is resolved at deploy time. Azure behaves the same way.

VPC and Subnets have no Azure counterpart, because AWS managed data and messaging services are VPC-bound where the Azure equivalents take no network input.

- **VPC and Subnets are filled in from the cluster.** The cluster's VPC is selected, and its private subnets are checked — the selection that works for workloads reaching a managed service. Public subnets appear in the list but are left unchecked.
- **Another VPC can be chosen**, and the form warns that reaching it needs peering or a transit gateway, which Radius does not create.
- **Subnets are limited to the selected VPC**, and the list states each subnet's availability zone.
- **Each subnet is labelled public or private**, derived from whether its route table reaches an internet gateway. A public subnet can still be selected, and selecting one warns that anything provisioned there is reachable from the internet.
- **A selection must span at least two availability zones.** A single-zone selection is a field error on Subnets and keeps **Create Environment** disabled until a second zone is added. When the cluster's private subnets do not span two zones, the form says so and leaves the selection empty rather than guessing.

#### What happens when you click Create Environment

**Create Environment** is the only action the developer takes. Everything else follows from it, and the canvas reports progress as it goes. There is no further prompt and no step completed by hand.

Progress runs through the same three stages Azure reports.

- **`Authorize deploy identity`** prepares the AWS side, naming each check as it passes.
  - The AWS CLI version is detected and confirmed against the 2.15.3 minimum.
  - The account's GitHub identity provider is checked, and created if the account has none.
  - The subject the role will trust is stated, as `Deploy identity will trust <subject>`. The subject is the same GitHub OIDC claim Azure's federated credential carries — `repo:<owner>/<repo>:environment:<env>` by default, and the immutable or customized form where the repository uses one — so the two clouds trust the identical string.
  - The role is created, or an existing one reused.
  - A deploy permission policy named `radius-deploy-<env>` is attached, carrying that environment's region. The role it attaches to already names the repository, so the policy name carries only the environment.
  - The cluster is checked, and the role granted access to it.
- **`Configure environment`** records the environment on GitHub and commits the deploy workflow.
- **`Verify credentials`** exercises the trust once, so the developer sees GitHub assume the role before a deploy depends on it.

**What the developer ends up with** is a role granted `PowerUserAccess`, bounded to the regions of the environments that use it, and `cluster-admin` on the target cluster. It cannot make itself or anyone else an administrator. One role serves the repository in that account, carrying a trust subject and a permission policy per environment, so adding an environment cannot narrow another and tearing one down cannot break another.

**Other setup outcomes.**

- **The repository already has a role in this account.** A second environment joins it rather than creating another, reported as `Reusing the Radius-managed IAM role radius-deploy-contoso-storefront`. Its subject is added to what the role already trusts, not substituted for it, reported as `Keeping 1 subject(s) already trusted by this role`.
- **A role of that name exists, but Radius did not create it.** Radius does not modify it. Setup stops, and the developer either renames the new role or picks that role deliberately, which is the case below.
- **The developer picked an existing role.** Radius adds this repository's trust, the environment's permissions, and cluster access to it, provided the signed-in identity may modify it.
- **The namespace is already claimed.** A namespace backs one environment, so one in use by another is rejected before anything is created.
- **Two environment names collide.** Where two environments would produce the same policy name or the same trust subject, setup stops and names both rather than overwriting, as Azure does when two environment names normalize to the same federated credential name.
- **A step cannot complete.** Setup stops there and reports a `Setup didn't finish` card showing what it created, what it left alone, and what someone else must do, with an offer to roll back what this attempt added.

**Parity with Azure**

| Capability | Azure today | What AWS requires |
| --- | --- | --- |
| What the wizard discovers for you | Resource groups, AKS clusters, namespaces | EKS clusters, namespaces, VPCs, subnets |
| What is created or changed in the cloud | App registration when needed, federated credential, and scoped role assignments | GitHub identity provider when the account has none, IAM role when needed, repository trust, regional permissions, and EKS cluster access |
| How many identities a repository gets | One per repository, spanning every subscription in the tenant | One per repository **per account**; an IAM role cannot span accounts, so an account per environment means a role per environment |
| Adding an environment | Adds a federated credential to the same app, and cannot disturb the others | Adds the environment's own permission policy and cluster access to the same shared role, and merges its subject into the role's single trust policy |

### Step 4 · Review the application graph

Before deploying, a developer wants to know what will be created in their AWS account. The `Planned` view answers that for a chosen application, branch, and environment.
The same Radius type resolves differently per environment. `Radius.Data/mySqlDatabases` is `Microsoft.DBforMySQL/flexibleServers` on an Azure environment and `AWS.RDS/DBInstance` on an AWS one. The card shows the recipe pack's name for the service, `Amazon RDS for MySQL`, and keeps the concrete type in the tooltip and the details panel. The pack names every resource it maps, Kubernetes objects included, so a credentials secret reads `Secret` rather than `core/Secret`. A resource the pack does not name keeps its own Radius type on the card, shortened — a generated custom type reads `Resources/<type>`, with no concrete type in the tooltip or details panel, exactly as it does on Azure today. Where the gap is a pack entry added before its mapping, the progress log names the types it could not resolve rather than leaving it silent. A container runs on the managed cluster, so its card names the cluster: `Amazon EKS` on AWS, as `Azure Kubernetes Service` does on Azure today.
Resolution is per recipe rather than by a single rule, and each recipe resolves to the one resource the application connects to: a database to Amazon RDS, a cache to ElastiCache, a stream to MSK. A recipe with no AWS service behind it resolves to the in-cluster resource it deploys instead, as RabbitMQ does on Azure today. The supporting resources a recipe also creates, such as an RDS subnet group or security group, are not modeled and appear neither as sibling nodes nor in the node's details.

![The Planned application graph for an AWS environment. The application node todo-list-app is labelled Amazon EKS, and connects to a mysql node labelled Amazon RDS for MySQL and a mysql-client-credentials node labelled Secret. Planned nodes are drawn with a dashed border, and each offers View source code.](2026-09-aws-support-canvas/graph-planned-aws.png)

Planned nodes are drawn with a dashed border and each offers `View source code`. `The planned deployment is current.` confirms the graph reflects the branch as it stands.

**Parity with Azure**

The renderer and the icon set are provider-neutral, and the icons already cover names such as `rds`, `ecr`, and `sqs`. Friendly service names on cards already ship for Azure and Kubernetes. The AWS work is the recipe-to-service mapping that supplies those names for AWS.

### Step 5 · Deploy

Deploying is the same act on either cloud. The developer deploys from the application view and sees `Deploying <app> to environment <env>` with `Track progress in the deployments list below.` Each row in that list offers `Monitor Graph`, `View Run`, and `Delete Deployment`.

On success the log closes with the completion message and `Click on deployed resources to view them in the AWS Console.`

Once a deployment finishes, the `Deployed` view shows the application as it now runs. Before a first deployment it falls back to the modeled topology under a notice saying so, rather than showing an empty panel.

The types in the fallback come from the recipe pack rather than from the account, so a database is typed `AWS.RDS/DBInstance` before any database exists. Under the notice a node shows what the recipe will create; without it, what exists in the account. A node in the fallback carries no console link.

![The Deployed application graph for the AWS environment Aws-test-env before a first deployment, reporting "Not deployed yet — showing the modeled application." above the same modeled topology.](2026-09-aws-support-canvas/graph-deployed-aws.png)

Deployed AWS resources link to the console from both the node and the details drawer. The drawer link reads `View in AWS console` and a node's accessible label reads `Open <resource> in AWS console`, mirroring the Azure portal links available today. A recognized type links to that service's console list for the environment's region. A type the canvas does not recognize carries no link.

Failures caused by identity or cluster access name their specific cause rather than reporting a generic workflow failure. The cases and what each one says are in [Error handling](#error-handling).

**Parity with Azure**

Watching a run, the deployments list, and the delete controls are provider-neutral and unchanged.

| Capability | Azure today | What AWS requires |
| --- | --- | --- |
| The closing message | `🎉 Deployment complete! Application deployed to Azure.` | `🎉 Deployment complete! Application deployed to AWS.` |
| When identity has drifted | Names the federated credential or role assignment | Names the trust policy or permissions |

#### What each dependency deploys to

The recipe pack decides which AWS service stands behind each Radius type.

Ten backing services are in the first release, ranked by how often developers need them, from the ranked catalog proposed in [radius-project/radius#13122](https://github.com/radius-project/radius/pull/13122). They are where the pack starts, not the limit of what an application can use.

| Rank | Developer dependency | Radius resource type | Azure outcome | AWS outcome |
| --- | --- | --- | --- | --- |
| 1 | PostgreSQL | `Radius.Data/postgreSqlDatabases` | PostgreSQL Flexible Server | Amazon RDS PostgreSQL |
| 2 | Redis | `Radius.Data/redisCaches` | Azure Managed Redis | Amazon ElastiCache |
| 3 | Object storage | `Radius.Storage/objectStorage` | Storage Account | Amazon S3 |
| 4 | LLM inference API | `Radius.AI/models` | Azure OpenAI | Amazon Bedrock |
| 5 | MongoDB | `Radius.Data/mongoDatabases` | Cosmos DB, Mongo API | Amazon DocumentDB |
| 6 | MySQL | `Radius.Data/mySqlDatabases` | MySQL Flexible Server | Amazon RDS MySQL |
| 7 | Kafka | `Radius.Messaging/kafka` | Event Hubs, Kafka-compatible | Amazon MSK |
| 8 | Search | `Radius.AI/search` | Azure AI Search | Amazon OpenSearch |
| 9 | RabbitMQ | `Radius.Messaging/rabbitMQ` | Kubernetes recipe | Amazon MQ |
| 10 | SQL Server | `Radius.Data/sqlServerDatabases` | Azure SQL Database | Amazon RDS SQL Server |

The core primitives are `Radius.Compute/containers`, `containerImages`, `routes`, `persistentVolumes`, and `Radius.Security/secrets`. These resolve through the same Kubernetes recipes on both clouds, so an application using only these types moves between AKS and EKS unchanged, subject to what each cluster provides: a route needs an ingress controller, and a volume needs a storage class.

### Step 6 · Delete

A developer tearing down work needs to know what leaves their AWS account and what stays. Deleting a deployment uses the existing three-step confirmation — intent, acknowledged effects, and typing `<app>/<environment>` to confirm — preceded by a list of resources to be deleted. It is provider-neutral and unchanged. Where resources are left in a non-terminal state, force delete remains available with its existing warning about orphaned external resources.

Deleting an environment states the AWS consequences first. It names the cluster the environment is removed from, the trust subject and policy removed from the role, and the role that is left in place. If applications remain, deletion is blocked and names the applications to delete first.

What the environment added to the role is removed: its subject leaves the trust policy and its `radius-deploy-<env>` policy is detached and deleted. The role itself is never deleted, whether Radius created it or Sam picked it — it is shared by every environment in the repository, so an environment teardown leaves it alone, names it, and says to remove it in the console if it is no longer needed. This matches Azure, which leaves the app registration in place for the same reason. The account's GitHub identity provider is always retained.

**Parity with Azure**

| Capability | Azure today | What AWS requires |
| --- | --- | --- |
| What happens to the deploy identity | Deletes the environment's federated credential; leaves the app registration and says to remove it manually | Removes the environment's trust subject and its policy; leaves the role and says to remove it manually |
| What you are told afterwards | Names the federated credential removed | Names what was removed and what was kept |

## Error handling

These rules hold wherever a step fails.

- **Nothing is created until every check that can fail for free has passed.**
- **What Radius cannot prove it owns, it does not touch.** It names the object and says what it could not establish.
- **A refusal hands back what it was about to do.** Where a policy would have been written, the policy is returned; where a command resolves the problem, the command is given.

Several of these are not the developer's to fix. Where a permission they do not hold is required, the message names the command and is written to be handed to whoever does. The conditions below follow the order of the journey.

| Condition | What the developer is told |
| --- | --- |
| A dependency neither AWS nor the cluster can provide | Named during modeling, with nothing generated for it, and reported as permanent rather than offered a retry |
| No AWS CLI session | Named, with the commands to sign in, alongside a `Sign in to AWS CLI` remediation that runs `aws sso login` for them |
| Account ID or region is not a valid value | Named at the field, before verification runs |
| A credential profile is deleted while environments use it | The confirmation names those environments and says each keeps working because it holds its own copy of the credential values, then the delete proceeds, as Azure does today. Deleting a profile never touches anything in AWS |
| AWS CLI too old, or cannot be run | The installed version, the version required, and why — granting cluster access needs EKS access entries — with the upgrade link. Where the CLI cannot be run at all, its own output is shown |
| The account has no GitHub identity provider, and the signed-in identity cannot create one | Names the account and hands over the `aws iam create-open-id-connect-provider` command for an IAM administrator to run |
| The cluster grants access through `aws-auth` | Setup stops at the cluster check, naming the cluster's authentication mode, explaining that Radius grants access through an access entry which that mode does not support, and giving the `aws eks update-cluster-config` command that enables one |
| A role of the expected name is not Radius-managed | Names the matching role, says that no change was made, and offers the two valid paths: select that role explicitly, or choose a different name |
| Role creation denied by IAM | Said plainly, with a choice to return and select an existing role, or hand the denied action to an IAM administrator |
| A selected role cannot be updated | Names the trust, permission, or cluster-access change that was denied, and leaves the role as it was before setup began |
| The role has reached an AWS quota, such as the limit on attached policies | AWS's own error is reported as it was given, naming the role and the quota reached, and the role is left as it was |
| Discovery is denied, or returns nothing | Each list says whether it is empty because the account holds none or because the signed-in identity cannot read them; the namespace accepts a typed value meanwhile |
| The GitHub environment or workflow cannot be written | Named as the stage that failed, separately from anything created in AWS |
| Verification: AWS refuses the GitHub token over its claims | `GitHub Actions isn’t trusted to sign in to AWS.` The environment cannot be created until the trust is fixed, so no bypass is offered |
| Verification: the role is trusted but lacks a permission | `Signed in to AWS, but the identity is missing required permissions.` The actions AWS named are listed, such as `eks:DescribeCluster`, and the environment can be created now and the access fixed before deploying |
| Verification: the cluster cannot be reached | `Radius couldn’t reach the Kubernetes cluster.` The environment can be created now and deployed once the cluster is reachable |
| Verification: AWS cannot be reached | `Radius couldn’t reach AWS.` Reported as usually transient, with the same create-now option |
| Verification fails for any other reason | `Credential verification failed.` with the run's own error, and no bypass, so an unrecognized failure is surfaced rather than treated as one of the cases above |
| Deploy: AWS refuses the role before any resource is touched | `Cloud authentication or authorization failed before any resource was deployed.` It names drift as the likely cause — the role's trust policy or permissions changed since setup — and asks for re-verification before a redeploy. A failure after a resource is touched is never reported this way |
| A recipe fails part way through | Names the resource and leaves what was provisioned visible in the graph |
| A deploy fails for any other reason | The failed workflow step is named, the Radius error is quoted, and the run is linked. Where the run's details cannot be read, that is said rather than guessed at |
| Cleanup partly fails | What was removed and what remains are listed separately, with the remainder offered for retry |
| The role is already gone at delete | Reported as already absent, and deletion continues |

## Appendix

### Needs engineering investigation

| Area | Question |
| --- | --- |
| AWS recipe coverage | Investigate an alternative to Terraform for building the AWS recipe pack, and whether it covers all ten backing services |
| Application credentials | Whether every recipe can return an access key as a secret, or whether workload identity is needed for an application to reach its AWS resource. |
| Deploy identity breadth | Azure scopes the deploy identity's permissions to a resource group. The `PowerUserAccess` policy in AWS, bounded by region, is account-wide within that region. Whether the role can be narrowed by tag, by permissions boundary, or by a scoped policy. |
| Environments past the per-identity quota | A role holds 20 attached policies by default, 25 at most. Azure has the same shape of limit — an app registration caps federated identity credentials at 20 — so a repository with more environments than that hits a ceiling on either cloud. Today the quota error is relayed as AWS gave it. Whether to collapse to one policy, split across roles, or raise the quota is a question for both clouds, not AWS alone. |
| Concurrent setup | Two environments created at once in one account both merge a subject into the role's single trust policy, which is the one object that cannot be made additive. |
| Console link mapping | Azure appends a resource ID to one portal template and lands on that resource's overview, so no per-type table exists. AWS console URLs differ by service, so every type needs its own mapping to a console list and region, and that table has to be written and kept current. |
