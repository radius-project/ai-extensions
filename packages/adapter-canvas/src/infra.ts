// Canvas adapter — cloud infrastructure wrappers: GitHub Actions workflow and
// portal-URL generation. Provider-specific logic is delegated to the
// @radius-project/core ComputePlatform; this module only adapts core outputs
// for the canvas routes.

import {
  getPlatform,
  generatePortalUrl as coreGeneratePortalUrl,
  generateVerifyWorkflow as coreGenerateVerifyWorkflow,
  generateDeployWorkflow as coreGenerateDeployWorkflow,
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
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE
} from "@radius-project/core";
import { VERIFY_OPERATION_INPUT } from "./verification-run-identity.js";
import type { DeployWorkflowOptions } from "@radius-project/core";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  fetchFileFromRepoResult,
  fetchFileFromRepo,
  getDefaultBranch,
  getBranchHeadSha,
  commitFileToRepo
} from "./gh.js";

interface ManagedEnvironment {
  name: string;
  provider?: string;
}

interface SyncWorkflowOptions {
  log?: (message: string) => void;
  only?: string[];
  workingBranch?: string;
  // When set, a workflow file that is missing on a branch is authored (created)
  // rather than skipped — but only on branches that already exist on the remote
  // (an unpushed working branch is never authored onto). Used by the
  // pre-dispatch sync so a workflow is always present on the branch it runs from.
  create?: boolean;
}

