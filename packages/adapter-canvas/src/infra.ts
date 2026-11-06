// Canvas adapter — cloud infrastructure wrappers: GitHub Actions workflow and
// portal-URL generation. Provider-specific logic is delegated to the
// @radius-project/core ComputePlatform; this module only adapts core outputs
// for the canvas routes.

import {
  assertTrustedGeneratedWorkflow as validateGeneratedWorkflow,
  deployWorkflowFiles,
  stripAwsDispatcherJob,
  synchronizeWorkflowCandidates,
  type WorkflowCandidate,
  getPlatform,
  generatePortalUrl as coreGeneratePortalUrl,
  generateVerifyWorkflow as coreGenerateVerifyWorkflow,
  verifyTemplateFile,
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeleteWorkflow as coreGenerateDeleteWorkflow,
  DELETE_RADIUS_REF,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_AWS_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE
} from "@radius-project/core";
import { VERIFY_OPERATION_INPUT } from "./verification-run-identity.js";
import {
  createDeploymentTemplates,
  createDeploymentRepository,
  createDeploymentWorkflows
} from "@radius-project/adapter-shared";

import { parse as parseYaml } from "yaml";
import {
  fetchFileFromRepoResult,
  fetchFileFromRepo,
  getDefaultBranch,
  getBranchHeadSha,
  commitFileToRepo,
  cliExec,
  redactGhCredentials
} from "./gh.js";

const assertTrustedGeneratedWorkflow = validateGeneratedWorkflow.bind(
  undefined,
  parseYaml
);
export { deployWorkflowFiles } from "@radius-project/core";
export const generateDeployWorkflow = createDeploymentTemplates({
  readRepositoryFile: fetchFileFromRepoResult,
  now: () => Date.now()
});
export function ensureDeployWorkflowsOnBranch(
  includeAws: boolean,
  repo: string,
  branch: string,
  environment: string,
  log: (message: string) => void,
  onWorkflowWritten: (file: string) => void
): Promise<void> {
  const repository = createDeploymentRepository({
    execute: cliExec,
    redactDiagnostic: redactGhCredentials
  });
  return createDeploymentWorkflows(includeAws, {
    ...repository,
    commitFile: commitFileToRepo,
    readRepositoryFile: fetchFileFromRepoResult,
    now: () => Date.now(),
    reportDiagnostic: (message) => console.error(message)
  }).ensureOnBranch(repo, branch, environment, log, onWorkflowWritten);
}

// Removed from target repos so it cannot double-trigger beside the dispatcher.
export const LEGACY_DEPLOY_WORKFLOW_FILE = "radius-deploy.yml";

export interface ProviderWorkflowOptions {
  // Commit the AWS provider workflows and keep the dispatchers' `aws:` jobs.
  // Off unless the developer-only AWS switch is on.
  includeAws?: boolean;
}

interface ManagedEnvironment {
  name: string;
  provider?: string;
}

interface SyncWorkflowOptions extends ProviderWorkflowOptions {
  log?: (message: string) => void;
  only?: string[];
  workingBranch?: string;
  // When set, a workflow file that is missing on a branch is authored (created)
  // rather than skipped — but only on branches that already exist on the remote
  // (an unpushed working branch is never authored onto). Used by the
  // pre-dispatch sync so a workflow is always present on the branch it runs from.
  create?: boolean;
}

// A workflow file the sync tried to commit but couldn't (e.g. the branch is
// protected). Carries the branch so a caller can tell the user exactly which
// branch the commit was rejected on.
export interface WorkflowCommitFailure {
  path: string;
  branch: string;
}

export interface SyncWorkflowResult {
  // Paths of already-committed files that were rewritten because they had
  // drifted from the upstream template.
  updated: string[];
  // Paths of files that were newly authored because they were missing on a
  // branch (only when `opts.create` is set). Kept separate from `updated` so a
  // caller can tell whether it just created a workflow and therefore needs to
  // wait for GitHub to register it before dispatching.
  created: string[];
  // Paths that appeared between the initial read and the commit helper's
  // confirmation read. Radius did not author them, but callers must still allow
  // GitHub time to register them before dispatching.
  registrationPending?: string[];
  // Per-branch commit failures (create or update) so a caller can surface a
  // specific "couldn't commit to <branch>" message instead of a generic hint.
  failed: WorkflowCommitFailure[];
  branches?: string[];
  skipped: boolean;
}

