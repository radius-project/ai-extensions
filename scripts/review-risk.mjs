import { appendFileSync, readFileSync } from "node:fs";
import { isMainModule } from "./module-entry.mjs";

export const POLICY_VERSION = 1;
export const COMMENT_MARKER = "<!-- radius-review-risk:v1 -->";
export const LABELS = Object.freeze({
  low: {
    name: "risk:low",
    color: "0e8a16",
    description:
      "Advisory: explicit low-risk paths only; human review required."
  },
  medium: {
    name: "risk:medium",
    color: "fbca04",
    description: "Advisory: ordinary or unknown paths; human review required."
  },
  high: {
    name: "risk:high",
    color: "b60205",
    description:
      "Advisory: sensitive paths; human and manual Max review expected."
  },
  instructions: {
    name: "review-instructions-changed",
    color: "d93f0b",
    description:
      "Disregard Copilot's assessment; a human must read changed review controls."
  }
});
const TIERS = ["low", "medium", "high"];
const FILE_LIMIT = 3000;
const COMMENT_LIMIT = 65536;
const BOT = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "labeled",
  "unlabeled"
];

// This is the only executable path policy. High matches always beat Low.
export const PATH_RULES = [
  {
    pattern: /(^|\/)(AGENTS\.md|copilot-instructions\.md)$/,
    tier: "high",
    warning: true,
    reason: "Agent instructions"
  },
  {
    pattern: /^\.github\/(instructions|skills|prompts)\//,
    tier: "high",
    warning: true,
    reason: "Contributor review instructions"
  },
  {
    pattern: /^extensions\/[^/]+\/skills\//,
    tier: "high",
    warning: true,
    reason: "Shipped agent instructions and helpers"
  },
  {
    pattern:
      /^(docs\/eng\/REVIEW_POLICY\.md|docs\/design\/2026-10-ai-assisted-review-plan\.md|CONTRIBUTING\.md|scripts\/(?:review-risk|module-entry)\.mjs|\.github\/workflows\/review-risk\.yml|packages\/adapter-canvas\/test\/ci\/(?:review-risk[^/]*|module-entry)\.test\.mjs)$/,
    tier: "high",
    warning: true,
    reason: "Review policy and classifier controls"
  },
  {
    pattern:
      /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|\.npmrc|\.pnpmfile\.cjs|\.node-version|\.nvmrc|coverage-baseline\.json|(?:eslint|vitest|playwright)[^/]*config\.[^/]+|tsconfig[^/]*\.json)$/,
    tier: "high",
    warning: true,
    reason: "Dependency, execution and verification controls"
  },
  {
    pattern:
      /^\.changeset\/(?![^/]+\.md$)|(^|\/)(Dockerfile[^/]*|\.dockerignore|action\.ya?ml)$/,
    tier: "high",
    reason: "Release configuration or executable build/action input"
  },
  {
    pattern: /^\.github\//,
    tier: "high",
    reason: "Repository or shipped automation"
  },
  {
    pattern: /^(scripts|build)\//,
    tier: "high",
    reason: "Build, publication and credentialed execution inputs"
  },
  {
    pattern: /^packages\/[^/]+\/build\.[^/]+$/,
    tier: "high",
    reason: "Package build entry point"
  },
  {
    pattern: /^plugins\/[^/]+\/plugin\.json$|^marketplace\.json$/,
    tier: "high",
    reason: "Published plugin metadata"
  },
  {
    pattern:
      /^packages\/core\/src\/(platforms\/|workflows\/|setup-[^/]+|credential-redaction\.[^/]+$)|^packages\/adapter-shared\/src\/(?:setup-[^/]+|deployment-[^/]+|(?:(?:production|runtime)-deployment|ghcr-bootstrap)\.[^/]+$)/,
    tier: "high",
    reason: "Platform, identity and workflow generation/publication"
  },
  {
    pattern:
      /^packages\/adapter-canvas\/src\/(azure-[^/]+|credential-[^/]+|github-[^/]+|gh(?:\.|-)[^/]*|ghcr[^/]*|(?:shared|deploy)\.[^/]+$|operations(?:\.|-)[^/]*|publish-targets[^/]*|infra[^/]*|verification-plan[^/]*|runtime\/(?:environment-account-context|production-github-account-context|production-deployment|deployment-(?:tools|account))[^/]*|server\/(?:routes\/(?:azure-[^/]+|setup-[^/]+|create-environment-[^/]+|(?:identity-auth|aws-discovery|deployments)\.[^/]+$|graphs-planning-writes[^/]*|graph-workflows[^/]*)|services\/(?:aws-[^/]+|azure-[^/]+|github-[^/]+|setup-[^/]+|workflow-[^/]+|branch-[^/]+|recovered-branch-delete[^/]*|pull-request-url[^/]*|gh-command-result[^/]*|configure-environment[^/]*|environment-deletion[^/]*|radius-environment-workflow-deletion[^/]*|deploy(?:ment)?-[^/]*)))/,
    tier: "high",
    reason: "Credential, cloud and workflow publication boundary"
  },
  {
    pattern: /^packages\/adapter-canvas\/test\/(e2e-cloud|ci)\//,
    tier: "high",
    reason: "Privileged cloud suite or CI contracts"
  },
  {
    pattern:
      /^packages\/adapter-canvas\/test\/(?:e2e\/(?:global-(?:setup|teardown)\.ts|support\/canvas-harness[^/]*\.ts)|support\/(?:azure-discovery-contract[^/]*|server\/(?:production-runtime|deployment-runtime)[^/]*)\.ts)$/,
    tier: "high",
    reason: "Shared credentialed-cloud execution and fixture inputs"
  },
  {
    pattern:
      /^(README\.md|LICENSE|CODE_OF_CONDUCT\.md|SECURITY\.md)$|^docs\/(?:architecture|design|eng)\/.+\.md$|^\.changeset\/[^/]+\.md$/,
    tier: "low",
    reason: "Recognized ordinary documentation or release note"
  },
  {
    pattern:
      /^packages\/[^/]+\/(?:src\/.+\.test\.ts|test\/(?:component|fixtures|support|integration|e2e)\/.+)$/,
    tier: "low",
    reason: "Enumerated credential-free tests and fixtures"
  },
  {
    pattern:
      /^packages\/adapter-canvas\/test\/visual\/__screenshots__\/.+\.png$|^plugins\/[^/]+\/assets\/[^/]+\.(?:png|jpg|svg)$/,
    tier: "low",
    reason: "Recognized copy-only image or visual baseline"
  }
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integer(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function sha(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function pathName(value) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Malformed repository-relative path"
  );
  return value;
}

