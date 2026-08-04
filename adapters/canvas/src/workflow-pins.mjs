// Canvas adapter — the Repo Radius workflow-pin gate.
//
// Before a deployment is dispatched, the `uses:` refs already committed in the
// user's repository are compared against the pinset this build of the extension
// requires. When they match, nothing happens at all: two file reads, no template
// fetch, no writes, no prompt. When they are stale the dispatch is withheld and
// the user is shown exactly what would change, because rewriting their workflows
// changes which code runs with their cloud credentials.
//
// Nothing in this module writes to a repository except applyWorkflowUpgrade, and
// that is only ever reached from an explicit confirmation.

import {
  REPO_RADIUS_PINSET,
  comparePins,
  describePlan,
  pinActionRefs,
} from "@radius-project/core";
import {
  commitFileToRepo,
  createBranchRef,
  createPullRequestApi,
  fetchFileFromRepo,
  getBranchHeadSha,
  getDefaultBranch,
  isProtectedBranchFailure,
  needsWorkflowScope,
} from "./gh.mjs";

const WORKFLOW_DIR = ".github/workflows";

/** `.github/workflows/<name>` for a bare workflow filename. */
export function workflowPath(name) {
  const bare = String(name || "").split("/").pop();
  return `${WORKFLOW_DIR}/${bare}`;
}

/**
 * Compare the workflow files committed in `repo` against the pinset.
 *
 * `files` is a list of bare workflow filenames that GATE the caller (e.g. the
 * deploy dispatcher plus its provider workflow). Branches: the repo's default
 * branch, because Repo Radius runs from there, plus `opts.deployRef` when a
 * worktree-consistent deploy will dispatch against a different branch and would
 * therefore check out that branch's copy.
 *
 * `opts.alsoUpgrade` names workflows that must never gate the caller but should
 * still be repaired — the delete workflows, which also run with `id-token:
 * write` yet must stay usable even when their pins are stale, or a user could
 * be left unable to tear down cloud resources. They are read only once the
 * gating files are already outdated, so the common case still costs one read per
 * gating file and the user's single confirmation fixes every workflow at once
 * instead of leaving these frozen at whatever SHA created them.
 *
 * Read-only. Resolves `{ status, repo, base, targets, files }` where `status` is
 * `"current"` when there is nothing to do. A branch whose files can't be read
 * (unpushed, or a transient API failure) contributes nothing rather than
 * blocking: a GitHub outage must not stop a deploy that would otherwise work.
 */
export async function planWorkflowUpgrade(repo, files, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const paths = (files || []).filter(Boolean).map(workflowPath);
  if (!repo || paths.length === 0) return emptyPlan(repo, "");
  const alsoPaths = (opts.alsoUpgrade || []).filter(Boolean).map(workflowPath).filter((p) => !paths.includes(p));

  const base = (await getDefaultBranch(repo)) || "main";
  const deployRef = (opts.deployRef || "").trim();
  const branches = deployRef && deployRef !== base ? [base, deployRef] : [base];

  const readPins = async (branch, list) => {
    const committed = {};
    for (const path of list) {
      const body = await fetchFileFromRepo(repo, path, branch);
      if (body) committed[path] = body;
    }
    return comparePins(committed, REPO_RADIUS_PINSET);
  };

  const targets = [];
  for (const branch of branches) {
    const plan = await readPins(branch, paths);
    if (plan.status === "current") continue;
    const alsoPlan = alsoPaths.length ? await readPins(branch, alsoPaths) : { files: [] };
    targets.push({
      branch,
      headSha: await getBranchHeadSha(repo, branch),
      files: [...plan.files, ...alsoPlan.files],
    });
  }

  if (targets.length === 0) return emptyPlan(repo, base);

  // Union of the per-branch file lists, for rendering and for the commit body.
  // Branches can be stale in different ways (one pinned to an old SHA, another
  // still on a moving ref), so changes are unioned per file rather than taking
  // the first branch's list — everything applyWorkflowUpgrade will write has to
  // be something the user was shown. Identical changes across branches collapse
  // to one line.
  const merged = new Map();
  for (const target of targets) {
    for (const file of target.files) {
      const entry = merged.get(file.path) || { path: file.path, changes: [] };
      for (const change of file.changes) {
        const seen = entry.changes.some(
          (c) => c.target === change.target && c.from.ref === change.from.ref && c.to.sha === change.to.sha,
        );
        if (!seen) entry.changes.push(change);
      }
      merged.set(file.path, entry);
    }
  }
  const plan = {
    status: "outdated",
    repo,
    base,
    targets,
    files: [...merged.values()],
  };
  for (const line of describePlan(plan)) log(line);
  return plan;
}

