# Functional Spec : AWS support for the Radius Canvas extension

- **Author**: Reshma Abdul Rahim (@reshrahim)
- **Date**: 2026-09
- **Status**: Draft

## Overview

The Radius Canvas extension gives a developer a guided path from source code to a running application: connect a cloud account, create an environment, model the application, deploy through GitHub Actions, inspect the application graph, and tear it down. That path exists today for Azure and AKS.

This spec defines the same capability for **AWS and Amazon EKS**. A developer whose platform runs on AWS completes the same journey, through the same screens, in AWS-native terms: an account and region instead of a subscription, an IAM role instead of an Entra app registration, an EKS cluster with a VPC and subnets instead of a resource group and AKS cluster, and AWS managed services instead of Azure ones.

Everything on the AWS side is a proposal. Where this document describes Azure it describes what ships today; where it describes AWS it states what the product will do.

Three principles shape it.

**Passwordless by default.** No AWS credential is stored in the repository or in the extension. Discovery and verification run against the developer's own `aws` CLI session. Deployments authenticate through GitHub OIDC and short-lived role assumption. This is the trust model Azure already uses.

**Recipe-driven provisioning.** AWS resources are provisioned by Radius recipes, delivered as a published AWS recipe pack. Recipes are written in Bicep — the language the Azure pack already uses, and a licensing requirement. Where an application depends on a service the pack does not cover, modeling generates a resource type and recipe into the developer's own repository, reviewed alongside the application.

**The canvas tells the truth.** What the interface shows — the types in a planned graph, the console links on a deployed node, the consequences listed in a delete confirmation — matches what happens in the developer's AWS account.

## Terms and definitions

| Term            | Definition                                                                                                                                                                                |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Deploy identity | The identity GitHub Actions assumes when deploying. On Azure an Entra app registration, which spans every subscription in its tenant; on AWS an IAM role, which cannot leave its account. |
| Recipe pack     | The mapping from each Radius resource type to the recipe that provisions it. It decides whether a dependency becomes an AWS managed service or a workload on the cluster.                 |
| Target cluster  | The cluster the developer's applications run on.                                                                                                                                          |
| Tier 1 catalog  | The ranked set of backing services the built-in recipe pack covers on both clouds.                                                                                                        |

## Objectives

