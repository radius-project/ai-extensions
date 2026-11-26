---
name: radius-app-model
description: Models an application's source code as a platform-neutral Radius application graph in .radius/app.bicep, with its workloads, images, backing services, routes, and the connections between them. Use when the user asks to model an app for Radius, create or refresh app.bicep, or see the app's Radius application graph. Not for planning the model for a cloud provider or making it deployable.
---

# Model an app for Radius (Stage 1)

Read the application's repository and write `.radius/app.bicep`, which shows the app as a Radius application graph. This is Stage 1 of 3. Stage 2 plans the model for a cloud provider, and Stage 3 makes it deployable. Stage 1 is fast and platform-neutral, so the user can check the graph and correct it while a change is still small.

## What Stage 1 writes

Stage 1 writes the application, the workloads, their image sources and ports, the backing services, routes, persistent volumes, the connections between resources, resource names, and a `codeReference` on each resource.

Leave everything else to Stage 3, even when the source shows it: credentials, `@secure()` parameters, `Radius.Security/secrets`, environment variables, `command` and `args`, probes, volume mounts, build platforms and build args, and the registry secret. Those settings take most of the time in a full model, and the user may never deploy.

Gotchas:

- **Do not stop because deployment looks hard.** Settings, credentials, file permissions, and missing Recipes belong to Stages 2 and 3. Model the graph, and name the concern in your reply. Stop only when the repository has no app to model.
- **Expect BCP035 warnings.** The database types require `username` and `password`, and Stage 3 adds them. Any other warning is a problem.
- **Keep the source's values.** If the source uses a database name that a cloud reserves, such as `postgres`, keep it. Stage 2 fixes cloud limits.
- **An existing model is the start point.** If `.radius/app.bicep` exists, `begin` copies it into the run. Edit that copy: keep its names and any later-stage content, and change only what the source shows is wrong or missing.
- **Ask only when the source cannot decide something that changes the graph,** such as which of two unrelated apps to model. When nobody can answer, choose the most likely answer and state it in your reply.

## Workflow

`<skill-dir>` is this skill's base directory. Run the scripts with absolute paths, from the application's directory.

1. **Read the repository.** Start with the README, the deployment files (compose files, Kubernetes manifests, Helm charts), the Dockerfiles, the code that starts each process, and the code that reads its configuration. For an app with many services, you can give each service to a subagent and ask for its image, port, the services it connects to, and the file and line of each fact.
2. **Decide** the resources and connections with the rules below.
3. **Look up the types.** `node <skill-dir>/scripts/types.mjs` lists the Radius types of the installed release. `node <skill-dir>/scripts/types.mjs Radius.Compute/containers Radius.Data/redisCaches` prints their properties.
4. **Start a run.** Run `node <skill-dir>/scripts/model.mjs begin`. It prints a staging directory, `<run>`, with a copy of the current model files, if there are any. Write only in `<run>`, never in `.radius/`: the check publishes the run, so a run that fails leaves the published model as it was.
5. **Write `<run>/app.bicep`.** Read [references/example.bicep](references/example.bicep) first. It is a complete Stage 1 model, and yours has the same shape.
6. **Check.** Run `node <skill-dir>/scripts/model.mjs check <run>`. It writes `bicepconfig.json` if it is missing, compiles the model, checks image sources and source references against the git checkout, and prints the resources and connections. Fix each problem in `<run>` and run it again. When it passes, it records the commit and the stage in `app.origin.json` and publishes the run into `.radius/`. After five failed checks, run `node <skill-dir>/scripts/model.mjs abort <run>` and report the problems that remain. If the stage fails and the `radius-report-issue` skill is installed, use the `radius-report-issue` skill to offer a report to the Radius team. The user reviews the draft first, and you require separate explicit permission to submit the reviewed draft.
7. **Reply** with the description below. If the user asked for more than the model, such as planning it for a cloud or making it ready to deploy, do not end here: go on with the `radius-app-plan` skill, and then `radius-app-complete`.

## Decide the resources

### Workloads

Make one `Radius.Compute/containers` resource for each process that the app runs as its own deployment unit, such as each service in the compose file or each Kubernetes Deployment. Put a sidecar, or an init container (`initContainer: true`), that must run in the same pod in the same resource. Leave out tests, development tools, CI jobs, and examples, and leave out a process that the app runs without, such as a load generator.

