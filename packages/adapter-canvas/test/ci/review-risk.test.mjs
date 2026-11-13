import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classify,
  COMMENT_MARKER,
  escapeDisplay,
  eventContext,
  LABELS,
  reconcile,
  renderAdvisory,
  renderEvidence,
  reviewRiskMain,
  runReviewRisk
} from "../../../../scripts/review-risk.mjs";

const HEAD = "a".repeat(40);
const POLICY = "b".repeat(40);
const BASE = "c".repeat(40);
const context = {
  repository: "owner/repo",
  repositoryId: 7,
  defaultBranch: "main",
  number: 12,
  policySha: POLICY
};
const env = {
  REVIEW_RISK_ENABLED: "true",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: POLICY,
  GITHUB_WORKFLOW_SHA: POLICY,
  GITHUB_EVENT_NAME: "pull_request_target",
  GITHUB_TOKEN: "offline-test-only"
};
const event = {
  repository: { full_name: "owner/repo", id: 7, default_branch: "main" },
  number: 12,
  pull_request: { number: 12 },
  action: "opened"
};
const file = (filename, extra = {}) => ({
  filename,
  status: "modified",
  ...extra
});
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fakeApi({
  files = [file("README.md")],
  labels = ["pr:ready"],
  comments = [],
  count = files.length,
  intercept
} = {}) {
  const state = {
    repo: { id: 7, full_name: "owner/repo", default_branch: "main" },
    pr: {
      id: 42,
      number: 12,
      url: "https://api.github.com/repos/owner/repo/pulls/12",
      state: "open",
      head: { sha: HEAD },
      base: {
        ref: "main",
        sha: BASE,
        repo: { full_name: "owner/repo", id: 7 }
      },
      changed_files: count,
      comments: comments.length,
      labels: labels.map((name) => ({ name }))
    },
    comments: structuredClone(comments),
    files: structuredClone(files),
    calls: []
  };
  const response = (data, status = 200, headers = {}) =>
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers
    });
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.github.com");
    expect(options.headers.authorization).toBe("Bearer offline-test-only");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const path = parsed.pathname.replace("/repos/owner/repo", "");
    const body =
      options.body === undefined ? undefined : JSON.parse(options.body);
    const call = {
      method: options.method,
      path,
      page: Number(parsed.searchParams.get("page")),
      body
    };
    state.calls.push(call);
    const override = await intercept?.(call, state, response);
    if (override !== undefined) return override;
    if (call.method === "GET" && path === "") return response(state.repo);
    if (call.method === "GET" && path === "/pulls/12")
      return response(state.pr);
    if (
      call.method === "GET" &&
      ["/pulls/12/files", "/issues/12/comments"].includes(path)
    ) {
      expect(parsed.searchParams.get("per_page")).toBe("100");
      const all = path.endsWith("files") ? state.files : state.comments;
      const data = all.slice((call.page - 1) * 100, call.page * 100);
      return response(
        data,
        200,
        call.page * 100 < all.length ?
          {
            link: `<https://api.github.com/repos/owner/repo${path}?per_page=100&page=${call.page + 1}>; rel="next"`
          }
        : {}
      );
    }
    if (call.method === "GET" && path.startsWith("/labels/")) {
      const name = decodeURIComponent(path.slice("/labels/".length));
      expect(Object.values(LABELS).some((label) => label.name === name)).toBe(
        true
      );
      return response({ name });
    }
    if (call.method === "POST" && path === "/issues/12/labels") {
      expect(body.labels).toHaveLength(1);
      for (const name of body.labels)
        if (!state.pr.labels.some((label) => label.name === name))
          state.pr.labels.push({ name });
      return response(state.pr.labels);
    }
    if (call.method === "DELETE" && path.startsWith("/issues/12/labels/")) {
      const name = decodeURIComponent(path.slice("/issues/12/labels/".length));
      expect(Object.values(LABELS).some((label) => label.name === name)).toBe(
        true
      );
      state.pr.labels = state.pr.labels.filter((label) => label.name !== name);
      return response(undefined, 204);
    }
    if (call.method === "POST" && path === "/issues/12/comments") {
      state.comments.push(botComment(body.body, state.comments.length + 1000));
      state.pr.comments = state.comments.length;
      return response(state.comments.at(-1), 201);
    }
    if (call.method === "PATCH" && /^\/issues\/comments\/[0-9]+$/.test(path)) {
      const comment = state.comments.find(
        (item) => item.id === Number(path.split("/").at(-1))
      );
      expect(comment).toBeDefined();
      comment.body = body.body;
      return response(comment);
    }
    throw new Error(`Unspecified fake request: ${call.method} ${path}`);
  };
  const run = () => reconcile(context, { fetch, token: env.GITHUB_TOKEN });
  const writes = () => state.calls.filter((call) => call.method !== "GET");
  const names = () => state.pr.labels.map((label) => label.name);
  return { state, fetch, run, writes, names };
}

function botComment(body = `${COMMENT_MARKER}\nold advisory`, id = 1) {
  return {
    id,
    body,
    user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    issue_url: "https://api.github.com/repos/owner/repo/issues/12"
  };
}

async function failure(api, message) {
  try {
    await api.run();
    throw new Error("Expected reconciliation failure");
  } catch (error) {
    expect(error.message).toMatch(message);
    expect(error.evidence.status).toBe("failed");
    return error.evidence;
  }
}

