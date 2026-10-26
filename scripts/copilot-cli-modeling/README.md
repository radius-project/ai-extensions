# Copilot CLI modeling run

This harness runs Copilot CLI with the Radius plugin built from this checkout. For one case from [`cases`](cases), it sends the dataset prompt, `Model my app as a Radius application`. The run passes when the agent loads the plugin's `radius-app-bicep` skill and the skill publishes `.radius/app.bicep` in the case's app. It does not grade the model.

The [Copilot CLI Modeling](../../.github/workflows/copilot-cli-modeling.yml) workflow runs every case on `ubuntu-24.04`, each in its own job. It runs daily at 05:53 UTC, and you can start it by hand from the Actions tab. A scheduled failure opens or updates the issue "Copilot CLI Modeling scheduled failure" with the `test-failure` label, and the next passing scheduled run closes it.

## How it works

1. The workflow builds the plugin and installs the pinned Copilot CLI version from npm.
2. `run-modeling.mjs` makes a new checkout of the case's app at its pinned commit. It deletes the case's excluded paths, and it stops if the app already has `.radius/app.bicep`.
3. It copies the plugin from `.artifacts/radius` into a local plugin marketplace and installs the plugin from there.
4. It runs `copilot --prompt` in the app's directory, with the settings in the next section.
5. It waits up to 30 minutes for the CLI to exit. Then it copies the evidence to the output directory.
6. It reads the session events. The run passes only if all of these are true:
   - The CLI exited with code 0 in 30 minutes, and the session did not fail.
   - The agent loaded the `radius-app-bicep` skill from the `radius` plugin. A project skill with the same name does not count.
   - `.radius/app.bicep` exists and is not empty.
   - `.radius/app.origin.json` records the hash of that `app.bicep`. The skill writes this record when it publishes a model, so an `app.bicep` that the agent writes outside the skill fails.

The summary shows the model calls, tokens, and durations, but they do not change the result.

These checks find a run that does not produce a model. They do not stop an agent that forges the evidence. The agent has `sudo` on the runner, so it can write a skill event or an origin record itself.

The CLI runs with a disposable `HOME`. The run removes variables with secret names (such as `*TOKEN*` and `*SECRET*`) from the CLI's environment, because the agent runs commands in third-party sample code. Only the session process gets the Copilot token, and `--secret-env-vars` keeps the token out of the agent's shell and MCP server environments.

## Match with the GitHub Copilot app

The GitHub Copilot app has no sign-in for CI, so this harness runs Copilot CLI. The CLI uses the same agent runtime as the app, and the run uses the app's settings:

| Setting              | Value                                                                                      |
|----------------------|--------------------------------------------------------------------------------------------|
| CLI version          | `1.0.99-2`, the version that GitHub Copilot app 1.1.30 bundles                             |
| Plugin               | The plugin built from this checkout, from a local marketplace                              |
| Prompt               | `Model my app as a Radius application`, the only message sent                              |
| Model                | `gpt-6.1-sol` for mongo-express and `gpt-6-astra` for pgweb, unless you choose another one |
| Reasoning effort     | `medium` unless you choose another one                                                     |
| Mode and permissions | `--autopilot` and `--allow-all`, as the app's Autopilot sessions                           |
| Plugin extensions    | Loaded. This CLI version needs `--experimental` to load them.                              |

These differences remain:

- The system prompt is different. The CLI tells the model that it runs in non-interactive mode and cannot ask the user questions.
- The app adds its own built-in skills and canvases. The CLI does not have them.
- The run does not test the app itself, such as its install, sign-in, plugin install, or canvas UI.

## Reliability

The workflow is a daily regression check, so a failure must mean that modeling broke, not that the network was slow. The run pins every input that it can: the CLI version, each case's commit, the Ubuntu version, the model, and the reasoning effort. It turns off CLI auto-update. It also bounds every network step:

- The CLI install step has a 5-minute timeout. npm retries failed downloads.
- The case checkout retries `git fetch` three times and stops a transfer that stays below 1 KB/s for 60 seconds.
- The harness stops the session after 30 minutes, before the 40-minute step timeout, so it always writes `summary.md`.

The harness does not retry a session. A session that ends without `.radius/app.bicep` is the failure this check exists to find.

## Cases

Each directory in `cases` is one case. Its `case.yaml` pins a public app repository at a commit, with an optional `path` for a sparse checkout and an optional `exclude` list of paths to delete before the session starts. The two cases are small apps, so the daily run stays short. To add a case, add its directory. Then add an entry with the directory name and a model to the workflow's `matrix.include` list.

Expected models are not in this repository. This repository is public, and the agent must not see the answers.

## Workflow inputs

| Input              | Default  | Use                                                                                            |
|--------------------|----------|------------------------------------------------------------------------------------------------|
| `model`            | Blank    | A model ID for every case. Leave it blank to use each case's model from the workflow's matrix. |
| `reasoning-effort` | `medium` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`, for every case.                 |

Scheduled runs have no inputs, so they use each case's model and `medium`.

## Token

The workflow needs no secret. The modeling step gives the CLI the workflow's own `GITHUB_TOKEN` as `COPILOT_GITHUB_TOKEN`, and the job grants the token the `copilot-requests: write` permission. The organization pays for the Copilot requests.

An organization owner must keep the Copilot policy "Allow use of Copilot CLI billed to the organization" turned on. It is on by default when Copilot CLI is on. See [Copilot CLI in GitHub Actions](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions).

## Output

Each case uploads the `copilot-cli-modeling-<case>` artifact with these files:

- `summary.json` and `summary.md`: the result, the case, the prompt, the CLI version, the requested model and reasoning effort, the models used, skills, tool calls, model calls, tokens, model API time, session duration, and total duration. The workflow also adds `summary.md` to the job summary.
- `session-events.jsonl`: the agent session's events.
- `logs/`: the CLI output and the Copilot runtime logs.
- `radius/`: if the agent wrote `.radius/app.bicep`, the regular files in the `.radius` directory. The run skips symbolic links.

The run removes GitHub tokens and the Copilot token from every file it writes and from the job summary.

## Run it locally

From the repository root, build the plugin and install the CLI version that the workflow pins. Then run the harness with your own token. The run uses your Copilot requests.

```bash
pnpm install --frozen-lockfile
pnpm build
npm install --global @github/copilot@1.0.99-2

COPILOT_GITHUB_TOKEN="$(gh auth token)" node scripts/copilot-cli-modeling/run-modeling.mjs \
  --case scripts/copilot-cli-modeling/cases/sosedoff-pgweb/case.yaml \
  --work-dir /tmp/copilot-cli-work --output-dir /tmp/copilot-cli-output \
  --model gpt-6-astra --reasoning-effort medium
```

`--work-dir` must be empty or missing. Neither directory can be inside the other.

## Update the Copilot CLI

Keep the CLI version the same as the version in the current GitHub Copilot app. The app records its version in `copilot-sdk/cliVersion.d.ts` in its install directory, as `COPILOT_CLI_VERSION`. On Linux, the directory is `/usr/lib/GitHub Copilot`. On macOS, it is `/Applications/GitHub Copilot.app/Contents/Resources`. Change `CLI_PACKAGE` in the workflow and the version in this README. Then run the workflow by hand before you merge.