interface TemplateCacheEntry {
  at: number;
  body: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const VERIFY_WORKFLOW_PATH = ".github/workflows/radius-verify-credentials.yml";

export { DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE };
export {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_AWS_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE
};

export function deleteApplicationWorkflowFiles(includeAws: boolean): string[] {
  return includeAws ?
      [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE, DELETE_AWS_FILE]
    : [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE];
}

export function deleteEnvironmentWorkflowFiles(includeAws: boolean): string[] {
  return includeAws ?
      [DELETE_ENV_DISPATCHER_FILE, DELETE_ENV_AZURE_FILE, DELETE_ENV_AWS_FILE]
    : [DELETE_ENV_DISPATCHER_FILE, DELETE_ENV_AZURE_FILE];
}

/**
 * Fetch a workflow template from radius-project/ai-extensions `.github/extension/` at
 * the pinned RADIUS_REF. radius-project/ai-extensions is the single source of truth,
 * so a fetch failure (offline, transient API error, or the ref/file missing) is
 * a hard error rather than a fall back to a bundled copy. The underlying cause
 * (gh stderr, 404, decode error) is surfaced in the thrown message.
 */
const TEMPLATE_CACHE_TTL_MS = 60_000;
const templateCache = new Map<string, TemplateCacheEntry>();

async function fetchRadiusTemplate(
  fileName: string,
  ref = RADIUS_REF
): Promise<string> {
  // Cache decoded template bodies briefly so a single drift-sync pass (which
  // regenerates workflows for every managed environment) fetches each upstream
  // template once instead of once per environment.
  const cacheKey = `${ref}\u0000${fileName}`;
  const cached = templateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TEMPLATE_CACHE_TTL_MS) {
    return cached.body;
  }
  const source = `${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR}/${fileName} at "${ref}"`;
  const { content, error } = await fetchFileFromRepoResult(
    RADIUS_WORKFLOW_REPO,
    `${RADIUS_WORKFLOW_DIR}/${fileName}`,
    ref
  );
  if (error) {
    throw new Error(`Failed to fetch workflow template ${source}: ${error}`);
  }
  if (!content || !content.trim()) {
    throw new Error(`Workflow template ${source} is empty.`);
  }
  templateCache.set(cacheKey, { at: Date.now(), body: content });
  return content;
}

export async function generateVerifyWorkflow(
  env: string,
  provider: string,
  ref: string = RADIUS_REF,
  options: { setupPushOperationMarker?: string } = {}
): Promise<string> {
  const platform = getPlatform(provider);
  if (!platform)
    throw new Error(
      `Unknown provider "${provider}". Supported providers: azure, aws.`
    );
  // Always use the upstream template from radius-project/ai-extensions; no fallback.
  const fileName = verifyTemplateFile(platform);
  if (!fileName)
    throw new Error(`No verify template for provider "${provider}".`);
  const upstream = await fetchRadiusTemplate(fileName, ref);
  const rendered = coreGenerateVerifyWorkflow(env, platform, upstream);
  const pushMarker = options.setupPushOperationMarker?.trim() || "";
  if (pushMarker && !/^  push:\s*$/mu.test(rendered)) {
    throw new Error(
      "The upstream verify workflow template no longer exposes the constrained setup-branch push trigger."
    );
  }
  const triggerConfigured =
    pushMarker ? rendered : stripSetupPushTrigger(rendered);
  const workflow = configureVerifyGhcrProbe(
    configureVerifyOperationMarker(triggerConfigured, env, pushMarker)
  );
  assertTrustedGeneratedWorkflow(
    workflow,
    "verify",
    `verify workflow "${fileName}"`
  );
  return workflow;
}