function emptyPlan(repo, base) {
  return { status: "current", repo: repo || "", base: base || "", targets: [], files: [] };
}

/** Human-readable one-liner naming the versions involved, for prompts and logs. */
export function summarizePlan(plan) {
  const versions = new Set();
  for (const file of plan.files || []) {
    for (const change of file.changes) versions.add(`${change.from.version || change.from.ref} → ${change.to.version}`);
  }
  const count = (plan.files || []).length;
  return `${count} workflow file${count === 1 ? "" : "s"} (${[...versions].join(", ")})`;
}

function commitMessage(plan) {
  return [
    "Update Radius workflow action pins",
    "",
    ...describePlan(plan),
    "",
    "Pins every Repo Radius `uses:` to an exact commit SHA so deployments are",
    "reproducible. Applied by the Radius Canvas extension after confirmation.",
  ].join("\n");
}

/**
 * Rewrite one workflow file's action refs on `branch`.
 *
 * The committed body is re-read and re-pinned rather than regenerated from the
 * upstream template, so the diff is exactly the `uses:` lines and any local edit
 * the user made to their workflow survives. `pinActionRefs` is idempotent, so a
 * retried apply is a no-op rather than a conflict.
 *
 * Resolves `{ changed, ok, stderr }`; never throws.
 */
async function pinFileOnBranch(repo, path, branch, message) {
  const body = await fetchFileFromRepo(repo, path, branch);
  if (!body) return { changed: false, ok: true, stderr: "" };
  const pinned = pinActionRefs(body, REPO_RADIUS_PINSET);
  if (pinned === body) return { changed: false, ok: true, stderr: "" };
  try {
    await commitFileToRepo(repo, path, pinned, branch, message);
    return { changed: true, ok: true, stderr: "" };
  } catch (e) {
    return { changed: false, ok: false, stderr: (e?.message || String(e)).trim() };
  }
}

/**
 * Apply a plan the user has confirmed.
 *
 * `mode` is `"commit"` (write to the branches the plan targets) or
 * `"pull-request"` (open one pull request into `opts.branch`, defaulting to the
 * default branch). The two are separate confirmations on purpose: opening a
 * pull request is itself a visible action on a shared repository, so a rejected
 * direct commit reports back and waits rather than silently escalating.
 *
 * `opts.branch` is the branch a previous call reported as protected. A deploy
 * can target a non-default branch, and that branch can be the protected one, so
 * the pull request has to land on whichever branch refused the commit — a pull
 * request into the default branch would leave the deploy ref unrepaired.
 *
 * `expectedHeadSha` must still match each target branch's head — the plan the
 * user approved is the plan that gets applied, never a repository state they
 * never saw.
 *
 * Resolves one of:
 * - `{ status: "updated", updated: [...] }` — safe to deploy.
 * - `{ status: "needs-pull-request", branch, detail }` — protected; offer the PR.
 * - `{ status: "blocked", reason, detail, url? }` — deployment must not proceed.
 * - `{ status: "stale-plan", detail }` — branch moved; recompute and re-show.
 */