export function classify(files) {
  requireValue(
    Array.isArray(files) && files.length > 0 && files.length <= FILE_LIMIT,
    "Changed files must be a nonempty complete list of at most 3000 records"
  );
  const paths = new Set();
  const names = new Set();
  for (const file of files) {
    requireValue(
      record(file) &&
        [
          "added",
          "removed",
          "modified",
          "renamed",
          "copied",
          "changed",
          "unchanged"
        ].includes(file.status),
      "Malformed changed-file record"
    );
    const name = pathName(file.filename);
    requireValue(!names.has(name), "Duplicate changed-file record");
    names.add(name);
    paths.add(name);
    if (file.status === "renamed")
      requireValue(
        typeof file.previous_filename === "string",
        "Rename lacks previous filename"
      );
    if (file.previous_filename !== undefined)
      paths.add(pathName(file.previous_filename));
  }
  const details = [...paths].sort().map((path) => {
    const matches = PATH_RULES.filter((rule) => rule.pattern.test(path));
    const tier =
      matches.some((rule) => rule.tier === "high") ? "high"
      : (
        matches.some((rule) => rule.tier === "low") &&
        !path.endsWith(".live.test.ts")
      ) ?
        "low"
      : "medium";
    return {
      path,
      tier,
      reasons:
        tier === "medium" ?
          ["Unmatched or ordinary production path (Medium fallback)"]
        : matches
            .filter((rule) => rule.tier === tier)
            .map((rule) => rule.reason),
      warning: matches.some((rule) => rule.warning === true)
    };
  });
  return {
    tier: TIERS[
      Math.max(...details.map((detail) => TIERS.indexOf(detail.tier)))
    ],
    details,
    highPaths: details
      .filter((detail) => detail.tier === "high")
      .map((detail) => detail.path),
    warningPaths: details
      .filter((detail) => detail.warning)
      .map((detail) => detail.path)
  };
}