function githubExpressionString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function setupPushOperationMarker(workflow: string): string | null {
  const operationInputPattern = VERIFY_OPERATION_INPUT.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const match = workflow.match(
    new RegExp(
      "^run-name: Radius verify .+ \\[\\$\\{\\{ inputs\\." +
        operationInputPattern +
        " \\|\\| '((?:''|[^'])+)' \\}\\}\\]$",
      "mu"
    )
  );
  return match ? match[1].replaceAll("''", "'") : null;
}

export function configureVerifyOperationMarker(
  workflow: string,
  environment = "",
  pushOperationMarker = ""
): string {
  const lines = workflow.split("\n");
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  const dispatchIndex = lines.findIndex((line) =>
    /^\s+workflow_dispatch:\s*$/.test(line)
  );
  const inputsIndex =
    dispatchIndex < 0 ? -1 : (
      lines.findIndex(
        (line, index) => index > dispatchIndex && /^\s+inputs:\s*$/.test(line)
      )
    );
  // Returning the workflow unchanged would ship a verify workflow that does not
  // declare the marker input, while the dispatch still sends it and GitHub
  // answers 422 — a refusal the journal reads as conclusive, failing setup with
  // a message about the dispatch rather than about this template. The template
  // is fetched at runtime, so its shape can move underneath us; say so here.
  if (onIndex < 0 || inputsIndex < 0) {
    throw new Error(
      "The upstream verify workflow template no longer exposes an `on:` block with `workflow_dispatch.inputs`, so Radius cannot add the operation marker it uses to identify verification runs."
    );
  }
  const inputsIndent = lines[inputsIndex].match(/^\s*/)?.[0] ?? "";
  const fieldIndent = `${inputsIndent}  `;
  lines.splice(
    inputsIndex + 1,
    0,
    `${fieldIndent}${VERIFY_OPERATION_INPUT}:`,
    `${fieldIndent}  description: Radius operation identity`,
    `${fieldIndent}  required: false`,
    `${fieldIndent}  type: string`
  );
  lines.splice(
    onIndex,
    0,
    `run-name: Radius verify \${{ inputs.environment || ${githubExpressionString(environment)} }} [\${{ inputs.${VERIFY_OPERATION_INPUT} || ${githubExpressionString(pushOperationMarker)} }}]`
  );
  return lines.join("\n");
}

function stripSetupPushTrigger(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^  push:\s*$/.test(line));
  if (start === -1) return yaml;
  let to = start + 1;
  while (to < lines.length && /^    /.test(lines[to])) to += 1;
  lines.splice(start, to - start);
  return lines.join("\n");
}

/**
 * Replace the upstream GHCR token-claim decoder with the registry's real
 * authorization check.
 *
 * GHCR may return an opaque bearer token, so decoding a JWT `access` claim can
 * report no actions even when GITHUB_TOKEN can push. Starting a blob upload is
 * non-destructive until content is uploaded and returns HTTP 202 only when the
 * token has push permission.
 */
export function configureVerifyGhcrProbe(workflow: string): string {
  const lines = workflow.split("\n");
  const index = lines.findIndex((line) =>
    /^\s*-\s+name:\s*Verify GHCR package push permission\s*$/.test(line)
  );
  if (index < 0) {
    throw new Error(
      'The upstream verify workflow template no longer contains the "Verify GHCR package push permission" step, so Radius cannot replace it with the trusted non-mutating probe.'
    );
  }
  const indent = lines[index].match(/^\s*/)?.[0] ?? "";
  let end = index + 1;
  while (end < lines.length && !lines[end].startsWith(`${indent}- name:`)) {
    end++;
  }
  const replacement = `${indent}- name: Verify GHCR package push permission
${indent}  shell: bash
${indent}  env:
${indent}    GH_ACTOR: \${{ github.actor }}
${indent}    GHCR_TOKEN: \${{ secrets.GITHUB_TOKEN }}
${indent}    STATE_REGISTRY: \${{ vars.RADIUS_STATE_REGISTRY }}
${indent}  run: |
${indent}    set -euo pipefail
${indent}    curl() { command curl --connect-timeout 10 --max-time 30 "$@"; }
${indent}    repo_path="\${STATE_REGISTRY#ghcr.io/}"
${indent}    bearer="$(curl -fsS -u "\${GH_ACTOR}:\${GHCR_TOKEN}" "https://ghcr.io/token?service=ghcr.io&scope=repository:\${repo_path}:pull,push" | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).token || ""));')"
${indent}    if [[ -z "\${bearer}" ]]; then
${indent}      echo "::error::Could not obtain a GHCR token for \${STATE_REGISTRY}."
${indent}      exit 1
${indent}    fi
${indent}    status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer \${bearer}" "https://ghcr.io/v2/\${repo_path}/blobs/uploads/")"
${indent}    if [[ "\${status}" != "202" ]]; then
${indent}      echo "::error::GITHUB_TOKEN cannot start a GHCR upload for \${STATE_REGISTRY} (HTTP \${status})."
${indent}      exit 1
${indent}    fi
${indent}    echo "GHCR_PUSH_CHECK=ok" >> "$GITHUB_ENV"
${indent}    echo "✅ GHCR accepted a non-mutating upload-session probe."`;
  lines.splice(index, end - index, ...replacement.split("\n"));
  return lines.join("\n");
}