### Images

- Build from the repository when its Dockerfile builds the process from source: a `Radius.Compute/containerImages` resource with `build.source` set to `git::https://github.com/<owner>/<repo>.git?ref=<full commit SHA of HEAD>`. When the build context is a folder, add `//<folder>` before `?ref=`. Set `build.dockerfile`, relative to the build context, when the file is not `Dockerfile`. The container's image is `<image>.properties.imageReference`.
- The Recipe builds from a clean checkout of that commit. A Dockerfile that copies a file that is not in git, and that no earlier stage of the same Dockerfile makes, cannot build. Then, or when there is no Dockerfile, use the published image that the README or the deployment files name. A published image is one that a registry serves, with a tag or digest, such as `ghcr.io/org/app:1.4.2`. A compose `image:` value on a service that also has a `build:` section only tags the local build. When no published image exists, keep the build and name the build problem in your reply, for Stage 3.
- A backing service that the app's client cannot reach through any Radius type runs as a container from the image that the deployment files name, with a `Radius.Compute/persistentVolumes` resource if it keeps data.

### Ports

Use the port that the process listens on, from its code, its configuration defaults, or its image. A compose mapping such as `8080:3000` publishes container port 3000.

### Backing services

Model each service that the app's main feature uses, with its Radius type: PostgreSQL, MySQL, SQL Server, MongoDB, Redis, RabbitMQ, Kafka, object storage, an AI model, or a search service. This includes a service that the process can start without but exists to work with, such as the service that the app is a UI, client, or proxy for. Leave out a service that only an optional feature uses, or that the app replaces with a built-in default, such as an embedded SQLite database or local file storage. Name each one in your reply with the setting that turns it on. Set `database` or similar values only when the source names them.

A custom resource type is rare. Define one only for a service that a deployment must create for the app, when no Radius type fits it and the deployment files do not run it from a published image, such as a managed message broker that the app's SDK calls. See [references/custom-types.md](references/custom-types.md). The platform that the app runs on or manages, such as the Kubernetes API, is not a resource of the app.

When a workload keeps data on its own disk, such as a SQLite file, uploaded files, or repositories, add a `Radius.Compute/persistentVolumes` resource for it, and connect the workload to it.

### Connections

A uses B when A's code or configuration connects to B. Write each connection as `dependsOn: [b]` on A. The image reference and a route's destination already connect their resources. Do not add a connection for start order alone, and avoid cycles.

### Routes

Add a `Radius.Compute/routes` resource only when the app's deployment requires clients outside the cluster to reach a workload. Signs are a Kubernetes Ingress, Gateway API route, or `LoadBalancer` Service; public DNS or load-balancer configuration; or a setting for the app's public URL or domain that a production deployment must change. Compose port publishing, localhost instructions, `EXPOSE`, and the files of other hosting platforms do not require a route. Routes share one gateway, so add one route that matches `/`, to the main user-facing workload.

### Names

- Resource names are kebab-case and come from the compose service or manifest name.
- When code or a config file that is built into the image reaches another workload at a fixed host name, and no setting changes it, the names must produce that host. The containers Recipe names each Kubernetes Service `<resource name>-<container key>`, in lower case.
- Symbolic names: `<name>App`, `<name>Container`, `<name>Image`, `<name>Route`, and `<engine>Db`, `<engine>Cache`, or a similar name for a backing service. Container keys are camelCase.

### Source references

Give every resource except the application a `codeReference`: `https://github.com/<owner>/<repo>/blob/<full commit SHA of HEAD>/<path>#L<line>`. Point it to the file that defines the resource: a container's entry point or its service in the deployment file, an image's Dockerfile, a backing service's client setup or its service in the deployment file, and a route's ingress or public-URL setting.

## Reply

After the check passes, reply in plain words, in this order:

1. **How the app works,** in its own terms, in the form `A <language> <kind of process> on port <port> that <what it does with each service>`.
2. **How you modeled it:** one line for each resource, with its type.
3. **What you left out and assumed,** each with the reason. Include optional services and the setting that turns each on, and any deployment concern for Stage 3.
4. **A request for corrections.** A change now is a small edit. After the later stages add deployment details, the same change takes more work.
