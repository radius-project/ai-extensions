---
name: radius-app-complete
description: Makes a planned Radius application model (.radius/app.bicep) ready to deploy. Wires each setting that the app reads to reach its services, adds credentials as @secure() parameters and Radius secrets, and finishes the image builds. Use when the user asks to make the Radius app ready to deploy, complete the model, or prepare it for deployment. Not for first-time modeling or for planning the model for a cloud provider.
---

# Make a Radius app ready to deploy (Stage 3)

Complete the planned model in `.radius/app.bicep` so that it deploys and the app runs. This is Stage 3 of 3. Stage 1 modeled the app's resources and connections, and Stage 2 planned it for a cloud provider. Stage 3 adds what a deployment needs.

## What Stage 3 changes

Stage 3 adds credentials, `@secure()` parameters, `Radius.Security/secrets` resources, environment variables, `command` and `args`, probes, volume mounts, build platforms, and the registry secret.

It changes nothing that Stage 1 or Stage 2 decided: no resource or connection is added or removed (except secrets), and no name, image, port, build source, or provider value changes. If the app needs a resource or connection that the model lacks, or a published image does not work, do not fix it here. Finish what you can, and tell the user to correct the model with Stage 1.

The finished model compiles with zero warnings.

Gotchas:

- **The app's parser decides each setting.** Find the code that reads each setting. It decides the name, the format (one URL, or separate host and port; the TLS options), and whether the setting is required. A setting that a compose file or `.env` example sets is a hint, not the format.
- **Leave no required setting out.** An unchanged model is not a result. If the app cannot work with what a Recipe provides, wire everything else, and name the gap in your reply.
- **Take each other required setting from the deployment files that the model follows.** A required setting that no model resource provides, such as a mode or profile, keeps their value: another value can turn on code paths that need settings the model lacks.
- **Add a probe only when the deployment files define one.** When the deployment files that the model follows define a health check for a workload, such as a compose `healthcheck` or a Kubernetes probe, copy its path, port, or command. Do not build a probe path from route code: it can miss a prefix, and a wrong probe keeps the workload from becoming ready.
- **Secrets never appear as literals.** A password or key comes from a `@secure()` parameter with no default, or from the secret that a Recipe makes. A container reads it with `secretKeyRef` or a connection's environment variable, or, when the app reads it only from a file, from a secret volume.
- **The provider is the one that Stage 2 planned for:** Azure, unless the user names another one. The provider's managed services require TLS, and Azure forbids some usernames, such as `admin` and `root`. Use `myadmin`.
- **Use dot access** for outputs, such as `peer.properties.hosts.web`. Quoted access, such as `hosts['web']`, makes a Bicep warning.

## Workflow

`<skill-dir>` is this skill's base directory. Run the scripts with absolute paths, from the application's directory.

1. **Begin.** Run `node <skill-dir>/scripts/complete.mjs begin`. It starts a run in a staging directory, `<run>`, with a copy of the model, and lists the problems to fix, such as missing credentials. Edit only `<run>/app.bicep`, never `.radius/`.
2. **Find the settings.** For each container, find every setting that it reads at startup or to reach a service: environment variables, command-line flags, and config files. Find the code that parses each one, with the file and line. Find how each client signs in to its service. For an app with many workloads, you can give each workload to a subagent and ask for this list.
3. **Look up what each service provides.** `node <skill-dir>/scripts/types.mjs <type> ...` prints each type's properties, read-only outputs, and secret keys. `node <skill-dir>/scripts/recipe.mjs --provider azure <type> ...` prints what the provider's Recipe deploys and how its outputs map, such as whether `host` is a full host name.
4. **Write the settings.** Read [references/wiring.md](references/wiring.md) first. It shows each pattern: chosen credentials, Recipe-made secrets, connection environment variables, peer addresses, volumes, and the registry secret.
5. **Compare each setting with its parser** once more.
6. **Check.** Run `node <skill-dir>/scripts/complete.mjs check <run>`. It compiles the model with zero warnings, confirms that no Stage 1 or Stage 2 value, resource, or connection changed, and checks build platforms, the registry secret, and usernames. Fix each problem and run it again. When it passes, it records the commit and the stage in `app.origin.json` and publishes the run into `.radius/`. After five failed checks, run `node <skill-dir>/scripts/complete.mjs abort <run>` and report the problems that remain. If the stage fails and the `radius-report-issue` skill is installed, use the `radius-report-issue` skill to offer a report to the Radius team. The user reviews the draft first, and you require separate explicit permission to submit the reviewed draft.
7. **Reply** with the description below.

## Reply

1. **What you added,** for each workload: the settings, with the source file and line of each parser.
2. **The parameters** that the user must supply at deployment, such as passwords and the registry credentials.
3. **Gaps and assumptions,** each with the reason: a setting that you could not wire, a format that a Recipe output does not fit, or a change that Stage 1 must make.