describe("path risk policy", () => {
  it.each([
    ["README.md", "low", false],
    ["docs/eng/RELEASING.md", "low", false],
    ["docs/architecture/graph.md", "low", false],
    [".changeset/new-note.md", "low", false],
    ["packages/core/src/graph/diff.test.ts", "low", false],
    [
      "packages/adapter-canvas/test/integration/http/routes.test.ts",
      "low",
      false
    ],
    ["packages/adapter-canvas/test/fixtures/app/sample.json", "low", false],
    [
      "packages/adapter-canvas/test/visual/__screenshots__/graph.png",
      "low",
      false
    ],
    ["plugins/radius/assets/preview.png", "low", false],
    ["packages/core/src/graph/diff.ts", "medium", false],
    ["future/tool.ts", "medium", false],
    ["future/README.md", "medium", false],
    ["future/test.test.ts", "medium", false],
    ["future/workflow.snap", "medium", false],
    ["packages/adapter-canvas/src/verify-marker.live.test.ts", "medium", false],
    [".changeset/config.json", "high", false],
    [".github/workflows/build.yml", "high", false],
    [".github/workflows/review-risk.yml", "high", true],
    [".github/extension/radius-deploy.yml", "high", false],
    [".github/skills/review/SKILL.md", "high", true],
    [".github/instructions/review.md", "high", true],
    [".github/prompts/review.md", "high", true],
    [".github/copilot-instructions.md", "high", true],
    ["AGENTS.md", "high", true],
    ["packages/nested/AGENTS.md", "high", true],
    ["packages/copilot-instructions.md", "high", true],
    ["extensions/future/skills/anything/scripts/helper.mjs", "high", true],
    ["docs/eng/REVIEW_POLICY.md", "high", true],
    ["docs/design/2026-10-ai-assisted-review-plan.md", "high", true],
    ["CONTRIBUTING.md", "high", true],
    ["scripts/review-risk.mjs", "high", true],
    [
      "packages/adapter-canvas/test/ci/review-risk-workflow.test.mjs",
      "high",
      true
    ],
    ["packages/core/src/platforms/oidc-subject.test.ts", "high", false],
    ["packages/core/src/workflows/deploy.test.ts", "high", false],
    ["packages/core/src/setup-workflow-publication.ts", "high", false],
    [
      "packages/adapter-shared/src/setup-workflow-content.test.ts",
      "high",
      false
    ],
    ["packages/adapter-canvas/src/azure-oidc.ts", "high", false],
    ["packages/adapter-canvas/src/gh.ts", "high", false],
    ["packages/adapter-canvas/src/ghcr.ts", "high", false],
    ["packages/adapter-canvas/src/github-app-installation.ts", "high", false],
    [
      "packages/adapter-canvas/src/server/services/github-account-coordinator.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/github-environment-variable-rollback.test.ts",
      "high",
      false
    ],
    ["packages/adapter-canvas/src/gh.windows.test.ts", "high", false],
    ["packages/adapter-canvas/src/operations.ts", "high", false],
    [
      "packages/adapter-canvas/src/runtime/environment-account-context.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/runtime/production-github-account-context.test.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/routes/create-environment-gh-runner.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/routes/create-environment-workflow-committer.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/routes/create-environment-workflow-committer.test.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/workflow-rollback.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/workflow-rollback.test.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/workflow-rollback-ports.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/workflow-rollback-ports.test.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/branch-absence.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/recovered-branch-delete.ts",
      "high",
      false
    ],
    ["packages/adapter-canvas/test/e2e/global-setup.ts", "high", false],
    ["packages/adapter-canvas/test/e2e/global-teardown.ts", "high", false],
    [
      "packages/adapter-canvas/test/e2e/support/canvas-harness.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/test/e2e/support/canvas-harness.test.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/test/support/azure-discovery-contract.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/routes/graph-workflows.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/src/server/services/deploy-dispatch.test.ts",
      "high",
      false
    ],
    [
      "packages/adapter-canvas/test/e2e-cloud/support/fixture.ts",
      "high",
      false
    ],
    ["packages/adapter-canvas/playwright.cloud.config.ts", "high", true],
    ["packages/adapter-canvas/test/ci/library-release.test.mjs", "high", false],
    ["scripts/publish-libraries.mjs", "high", false],
    ["scripts/library-artifacts.mjs", "high", false],
    ["scripts/graph-vendor-styles.mjs", "high", false],
    ["scripts/module-entry.mjs", "high", true],
    ["scripts/copilot-cli-modeling/fixtures/example.md", "high", false],
    ["build/scripts/update-radius-installer.sh", "high", false],
    ["packages/adapter-canvas/build.mjs", "high", false],
    ["packages/future/package.json", "high", true],
    ["pnpm-lock.yaml", "high", true],
    ["pnpm-workspace.yaml", "high", true],
    ["eslint.config.mjs", "high", true],
    ["vitest.config.ts", "high", true],
    ["coverage-baseline.json", "high", true],
    ["packages/core/tsconfig.build.json", "high", true],
    ["plugins/radius/plugin.json", "high", false],
    ["some/action.yaml", "high", false],
    ["Dockerfile", "high", false]
  ])("classifies %s as %s (warning %s)", (path, tier, warning) => {
    const result = classify([file(path)]);
    expect(result.tier).toBe(tier);
    expect(result.warningPaths).toEqual(warning ? [path] : []);
    expect(result.details[0]).toMatchObject({ path, tier });
  });

  it.each([
    "packages/adapter-shared/src/ghcr-bootstrap",
    "packages/adapter-shared/src/deployment-templates",
    "packages/adapter-shared/src/deployment-workflows",
    "packages/adapter-shared/src/deployment-dispatch",
    "packages/adapter-canvas/src/server/routes/identity-auth",
    "packages/adapter-canvas/src/shared",
    "packages/adapter-canvas/src/server/routes/aws-discovery",
    "packages/core/src/credential-redaction",
    "packages/adapter-shared/src/deployment-repository",
    "packages/adapter-shared/src/deployment-command-bindings",
    "packages/adapter-shared/src/production-deployment",
    "packages/adapter-shared/src/runtime-deployment",
    "packages/adapter-canvas/src/server/routes/deployments",
    "packages/adapter-canvas/src/server/services/deploy-request",
    "packages/adapter-canvas/src/runtime/production-deployment",
    "packages/adapter-canvas/src/runtime/deployment-tools",
    "packages/adapter-canvas/src/runtime/deployment-account",
    "packages/adapter-canvas/src/deploy",
    "packages/adapter-canvas/test/support/server/production-runtime",
    "packages/adapter-canvas/test/support/server/deployment-runtime"
  ])("requires High/Max review for %s and its collocated tests", (stem) => {
    for (const suffix of [".ts", ".test.ts"]) {
      const path = `${stem}${suffix}`;
      const result = classify([file(path)]);
      expect(result.tier).toBe("high");
      expect(result.highPaths).toEqual([path]);
      expect(result.warningPaths).toEqual([]);
      expect(
        renderAdvisory(
          result,
          { head: HEAD, base: "main", baseSha: BASE },
          POLICY,
          "owner/repo"
        )
      ).toContain("manually requested Max review");
    }
  });

  it.each(["modified", "removed", "renamed"])(
    "keeps the control warning when its workflow is %s",
    (status) => {
      const path = ".github/workflows/review-risk.yml";
      const item =
        status === "renamed" ?
          file("docs/eng/renamed.md", { status, previous_filename: path })
        : file(path, { status });
      const result = classify([item]);
      expect(result.tier).toBe("high");
      expect(result.warningPaths).toEqual([path]);
      expect(
        classify([
          file(path, {
            status: "renamed",
            previous_filename: "docs/eng/renamed.md"
          })
        ]).warningPaths
      ).toEqual([path]);
    }
  );

  it("uses the highest tier, sorted paths and both rename names; deletions remain changes", () => {
    const files = [
      file("z.md", {
        status: "renamed",
        previous_filename: "nested/AGENTS.md"
      }),
      file("README.md"),
      file(".github/workflows/deploy.yml", { status: "removed" })
    ];
    const result = classify(files);
    expect(result.tier).toBe("high");
    expect(result.highPaths).toEqual([
      ".github/workflows/deploy.yml",
      "nested/AGENTS.md"
    ]);
    expect(result.warningPaths).toEqual(["nested/AGENTS.md"]);
    expect(classify([...files].reverse())).toEqual(result);
    expect(
      classify([
        file("AGENTS.md", { status: "renamed", previous_filename: "README.md" })
      ]).tier
    ).toBe("high");
  });

  it.each([
    null,
    {},
    [],
    [null],
    [file("")],
    [file("/root")],
    [file("C:\\foo")],
    [file("x/../y")],
    [file("./x")],
    [file("x//y")],
    [file("x/")],
    [file("x", { status: "weird" })],
    [file("x", { status: "renamed" })],
    [file("x", { previous_filename: null })],
    [file("x"), file("x")],
    Array.from({ length: 3001 }, (_, index) => file(`x${index}`))
  ])("rejects malformed or incomplete changed files %#", (files) => {
    expect(() => classify(files)).toThrow();
  });
});