interface WorkflowCandidate {
  content: string;
  provider: string | null;
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

function assertValidWorkflowYaml(workflow: string, context: string): void {
  try {
    parseYaml(workflow);
  } catch (error) {
    throw new Error(
      `Generated ${context} is invalid YAML: ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

export { DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE };
export {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE
};

/**
 * Fetch a workflow template from radius-project/radius `.github/extension/` at
 * the pinned RADIUS_REF. radius-project/radius is the single source of truth,
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

// Candidate directories to read a bundled static workflow template from, in
// priority order. `import.meta.url` resolves to the compiled bundle
// (plugins/radius/dist/extension.mjs or the installed copy) at runtime, whose
// sibling `workflows/` directory is populated by build.mjs. When running from a
// built bundle that sibling is the ONLY source of truth: the walk up to a
// `.github/extension/` directory is deliberately skipped so a production install
// can never read a `delete-environment.yml` that happens to sit in the user's
// own repository checkout. In tests and source runs `import.meta.url` resolves
// to this file under `src/`, so the walk locates the repository's own
// `.github/extension/`.
function bundledWorkflowDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return computeBundledWorkflowDirs(here, existsSync(join(here, "workflows")));
}

// Pure, testable core of bundledWorkflowDirs: given the directory this module
// runs from and whether its sibling `workflows/` directory exists, return the
// candidate template directories in priority order.
export function computeBundledWorkflowDirs(
  here: string,
  bundleWorkflowsPresent: boolean
): string[] {
  const dirs = [join(here, "workflows")];
  // The presence of the sibling `workflows/` directory (populated by build.mjs
  // beside the installed extension.mjs) is what tells us we are running from a
  // built bundle — every install layout has it, but no path-segment name is
  // reliable across them (`~/.copilot/extensions/radius/`,
  // `~/.copilot/installed-plugins/.../radius-edge/`, and in-repo
  // `plugins/radius/dist/` all differ). When it is present that sibling is the
  // only source of truth, so skip the walk up to the in-repo `.github/extension/`
  // templates. Source/test runs have no sibling `workflows/`, so they walk up.
  if (!bundleWorkflowsPresent) {
    let cursor = here;
    for (let depth = 0; depth < 8; depth++) {
      dirs.push(join(cursor, ".github", "extension"));
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return dirs;
}

/**
 * Read a static, ai-extensions-owned workflow template shipped inside the
 * plugin. Unlike fetchRadiusTemplate this never touches the network: the
 * environment-delete workflows (issue #303) are committed in this repo and
 * bundled beside the extension. A missing file is a hard error — there is no
 * fallback — so a packaging regression surfaces immediately.
 */
export function readBundledWorkflowTemplate(fileName: string): string {
  for (const dir of bundledWorkflowDirs()) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) {
      const body = readFileSync(candidate, "utf8");
      if (!body || !body.trim()) {
        throw new Error(`Bundled workflow template ${candidate} is empty.`);
      }
      return body;
    }
  }
  throw new Error(
    `Bundled workflow template "${fileName}" was not found beside the extension or in .github/extension.`
  );
}

export async function generateVerifyWorkflow(
  env: string,
  provider: string
): Promise<string> {
  const platform = getPlatform(provider);
  if (!platform)
    throw new Error(
      `Unknown provider "${provider}". Supported providers: azure, aws.`
    );
  // Always use the upstream template from radius-project/radius; no fallback.
  const fileName = verifyTemplateFile(platform);
  if (!fileName)
    throw new Error(`No verify template for provider "${provider}".`);
  const upstream = await fetchRadiusTemplate(fileName);
  const workflow = configureVerifyGhcrProbe(
    configureVerifyOperationMarker(
      coreGenerateVerifyWorkflow(env, platform, upstream)
    )
  );
  assertValidWorkflowYaml(workflow, `verify workflow "${fileName}"`);
  return workflow;
}

export function configureVerifyOperationMarker(workflow: string): string {
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
    `run-name: Radius verify \${{ inputs.environment }} [\${{ inputs.${VERIFY_OPERATION_INPUT} }}]`
  );
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
  if (index < 0) return workflow;
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
 * Generate the deploy workflow files (dispatcher + both provider workflows).
 * Returns an object mapping bare workflow filename -> YAML content; the caller
 * commits each under `.github/workflows/`. The provider is auto-detected at
 * runtime by the dispatcher, so all three files are emitted regardless of the
 * environment's cloud.
 *
 * The templates are fetched from radius-project/radius `.github/extension/` at
 * the pinned RADIUS_REF so user repos always get the reviewed upstream version;
 * there is no bundled fallback, so a fetch failure surfaces as an error.
 */
export async function generateDeployWorkflow(
  env: string,
  appFile: string,
  options: DeployWorkflowOptions = {}
): Promise<Record<string, string>> {
  // Only the dispatcher + the Azure provider workflow are fetched and committed;
  // the AWS provider workflow is intentionally never fetched or committed. The
  // dispatcher's `aws:` job (which `uses:` the absent AWS provider file) is
  // stripped below so GitHub can still parse the committed workflow.
  const files = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
  const bodies = await Promise.all(files.map((f) => fetchRadiusTemplate(f)));
  const templates: Record<string, string> = {};
  files.forEach((f, i) => {
    templates[f] = bodies[i];
  });
  // Satisfy core's "all files required" contract without a network lookup for
  // the AWS template; the generated AWS output is dropped below and never
  // committed.
  templates[DEPLOY_AWS_FILE] = templates[DEPLOY_AZURE_FILE];
  const generated = coreGenerateDeployWorkflow(
    env,
    appFile,
    templates,
    options
  );
  delete generated[DEPLOY_AWS_FILE];
  // Creating an environment should ONLY run the verify-credentials workflow.
  // The upstream dispatcher auto-triggers the deploy via a `workflow_run`
  // trigger once verify completes; strip it so `run-rad-commands` runs only on
  // explicit `workflow_dispatch` (the Deploy button), never on env creation.
  if (generated && typeof generated[DEPLOY_DISPATCHER_FILE] === "string") {
    generated[DEPLOY_DISPATCHER_FILE] = stripWorkflowRunTrigger(
      generated[DEPLOY_DISPATCHER_FILE]
    );
    generated[DEPLOY_DISPATCHER_FILE] = stripAwsDispatcherJob(
      generated[DEPLOY_DISPATCHER_FILE]
    );
  }
  for (const [file, workflow] of Object.entries(generated)) {
    assertValidWorkflowYaml(workflow, `deploy workflow "${file}"`);
  }
  return generated;
}

/**
 * Generate the delete workflow files. Returns an object mapping bare workflow
 * filename -> YAML content; the caller commits each under `.github/workflows/`.
 * As with deploy, the AWS provider workflow is never committed and the
 * application dispatcher's `aws:` job is stripped.
 *
 * Two paths share this generator with different provenance:
 *
 *   - Application delete (`delete-application.yml` + the reusable
 *     `delete-azure.yml`) is fetched from radius-project/radius, which stays the
 *     single source of truth for that reviewed upstream workflow.
 *   - Environment delete (`delete-environment.yml` + its own reusable provider
 *     `delete-environment-azure.yml`) is authored as static YAML in this repo's
 *     `.github/extension/` and shipped inside the plugin (issue #303), so the
 *     ai-extensions-owned "no deployed applications" guard can be reviewed here.
 *     Those two files are read from the bundled plugin rather than fetched.
 *
 * The `{{RADIUS_REF}}` pinned into every provider workflow's composite actions
 * uses DELETE_RADIUS_REF regardless of where the template body came from.
 */
export async function generateDeleteWorkflow(
  env: string
): Promise<Record<string, string>> {
  // Application-delete templates come from upstream; environment-delete
  // templates are static local assets read from the bundled plugin.
  const fetched = [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE];
  const fetchedBodies = await Promise.all(
    fetched.map((f) => fetchRadiusTemplate(f, DELETE_RADIUS_REF))
  );
  const templates: Record<string, string> = {};
  fetched.forEach((f, i) => {
    templates[f] = fetchedBodies[i];
  });
  templates[DELETE_ENV_DISPATCHER_FILE] = readBundledWorkflowTemplate(
    DELETE_ENV_DISPATCHER_FILE
  );
  templates[DELETE_ENV_AZURE_FILE] = readBundledWorkflowTemplate(
    DELETE_ENV_AZURE_FILE
  );
  templates[DELETE_AWS_FILE] = templates[DELETE_AZURE_FILE];
  const generated = coreGenerateDeleteWorkflow(env, templates);
  delete generated[DELETE_AWS_FILE];
  // The application dispatcher references the never-committed AWS provider file
  // via its `aws:` job; strip it so GitHub can parse the committed workflow. The
  // static environment dispatcher is authored Azure-only, so this is a no-op for
  // it, but running it keeps both dispatchers guarded the same way.
  for (const dispatcher of [
    DELETE_APP_DISPATCHER_FILE,
    DELETE_ENV_DISPATCHER_FILE
  ]) {
    if (typeof generated[dispatcher] === "string") {
      generated[dispatcher] = stripAwsDispatcherJob(generated[dispatcher]);
    }
  }
  for (const [file, workflow] of Object.entries(generated)) {
    assertValidWorkflowYaml(workflow, `delete workflow "${file}"`);
  }
  return generated;
}

/**
 * Remove the `aws:` job (and any contiguous comment lines directly above it)
 * from a dispatcher workflow. The extension only commits the Azure provider
 * workflow, so the dispatcher's `aws:` job — which `uses:` the never-committed
 * AWS provider file — would otherwise make GitHub reject the whole workflow with
 * a parse error (HTTP 422). Jobs are indented two spaces; the block runs until
 * the next two-space-indented key, a top-level key, or EOF.
 */
function stripAwsDispatcherJob(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^  aws:\s*$/.test(l));
  if (start === -1) return yaml;
  let from = start;
  while (from > 0 && /^  #/.test(lines[from - 1])) from--;
  // Drop a single blank separator line above the block, if present.
  if (from > 0 && lines[from - 1].trim() === "") from--;
  let to = start + 1;
  while (
    to < lines.length &&
    !/^  \S/.test(lines[to]) &&
    !/^\S/.test(lines[to])
  ) {
    to++;
  }
  lines.splice(from, to - from);
  return lines.join("\n");
}

/**
 * Remove the top-level `workflow_run:` trigger (and its preceding comment block)
 * from a GitHub Actions workflow YAML, leaving `workflow_dispatch` as the only
 * trigger. Operates on the `on:` mapping where triggers are indented two spaces
 * and their children deeper.
 */
function stripWorkflowRunTrigger(yaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^  workflow_run:\s*$/.test(l));
  if (start === -1) return yaml;
  // Include any contiguous comment lines directly above the trigger.
  let from = start;
  while (from > 0 && /^  #/.test(lines[from - 1])) from--;
  // Drop the trigger line and all more-deeply-indented child lines.
  let to = start + 1;
  while (
    to < lines.length &&
    (/^    /.test(lines[to]) || lines[to].trim() === "")
  ) {
    // Stop at a blank line that is followed by a non-child (keeps section spacing).
    if (
      lines[to].trim() === "" &&
      !(to + 1 < lines.length && /^    /.test(lines[to + 1]))
    )
      break;
    to++;
  }
  lines.splice(from, to - from);
  return lines.join("\n");
}
export function generatePortalUrl(
  resourceType: string,
  provider: string
): string {
  return coreGeneratePortalUrl(resourceType, provider);
}

// Repo path of the shared verify-credentials workflow the extension commits.
const VERIFY_WORKFLOW_PATH = ".github/workflows/radius-verify-credentials.yml";

/**
 * Re-fetch the upstream workflow templates and update any workflow files the
 * extension previously committed to `repo` whose content has drifted from
 * upstream (radius-project/radius `.github/extension/`).
 *
 * radius-project/radius is the single source of truth for the verify, deploy and
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
  const add = (path: string, content: string, provider: string | null) => {
    if (typeof content !== "string" || !content) return;
    if (onlySet && !onlySet.has(path.split("/").pop())) return;
    const list = byPath.get(path) || [];
    list.push({ content, provider });
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
          provider
        );
      } catch (e) {
        log(
          `skipped verify template for "${env.name}" (${provider}): ${errorMessage(e)}`
        );
      }
    }
    // Deploy + delete workflows are provider-agnostic (only the Azure provider
    // file is committed and the content doesn't vary by env provider), so
    // generate them once per environment with a null provider tag.
    try {
      const deploy = await generateDeployWorkflow(
        env.name,
        ".radius/app.bicep"
      );
      for (const [file, content] of Object.entries(deploy))
        add(wf(file), content, null);
    } catch (e) {
      log(`skipped deploy templates for "${env.name}": ${errorMessage(e)}`);
    }
    try {
      const del = await generateDeleteWorkflow(env.name);
      for (const [file, content] of Object.entries(del))
        add(wf(file), content, null);
    } catch (e) {
      log(`skipped delete templates for "${env.name}": ${errorMessage(e)}`);
    }
  }

  const updated = new Set<string>();
  const created = new Set<string>();
  const failed: WorkflowCommitFailure[] = [];
  // Cache branch-existence lookups so authoring missing files doesn't re-query
  // the same branch for every candidate path. A branch that isn't on the remote
  // (e.g. an unpushed working branch) must never be authored onto.
  const branchExists = new Map<string, boolean>();
  const remoteHasBranch = async (branch: string): Promise<boolean> => {
    if (branchExists.has(branch)) return branchExists.get(branch) as boolean;
    const exists = !!(await getBranchHeadSha(repo, branch));
    branchExists.set(branch, exists);
    return exists;
  };

  for (const branch of branches) {
    // The env-delete dispatcher (`delete-environment.yml`) hard-references its
    // reusable provider via `uses: ./.github/workflows/delete-environment-azure.yml`,
    // so the two static files must always be committed together. byPath is built
    // with the dispatcher inserted before the provider, so this flag is set while
    // the dispatcher is processed and read when the provider is reached: whenever
    // the dispatcher is present on a branch, author the provider too even in the
    // background pass (no `opts.create`), so a drift rewrite of the dispatcher can
    // never leave a dangling `uses:` reference behind.
    let envDeleteDispatcherPresent = false;
    for (const [path, candidates] of byPath.entries()) {
      const fileName = path.split("/").pop();
      const committed = await fetchFileFromRepo(repo, path, branch);
      const missing = committed == null || committed === "";
      if (missing) {
        // By default don't author missing files here (environment creation owns
        // that), and an unpushed working branch simply reads as "missing" and is
        // skipped. When `opts.create` is set, author the file so the workflow is
        // present on the branch it will run from — but only if the branch exists
        // on the remote, so we never author onto an unpushed working branch. The
        // env-delete provider is additionally force-authored when its dispatcher
        // is present (see envDeleteDispatcherPresent), since a committed
        // dispatcher without its provider is always a broken workflow; a
        // `workflow_call`-only provider never triggers a run on push, so
        // authoring it early is safe.
        const forceAuthorEnvDeleteProvider =
          fileName === DELETE_ENV_AZURE_FILE && envDeleteDispatcherPresent;
        if (!opts.create && !forceAuthorEnvDeleteProvider) continue;
        if (!(await remoteHasBranch(branch))) {
          log(`skipped creating ${path} on "${branch}" (branch not on remote)`);
          continue;
        }
        const choice = candidates[0];
        try {
          await commitFileToRepo(
            repo,
            path,
            choice.content,
            branch,
            `Add ${fileName} from upstream Radius workflow templates`
          );
          created.add(path);
          log(`created ${path} on "${branch}"`);
        } catch (e) {
          failed.push({ path, branch });
          log(`could not create ${path} on "${branch}": ${errorMessage(e)}`);
        }
        continue;
      }
      // The env-delete dispatcher is present on this branch, so its reusable
      // provider must be committed alongside it (see envDeleteDispatcherPresent).
      if (fileName === DELETE_ENV_DISPATCHER_FILE)
        envDeleteDispatcherPresent = true;
      // In sync if the committed copy matches any environment's generated
      // content — the only per-env difference is the cosmetic dispatch default.
      if (candidates.some((c) => c.content === committed)) continue;

      // Drift detected. Prefer a replacement whose provider matches the
      // committed file so the shared verify file keeps its current provider;
      // fall back to the first candidate (deploy/delete content is provider
      // agnostic, so any candidate is equivalent there).
      const committedProvider =
        /AZURE_/.test(committed) ? "azure"
        : /AWS_/.test(committed) ? "aws"
        : null;
      const choice =
        (committedProvider &&
          candidates.find((c) => c.provider === committedProvider)) ||
        candidates[0];
      try {
        await commitFileToRepo(
          repo,
          path,
          choice.content,
          branch,
          `Update ${fileName} to match upstream Radius workflow templates`
        );
        updated.add(path);
        log(`updated ${path} on "${branch}"`);
      } catch (e) {
        failed.push({ path, branch });
        log(`could not update ${path} on "${branch}": ${errorMessage(e)}`);
      }
    }
  }

  return {
    updated: [...updated],
    created: [...created],
    failed,
    branches,
    skipped: false
  };
}