/**
 * Generate the delete workflow files. Returns an object mapping bare workflow
 * filename -> YAML content; the caller commits each under `.github/workflows/`.
 * As with deploy, the AWS provider workflows are only committed, and the
 * dispatchers' `aws:` jobs only kept, while the AWS switch is on.
 *
 * Application and environment delete templates are all fetched from
 * radius-project/ai-extensions at DELETE_RADIUS_REF. This keeps one canonical
 * source and prevents an installed plugin's local asset tree from being mixed
 * with the source commit pinned into first-party composite-action references.
 */
export async function generateDeleteWorkflow(
  env: string,
  options: ProviderWorkflowOptions = {}
): Promise<Record<string, string>> {
  const includeAws = options.includeAws ?? false;
  const applicationFiles = deleteApplicationWorkflowFiles(includeAws);
  const environmentFiles = deleteEnvironmentWorkflowFiles(includeAws);
  const fetched = [...applicationFiles, ...environmentFiles];
  const fetchedBodies = await Promise.all(
    fetched.map((f) => fetchRadiusTemplate(f, DELETE_RADIUS_REF))
  );
  const templates: Record<string, string> = {};
  fetched.forEach((f, i) => {
    templates[f] = fetchedBodies[i];
  });
  if (!includeAws) {
    templates[DELETE_AWS_FILE] = templates[DELETE_AZURE_FILE];
    templates[DELETE_ENV_AWS_FILE] = templates[DELETE_ENV_AZURE_FILE];
  }
  const generated = coreGenerateDeleteWorkflow(env, templates);
  if (!includeAws) {
    delete generated[DELETE_AWS_FILE];
    delete generated[DELETE_ENV_AWS_FILE];
    // The dispatchers reference the AWS provider files through their `aws:`
    // jobs; strip them so GitHub can parse the committed workflows.
    for (const dispatcher of [
      DELETE_APP_DISPATCHER_FILE,
      DELETE_ENV_DISPATCHER_FILE
    ]) {
      generated[dispatcher] = stripAwsDispatcherJob(generated[dispatcher]);
    }
  }
  for (const [file, workflow] of Object.entries(generated)) {
    const isDispatcher =
      file === DELETE_APP_DISPATCHER_FILE ||
      file === DELETE_ENV_DISPATCHER_FILE;
    const providerWorkflows =
      file === DELETE_APP_DISPATCHER_FILE ? applicationFiles.slice(1)
      : file === DELETE_ENV_DISPATCHER_FILE ? environmentFiles.slice(1)
      : [];
    assertTrustedGeneratedWorkflow(
      workflow,
      isDispatcher ? "dispatcher" : "provider",
      `delete workflow "${file}"`,
      providerWorkflows
    );
  }
  return generated;
}

export interface WorkflowTemplates {
  deploy(environment: string, appFile: string): Promise<Record<string, string>>;
  delete(environment: string): Promise<Record<string, string>>;
}