describe("advisory rendering", () => {
  const snapshot = { head: HEAD, base: "stack-parent", baseSha: BASE };
  it("lists all High paths and human/Max expectations without timestamps or moving base tips", () => {
    const result = classify([
      file("AGENTS.md"),
      file(".github/workflows/a.yml"),
      file("README.md")
    ]);
    const body = renderAdvisory(result, snapshot, POLICY, "owner/repo");
    expect(body).toContain("HIGH");
    expect(body).toContain("One qualifying approvers-team human");
    expect(body).toContain("not a second human");
    expect(body).toContain("Disregard Copilot");
    for (const path of result.highPaths)
      expect(body).toContain(escapeDisplay(path));
    expect(body).toContain(HEAD);
    expect(body).toContain(POLICY);
    expect(body).toContain(
      `https://github.com/owner/repo/blob/${POLICY}/docs/design/2026-10-ai-assisted-review-plan.md#phase-4-scale-human-approval-to-risk`
    );
    expect(body).not.toContain("/docs/eng/REVIEW_POLICY.md");
    expect(body).toContain("stack-parent");
    expect(body).not.toContain(BASE);
    expect(body).not.toContain("/actions/runs/");
    expect(
      renderAdvisory(
        result,
        { ...snapshot, baseSha: "d".repeat(40), runId: 999 },
        POLICY,
        "owner/repo"
      )
    ).toBe(body);
  });

  it("removes warning/Max text when not applicable and explains the fallback", () => {
    for (const path of ["README.md", "unknown.ts"]) {
      const body = renderAdvisory(
        classify([file(path)]),
        snapshot,
        POLICY,
        "owner/repo"
      );
      expect(body).not.toContain("Disregard");
      expect(body).not.toContain("manually requested");
      expect(body).toContain("None.");
      expect(body).toContain("Unknown paths are Medium");
    }
  });

  it("escapes mentions, Markdown, HTML, newlines and bidi controls in paths and base names", () => {
    const hostile = ".github/@everyone/<img>_[x](`run`)&\n\u202e.md";
    const body = renderAdvisory(
      classify([file(hostile)]),
      { ...snapshot, base: "@team\n<script>" },
      POLICY,
      "owner/repo"
    );
    expect(body).not.toContain("@everyone");
    expect(body).not.toContain("<img>");
    expect(body).not.toContain("<script>");
    expect(body).toContain("&#64;everyone");
    expect(body).toContain("&#10;");
    expect(body).toContain("&#8238;");
    expect(escapeDisplay("\\\u007f\u2066")).toBe("&#92;&#127;&#8294;");
    expect(escapeDisplay("name\u200b\u2060\u2028\u2029.md")).toBe(
      "name&#8203;&#8288;&#8232;&#8233;.md"
    );
  });

  it("enforces the conservative byte boundary without silently dropping a High path", () => {
    const result = classify([file(".github/a")]);
    const initial = renderAdvisory(result, snapshot, POLICY, "owner/repo");
    const remaining = 65536 - Buffer.byteLength(initial);
    const fits = {
      ...result,
      details: [
        { ...result.details[0], path: `.github/a${"x".repeat(remaining)}` }
      ],
      highPaths: [`.github/a${"x".repeat(remaining)}`]
    };
    expect(
      Buffer.byteLength(renderAdvisory(fits, snapshot, POLICY, "owner/repo"))
    ).toBe(65536);
    const over = {
      ...fits,
      details: [{ ...fits.details[0], path: `${fits.highPaths[0]}é` }]
    };
    try {
      renderAdvisory(over, snapshot, POLICY, "owner/repo");
      throw new Error("Expected overflow");
    } catch (error) {
      expect(error.message).toContain("65536");
      expect(error.fullReport).toContain(`${fits.highPaths[0]}é`);
    }
  });
});