export function escapeDisplay(value) {
  return String(value).replace(
    /[&<>"'@`\\*_[\]{}()!|~\p{C}\p{Zl}\p{Zp}]/gu,
    (character) => `&#${character.codePointAt(0)};`
  );
}

function reportLinks(repository, policySha) {
  return `[Review guidance](https://github.com/${repository}/blob/${policySha}/docs/design/2026-10-ai-assisted-review-plan.md#phase-4-scale-human-approval-to-risk) | [Advisory workflow](https://github.com/${repository}/actions/workflows/review-risk.yml)`;
}

function metadata(snapshot, policySha) {
  return `Inspected head: ${snapshot.head}; base branch: ${escapeDisplay(snapshot.base)}; trusted policy: v${POLICY_VERSION} at ${policySha}.`;
}

export function renderAdvisory(result, snapshot, policySha, repository) {
  const lines = [
    COMMENT_MARKER,
    `## Advisory review risk: ${result.tier.toUpperCase()}`,
    "",
    "The highest tier across every changed path (including old rename names) applies. Unknown paths are Medium; Low requires an explicit match.",
    "",
    "**One qualifying approvers-team human approval remains required for every tier.** Stage 4 does not verify membership or approval validity.",
    ...(result.tier === "high" ?
      [
        "High additionally calls for a **manually requested Max review**, not a second human approval. This workflow does not request paid reviews."
      ]
    : []),
    "",
    ...(result.warningPaths.length ?
      [
        "**Disregard Copilot's assessment. A human must read the changed reviewer instructions and policy controls:**",
        ...result.warningPaths.map((path) => `- ${escapeDisplay(path)}`),
        ""
      ]
    : []),
    "### Changed High paths",
    ...(result.highPaths.length ?
      result.details
        .filter((detail) => detail.tier === "high")
        .map(
          (detail) =>
            `- ${escapeDisplay(detail.path)}: ${detail.reasons.join("; ")}`
        )
    : ["None."]),
    "",
    "**Labels and this comment are advisory, not merge authorization or a required merge check.** A path tier does not establish that a change is safe.",
    reportLinks(repository, policySha),
    "",
    metadata(snapshot, policySha)
  ];
  const body = lines.join("\n");
  if (Buffer.byteLength(body, "utf8") > COMMENT_LIMIT) {
    const error = new Error(
      "Complete advisory exceeds the conservative 65536-byte budget within GitHub's comment character limit; full report follows in execution evidence"
    );
    error.fullReport = body;
    throw error;
  }
  return body;
}

export function eventContext(env, event) {
  requireValue(
    record(event) && record(event.repository),
    "Missing event repository"
  );
  const repository = env.GITHUB_REPOSITORY;
  requireValue(
    typeof repository === "string" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
      event.repository.full_name === repository &&
      integer(event.repository.id),
    "Unexpected event repository identity"
  );
  requireValue(
    typeof event.repository.default_branch === "string" &&
      event.repository.default_branch.length > 0 &&
      env.GITHUB_REF === `refs/heads/${event.repository.default_branch}`,
    "Workflow must execute from the default-branch ref"
  );
  requireValue(
    sha(env.GITHUB_WORKFLOW_SHA) && env.GITHUB_SHA === env.GITHUB_WORKFLOW_SHA,
    "Workflow and checked-out policy must share an immutable default-branch SHA"
  );
  let number;
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    requireValue(
      record(event.inputs) &&
        typeof event.inputs.pr === "string" &&
        /^[0-9]+$/.test(event.inputs.pr),
      "Manual dispatch requires one numeric PR input"
    );
    number = Number(event.inputs.pr);
  } else {
    requireValue(
      env.GITHUB_EVENT_NAME === "pull_request_target" &&
        ACTIONS.includes(event.action),
      "Unsupported review-risk event"
    );
    number = event.number;
    requireValue(
      record(event.pull_request) && event.pull_request.number === number,
      "Event PR identity mismatch"
    );
    if (event.action === "labeled" || event.action === "unlabeled") {
      requireValue(
        record(event.label) &&
          Object.values(LABELS).some(
            (label) => label.name === event.label.name
          ),
        "Unrelated label event must be skipped by the advisory job"
      );
    }
  }
  requireValue(integer(number), "Invalid PR number");
  return {
    repository,
    repositoryId: event.repository.id,
    defaultBranch: event.repository.default_branch,
    number,
    policySha: env.GITHUB_WORKFLOW_SHA
  };
}