// The deploy and delete templates one runtime commits, with its AWS switch
// bound in.
export function workflowTemplates(includeAws: boolean): WorkflowTemplates {
  return {
    deploy: (environment, appFile) =>
      generateDeployWorkflow(environment, appFile, { includeAws }),
    delete: (environment) => generateDeleteWorkflow(environment, { includeAws })
  };
}

export function generatePortalUrl(
  resourceType: string,
  provider: string
): string {
  return coreGeneratePortalUrl(resourceType, provider);
}

/**
 * Re-fetch the upstream workflow templates and update any workflow files the
 * extension previously committed to `repo` whose content has drifted from
 * upstream (radius-project/ai-extensions `.github/extension/`).
 *
 * radius-project/ai-extensions is the single source of truth for the verify, deploy and
 * delete workflows. Users get a snapshot of those templates committed into their
 * repo at environment-creation time; when upstream changes, those committed
 * copies go stale. This resynchronises them in place.
 *
 * Files are synced on the repo's default branch (where the verify/deploy Actions
 * run from) AND on the caller's working branch (`opts.workingBranch`, the
 * session worktree branch) when supplied and different — worktree-consistent
 * deploys check out and run the selected branch's workflow files, so a stale
 * copy there would deploy with an out-of-date workflow. A working branch that
 * isn't pushed to the remote (no ref, so its files can't be read) is silently
 * skipped rather than treated as an error.
 *
 * `environments` is the list of Radius-managed environments (`{ name, provider }`)
 * for the repo. Because the committed workflow files are shared across
 * environments (only the `{{ENV}}` dispatch default varies), a file is treated
 * as in-sync when it matches the freshly generated content for ANY managed
 * environment — so a repo with several environments never ping-pongs the baked-in
 * default. Drift is only flagged (and the file rewritten) when the committed copy
 * matches none of them, i.e. the upstream template itself changed.
 *
 * `opts.only` (optional) restricts the pass to a set of bare workflow filenames
 * (e.g. `["run-rad-commands.yml", "run-rad-commands-azure.yml"]`). This is what
 * lets a caller cheaply ensure just the workflow it is about to dispatch is
 * current, instead of syncing every committed workflow file.
 *
 * By default only files that already exist on a branch are updated; missing
 * files are left to environment creation to author. When `opts.create` is set
 * (the pre-dispatch sync), a missing file is instead authored on any branch that
 * exists on the remote, so the workflow is always present on the branch it will
 * run from — an unpushed working branch is still skipped. Best-effort and
 * non-throwing per file: a protected branch (or any commit failure) is reported
 * via `log`, recorded in the returned `failed` list, and skipped rather than
 * aborting the pass. Returns `{ updated, created, failed, branches, skipped }`:
 * `updated` is the de-duplicated set of drift-rewritten paths, `created` the set
 * of newly-authored paths (so a caller can tell it must wait for GitHub to
 * register a just-created workflow before dispatching), and `failed` the
 * per-branch commit failures (so a caller can name the branch a commit was
 * rejected on).
 */