describe("trusted event boundary", () => {
  it("validates current-base events and normalizes manual PR numbers", () => {
    expect(eventContext(env, event)).toEqual(context);
    expect(
      eventContext(
        { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" },
        { ...event, inputs: { pr: "00012" } }
      )
    ).toEqual(context);
    for (const action of [
      "edited",
      "reopened",
      "synchronize",
      "ready_for_review"
    ])
      expect(eventContext(env, { ...event, action })).toEqual(context);
    for (const action of ["labeled", "unlabeled"])
      for (const label of Object.values(LABELS))
        expect(
          eventContext(env, { ...event, action, label: { name: label.name } })
        ).toEqual(context);
  });

  it.each([
    [{}, null],
    [env, {}],
    [{ ...env, GITHUB_REPOSITORY: "different/repo" }, event],
    [{ ...env, GITHUB_REPOSITORY: "owner/repo\n" }, event],
    [env, { ...event, repository: { ...event.repository, id: "7" } }],
    [{ ...env, GITHUB_REF: "refs/heads/stack-parent" }, event],
    [{ ...env, GITHUB_WORKFLOW_SHA: "main" }, event],
    [{ ...env, GITHUB_SHA: HEAD }, event],
    [{ ...env, GITHUB_EVENT_NAME: "pull_request" }, event],
    [env, { ...event, action: "closed" }],
    [env, { ...event, number: 0 }],
    [env, { ...event, pull_request: { number: 13 } }],
    [env, { ...event, action: "labeled", label: { name: "pr:ready" } }],
    [
      { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" },
      { ...event, inputs: { pr: "12;echo" } }
    ],
    [
      { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" },
      { ...event, inputs: { pr: "9007199254740992" } }
    ],
    [{ ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }, event]
  ])("rejects untrusted or malformed event %#", (environment, payload) => {
    expect(() => eventContext(environment, payload)).toThrow();
  });

  it.each([undefined, "", "false", "TRUE"])(
    "disabled startup flag %s performs no reads or writes",
    async (flag) => {
      const reports = [];
      const result = await runReviewRisk(
        { ...env, REVIEW_RISK_ENABLED: flag },
        null,
        {
          fetch: () => {
            throw new Error("Network forbidden");
          },
          report: (value) => reports.push(value)
        }
      );
      expect(result.status).toBe("disabled");
      expect(reports).toEqual([result]);
    }
  );

  it("reports invalid context and missing credentials without API access", async () => {
    const report = [];
    await expect(
      runReviewRisk(env, {}, { report: (value) => report.push(value) })
    ).rejects.toThrow("repository");
    expect(report[0].status).toBe("failed");
    await expect(
      reconcile(context, {
        fetch: () => {
          throw new Error("Network forbidden");
        },
        token: ""
      })
    ).rejects.toThrow("Missing GitHub token");
  });
});

describe("offline API reconciliation", () => {
  it.each(["/pulls/12/files", "/issues/12/comments"])(
    "accepts verified numeric-ID pagination links for %s",
    async (path) => {
      const api = fakeApi({
        files: Array.from({ length: 101 }, (_, index) =>
          file(`docs/eng/file-${index}.md`)
        ),
        comments: Array.from({ length: 101 }, (_, index) =>
          botComment(`unrelated comment ${index}`, index + 1)
        ),
        intercept: (call, state, respond) => {
          if (call.path === path && call.page === 1) {
            const all = path.endsWith("files") ? state.files : state.comments;
            return respond(all.slice(0, 100), 200, {
              link: `<https://api.github.com/repositories/7${path}?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/7${path}?per_page=100&page=2>; rel="last"`
            });
          }
        }
      });
      expect((await api.run()).status).toBe("reconciled");
      expect(api.names()).toEqual(["pr:ready", "risk:low"]);
      expect(
        api.state.calls.some((call) => call.path === path && call.page === 2)
      ).toBe(true);
      expect(api.state.comments.at(-1).body).toContain("Advisory review risk");
    }
  );

  it("verifies complete comment counts rather than trusting a missing pagination header", async () => {
    const api = fakeApi();
    api.state.pr.comments = 101;
    await failure(api, /Comment count mismatch/);
    expect(api.state.comments).toEqual([]);
  });

  it("reports missing label bootstrap and keeps repeated unavailable cleanup idempotent", async () => {
    const api = fakeApi({
      labels: ["risk:low"],
      comments: [botComment()],
      intercept: (call, _state, respond) => {
        if (call.path.startsWith("/labels/")) return respond({}, 404);
      }
    });
    await failure(api, /authorized admin must bootstrap/);
    expect(api.names()).toEqual([]);
    api.state.calls.length = 0;
    await failure(api, /authorized admin must bootstrap/);
    expect(api.writes()).toEqual([]);
  });

  it("repairs tier tampering, preserves unrelated labels/comments and is write-idempotent", async () => {
    const unrelated = {
      ...botComment("unrelated status comment", 99),
      user: { id: 10, login: "human", type: "User" }
    };
    const api = fakeApi({
      labels: [
        "pr:ready",
        "risk:high",
        "risk:medium",
        "review-instructions-changed"
      ],
      comments: [unrelated]
    });
    const reports = [];
    const result = await runReviewRisk(env, event, {
      fetch: api.fetch,
      report: (value) => reports.push(value)
    });
    expect(result.status).toBe("reconciled");
    expect(result.inspected.baseSha).toBe(BASE);
    expect(reports).toEqual([result]);
    expect(api.names()).toEqual(["pr:ready", "risk:low"]);
    expect(api.state.comments[0]).toEqual(unrelated);
    expect(api.state.comments).toHaveLength(2);
    api.state.calls.length = 0;
    await api.run();
    expect(api.writes()).toEqual([]);
    api.state.pr.labels = [{ name: "pr:ready" }];
    await api.run();
    expect(api.names()).toContain("risk:low");
    expect(api.state.comments).toHaveLength(2);
  });

  it("independently adds the warning and updates exactly the owned comment", async () => {
    const api = fakeApi({
      files: [file("AGENTS.md")],
      labels: ["pr:ready", "risk:low"],
      comments: [botComment()]
    });
    await api.run();
    expect(api.names().sort()).toEqual([
      "pr:ready",
      "review-instructions-changed",
      "risk:high"
    ]);
    expect(api.state.comments).toHaveLength(1);
    expect(api.state.comments[0].body).toContain("Disregard Copilot");
    api.state.files = [file("new-production.ts")];
    await api.run();
    expect(api.names().sort()).toEqual(["pr:ready", "risk:medium"]);
    expect(api.state.comments[0].body).not.toContain("Disregard");
  });

  it("paginates complete files and comments including the exact 3000-file API boundary", async () => {
    const comments = Array.from({ length: 101 }, (_, index) => ({
      ...botComment("human", index + 10),
      user: { id: 10, login: "human", type: "User" }
    }));
    const files = Array.from({ length: 3000 }, (_, index) =>
      file(`future/p${index}`)
    );
    const api = fakeApi({ files, comments });
    const result = await api.run();
    expect(result.classification.details).toHaveLength(3000);
    expect(
      api.state.calls.some(
        (call) => call.path === "/pulls/12/files" && call.page === 30
      )
    ).toBe(true);
    expect(
      api.state.calls.some(
        (call) => call.path === "/issues/12/comments" && call.page === 2
      )
    ).toBe(true);
    expect(api.state.comments).toHaveLength(102);
  });

  it("uses the current base after edited/parent merge retargeting, not historical event contents", async () => {
    const api = fakeApi({ files: [file("packages/core/src/graph/diff.ts")] });
    api.state.pr.base.ref = "new-stack-parent";
    const result = await runReviewRisk(
      env,
      {
        ...event,
        action: "edited",
        changes: { base: { ref: { from: "old-parent" } } },
        pull_request: {
          number: 12,
          base: { ref: "old-parent" },
          body: "trusted author: yes"
        }
      },
      { fetch: api.fetch }
    );
    expect(result.classification.tier).toBe("medium");
    expect(result.inspected.base).toBe("new-stack-parent");
    expect(api.state.comments[0].body).toContain("new-stack-parent");
    expect(api.state.comments[0].body).not.toContain("old-parent");
  });

  it.each([
    ["before writes", 2],
    ["after writes", 3]
  ])(
    "rejects a same-count High diff when the base commit changes %s",
    async (_stage, snapshotRead) => {
      const production = file("packages/core/src/graph/diff.ts");
      const api = fakeApi({
        files: [file("docs/eng/guide.md"), production],
        labels: ["pr:ready", "risk:high", "review-instructions-changed"],
        comments: [botComment()],
        intercept: (call, state) => {
          if (
            call.path === "/pulls/12" &&
            state.calls.filter((item) => item.path === call.path).length ===
              snapshotRead
          ) {
            state.pr.base.sha = "d".repeat(40);
            state.files = [file("AGENTS.md"), production];
          }
        }
      });
      const evidence = await failure(api, /snapshot changed.*base commit/);
      expect(evidence.classification.tier).toBe("medium");
      expect(classify(api.state.files).tier).toBe("high");
      expect(evidence.inspected.head).toBe(api.state.pr.head.sha);
      expect(evidence.inspected.base).toBe(api.state.pr.base.ref);
      expect(evidence.inspected.count).toBe(api.state.files.length);
      expect(api.writes().length > 0).toBe(snapshotRead === 3);
      expect(evidence.staleTierLabels).toEqual([
        snapshotRead === 2 ? "risk:high" : "risk:medium"
      ]);
      expect(evidence).not.toHaveProperty("cleanup");
      api.state.calls.length = 0;
      expect((await api.run()).classification.tier).toBe("high");
      expect(api.names().sort()).toEqual([
        "pr:ready",
        "review-instructions-changed",
        "risk:high"
      ]);
    }
  );

  it.each(["id", "login", "type", "marker"])(
    "does not overwrite a marker spoof with wrong %s",
    async (field) => {
      const spoof = botComment();
      if (field === "marker") spoof.body = "not-owned\n" + spoof.body;
      else spoof.user[field] = field === "id" ? 9 : "human";
      const api = fakeApi({ comments: [spoof] });
      await api.run();
      expect(api.state.comments[0]).toEqual(spoof);
      expect(api.state.comments).toHaveLength(2);
    }
  );

  it("fails on ambiguous owned comments rather than editing either one", async () => {
    const api = fakeApi({
      labels: ["risk:low"],
      comments: [
        botComment(),
        botComment("<!-- radius-review-risk:v1 -->\nduplicate", 2)
      ]
    });
    const evidence = await failure(api, /Ambiguous/);
    expect(api.writes().every((call) => call.method === "DELETE")).toBe(true);
    expect(evidence.cleanup.join()).toContain("Ambiguous");
    expect(api.names()).not.toContain("risk:low");
  });

  it.each([
    [
      "repository",
      (state) => {
        state.repo.id = 99;
      }
    ],
    [
      "PR repository",
      (state) => {
        state.pr.base.repo.full_name = "fork/repo";
      }
    ],
    [
      "PR number",
      (state) => {
        state.pr.number = 3;
      }
    ],
    [
      "closed",
      (state) => {
        state.pr.state = "closed";
      }
    ],
    [
      "head",
      (state) => {
        state.pr.head.sha = "bad";
      }
    ],
    [
      "labels",
      (state) => {
        state.pr.labels = [{ name: "x" }, { name: "x" }];
      }
    ]
  ])(
    "fails before mutations for invalid %s identity/state",
    async (_name, mutate) => {
      const api = fakeApi();
      mutate(api.state);
      await failure(api, /identity|open|snapshot|labels/i);
      expect(api.writes()).toEqual([]);
    }
  );

  it.each([
    [
      "head",
      (state) => {
        state.pr.head.sha = "d".repeat(40);
      }
    ],
    [
      "base",
      (state) => {
        state.pr.base.ref = "retargeted";
      }
    ],
    [
      "base commit",
      (state) => {
        state.pr.base.sha = "d".repeat(40);
      }
    ],
    [
      "count",
      (state) => {
        state.pr.changed_files = 2;
      }
    ]
  ])(
    "stops without reevaluation if %s changes before writes",
    async (_name, change) => {
      const api = fakeApi({
        intercept: (call, state) => {
          if (
            call.path === "/pulls/12" &&
            state.calls.filter((item) => item.path === call.path).length === 2
          )
            change(state);
        }
      });
      await failure(api, /snapshot changed/);
      expect(api.writes()).toEqual([]);
    }
  );

  it("reports a retarget race after partial writes without claiming atomic success", async () => {
    const api = fakeApi({
      intercept: (call, state) => {
        if (call.method === "POST" && call.path.endsWith("/labels"))
          state.pr.base.ref = "retargeted";
      }
    });
    const evidence = await failure(api, /snapshot changed/);
    expect(evidence.mutations.length).toBeGreaterThan(0);
    expect(evidence.residualLabels).toContain("risk:low");
    expect(evidence).not.toHaveProperty("cleanup");
  });

  it.each([0, 3001])(
    "rejects API count %s and removes stale tiers without removing the instruction warning",
    async (count) => {
      const api = fakeApi({
        count,
        labels: [
          "risk:low",
          "risk:medium",
          "risk:high",
          "review-instructions-changed",
          "pr:ready"
        ],
        comments: [botComment()]
      });
      const evidence = await failure(api, /3000/);
      expect(api.names()).toEqual(["review-instructions-changed", "pr:ready"]);
      expect(api.state.comments[0].body).toContain("Advisory unavailable");
      expect(evidence.staleTierLabels).toEqual([]);
    }
  );

  it("cleans up an incomplete formerly Low diff and reports denied cleanup precisely", async () => {
    const api = fakeApi({
      count: 2,
      labels: ["risk:low", "pr:ready"],
      comments: [botComment()],
      intercept: (call, _state, respond) => {
        if (call.method === "DELETE" || call.method === "PATCH")
          return respond({ message: "denied" }, 403);
      }
    });
    const evidence = await failure(api, /count mismatch/);
    expect(evidence.staleTierLabels).toEqual(["risk:low"]);
    expect(evidence.cleanup).toHaveLength(2);
    expect(evidence.cleanup.join()).toContain("403");
    expect(evidence.residualComment).toContain("old advisory");
  });

  it.each([false, true])(
    "attempts unavailable cleanup after a failed pre-write read (denied %s)",
    async (denied) => {
      const api = fakeApi({
        files: [file(".github/workflows/deploy.yml")],
        labels: ["risk:low", "pr:ready", "review-instructions-changed"],
        comments: [botComment()],
        intercept: (call, state, respond) => {
          if (
            call.path === "/pulls/12" &&
            state.calls.filter((item) => item.path === call.path).length === 2
          )
            return respond({}, 503);
          if (denied && ["DELETE", "PATCH"].includes(call.method))
            return respond({}, 403);
        }
      });
      const evidence = await failure(api, /503/);
      expect(evidence.classification.tier).toBe("high");
      expect(evidence.cleanup).toHaveLength(denied ? 2 : 0);
      expect(api.writes().map((call) => call.method)).toEqual([
        "DELETE",
        "PATCH"
      ]);
      expect(api.names()).toEqual(
        denied ?
          ["risk:low", "pr:ready", "review-instructions-changed"]
        : ["pr:ready", "review-instructions-changed"]
      );
      expect(evidence.staleTierLabels).toEqual(denied ? ["risk:low"] : []);
      expect(evidence.residualComment).toContain(
        denied ? "old advisory" : "Advisory unavailable"
      );
    }
  );

  it("retains a complete escaped overflow report and marks the old advisory unavailable", async () => {
    const files = Array.from({ length: 200 }, (_, index) =>
      file(`.github/${index}${"x".repeat(400)}`)
    );
    const api = fakeApi({
      files,
      labels: ["risk:low"],
      comments: [botComment()]
    });
    const evidence = await failure(api, /65536/);
    for (const item of files)
      expect(evidence.fullReport).toContain(item.filename);
    expect(api.names()).not.toContain("risk:low");
    expect(api.state.comments[0].body).toContain("could not be verified");
  });

  it("does not clean up against a changed or now-closed snapshot", async () => {
    for (const close of [false, true]) {
      const api = fakeApi({
        count: 2,
        labels: ["risk:low"],
        intercept: (call, state) => {
          if (call.path === "/pulls/12/files") {
            if (close) state.pr.state = "closed";
            else state.pr.head.sha = "d".repeat(40);
          }
        }
      });
      const evidence = await failure(api, /count mismatch/);
      expect(api.writes()).toEqual([]);
      expect(evidence.cleanup.join()).toContain("Cleanup not safe");
    }
  });

  it("does not clean up after the base commit changes during an incomplete diff read", async () => {
    const api = fakeApi({
      count: 2,
      labels: ["risk:low", "review-instructions-changed"],
      comments: [botComment()],
      intercept: (call, state) => {
        if (call.path === "/pulls/12/files") state.pr.base.sha = "d".repeat(40);
      }
    });
    const evidence = await failure(api, /count mismatch/);
    expect(api.writes()).toEqual([]);
    expect(evidence.cleanup.join()).toContain("snapshot changed");
    expect(evidence.staleTierLabels).toEqual(["risk:low"]);
    expect(api.state.comments[0].body).toContain("old advisory");
  });

  it.each([403, 429, 500])(
    "surfaces API HTTP %s, with no silent fallback or retries",
    async (status) => {
      const api = fakeApi({
        intercept: (call, _state, respond) =>
          call.path === "" ? respond({}, status) : undefined
      });
      await failure(api, new RegExp(String(status)));
      expect(api.state.calls).toHaveLength(1);
      expect(api.writes()).toEqual([]);
    }
  );

  it("does not retry uncertain comment creation and reports partial mutations", async () => {
    const api = fakeApi({
      intercept: (call) => {
        if (call.method === "POST" && call.path.endsWith("/comments"))
          throw new Error("offline transport interrupted");
      }
    });
    const evidence = await failure(api, /uncertain/);
    expect(
      api.writes().filter((call) => call.path.endsWith("/comments"))
    ).toHaveLength(1);
    expect(evidence.mutations.at(-1).state).toContain("not confirmed");
  });

  it("reports malformed JSON and a failed residual read without exposing transport secrets", async () => {
    const api = fakeApi({
      intercept: (call, state) => {
        if (call.path === "/pulls/12/files") return new Response("broken json");
        if (
          call.path === "/pulls/12" &&
          state.calls.filter((item) => item.path === call.path).length > 1
        )
          throw new Error("do not log credentials");
      }
    });
    const evidence = await failure(api, /malformed JSON/);
    expect(evidence.residualState).toContain(
      "Unknown; stale advisory may remain"
    );
    expect(JSON.stringify(evidence)).not.toContain("do not log credentials");
  });

  it.each([
    ["files shape", "/pulls/12/files", {}],
    ["comment shape", "/issues/12/comments", [{}]],
    [
      "foreign comment",
      "/issues/12/comments",
      [
        {
          ...botComment(),
          issue_url: "https://api.github.com/repos/other/repo/issues/12"
        }
      ]
    ],
    ["duplicate comment", "/issues/12/comments", [botComment(), botComment()]],
    ["label definition", "/labels/risk%3Alow", {}]
  ])("fails strict %s validation", async (_name, path, value) => {
    const api = fakeApi({
      intercept: (call, _state, respond) =>
        call.method === "GET" && call.path === path ? respond(value) : undefined
    });
    if (path.endsWith("/comments")) api.state.pr.comments = value.length;
    await failure(api, /Malformed|Missing|malformed/);
  });

  it.each([
    '<https://evil.example/files?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/8/pulls/12/files?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/7/pulls/13/files?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/7/issues/12/comments?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/7/pulls/12/files?per_page=100&page=3>; rel="next"',
    '<https://api.github.com/repositories/7/pulls/12/files?per_page=10&page=2>; rel="next"',
    '<https://api.github.com/repositories/7/pulls/12/files?per_page=100&page=2&page=3>; rel="next"',
    '<https://api.github.com/repositories/7/pulls/12/files?per_page=100&page=2&extra=yes>; rel="next"',
    '<https://api.github.com/repos/owner/repo/pulls/12/files?per_page=100&page=3>; rel="next"',
    "not a link",
    '<https://api.github.com/repos/owner/repo/pulls/12/files?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/pulls/12/files?per_page=100&page=2>; rel="next"'
  ])("rejects malformed or redirected pagination %s", async (link) => {
    const api = fakeApi({
      intercept: (call, _state, respond) =>
        call.path === "/pulls/12/files" ?
          respond([file("README.md")], 200, { link })
        : undefined
    });
    await failure(api, /pagination/);
  });

  it("fails explicitly if pagination exceeds its cap even when GitHub advertises another page", async () => {
    const api = fakeApi({
      count: 3000,
      intercept: (call, _state, respond) => {
        if (call.path === "/pulls/12/files")
          return respond(
            Array.from({ length: 100 }, (_, index) =>
              file(`page${call.page}/file${index}`)
            ),
            200,
            {
              link: `<https://api.github.com/repos/owner/repo/pulls/12/files?per_page=100&page=${call.page + 1}>; rel="next"`
            }
          );
      }
    });
    await failure(api, /Pagination exceeds/);
    expect(
      api.state.calls.filter((call) => call.path === "/pulls/12/files")
    ).toHaveLength(30);
  });

  it("detects owned-comment changes and final label/comment read-back interference", async () => {
    for (const mode of [
      "comment identity",
      "label readback",
      "comment readback"
    ]) {
      let commentReads = 0;
      const api = fakeApi({
        comments: [botComment()],
        intercept: (call, state, respond) => {
          if (call.path === "/issues/12/comments" && call.method === "GET") {
            commentReads++;
            if (mode === "comment identity" && commentReads === 2)
              state.comments[0].id = 2;
            if (mode === "comment readback" && commentReads === 3)
              state.comments[0].body = "interference";
          }
          if (
            mode === "label readback" &&
            call.method === "POST" &&
            call.path.endsWith("/labels")
          )
            return respond([]);
        }
      });
      await failure(api, /changed during|read-back mismatch/);
    }
  });
});

describe("execution evidence and CLI", () => {
  function localInput() {
    const root = mkdtempSync(join(tmpdir(), "review-risk-main-"));
    roots.push(root);
    const payload = join(root, "event.json");
    const summary = join(root, "summary.md");
    writeFileSync(payload, JSON.stringify(event));
    return { ...env, GITHUB_EVENT_PATH: payload, GITHUB_STEP_SUMMARY: summary };
  }

  it("persists enabled success and failure evidence through the real CLI entry seam", async () => {
    const input = localInput();
    const api = fakeApi();
    expect(await reviewRiskMain(input, api.fetch)).toBe(0);
    expect(readFileSync(input.GITHUB_STEP_SUMMARY, "utf8")).toContain(
      "reconciled"
    );
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    writeFileSync(input.GITHUB_EVENT_PATH, "not json");
    expect(await reviewRiskMain(input, api.fetch)).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("JSON");
  });

  it("emits the complete oversized escaped evidence to the log and fails explicitly", async () => {
    const input = localInput();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const files = Array.from({ length: 3000 }, (_, index) =>
      file(`.github/${index}${"x".repeat(220)}`)
    );
    const api = fakeApi({
      files,
      labels: ["risk:low"],
      comments: [botComment()]
    });
    expect(await reviewRiskMain(input, api.fetch)).toBe(1);
    const output = stdout.mock.calls.flat().join("");
    for (const item of files) expect(output).toContain(item.filename);
    expect(output).toContain("Advisory unavailable");
    expect(stderr.mock.calls.flat().join("")).toContain("step-summary limit");
    expect(api.names()).not.toContain("risk:low");
  });

  it("writes disabled evidence without a summary path or injected dependencies", async () => {
    const input = localInput();
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    expect(
      await reviewRiskMain({
        ...input,
        REVIEW_RISK_ENABLED: "",
        GITHUB_STEP_SUMMARY: ""
      })
    ).toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("disabled");
  });

  it("keeps recovery JSON readable and round-trippable while neutralizing invisible controls", () => {
    const value = {
      mutations: [
        { method: "POST", path: "/issues/12/labels", labels: ["risk:high"] }
      ],
      residualComment:
        "<script>@everyone\n::error:: ``` \u001b\u200b\u2028\u2029\u202e\u{e0001}"
    };
    const evidence = renderEvidence(
      value,
      "https://github.com/owner/repo/actions/runs/99"
    );
    expect(evidence).toContain("/actions/runs/99");
    const json = evidence
      .split("\n")
      .filter((line) => line.startsWith("    "))
      .map((line) => line.slice(4))
      .join("\n");
    expect(JSON.parse(json)).toEqual(value);
    expect(json).toContain('"method": "POST"');
    expect(json).toContain("<script>@everyone");
    expect(json).not.toMatch(/&#[0-9]+;/);
    expect(json).not.toMatch(/[\u001b\u200b\u2028\u2029\u202e\u{e0001}]/u);
    expect(json).toContain("\\u202e");
    expect(evidence).not.toMatch(/^::error::/m);
    expect(renderEvidence({ status: "disabled" })).not.toContain("Run:");
  });

  it("executes disabled CLI without dependencies or credentials and surfaces invalid input", () => {
    const root = mkdtempSync(join(tmpdir(), "review-risk-"));
    roots.push(root);
    const payload = join(root, "event.json");
    const summary = join(root, "summary.md");
    writeFileSync(payload, JSON.stringify(event));
    const script = new URL(
      "../../../../scripts/review-risk.mjs",
      import.meta.url
    );
    const run = (extra = {}) =>
      spawnSync(
        process.execPath,
        [script.pathname.replace(/^\/([A-Za-z]:)/, "$1")],
        {
          encoding: "utf8",
          env: {
            ...env,
            REVIEW_RISK_ENABLED: "",
            GITHUB_EVENT_PATH: payload,
            GITHUB_STEP_SUMMARY: summary,
            ...extra
          },
          timeout: 5000
        }
      );
    const disabled = run();
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(readFileSync(summary, "utf8")).toContain("disabled");
    const invalid = run({
      REVIEW_RISK_ENABLED: "true",
      GITHUB_REF: "refs/heads/fork"
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("default-branch");
    expect(readFileSync(summary, "utf8")).toContain("failed");
    const stdout = run({ GITHUB_STEP_SUMMARY: "" });
    expect(stdout.status).toBe(0);
    expect(stdout.stdout).toContain("disabled");
  });
});
