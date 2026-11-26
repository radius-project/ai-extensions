---
name: radius-app-plan
description: Plans an existing Radius application model (.radius/app.bicep) for a cloud provider such as Azure. Checks that each resource type has a Recipe in the provider's Recipe pack, writes Recipes for custom resource types, and changes values that the provider rejects, such as a reserved database name, when the app's source allows another value. Use when the user asks to plan the app for Azure or another cloud, choose a provider or environment, or see what will be deployed. Not for first-time modeling or for making the model deployable.
---

# Plan a Radius app for a cloud provider (Stage 2)

Check that the Stage 1 model in `.radius/app.bicep` works on the selected provider, and fix the values that the provider rejects. This is Stage 2 of 3. Stage 1 modeled the app, and Stage 3 makes the model deployable.

A Recipe deploys each Radius resource type on a platform. The provider's Recipe pack decides which cloud resource each type becomes, so Stage 2 does not change types. It changes only values that the provider limits, such as a database name that Azure reserves.

## What Stage 2 changes

Only the values that `plan.mjs` reports as breaking a provider rule, and only when the app's source lets the app use another value, and the Recipes of custom resource types. Nothing else: no resources, connections, images, ports, names, credentials, or settings. If you see a problem outside these values, such as a missing service, name it in your reply for Stage 1 or Stage 3 to fix.

No change is the correct result when every value meets the rules. Most models need no change.

Gotchas:

- **The source decides whether a value can change.** The app may read a database name from an environment variable, a connection string, a flag, or a config file. Then a new name works, because Stage 3 sets that setting. If code or the image fixes the name, a new name breaks the app. Then keep the value and report the conflict.
- **Choose a new value from the app,** such as the application's name, and check it against the rule that `plan.mjs` prints.
- **Usernames and passwords are Stage 3 work,** even though the provider limits them too.
- **A custom resource type (`Radius.Resources/*`) needs a Recipe that you write.** Write it in the run, as [references/custom-recipes.md](references/custom-recipes.md) shows.
- If `.radius/app.bicep` does not exist, stop and tell the user to model the app first with the Stage 1 skill, `radius-app-model`.

## Workflow

`<skill-dir>` is this skill's base directory. Run the script with its absolute path, from the application's directory. The provider is `azure` unless the user names another one that `plan.mjs` supports.

1. **Begin.** Run `node <skill-dir>/scripts/plan.mjs begin --provider azure`. It starts a run in a staging directory, `<run>`, with a copy of the model, compiles it, and lists each resource with its Recipe and each provider-limited value with the result of its rule. If it reports no problems, it publishes the plan; skip to step 4.
2. **Decide each value that breaks a rule.** Find in the source where the app gets the value, with the file and line. Change the value in `<run>/app.bicep` only when a setting can change it. Change nothing else, and never edit `.radius/` directly.
3. **Check.** Run `node <skill-dir>/scripts/plan.mjs check --provider azure <run>`. It confirms that only provider-limited values changed since `begin`, and checks the rules again. Fix each problem and run it again, up to five times. When it passes, it records the commit, the stage, and the provider in `app.origin.json` and publishes the run into `.radius/`. A rule that the source fixes stays a problem: run `node <skill-dir>/scripts/plan.mjs abort <run>`, which leaves `.radius/` as it was, and report it. If the stage fails and the `radius-report-issue` skill is installed, use the `radius-report-issue` skill to offer a report to the Radius team. The user reviews the draft first, and you require separate explicit permission to submit the reviewed draft.
4. **Reply** with the description below. If the user also asked to make the app ready to deploy, do not end here: go on with the `radius-app-complete` skill.

## Reply

1. **The provider and its Recipe pack,** and whether each resource type has a Recipe. For each custom type, give its Recipe, and any Recipe that must be published before the app deploys.
2. **Each value that you changed,** from what to what, with the source file and line that show the app accepts the new value. Stage 3 must set that setting.
3. **Each conflict that you did not change,** with the file and line that fix the value, and the choices the user has.
4. If nothing changed, say that the model already meets the provider's rules.