export async function syncRepoWorkflows(
  repo: string,
  environments: ManagedEnvironment[],
  opts: SyncWorkflowOptions = {}
): Promise<SyncWorkflowResult> {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const envs = (environments || []).filter((e) => e && e.name);
  if (!repo || envs.length === 0)
    return { updated: [], created: [], failed: [], skipped: true };

  // Optional allow-list of bare workflow filenames to sync. When set, only
  // those files are considered (see opts.only above).
  const onlySet =
    opts.only && opts.only.length ?
      new Set(opts.only.map((f) => String(f).split("/").pop()))
    : null;

  const defaultBranch = (await getDefaultBranch(repo)) || "main";
  // Sync the default branch (Actions run from it) plus the working branch a
  // worktree-consistent deploy would check out. Dedupe so we never commit the
  // same branch twice when the working branch IS the default branch.
  const workingBranch = (opts.workingBranch || "").trim();
  const branches = [defaultBranch];
  if (workingBranch && workingBranch !== defaultBranch)
    branches.push(workingBranch);

  // path -> [{ content, provider }]: every committed workflow file mapped to
  // the acceptable (upstream-matching) contents, one candidate per environment.
  // Branch-independent, so it's built once and reused across every branch.
  const byPath = new Map<string, WorkflowCandidate[]>();
  const add = (
    path: string,
    content: string,
    provider: string | null,
    environment: string | null = null
  ) => {
    if (typeof content !== "string" || !content) return;
    if (onlySet && !onlySet.has(path.split("/").pop())) return;
    const list = byPath.get(path) || [];
    list.push({ content, provider, environment });
    byPath.set(path, list);
  };
  const wf = (name: string) => `.github/workflows/${name}`;

  for (const env of envs) {
    // Which providers to generate verify candidates for. An environment whose
    // provider couldn't be inferred (server.ts passes "") gets BOTH, so a
    // committed AWS verify file is never rewritten with the Azure template
    // (or vice versa) merely because the provider was unknown — matching the
    // in-sync check against either provider's template and preferring the
    // committed file's own provider when a rewrite is needed.
    const providers =
      env.provider === "azure" || env.provider === "aws" ?
        [env.provider]
      : ["azure", "aws"];
    for (const provider of providers) {
      try {
        add(
          VERIFY_WORKFLOW_PATH,
          await generateVerifyWorkflow(env.name, provider),
          provider,
          env.name
        );
      } catch (e) {
        log(
          `skipped verify template for "${env.name}" (${provider}): ${errorMessage(e)}`
        );
      }
    }
    // Deploy + delete workflows are provider-agnostic (the content doesn't
    // vary by env provider), so generate them once per environment with a null
    // provider tag.
    try {
      const deploy = await generateDeployWorkflow(
        env.name,
        ".radius/app.bicep",
        { includeAws: opts.includeAws }
      );
      for (const [file, content] of Object.entries(deploy))
        add(wf(file), content, null);
    } catch (e) {
      log(`skipped deploy templates for "${env.name}": ${errorMessage(e)}`);
    }
    try {
      const del = await generateDeleteWorkflow(env.name, {
        includeAws: opts.includeAws
      });
      for (const [file, content] of Object.entries(del))
        add(wf(file), content, null);
    } catch (e) {
      log(`skipped delete templates for "${env.name}": ${errorMessage(e)}`);
    }
  }

  // Each dispatcher `uses:` its provider workflows by path, and GitHub rejects
  // the whole dispatcher when one is missing. Whenever a dispatcher is on a
  // branch, its providers are authored even in the background pass (a
  // `workflow_call`-only provider never runs on push, so that is safe), and a
  // dispatcher is only written once every provider it references is there.
  const includeAws = opts.includeAws ?? false;
  const dispatcherProviders = new Map<string, string[]>([
    [DEPLOY_DISPATCHER_FILE, deployWorkflowFiles(includeAws).slice(1)],
    [
      DELETE_APP_DISPATCHER_FILE,
      deleteApplicationWorkflowFiles(includeAws).slice(1)
    ],
    [
      DELETE_ENV_DISPATCHER_FILE,
      deleteEnvironmentWorkflowFiles(includeAws).slice(1)
    ]
  ]);
  return synchronizeWorkflowCandidates(
    {
      repo,
      branches,
      candidates: byPath,
      dispatcherProviders,
      createMissing: opts.create ?? false
    },
    {
      readFile: fetchFileFromRepo,
      branchExists: async (repository, branch) =>
        !!(await getBranchHeadSha(repository, branch)),
      commitFile: commitFileToRepo,
      log,
      errorMessage,
      async matchesVariant(path, committed, candidates) {
        const setupMarker =
          path === VERIFY_WORKFLOW_PATH ?
            setupPushOperationMarker(committed)
          : null;
        if (!setupMarker) return false;
        for (const candidate of candidates) {
          if (!candidate.provider || !candidate.environment) continue;
          try {
            const variant = await generateVerifyWorkflow(
              candidate.environment,
              candidate.provider,
              RADIUS_REF,
              { setupPushOperationMarker: setupMarker }
            );
            if (variant === committed) return true;
          } catch (error) {
            log(
              `skipped setup verify variant for "${candidate.environment}" (${candidate.provider}): ${errorMessage(error)}`
            );
          }
        }
        return false;
      }
    }
  );
}
