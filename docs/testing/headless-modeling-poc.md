# Headless modeling evaluation POC

This proof of concept tests a real agent's pre-authoring decision without opening or automating the Canvas UI. It covers the Environment-registration boundary from [#962](https://github.com/radius-project/ai-extensions/issues/962), including the stricter checks for named targets.

## What runs

The runner starts a small MCP server on `127.0.0.1` with an OS-assigned port. It supplies the production Canvas handoff from `runtime/hooks.ts`, the production skill-handoff factory from `skill.ts`, and the skill's `SKILL.md` and `references/runtime-contract.md`. A non-interactive Copilot CLI session reads this guidance and calls three tools: `radius_generate_app`, `resolve_modeling_evidence`, and `submit_modeling_decision`.

The first tool wraps the production handoff factory and supplies the guidance text and synthetic application source. The second replaces external schema and Recipe lookups with controlled responses. The third records the agent's decision. Expected answers stay in the runner; the agent receives no pass/fail labels. The runner fails if the agent returns the wrong decision, does not submit a decision, exits with an error, or exceeds the two-minute limit for a case.

The application fixture has a container and a Redis backing service. The application must consume the Recipe's generated `properties.url` as `REDIS_URL`. Supplied evidence establishes the schema path, output mapping, protocol, and credential compatibility. No fixture uses cloud accounts, tokens, private application code, GitHub calls, or a registry.

## Tests implemented

| Case                      | Controlled inputs                                                                                            | Required decision                                          |
|---------------------------|--------------------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| `no-environment`          | Available Azure Recipes; no named Environment and no supplied contract                                       | Ready to author; do not require registration proof         |
| `named-registered`        | Named Azure Environment; supplied contract registers both required types and matches their Recipes           | Ready to author                                            |
| `named-unverified`        | Named Environment; no registration evidence                                                                  | Block on registration                                      |
| `contract-without-name`   | An actual Recipe-selection contract is supplied without an Environment name; registration evidence is absent | Block on registration                                      |
| `aws-with-azure-evidence` | Explicit AWS profile; only Azure Recipe behavior is supplied                                                 | Block on Recipe behavior; do not substitute Azure evidence |
| `recipe-unavailable`      | No target Environment; required Recipe behavior is unavailable                                               | Block on Recipe behavior, not registration                 |

The ordinary Vitest suite also has 19 offline tests for the harness. They check the model/case matrix, distinct result paths, default model selection, case filtering, argument handling, production handoff wiring, evidence-before-decision ordering, expected-result checks for all six cases, failure reporting, and loopback MCP transport. Protocol checks include malformed input, unavailable methods, tool errors, request-size limits, and server shutdown. These tests prove the harness behavior, not real-agent reasoning.

## Run

Use Node.js 24, the repository's pnpm version, and a Copilot CLI installation with model access. Run the command from the repository root. `--cli` must point to a native executable, such as `copilot.exe` on Windows, not a `.cmd` or `.ps1` shim. On other platforms, use the native `copilot` executable.

```powershell
pnpm run test:agent:modeling --list
pnpm exec vitest run packages\adapter-canvas\test\support\agent-eval
pnpm run test:agent:modeling --cli "C:\tools\copilot.exe" --model gpt-6-astra
```

Supply repeated `--model` options to compare models on the same cases. Each model/case pair gets a fresh CLI session and its own result file. Duplicate model identifiers run only once. An unavailable model fails the run; the runner does not substitute another model. With no `--model`, the CLI uses its configured default, which the result labels as `CLI default`, not as a known model version.

```powershell
pnpm run test:agent:modeling --cli "C:\tools\copilot.exe" --model gpt-6.1-sol --model gpt-6-astra --model claude-sonnet-5.5
pnpm run test:agent:modeling --cli "C:\tools\copilot.exe" --model gpt-6-astra --case no-environment
```

To compare guidance from another Git revision, use `--guidance-ref`. The runner resolves the revision to a commit, reads both guidance files from that commit, and bundles its `hooks.ts`. It does not check out the revision or change the worktree. The fixture, production skill-handoff factory, and test runner remain from the current worktree. This is a guidance comparison, not an execution of the full extension from that revision.

```powershell
git fetch origin main
pnpm run test:agent:modeling --cli "C:\tools\copilot.exe" --model gpt-6-astra --guidance-ref origin/main
```

## Results

Evidence is saved under `.artifacts\agent-modeling\run-*`, which Git ignores. Each case records the requested model, guidance commit, guidance-text hash, duration, expected result, recorded tool calls, CLI output, and any failure. `summary.json` contains the complete model matrix. Review output before sharing it. Live runs use the CLI's existing authentication and consume AI credits; they are opt-in and are not part of normal CI.

The CLI receives only the evaluation MCP tools. Built-in GitHub MCP servers are disabled. The server returns controlled data and does not write a model, run shell commands, or contact a cloud service. Each case uses a separate directory and the server closes on success or failure. The runner keeps local reports for inspection and removes its generated evaluation bundle.

### Astra comparison on 2026-10-06

| Guidance                                                       | Result                                                                                                                           |
|----------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `main` at `a77ba988a4fb0e42c9cc96e70b2b0bf6f694a3d1`           | Five cases passed. `contract-without-name` failed: Astra allowed authoring without registration proof for the supplied contract. |
| PR #981 guidance at `954060d1064c7e734289db15a17a510e4d0bf1d6` | All six cases passed.                                                                                                            |

The `no-environment` case passed against both guidance versions. Thus this run detects a contract-boundary difference, but **does not reproduce the original no-Environment stop**. Do not claim that a passing run proves the original regression cannot recur.

## Limits and next steps

This POC evaluates only whether authoring can begin. It does not run the full skill workflow, write or compile Bicep, verify origin records, load the full extension through the Copilot host, or test deployment. Its schema and Recipe definitions are synthetic evidence, not a managed-release compatibility qualification. The pre-authoring task deliberately stops before script execution and narrows the agent's tools; this differs from an unrestricted modeling session.

Live model responses can vary. Repeat runs across supported models before using this as a release signal. A stronger evaluation would use an isolated fixture repository, run the complete shipped skill, inspect generated Bicep and tool traces, and validate the output against pinned schemas. [#685](https://github.com/radius-project/ai-extensions/issues/685) tracks the wider skill-evaluation capability. Keep offline runtime and artifact tests as the fast, repeatable CI checks.