export async function applyWorkflowUpgrade(repo, plan, mode, opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  if (!plan || plan.status !== "outdated") return { status: "updated", updated: [] };

  const message = commitMessage(plan);

  for (const target of plan.targets) {
    const head = await getBranchHeadSha(repo, target.branch);
    if (target.headSha && head && head !== target.headSha) {
      return {
        status: "stale-plan",
        detail: `"${target.branch}" moved from ${target.headSha.slice(0, 7)} to ${head.slice(0, 7)} while the update was being reviewed.`,
      };
    }
  }

  if (mode === "pull-request") return openUpgradePullRequest(repo, plan, message, log, opts.branch || "");

  const updated = [];
  for (const target of plan.targets) {
    for (const file of target.files) {
      const result = await pinFileOnBranch(repo, file.path, target.branch, message);
      if (result.ok) {
        if (result.changed) {
          updated.push(`${file.path} on "${target.branch}"`);
          log(`updated ${file.path} on "${target.branch}"`);
        }
        continue;
      }
      if (needsWorkflowScope(result.stderr)) {
        return {
          status: "blocked",
          reason: "missing-workflow-scope",
          detail: result.stderr,
          updated,
        };
      }
      if (isProtectedBranchFailure(result.stderr)) {
        return {
          status: "needs-pull-request",
          detail: result.stderr,
          branch: target.branch,
          updated,
        };
      }
      return { status: "blocked", reason: "no-permission", detail: result.stderr, updated };
    }
  }
  return { status: "updated", updated };
}

/**
 * Commit the updated workflows to a fresh branch and open a pull request into
 * `prBase` — the branch that refused the direct commit, which is the default
 * branch unless the deploy targets a protected non-default branch.
 *
 * The deployment does NOT proceed on success: until the pull request merges, the
 * updated workflows are not on the branch the run would read them from. Saying
 * that plainly beats dispatching a run that would execute the old actions.
 */
async function openUpgradePullRequest(repo, plan, message, log, prBase) {
  const base = prBase || plan.base || (await getDefaultBranch(repo)) || "main";
  const baseSha = await getBranchHeadSha(repo, base);
  if (!baseSha) {
    return {
      status: "blocked",
      reason: "no-permission",
      detail: `Could not resolve the head of base branch "${base}".`,
    };
  }
  const branch = `radius/upgrade-workflows-${Date.now()}`;
  const created = await createBranchRef(repo, branch, baseSha);
  if (!created.ok) {
    return {
      status: "blocked",
      reason: "no-permission",
      detail: `Could not create branch "${branch}": ${created.stderr}`,
    };
  }

  // The pull request carries the changes for the branch it lands on; another
  // branch's copy of the same file can be stale in a different way.
  const target = plan.targets.find((t) => t.branch === base) || plan.targets[0];
  const committed = [];
  for (const file of target.files) {
    const result = await pinFileOnBranch(repo, file.path, branch, message);
    if (!result.ok) {
      return {
        status: "blocked",
        reason: "no-permission",
        detail: `Could not commit ${file.path} to "${branch}": ${result.stderr}`,
      };
    }
    if (result.changed) committed.push(file.path);
  }

  const body = [
    "Updates the Repo Radius GitHub Actions pinned in this repository's workflows.",
    "",
    "```text",
    ...describePlan(plan),
    "```",
    "",
    "Every `uses:` is pinned to an exact commit SHA so each workflow run executes",
    "identical action code. Opened by the Radius Canvas extension after the change",
    "was confirmed; deployments resume once this is merged.",
  ].join("\n");
  const pr = await createPullRequestApi(repo, branch, base, "Update Radius workflow action pins", body);
  if (!pr.ok) {
    return {
      status: "blocked",
      reason: "no-permission",
      detail: `Could not open a pull request from "${branch}" into "${base}": ${pr.stderr}`,
    };
  }
  log(`opened ${pr.url} with ${committed.length} workflow file(s)`);
  return { status: "blocked", reason: "pull-request-open", url: pr.url, number: pr.number, updated: committed };
}