function apiClient(fetch, token, repository, repositoryId) {
  requireValue(
    typeof token === "string" && token.trim().length > 0,
    "Missing GitHub token"
  );
  const prefix = `https://api.github.com/repos/${repository}`;
  async function request(method, path, body) {
    let response;
    try {
      response = await fetch(`${prefix}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30000)
      });
    } catch {
      throw new Error(
        `${method} ${path}: transport failed; write outcome may be uncertain; no automatic retry`
      );
    }
    requireValue(
      response.ok,
      `${method} ${path}: GitHub HTTP ${response.status}`
    );
    if (response.status === 204) return { data: undefined, link: null };
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        `${method} ${path}: malformed JSON response; write outcome may be uncertain`
      );
    }
    return { data, link: response.headers.get("link") };
  }
  async function pages(path, maxPages) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const { data, link } = await request(
        "GET",
        `${path}?per_page=100&page=${page}`
      );
      requireValue(
        Array.isArray(data) && data.length <= 100,
        `Malformed paginated response: ${path}`
      );
      items.push(...data);
      let next = false;
      if (link !== null) {
        const relations = new Set();
        for (const part of link.split(",")) {
          const match = part
            .trim()
            .match(/^<([^>]+)>; rel="(next|prev|first|last)"$/);
          requireValue(
            match && !relations.has(match[2]),
            `Malformed pagination Link: ${path}`
          );
          relations.add(match[2]);
          const url = new URL(match[1]);
          requireValue(
            url.origin === "https://api.github.com" &&
              [
                `/repos/${repository}${path}`,
                `/repositories/${repositoryId}${path}`
              ].includes(url.pathname) &&
              !url.username &&
              !url.password &&
              !url.hash &&
              [...url.searchParams].length === 2 &&
              url.searchParams.get("per_page") === "100" &&
              /^[1-9][0-9]*$/.test(url.searchParams.get("page")),
            `Unexpected pagination URL: ${path}`
          );
          if (match[2] === "next") {
            requireValue(
              Number(url.searchParams.get("page")) === page + 1 &&
                data.length === 100,
              `Incomplete pagination: ${path}`
            );
            next = true;
          }
        }
      }
      if (!next) return items;
    }
    throw new Error(`Pagination exceeds API/safety limit: ${path}`);
  }
  return { request, pages };
}

function snapshot(data, context) {
  requireValue(
    record(data) &&
      integer(data.id) &&
      data.number === context.number &&
      data.url ===
        `https://api.github.com/repos/${context.repository}/pulls/${context.number}` &&
      record(data.base) &&
      record(data.base.repo) &&
      data.base.repo.full_name === context.repository &&
      data.base.repo.id === context.repositoryId,
    "PR repository/number identity mismatch"
  );
  requireValue(data.state === "open", "PR is not open");
  requireValue(
    record(data.head) &&
      sha(data.head.sha) &&
      sha(data.base.sha) &&
      typeof data.base.ref === "string" &&
      data.base.ref.length > 0 &&
      Number.isSafeInteger(data.changed_files) &&
      data.changed_files >= 0 &&
      Number.isSafeInteger(data.comments) &&
      data.comments >= 0 &&
      Array.isArray(data.labels) &&
      data.labels.every(
        (label) => record(label) && typeof label.name === "string"
      ),
    "Malformed PR snapshot"
  );
  const labels = data.labels.map((label) => label.name);
  requireValue(new Set(labels).size === labels.length, "Duplicate PR labels");
  return {
    id: data.id,
    head: data.head.sha,
    base: data.base.ref,
    baseSha: data.base.sha,
    count: data.changed_files,
    commentCount: data.comments,
    labels
  };
}

function sameSnapshot(before, after) {
  requireValue(
    before.id === after.id &&
      before.head === after.head &&
      before.base === after.base &&
      before.baseSha === after.baseSha &&
      before.count === after.count,
    "PR snapshot changed (head/base branch/base commit/count); stop and use the current event or manual recovery; no reevaluation loop"
  );
}

function ownedComment(comments, context) {
  const ids = new Set();
  for (const comment of comments) {
    requireValue(
      record(comment) &&
        integer(comment.id) &&
        typeof comment.body === "string" &&
        record(comment.user) &&
        integer(comment.user.id) &&
        typeof comment.user.login === "string" &&
        typeof comment.user.type === "string" &&
        comment.issue_url ===
          `https://api.github.com/repos/${context.repository}/issues/${context.number}` &&
        !ids.has(comment.id),
      "Malformed/duplicate comment identity"
    );
    ids.add(comment.id);
  }
  const owned = comments.filter(
    (comment) =>
      comment.body.startsWith(`${COMMENT_MARKER}\n`) &&
      Object.entries(BOT).every(([key, value]) => comment.user[key] === value)
  );
  requireValue(
    owned.length <= 1,
    "Ambiguous duplicate bot-owned advisory comments"
  );
  return owned[0];
}

export async function reconcile(context, { fetch, token }) {
  const api = apiClient(fetch, token, context.repository, context.repositoryId);
  const prPath = `/pulls/${context.number}`;
  const issuePath = `/issues/${context.number}`;
  const mutations = [];
  const evidence = {
    policyVersion: POLICY_VERSION,
    policySha: context.policySha,
    repository: context.repository,
    number: context.number,
    mutations
  };
  const readSnapshot = async () =>
    snapshot((await api.request("GET", prPath)).data, context);
  const readComment = async (count) => {
    const comments = await api.pages(`${issuePath}/comments`, 100);
    requireValue(
      comments.length === count,
      "Comment count mismatch; incomplete or changing comment list"
    );
    return ownedComment(comments, context);
  };
  const write = async (method, path, body) => {
    mutations.push({
      method,
      path,
      ...(body?.labels ? { labels: body.labels } : {}),
      state: "attempted; outcome not confirmed"
    });
    const result = await api.request(method, path, body);
    mutations[mutations.length - 1].state = "confirmed HTTP success";
    return result;
  };
  let initial;
  let preparing = true;
  try {
    const repo = (await api.request("GET", "")).data;
    requireValue(
      record(repo) &&
        repo.id === context.repositoryId &&
        repo.full_name === context.repository &&
        repo.default_branch === context.defaultBranch,
      "Live repository identity/default branch mismatch"
    );
    initial = await readSnapshot();
    evidence.inspected = initial;
    const comment = await readComment(initial.commentCount);
    requireValue(
      initial.count > 0 && initial.count <= FILE_LIMIT,
      "PR files API cannot provide a complete nonempty diff (maximum 3000 files)"
    );
    const files = await api.pages(`${prPath}/files`, 30);
    requireValue(
      files.length === initial.count,
      "Changed-file count mismatch; incomplete diff"
    );
    const result = classify(files);
    evidence.classification = result;
    const body = renderAdvisory(
      result,
      initial,
      context.policySha,
      context.repository
    );
    // Definitions are admin-bootstrapped, not created by this privileged writer.
    for (const label of Object.values(LABELS)) {
      let definition;
      try {
        definition = (
          await api.request("GET", `/labels/${encodeURIComponent(label.name)}`)
        ).data;
      } catch (error) {
        throw new Error(
          `Cannot verify label definition ${label.name}; authorized admin must bootstrap the four owned labels: ${error.message}`,
          { cause: error }
        );
      }
      requireValue(
        record(definition) && definition.name === label.name,
        `Missing/malformed label definition ${label.name}; authorized admin must bootstrap the four owned labels`
      );
    }
    const before = await readSnapshot();
    preparing = false;
    sameSnapshot(initial, before);
    const wanted = [
      LABELS[result.tier].name,
      ...(result.warningPaths.length ? [LABELS.instructions.name] : [])
    ];
    for (const name of wanted.filter((name) => !before.labels.includes(name))) {
      await write("POST", `${issuePath}/labels`, { labels: [name] });
    }
    for (const name of Object.values(LABELS)
      .map((label) => label.name)
      .filter(
        (name) => !wanted.includes(name) && before.labels.includes(name)
      )) {
      await write("DELETE", `${issuePath}/labels/${encodeURIComponent(name)}`);
    }
    // Re-read authorship immediately before editing; human/spoofed comments are never ours.
    const currentComment = await readComment(before.commentCount);
    requireValue(
      currentComment?.id === comment?.id,
      "Owned advisory changed during reconciliation"
    );
    if (currentComment?.body !== body) {
      if (currentComment)
        await write("PATCH", `/issues/comments/${currentComment.id}`, { body });
      else await write("POST", `${issuePath}/comments`, { body });
    }
    const after = await readSnapshot();
    sameSnapshot(initial, after);
    requireValue(
      Object.values(LABELS).every(
        (label) =>
          after.labels.includes(label.name) === wanted.includes(label.name)
      ),
      "Owned label read-back mismatch"
    );
    requireValue(
      (await readComment(after.commentCount))?.body === body,
      "Advisory comment read-back mismatch"
    );
    evidence.status = "reconciled";
    return evidence;
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error.message;
    if (error.fullReport) evidence.fullReport = error.fullReport;
    if (initial && preparing) {
      evidence.cleanup = [];
      try {
        const current = await readSnapshot();
        sameSnapshot(initial, current);
        for (const tier of TIERS) {
          const name = LABELS[tier].name;
          if (!current.labels.includes(name)) continue;
          try {
            await write(
              "DELETE",
              `${issuePath}/labels/${encodeURIComponent(name)}`
            );
          } catch (cleanupError) {
            evidence.cleanup.push(cleanupError.message);
          }
        }
        try {
          const comment = await readComment(current.commentCount);
          if (comment) {
            const body = `${COMMENT_MARKER}\n## Advisory unavailable\n\nThe tier could not be verified. **Human review remains required.** Disregard any stale risk labels or prior assessment. The instruction warning is preserved until successful classification.\n\n${reportLinks(context.repository, context.policySha)}\n\n${metadata(initial, context.policySha)}`;
            if (comment.body !== body)
              await write("PATCH", `/issues/comments/${comment.id}`, { body });
          }
        } catch (cleanupError) {
          evidence.cleanup.push(cleanupError.message);
        }
      } catch (cleanupError) {
        evidence.cleanup.push(
          `Cleanup not safe/available: ${cleanupError.message}`
        );
      }
    }
    if (initial) {
      try {
        const residual = await readSnapshot();
        evidence.residualLabels = residual.labels;
        evidence.residualComment =
          (await readComment(residual.commentCount))?.body ?? null;
        evidence.staleTierLabels = residual.labels.filter((name) =>
          TIERS.some((tier) => LABELS[tier].name === name)
        );
      } catch (readError) {
        evidence.residualState = `Unknown; stale advisory may remain: ${readError.message}`;
      }
    }
    error.evidence = evidence;
    throw error;
  }
}

export async function runReviewRisk(
  env,
  event,
  { fetch = globalThis.fetch, report } = {}
) {
  if (env.REVIEW_RISK_ENABLED !== "true") {
    const result = {
      status: "disabled",
      reason:
        "REVIEW_RISK_ENABLED startup snapshot is not true; no API calls or mutations"
    };
    report?.(result);
    return result;
  }
  let result;
  try {
    const context = eventContext(env, event);
    result = await reconcile(context, { fetch, token: env.GITHUB_TOKEN });
  } catch (error) {
    report?.(error.evidence ?? { status: "failed", error: error.message });
    throw error;
  }
  report?.(result);
  return result;
}

export function renderEvidence(evidence, runUrl) {
  // Indented JSON is inert Markdown, including hostile filenames and API metadata.
  const json = JSON.stringify(evidence, null, 2).replace(
    /[\p{C}\p{Zl}\p{Zp}]/gu,
    (character) =>
      character === "\n" ? character : (
        character
          .split("")
          .map(
            (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`
          )
          .join("")
      )
  );
  return `# Review risk execution evidence\n\n${runUrl ? `Run: ${escapeDisplay(runUrl)}\n\n` : ""}${json
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")}\n`;
}

export async function reviewRiskMain(env, fetch = globalThis.fetch) {
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    await runReviewRisk(env, event, {
      fetch,
      report: (evidence) => {
        const report = renderEvidence(
          evidence,
          `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        );
        if (env.GITHUB_STEP_SUMMARY) {
          // GitHub summaries have a 1 MiB limit. Never silently lose a full overflow report.
          if (Buffer.byteLength(report) > 1024 * 1024) {
            process.stdout.write(report);
            throw new Error(
              "Complete evidence exceeds step-summary limit; complete escaped report emitted to job log"
            );
          }
          appendFileSync(env.GITHUB_STEP_SUMMARY, report);
        } else process.stdout.write(report);
      }
    });
    return 0;
  } catch (error) {
    process.stderr.write(
      `Review risk failed: ${escapeDisplay(error.message)}. Inspect execution evidence. No approval or merge authorization was granted.\n`
    );
    return 1;
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  process.exitCode = await reviewRiskMain(process.env);
}