> **Issue Reference:** [#83 — Feature: Add support for deployment of resources to AWS](https://github.com/radius-project/ai-extensions/issues/83)

### Goals

1. **A developer reaches a first deployment without opening the AWS console.** No hand-authored IAM, whether the canvas creates the deploy role or the developer selects one their platform team already owns.
2. **What the canvas shows is what exists in AWS.** Planned and deployed graphs carry real AWS resource types, and resource nodes link to the AWS console.
3. **A developer can take it all back down.** Environments and deployments delete from the canvas, removing what Radius created and leaving alone what it did not.
4. **An application is not limited to a fixed catalog.** A dependency outside the built-in pack still deploys, through a type and recipe generated into the developer's repository.
5. **An Azure developer loses nothing.** Azure behavior, copy, and workflows are unchanged.

Parity with Azure is the organizing principle behind all five. Every capability the canvas offers an Azure developer has an AWS equivalent in AWS-native terms, or a recorded reason it does not — collected in [Deliberate non-parity](#deliberate-non-parity). Each journey step below closes with a table setting what an Azure developer gets today against what the AWS experience requires.

**Definition of done.** When this ships, a developer can:

- Create an AWS environment from the canvas — with a role Radius creates, or one their platform team owns — without opening the AWS console.
- Deploy an application whose dependencies resolve to AWS managed services, see those services' real types in the graph, and follow a link to each one in the console.
- Deploy a dependency outside the built-in catalog, through a type and recipe generated into their repository.
- Delete the deployment and then the environment, and find that nothing Radius created remains and nothing they brought themselves was touched.

### Non-goals

None of the following is needed for Azure parity, so none is in scope.

- **Wiring an application to a backing service through a workload identity** rather than a returned credential. Radius supported this on `Applications.Core/containers`; the new types do not, on either cloud, so there is no Azure behavior to match. Bringing it back reaches into the container recipe and needs its own design covering both clouds.
- **Long-lived AWS access keys as a deploy credential.** Deployment authenticates over OIDC on both clouds, and a stored key would regress that. An application's own credential is a separate matter: Azure hands each app a key its recipe returned, and AWS does the same.
- **Adding services beyond the Tier 1 catalog to the built-in pack.** Dependencies outside it remain deployable through generated custom types.
- **Compute outside EKS**, such as ECS or Fargate. Radius runs containers on Kubernetes and Azure Container Instances, so there is no execution model to target. EKS Auto Mode is out too.
- **Creating or reconfiguring infrastructure.** The canvas discovers clusters and networks; it does not create EKS clusters, VPCs, or subnets, and does not change how an existing cluster is configured. Azure does not create AKS clusters either.
- **Editing a saved credential profile.** Profiles are create-and-delete on Azure too. Region is the field most likely to justify changing that, and it changes for both clouds at once or not at all.

### User scenarios

**Scenario 1 — Self-service onboarding.** Priya is a developer whose team runs on EKS and who holds IAM permissions in a development account. She opens the canvas in a repository containing a Dockerfile, creates an AWS credential profile from her existing CLI session, and runs the environment wizard. The canvas discovers her clusters, VPCs, and subnets, shows her exactly what it will create in her account, creates the deploy role and cluster access, and deploys her application. She never opens the AWS console.

**Scenario 2 — Decommissioning.** Priya deletes her deployment, then her environment. The confirmation states what will be removed from AWS and what will be retained. A role Radius created is deleted once no other environment uses it. A role she selected from her account remains, and only the trust, permissions, and cluster access Radius added for this environment are removed.

**Scenario 3 — Platform-governed identity.** Sam works where only the platform team creates IAM roles. In the deploy identity section he picks an existing role from the credential profile's account. Before he confirms, the canvas shows the repository trust, AWS permissions, and cluster access it will add. The role stays with its owners: deleting the environment removes only what Radius added, and never the role.

### Dependencies

| Dependency                                          | Why it is needed                                                                      | What the developer sees if it is missing                                                                                   |
|-----------------------------------------------------|---------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| AWS CLI 2.15.3 or later, with a live session        | Discovery, verification, and identity setup all run through it                        | Checked before anything is created in AWS. The message names the installed version, the required one, and the upgrade link |
| A target EKS cluster the canvas may grant access to | Required to set up an environment on that cluster                                     | The cluster is listed as unusable at the point of selection, with the reason and the command its owner runs                |
| A GitHub identity provider in the AWS account       | Required for passwordless role assumption; one serves every repository in the account | Environment creation creates it. Only where the developer may not, setup stops and hands over the command                  |
| A published AWS recipe pack                         | Provides the Tier 1 and Kubernetes catalog, applied by the deploy workflow            | Deployment is unavailable. Environment creation is unaffected, since the pack is applied at deploy                         |

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

The developer starts with a repository and no environment. The canvas reads it and produces the model — the containers to run and the services they depend on.

Nothing here is AWS-specific. A dependency resolves to a **Radius resource type** — `Radius.Data/mySqlDatabases`, not Amazon RDS. Which cloud service ends up behind that type is decided later, by the environment. Everything generated lands in the repository beside the application definition and is reviewed in the same pull request.

| Dependency found in the application                     | What the developer gets                                                            |
|---------------------------------------------------------|------------------------------------------------------------------------------------|
| Shared Kubernetes type                                  | The shared Radius type, deployed through the same Kubernetes recipe on both clouds |
| Tier 1 backing service                                  | The standard Radius type, resolved at deploy to the cloud service in the catalog   |
| A service AWS can provision                             | A generated custom type whose recipe provisions the managed AWS service            |
| A service AWS cannot provision, but the cluster can run | A generated custom type whose recipe runs the service on the cluster               |
| Anything else                                           | Named during modeling, with nothing generated for it                               |

A dependency outside the catalog does not wait to be added to it. Modeling generates a custom type carrying only the properties the application uses, and the developer is never asked to choose this path — it follows from what is in their own source.

Where AWS has no service to provision, the cluster is the fallback, and the result is never dressed up as a managed one: the graph, the recipe, and the pull request all state that the service runs on the cluster, so backups, availability, storage, and upgrades visibly belong to the developer. Two cases produce nothing at all — a dependency needing durable storage the cluster cannot provide, and one neither cloud nor cluster can run. Both are named during modeling, and because a second run cannot change the answer the developer is told it is permanent rather than offered a retry. Modeling stops for that resource, not for the whole application.

**Parity with Azure**

| Capability                              | Azure today                                                                           | What AWS requires                                                                                            |
|-----------------------------------------|---------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Dependency outside the built-in catalog | Generates a custom type, with an Azure Verified Module where one matches              | The same, with a recipe declaring the AWS resource types directly, there being no verified-module equivalent |
| Service the cloud cannot provision      | RabbitMQ alone resolves to a Kubernetes recipe, as a catalog entry rather than a rule | A general rule covering any such service                                                                     |

### Step 2 · Connect an AWS account

An environment has to deploy into some AWS account, in some region, and Radius has to know the developer can sign in to it. That is what a credential profile records.

Cloud accounts are managed on the **Credentials** sub-tab, described as `Configure and manage the credentials needed to connect to your cloud account. Each environment requires credentials to deploy infrastructure.` Profiles are listed as `Profile Name | Provider | Status | Actions`, and each row offers **Create Env** and **Delete Profile**. An AWS profile shows the account's alias, as an Azure profile shows the subscription's name, so the list reads as names rather than digits. The same form is reachable from step 1 of the New Environment wizard, with identical fields.

Choosing **AWS** reveals a panel asking for two values — **Account ID** and **Region** — just as the Azure panel asks for a tenant and a subscription:

![The Create Credential Profile form in step 1 of the New Environment wizard, with Provider set to AWS, GitHub Packages access verified, Account ID and Region filled in, and a green "Credentials verified" pill.](2026-09-aws-support-canvas/credential-profile-aws.png)

A profile says where resources live, not who may create them. It carries no deploy identity, exactly as an Azure profile records a tenant and subscription but never a client ID. Who may deploy is settled when an environment is created, and one identity serves the whole repository.

**Verify Credentials** confirms the developer is signed in, showing `Verifying authentication to AWS…` while it runs and `✓ Credentials verified` with the signed-in principal on success — the same pill and wording Azure uses, because it is the same check. It proves only that a session exists; whether that session can reach a cluster and deploy is answered when an environment is created. The button stays unavailable until both fields are filled, and if the session belongs to a different account than the one typed, the developer is told immediately rather than discovering it later. With no session at all, the canvas offers `Sign in to AWS CLI`, which runs `aws sso login` on confirmation and notes that a machine using static credentials should run `aws configure` instead.

Saving unlocks only once both the cloud session and GitHub Packages access are verified; until then the form reads `Verify your credentials above to continue profile setup.`

**Parity with Azure**

| Capability                 | Azure today                 | What AWS requires                                                        |
|----------------------------|-----------------------------|--------------------------------------------------------------------------|
| What the profile scopes to | Tenant and subscription     | Account and region                                                       |
| How the list reads         | Subscription name           | Account alias                                                            |
| Signing in from the canvas | Azure CLI login remediation | `Sign in to AWS CLI`, which runs `aws sso login`                         |
| Wrong account detected     | Not applicable              | Reported on the form before the developer proceeds, naming both accounts |

### Step 3 · Create an environment

An environment is the deployment target: the cluster the application runs on, the network its services sit in, and the identity allowed to create them. Creating one is a two-step wizard. Wizard step 1, `Cloud credentials`, is provider-neutral — the developer selects a verified profile from the **Credential profile** menu, or creates one inline.

Wizard step 2, `Environment`, has four sections. The first two are identical across clouds; the last two are AWS-specific.

![Step 2 of the environment wizard for an AWS credential profile, showing all four sections: naming the environment, connecting GitHub to the cloud, the deploy identity with its IAM role field, and the discovered AWS infrastructure.](2026-09-aws-support-canvas/wizard-step-2-environment-aws.png)

Section 1 takes the environment name, under `The deployment target you'll deploy apps into by name.` Section 2, `Connect GitHub to a cloud`, is unchanged from Azure and states the model rather than offering a choice: `Radius wires a passwordless OIDC trust so GitHub Actions can deploy into this environment — no secrets stored in the repo. These are the two ends of that trust, not a choice between them: the cloud credentials are the profile you selected, shown here to confirm.`

#### Section 3 · Deploy identity

GitHub Actions needs an AWS identity it is allowed to assume. Section 3 is where the developer picks one and agrees to what it can do.

The screen is one labeled field, **IAM role**, under the lead-in `The IAM role GitHub Actions assumes to deploy — over OIDC, no stored secrets.` Help text below it fills in with the repository, environment, and region as they are typed:

`Created in your AWS account, trusted over OIDC by repo:<owner>/<repo> for the <environment> environment, and granted PowerUserAccess limited to resources in <region>. Setup also grants the role cluster-admin access on the target EKS cluster. One role serves every environment in this repository — a new environment is added to the role's trust policy rather than replacing it. If setup fails, Radius removes what it created.`

By default Radius creates the role and proposes the name `radius-deploy-<owner>-<repo>`. The developer can rename it, or pick a role a platform team already owns. The picker lists roles the signed-in identity can inspect, says which repositories each already trusts, and pins the choice by ARN rather than by its editable name. Either way the canvas shows every change before it makes one, and an existing role stays with its owner.

The role's grant is broad — a deploy provisions whatever the application declares, and a generated type can name any AWS service — but bounded: it cannot make itself or anyone else an administrator. Azure's identity is the same shape.

**One role serves the whole repository.** A second environment joins the role the repository already uses in that account rather than proposing a new name, so a repository never acquires a second role by accident. The role carries the sum of what its environments need — every repository subject, every region, every cluster — and each piece is added when an environment needs it and removed only when no environment still does. Tearing one environment down never breaks another, and the role itself goes only with the last environment on it.

This is the one piece of parity AWS cannot deliver. An Azure app registration belongs to a tenant and reaches every subscription in it, so one identity covers dev, staging, and production alike. An IAM role cannot leave its account. AWS's own guidance is an account per environment, which makes a role per environment the common shape — but environments sharing an account share a role. Everything Azure does *with* its identity carries over unchanged.

**What setup will not do.**

- *Overwrite a name the developer typed.* The field re-proposes only while it is empty or still holds the previous proposal, and the name carries the repository rather than the environment.
- *Write to a role because its name matches.* Radius reuses only a role it created for this repository; otherwise setup stops and hands back the trust policy for the owner to apply. Azure draws the same line.
- *Share an identity without being asked.* Selecting an existing role consents to adding this repository's trust, the environment's permissions, and cluster access. It disables the name field and is reversible until the environment is created. Azure's `use an existing application…` link works the same way and warns that `Sharing one identity across repositories means every wired repository can use its Azure permissions. Only do this for repos that belong to the same product.`
- *Leave a half-finished setup behind.* A change the signed-in identity cannot make ends setup with the action written out for the owner, and anything already created is removed.

#### Section 4 · Infrastructure

The environment needs somewhere to run and a network its services can reach. Section 4 reports what discovery found, as `Found 1 cluster(s), 16 VPC(s)`, and offers **↻ Refresh**. Cluster, namespace, VPC, and subnet selectors populate from the profile's account and region, and each accepts a typed value instead.

**EKS Cluster**, **Namespace**, **VPC**, and **Subnets** are all required, but only the first two start empty — VPC and Subnets arrive filled in from the selected cluster. The namespace field carries `A namespace backs one environment. Pick one that no other environment on this cluster uses.`

Not every cluster can be used. Some are configured so that only their owner can grant access to them. Such a cluster still appears in the list, marked unusable and stating why, with the command its owner runs to change it — so the developer meets this while choosing a cluster rather than after creating an environment.

VPC and Subnets have no Azure counterpart, because AWS managed data and messaging services are VPC-bound where the Azure equivalents are not — [deliberate non-parity](#deliberate-non-parity), not a gap. Four rules govern them.

- **Both arrive filled in from the cluster.** A managed service is reached by the workloads that use it, so the cluster's own VPC is the selection that works, and its private subnets are where a VPC-bound service belongs. Another VPC can be chosen, and the form says plainly that reaching it needs network routing the canvas does not create.
- **A selection must span at least two availability zones**, because that is what VPC-bound AWS services require. The list states each subnet's zone, and the form does not accept a selection resolving to a single zone.
- **Each subnet says whether it is public.** A database placed in a public subnet is a mistake a developer cannot see at selection time, so the form names it at the point of choosing.
- **A typed value is checked the same way a chosen one is.** Typing covers the case where discovery has not returned, not a way around the rules above: an identifier from another account, region, or VPC is rejected at the field.

#### What happens when you click Create Environment

**Create Environment** is the only action the developer takes. The deploy identity, the GitHub environment, the committed workflow, and verification all follow from it, with the canvas reporting progress as it goes — no further prompt, and no step completed by hand.

Progress is reported through the canvas's existing three stages: `Authorize deploy identity`, `Configure environment`, and `Verify credentials`. The first runs for both identity paths, creating a new role or applying the confirmed changes to a selected one. Within it the developer sees the CLI version confirmed, the account's GitHub identity provider found or created, the subject the role will trust, the role created or selected, the deploy permissions and region restriction applied, and the target cluster checked and access granted.

A second environment in the same repository and account reports the shared role instead, as `Reusing the Radius-managed IAM role radius-deploy-contoso-storefront`, followed by `Keeping 1 subject(s) already trusted by this role` when the existing trust is widened rather than replaced.

Failures reuse the established pattern: a summary card titled `Setup didn’t finish`, resources grouped as created, retained, reused, cleaned, and requiring manual action, and an offer to roll back. A new role appears under created resources; a selected role appears under reused, and rollback covers only what Radius added during this setup.

**Parity with Azure**

| Capability                              | Azure today                                                                     | What AWS requires                                                                                                                |
|-----------------------------------------|---------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| What the wizard discovers for you       | Resource groups, AKS clusters, namespaces                                       | EKS clusters, namespaces, VPCs, subnets                                                                                          |
| What you must fill in before continuing | Resource group, cluster, and namespace                                          | Cluster and namespace; VPC and subnets arrive filled in from the cluster                                                         |
| What is created or changed in the cloud | App registration when needed, federated credential, and scoped role assignments | IAM role when needed, repository trust, regional permissions, and EKS cluster access                                             |
| How many identities a repository gets   | One per repository, spanning every subscription in the tenant                   | One per repository **per account**; an IAM role cannot span accounts, so an account per environment means a role per environment |
| Adding an environment                   | Adds a federated credential to the same app, and cannot disturb the others      | Widens the shared role to the sum of what its environments need                                                                  |
| Minimum CLI version                     | None required                                                                   | AWS CLI 2.15.3 or later, checked before anything is created                                                                      |

### Step 4 · Review the application graph

Before deploying, a developer wants to know what will be created in their AWS account. The application graph answers that through `Modeled`, `Planned`, and `Diff` views. The matching question afterwards — what is actually running — is answered by the `Deployed` view, which only means anything once a deployment exists and so belongs with Step 5.

`Modeled` shows the Radius type the developer declared — `Radius.Data/mySqlDatabases` — the same on either cloud. `Planned` shows what the recipe resolves that to, per resource type rather than by a single rule: a database backed by Amazon RDS appears as `AWS.RDS/DBInstance`, a cache backed by ElastiCache or a stream backed by MSK as its own AWS type. The label is the namespace the recipe declares, the same convention Azure follows in showing `Microsoft.DBforMySQL/flexibleServers`. The graph is where an application stops being portable in the abstract and becomes a specific set of AWS resources.

A recipe that provisions several AWS resources — an RDS instance alongside its subnet group and security group — shows the one the application depends on, and the rest appear in the node's details rather than as siblings.

![The Planned application graph for an AWS environment. The application node todo-list-app resolves to apps/Deployment, and connects to a mysql node typed AWS.RDS/DBInstance and a mysql-client-credentials node typed core/Secret. Planned nodes are drawn with a dashed border, and each offers View source code.](2026-09-aws-support-canvas/graph-planned-aws.png)

The developer picks the application, branch, and environment, then deploys from this view. `The planned deployment is current.` confirms the graph reflects the branch as it stands. Planned nodes are drawn with a dashed border and deployed nodes with a solid, badged one, exactly as for Azure.

**Parity with Azure**

The renderer, the icon set, and the `Diff` view are provider-neutral and need no AWS-specific work — the icons already cover names such as `rds`, `ecr`, and `sqs`. Two things differ.

| Capability                            | Azure today                                                      | What AWS requires                                                                          |
|---------------------------------------|------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| Where the console link points         | Built from Azure resource IDs and types, with a cluster fallback | Matched from the resource type to that service's console list, in the environment's region |
| Cloud resources in the details drawer | Only IDs starting `/subscriptions/`                              | ARNs recognized, so AWS resources appear in the drawer                                     |

### Step 5 · Deploy

Deploying is the same act on either cloud. The developer deploys from the application view, sees `Deploying <app> to environment <env>` with `Track progress in the deployments list below.`, and tracks the run in the deployments list, where each row offers `Monitor Graph`, `View Run`, and `Delete Deployment`. On success the log closes with `🎉 Deployment complete! Application deployed to AWS.` followed by `Click on deployed resources to view them in the AWS Console.`

Once a deployment finishes, the `Deployed` view shows the application as it now runs, introduced as `The deployed application graph depicts the selected application as it is currently deployed and running in a given environment.` Before a first deployment there is nothing to show, and the view says so — `Not deployed yet — showing the modeled application.` — then renders the modeled topology so the developer sees what they are about to deploy rather than an empty panel.

That distinction matters more on AWS than it looks. The types in the fallback are resolved from the recipe pack rather than read from the account, so a database is typed `AWS.RDS/DBInstance` before any database exists. The notice is what keeps it honest: the same node means *this is what the recipe will create* under the notice, and *this exists in your account* without it. A node in the fallback carries no console link, because there is nothing to link to.

![The Deployed application graph for the AWS environment Aws-test-env before a first deployment, reporting "Not deployed yet — showing the modeled application." and rendering todo-list-app as apps/Deployment connected to mysql typed AWS.RDS/DBInstance and mysql-client-credentials typed core/Secret.](2026-09-aws-support-canvas/graph-deployed-aws.png)

Deployed AWS resources link to the console from both the node and the details drawer. The drawer link reads `View in AWS console` and a node's accessible label reads `Open <resource> in AWS console`, mirroring the Azure portal links available today. A recognized type links to that service's console list for the environment's region, so the link locates the service and the developer finds the resource by name within it. A type the canvas does not recognize carries no link at all — a link is never fabricated, because one that lands on the wrong page is worse than none.

AWS deployments require no new controls, and failures caused by identity or cluster access name their specific cause rather than reporting a generic workflow failure.

**Parity with Azure**

Watching a run, the deployments list, and the delete controls are provider-neutral and unchanged. Three things differ.

| Capability                           | Azure today                                              | What AWS requires                                                                       |
|--------------------------------------|----------------------------------------------------------|-----------------------------------------------------------------------------------------|
| The closing message                  | `🎉 Deployment complete! Application deployed to Azure.` | `🎉 Deployment complete! Application deployed to AWS.`                                  |
| When identity has drifted            | Names the federated credential or role assignment        | Names the trust policy or permissions                                                   |
| A deployment that outlives its token | Token refreshed by the Azure login action                | The GitHub OIDC token refreshed, so a long deployment does not fail on an expired token |

#### What each dependency deploys to

The recipe pack decides which AWS service stands behind each Radius type. The pack is applied by the deploy workflow rather than attached to the environment, so it is established on the first deploy and re-applied on every one after.

Which version applies is pinned by the repository, not the environment: the branch records the pack version it was validated against. Two developers deploying the same branch get the same infrastructure, and a new pack release cannot change a running application until that record is updated and reviewed like any other change.

Ten backing services are in the first release, ranked by how often developers need them, from the ranked catalog proposed in [radius-project/radius#13122](https://github.com/radius-project/radius/pull/13122). They are where the pack starts, not the limit of what an application can use — a dependency outside them generates its own type and recipe, as Step 1 describes.

| Rank | Developer dependency | Radius resource type              | Azure outcome                | AWS outcome           |
|------|----------------------|-----------------------------------|------------------------------|-----------------------|
| 1    | PostgreSQL           | `Radius.Data/postgreSqlDatabases` | PostgreSQL Flexible Server   | Amazon RDS PostgreSQL |
| 2    | Redis                | `Radius.Data/redisCaches`         | Azure Managed Redis          | Amazon ElastiCache    |
| 3    | Object storage       | `Radius.Storage/objectStorage`    | Storage Account              | Amazon S3             |
| 4    | LLM inference API    | `Radius.AI/models`                | Azure OpenAI                 | Amazon Bedrock        |
| 5    | MongoDB              | `Radius.Data/mongoDatabases`      | Cosmos DB, Mongo API         | Amazon DocumentDB     |
| 6    | MySQL                | `Radius.Data/mySqlDatabases`      | MySQL Flexible Server        | Amazon RDS MySQL      |
| 7    | Kafka                | `Radius.Messaging/kafka`          | Event Hubs, Kafka-compatible | Amazon MSK            |
| 8    | Search               | `Radius.AI/search`                | Azure AI Search              | Amazon OpenSearch     |
| 9    | RabbitMQ             | `Radius.Messaging/rabbitMQ`       | Kubernetes recipe            | Amazon MQ             |
| 10   | SQL Server           | `Radius.Data/sqlServerDatabases`  | Azure SQL Database           | Amazon RDS SQL Server |

The shared Kubernetes set is `Radius.Compute/containers`, `containerImages`, `persistentVolumes`, `routes`, and `Radius.Security/secrets`. These resolve through the same Kubernetes recipes on both clouds, so an application using only these types moves between AKS and EKS unchanged — subject to what each cluster provides, since a route needs an ingress controller and a volume needs a storage class.

### Step 6 · Delete

A developer tearing down work needs to know what leaves their AWS account and what stays. Deleting a deployment uses the existing three-step confirmation — intent, acknowledged effects, and typing `<app>/<environment>` to confirm — preceded by a list of resources to be deleted. It is provider-neutral and unchanged. Where resources are left in a non-terminal state, force delete remains available with its existing warning about orphaned external resources.

Deleting an environment states the AWS consequences first. It names the cluster the environment is removed from, the trust removed from the role, any region or cluster access no remaining environment needs, and whether the role itself is deleted or retained. If applications remain, deletion is blocked and names the applications to delete first.

The role is narrowed to what the environments still on it need. It is deleted only when Radius created it *and* no environment anywhere still uses it; a role selected through the picker is never deleted. The account's GitHub identity provider is always retained, including one Radius created, because every repository in the account depends on it. Where ownership or shared use cannot be established, the object is retained and reported as requiring manual action rather than removed on an assumption.

**Parity with Azure**

| Capability                          | Azure today                                    | What AWS requires                                                                                                               |
|-------------------------------------|------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| What happens to the deploy identity | Deletes the environment's federated credential | Removes what this environment added; deletes a Radius-created role only when unused, and never deletes a selected existing role |
| What you are told afterwards        | Names the federated credential removed         | A message conditional on what was actually removed, rather than a fixed statement of retention                                  |

### Deliberate non-parity

| Azure capability                       | Why AWS does not mirror it                                                                                                              |
|----------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| Resource group as a grouping scope     | AWS has no equivalent container. Region and VPC carry the equivalent meaning and are already surfaced.                                  |
| Enterprise app-registration governance | Immutable subjects and service-management references are Entra-specific. AWS governance is expressed by permissions boundaries instead. |

The reverse case — where AWS asks for something Azure does not — occurs once, and is equally deliberate.

| AWS input       | Why Azure has no equivalent                                                                                                                                                                                                                                                                        |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| VPC and Subnets | AWS managed data and messaging services are VPC-bound and need a subnet group spanning at least two availability zones, so their recipes require both. The Azure equivalents provision with public access and take no network input. See [Section 4 · Infrastructure](#section-4--infrastructure). |

## Error handling

Each condition carries its own remediation rather than folding into a generic failure, grouped by where in the journey the developer meets it. Several are not the developer's to fix: where a permission they do not hold is required, the message names the command and is written to be handed to whoever does.

**Step 1 · Modeling the application**

| Condition                                                    | What the developer is told                                                          |
|--------------------------------------------------------------|-------------------------------------------------------------------------------------|
| A dependency AWS cannot provision and the cluster cannot run | Named, with nothing generated for it, and reported as permanent rather than retried |
| Nothing deployable is found in the repository                | Said plainly, rather than producing an empty model                                  |

**Step 2 · Connecting an AWS account**

| Condition                                          | What the developer is told                                                                                                                                                                   |
|----------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| No AWS CLI session                                 | `No active AWS CLI session. Run "aws configure" (or "aws sso login") in your terminal, then click Verify again.` The `Sign in to AWS CLI` remediation offers to run `aws sso login` for them |
| Signed-in account differs from the profile account | Reported on the form before the developer proceeds, naming both accounts                                                                                                                     |
| Account ID or region is not a valid value          | Named at the field, before verification runs                                                                                                                                                 |
| A profile is deleted while environments use it     | Deletion names those environments and does not proceed; deleting a profile never touches anything in AWS                                                                                     |

**Step 3 · Creating an environment**

Most failures land here, because this is where Radius first writes to the developer's account.

| Condition                                                  | What the developer is told                                                                                                                                                                                                                                                                                                                     |
|------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| AWS CLI too old, or cannot be run                          | `AWS CLI 2.7.31 is installed, which cannot grant the deploy role access to an EKS cluster. Radius needs AWS CLI 2.15.3 or newer, the first release with EKS access entries.` alongside `Upgrade the AWS CLI, then retry:` and the install link. Where the CLI cannot be run at all, `Could not run the AWS CLI:` is followed by its own output |
| Identity provider missing and cannot be created            | Names the account and hands over the `aws iam create-open-id-connect-provider` command for an IAM administrator to run                                                                                                                                                                                                                         |
| Cluster grants access through `aws-auth`                   | `Cluster <name> uses CONFIG_MAP authentication, which does not support access entries. Radius grants cluster access through an access entry, so it cannot authorize the deploy role on this cluster.` with the `aws eks update-cluster-config` command                                                                                         |
| A role of the expected name is not Radius-managed          | Names the matching role, says that no change was made, and offers the two valid paths: select that role explicitly, or choose a different name                                                                                                                                                                                                 |
| Role creation denied by IAM                                | `The signed-in AWS identity is not permitted to create IAM roles.` with a choice to return and select an existing role, or hand the denied action to an IAM administrator                                                                                                                                                                      |
| A selected role cannot be updated                          | Names the trust, permission, or cluster-access change that was denied, and leaves the role as it was before setup began                                                                                                                                                                                                                        |
| Setup fails part way through                               | The stage is named alongside AWS's own output, and the partial-state summary offers rollback with created objects named rather than silently retained                                                                                                                                                                                          |
| Discovery is denied, or returns nothing                    | Each list says whether it is empty because the account holds none or because the signed-in identity cannot read them, and offers a typed value meanwhile                                                                                                                                                                                       |
| No two subnets in different availability zones             | Named against the chosen VPC, with the reason the field is empty rather than filled in                                                                                                                                                                                                                                                         |
| A typed cluster, VPC, or subnet does not fit the selection | Rejected at the field, naming whether it belongs to another account, another region, or another VPC                                                                                                                                                                                                                                            |
| Namespace already backs another environment                | Named at the field, with the environment already using it                                                                                                                                                                                                                                                                                      |
| The GitHub environment or workflow cannot be written       | Named as the stage that failed, separately from anything created in AWS, so it is clear which cloud the failure is in                                                                                                                                                                                                                          |

**Step 4 · Reviewing the application graph**

| Condition                                                | What the developer is told                                                                                                                                                                         |
|----------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| The branch carries no model yet                          | `No application model exists yet.` with the offer to create one, rather than an empty graph                                                                                                        |
| The repository holds nothing that can be modeled         | `I could not find a Dockerfile in this repository. I can only create application definitions for containerized applications. Add a Dockerfile first, then I can create an application definition.` |
| The model does not compile                               | The compiler's own output, rendered as it stands, so the failure is attributable to a line in the repository rather than to the environment                                                        |
| The graph cannot be drawn                                | `The application graph could not be rendered. Reload the graph to try again.` and `The graph library failed to load. Reload the graph to try again.`, separating a data failure from a client one  |
| A recipe in the pack has no known AWS resource behind it | Reported as a note on the graph naming the unmapped recipes, so a generic node is explained rather than silently generic                                                                           |

**Step 5 · Deploying**

| Condition                                | What the developer is told                                                                                             |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| GitHub OIDC token expires mid-deployment | Attributed to token expiry rather than a generic permission error, naming the stage it reached                         |
| A recipe fails part way through          | Names the resource and leaves what was provisioned visible in the graph rather than reporting only that the run failed |
| Identity has drifted since setup         | Named as the trust, permission, or cluster access that is now missing, rather than as a generic denial                 |

**Step 6 · Deleting**

| Condition                                             | What the developer is told                                                                    |
|-------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| Ownership of an identity object cannot be established | The object is named under manual actions, with what could not be established                  |
| Cleanup partly fails                                  | What was removed and what remains are listed separately, with the remainder offered for retry |
| The role is already gone                              | Reported as already absent, and deletion continues                                            |

However a step fails, three rules hold.

- **Nothing is created until every check that can fail for free has passed.** A developer acting on a refusal never has to undo something Radius made on the way to it.
- **What Radius cannot prove it owns, it does not touch.** It names the object and says what it could not establish, rather than modifying or deleting it on an assumption.
- **A refusal hands back what it was about to do.** Where a policy would have been written, the policy is returned; where a command resolves the problem, the command is given. Nobody is asked to reconstruct Radius's intent from a description of it.

## Open questions

- **Q1 · Should the canvas surface an environment that has drifted?** An environment deleted outside the canvas, or whose AWS objects are removed by hand, leaves the environments list and the role disagreeing. Deleting a sibling environment stays safe, because the role is read rather than remembered. Whether the developer should be told, and where, is undecided. *Product, with the canvas UX owner.*
- **Q2 · How far does the deploy role go in handing an application its credential?** An application on AWS needs a credential its recipe returns, and creating one requires permissions the deploy role is otherwise denied. How wide that exception is, and whether the help text discloses it at the point of consent, is undecided. *Product, with security review.*

## Appendix

### Needs engineering investigation

Each of these affects behavior this document specifies, and none is settled.

| Area                     | Question                                                                                                                                                                                                                                                  | Affects                     |
|--------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------|
| Region restriction       | The role is specified to accumulate regions, but the policy is written for one region and replaced rather than merged — so adding a second environment in a second region would narrow the boundary and break the first. Needs a policy that accumulates. | Step 3 · Deploy identity    |
| Application credentials  | Which IAM actions the deploy role needs to mint a scoped application credential, and how a permissions boundary keeps that from being an escalation path.                                                                                                 | Q2                          |
| Recipe language coverage | Bicep on AWS reaches only what Cloud Control supports. An access key has no Cloud Control type, so a recipe returning one cannot be expressed in Bicep as the pack requires.                                                                              | Overview, Step 5            |
| Concurrent setup         | Two environments created at once in one account must both finish without displacing each other on the shared role or the identity provider.                                                                                                               | Step 3 · Create Environment |
| Console link mapping     | Which AWS resource types map to which console list, and what a node shows for a type with no mapping.                                                                                                                                                     | Step 4, Step 5              |
| Drift detection          | Whether the environments list can detect a role that no longer matches what Radius recorded, and at what cost.                                                                                                                                            | Q1                          |
