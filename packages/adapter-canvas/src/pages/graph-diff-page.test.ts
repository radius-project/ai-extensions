import { describe, it, expect, vi } from "vitest";
import { graphDiffPage } from "./graph-diff-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts,
  readEmittedValue
} from "../../test/support/pages/hostile-state.js";
import {
  createFakeStatus,
  extractBrowserFunction,
  type FakeStatus,
  type FetchCall
} from "../../test/support/pages/browser-script.js";

const sampleResources = [
  {
    id: "app/web",
    name: "web",
    type: "Applications.Core/containers",
    connections: []
  }
];

describe("graphDiffPage — passes repo/branch context so source links + popup work (not just diffMode)", () => {
  it("passes repoUrl, branch (head), and baseBranch to radiusRenderGraph so buildSourceUrl doesn't short-circuit on missing repoUrl", () => {
    const html = graphDiffPage({
      diffResources: sampleResources,
      diffBase: "main",
      diffHead: "feature",
      diffTargetRepo: "octo/app"
    });
    expect(html).toContain("radiusRenderGraph('graph-container', resources, {");
    expect(html).toContain("diffMode: true");
    expect(html).toContain("repoUrl: DIFF_REPO_URL");
    expect(html).toContain("branch: 'feature'");
    expect(html).toContain("baseBranch: 'main'");
    expect(html).toContain(
      "var DIFF_REPO_URL = 'https://github.com/' + document.getElementById('diff-repo-select').value.trim();"
    );
  });
});

describe("graphDiffPage — comparison errors", () => {
  it.each([{ diffResources: [] }, { diffResources: sampleResources }])(
    "surfaces an automatic comparison failure with existing resources: $diffResources",
    ({ diffResources }) => {
      const html = graphDiffPage({
        diffError: "Unable to compile head graph",
        diffResources,
        diffTargetRepo: "octo/app",
        diffBase: "main",
        diffHead: "feature"
      });
      expect(html).toContain("Unable to compile head graph");
      expect(html).toContain('class="status error"');
    }
  );
});

describe("graphDiffPage", () => {
  it("renders the subtitle on both the empty and rendered paths", () => {
    const empty = graphDiffPage({
      branches: ["main", "dev"],
      diffBase: "main",
      diffHead: "dev"
    });
    const rendered = graphDiffPage({ diffResources: sampleResources });
    for (const html of [empty, rendered]) {
      expect(html).toContain('id="graph-diff-subtitle"');
      expect(html).toContain(
        "The application graph diff compares the application model"
      );
      expect(html).toContain("added, removed, or modified");
    }
  });
});

describe("graphDiffPage — selection, preloaded diff and errors", () => {
  it("renders the branch selector view before a comparison exists", () => {
    const html = graphDiffPage({ diffTargetRepo: "octo/app" });
    expect(html).toContain(
      '<input type="hidden" id="diff-repo-select" value="octo/app">'
    );
    expect(html).toContain('id="base-branch"');
    expect(html).toContain('id="head-branch"');
    expect(html).toContain(
      '<div id="diff-status" class="status info">Loading branches…</div>'
    );
    expect(html).toContain(
      "radiusPopulateDiffBranches(CONTEXT_REPO, STATE_BASE, STATE_HEAD)"
    );
    expect(html).not.toContain('<div id="graph-container"></div>');
  });

  it("carries the explicit base and head branches into the client", () => {
    const html = graphDiffPage({
      diffBase: "release/1",
      diffHead: "feature/x",
      diffTargetRepo: "octo/app"
    });
    expect(html).toContain("var STATE_BASE = 'release/1';");
    expect(html).toContain("var STATE_HEAD = 'feature/x';");
  });

  it("defaults the base to main and leaves the head unset when nothing is selected", () => {
    const html = graphDiffPage({});
    expect(html).toContain("var STATE_BASE = 'main';");
    expect(html).toContain("var STATE_HEAD = '';");
  });

  it("labels each selectable branch with its short commit sha and preselects base and head", () => {
    const html = graphDiffPage({
      diffResources: sampleResources,
      branches: ["main", "feature/x"],
      branchShas: { main: "abcdef1234567", "feature/x": "0123456789ab" },
      diffBase: "main",
      diffHead: "feature/x",
      diffTargetRepo: "octo/app"
    });
    expect(html).toContain('<option value="main" selected>main (abcdef1)');
    expect(html).toContain(
      '<option value="feature/x" selected>feature/x (0123456)'
    );
    // Base and head are separate lists, so each branch appears once per list.
    expect(html.split('<option value="main"').length - 1).toBe(2);
  });

  it("omits the sha suffix for a branch with no known commit", () => {
    const html = graphDiffPage({
      diffResources: sampleResources,
      branches: ["main"],
      branchShas: {},
      diffBase: "main",
      diffHead: "main"
    });
    expect(html).toContain('<option value="main" selected>main</option>');
  });

  it("summarises the compared model and passes diff context to the renderer", () => {
    const html = graphDiffPage({
      diffResources: [
        { id: "a", name: "a", type: "T", connections: [], diffStatus: "added" },
        {
          id: "b",
          name: "b",
          type: "T",
          connections: [],
          diffStatus: "removed"
        },
        {
          id: "c",
          name: "c",
          type: "T",
          connections: [],
          diffStatus: "modified"
        },
        {
          id: "d",
          name: "d",
          type: "T",
          connections: [],
          diffStatus: "unchanged"
        }
      ],
      diffBase: "main",
      diffHead: "feature/x",
      diffTargetRepo: "octo/app"
    });
    expect(html).toContain("+1 added");
    expect(html).toContain("-1 removed");
    expect(html).toContain("~1 modified");
    expect(html).toContain("1 unchanged");
    expect(html).toContain("var DIFF_BASE = 'main';");
    expect(html).toContain("var DIFF_HEAD = 'feature/x';");
    expect(html).not.toContain("No application graph changes detected");
  });

  it("says so plainly when the compared model is identical", () => {
    const html = graphDiffPage({
      diffResources: sampleResources,
      diffBase: "main",
      diffHead: "feature/x"
    });
    expect(html).toContain("No application graph changes detected in this PR.");
    expect(html).toContain(
      "<strong>main</strong> and <strong>feature/x</strong>"
    );
  });

  it("keeps a comparison error visible on the rendered path and hides an empty banner", () => {
    const withError = graphDiffPage({
      diffResources: sampleResources,
      diffError: "Unable to compile head graph"
    });
    expect(withError).toContain(
      '<div id="diff-status" class="status error" style="">Unable to compile head graph</div>'
    );
    const withoutError = graphDiffPage({ diffResources: sampleResources });
    expect(withoutError).toContain(
      '<div id="diff-status" class="status info" style="display:none;"></div>'
    );
  });

  it("escapes hostile branch names in the base and head option lists", () => {
    const html = graphDiffPage({
      diffResources: sampleResources,
      branches: [HOSTILE_STATE],
      branchShas: { [HOSTILE_STATE]: "<img src=x>abc" },
      diffBase: HOSTILE_STATE,
      diffHead: HOSTILE_STATE
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain('<option value="</script>');
    expect(html).toContain("&lt;/script&gt;&lt;script&gt;alert(1)");
    expect(html).toContain("(&lt;img sr)");
    expectSafeInlineScripts(html);
  });

  it("keeps hostile base and head branches inside their script strings", () => {
    for (const html of [
      graphDiffPage({
        diffTargetRepo: HOSTILE_STATE,
        diffBase: HOSTILE_STATE,
        diffHead: HOSTILE_STATE,
        diffError: HOSTILE_STATE
      }),
      graphDiffPage({
        diffResources: sampleResources,
        diffTargetRepo: HOSTILE_STATE,
        diffBase: HOSTILE_STATE,
        diffHead: HOSTILE_STATE
      })
    ]) {
      expectSafeInlineScripts(html);
    }
    const selector = graphDiffPage({
      diffBase: HOSTILE_STATE,
      diffHead: HOSTILE_STATE
    });
    expect(readEmittedValue(selector, "STATE_BASE")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(selector, "STATE_HEAD")).toBe(HOSTILE_STATE);
    const rendered = graphDiffPage({
      diffResources: sampleResources,
      diffBase: HOSTILE_STATE,
      diffHead: HOSTILE_STATE
    });
    expect(readEmittedValue(rendered, "DIFF_BASE")).toBe(HOSTILE_STATE);
    expect(readEmittedValue(rendered, "DIFF_HEAD")).toBe(HOSTILE_STATE);
  });

  it("serializes hostile diff resources without ending the script element", () => {
    const resources = [
      {
        id: HOSTILE_STATE,
        name: HOSTILE_STATE,
        type: HOSTILE_STATE,
        connections: [],
        diffStatus: "added"
      }
    ];
    const html = graphDiffPage({ diffResources: resources });
    expectSafeInlineScripts(html);
    expect(readEmittedValue(html, "resources")).toEqual(resources);
  });

  it("escapes repository, branch and error context in both render paths", () => {
    const hostile = "octo/<img src=x>'\"&";
    for (const html of [
      graphDiffPage({
        diffTargetRepo: hostile,
        diffBase: hostile,
        diffHead: hostile,
        diffError: hostile
      }),
      graphDiffPage({
        diffResources: sampleResources,
        diffTargetRepo: hostile,
        diffBase: hostile,
        diffHead: hostile,
        diffError: hostile
      })
    ]) {
      expect(html).not.toContain("<img src=x>");
      // The repository and the error message reach HTML, where they stay
      // HTML-escaped; the branches reach JavaScript strings instead.
      expect(html).toContain("octo/&lt;img src=x&gt;&#39;&quot;&amp;");
      expectSafeInlineScripts(html);
    }
  });
});

// Graph sub-tab navigation is a client-side partial swap (radiusNavTo replaces
// #graph-page-content), so the document never unloads and work scheduled by the
// page being left behind still runs — against a DOM whose controls are gone.
// Issue #366: a pending debounced runDiff dereferenced them and threw an
// uncaught TypeError attributed to the destination page. Both emitted copies of
// the scheduled functions must resolve their elements before dereferencing.
interface ScheduledTimer {
  fn: () => void;
  delay: number;
}

interface DiffHarness {
  runDiff: () => void;
  queueDiff: () => void;
  fetchCalls: FetchCall[];
  scheduled: ScheduledTimer[];
  cleared: unknown[];
  win: { __radiusDiffTimeout: unknown };
}

function diffControls(): {
  elements: Record<string, unknown>;
  status: FakeStatus;
} {
  const status = createFakeStatus();
  return {
    status,
    elements: {
      "base-branch": { value: "main" },
      "head-branch": { value: "dev" },
      "diff-repo-select": { value: "octo/app" },
      "diff-status": status
    }
  };
}

function loadDiffScript(
  html: string,
  elements: Record<string, unknown>,
  response: Record<string, unknown> = { message: "Diff ready" }
): DiffHarness {
  const src = `${extractBrowserFunction(html, "queueDiff")}\n${extractBrowserFunction(html, "runDiff")}`;
  const fetchCalls: FetchCall[] = [];
  const scheduled: ScheduledTimer[] = [];
  const cleared: unknown[] = [];
  const win: { __radiusDiffTimeout: unknown } = { __radiusDiffTimeout: null };
  const api = new Function(
    "document",
    "window",
    "fetch",
    "escapeHtmlClient",
    "setTimeout",
    "clearTimeout",
    `${src}\nreturn { runDiff: runDiff, queueDiff: queueDiff };`
  )(
    { getElementById: (id: string) => elements[id] ?? null },
    win,
    (url: string, init: { body: string }) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ json: () => Promise.resolve(response) });
    },
    (value: unknown) => String(value),
    (fn: () => void, delay: number) => {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    (id: unknown) => {
      cleared.push(id);
    }
  ) as Pick<DiffHarness, "runDiff" | "queueDiff">;
  return { ...api, fetchCalls, scheduled, cleared, win };
}

describe.each([
  [
    "empty state",
    () =>
      graphDiffPage({
        branches: ["main", "dev"],
        diffBase: "main",
        diffHead: "dev"
      })
  ],
  [
    "rendered diff",
    () =>
      graphDiffPage({
        diffResources: sampleResources,
        diffBase: "main",
        diffHead: "dev"
      })
  ]
] as Array<[string, () => string]>)(
  "graphDiffPage (%s) — runDiff after a client-side sub-tab swap",
  (_name, render) => {
    it("returns quietly when every diff control has been swapped out", () => {
      const harness = loadDiffScript(render(), {});
      expect(() => harness.runDiff()).not.toThrow();
      expect(harness.fetchCalls).toEqual([]);
    });

    it.each(["base-branch", "head-branch", "diff-repo-select", "diff-status"])(
      "returns quietly when only #%s is missing",
      (missing) => {
        const { elements } = diffControls();
        delete elements[missing];
        const harness = loadDiffScript(render(), elements);
        expect(() => harness.runDiff()).not.toThrow();
        expect(harness.fetchCalls).toEqual([]);
      }
    );

    it("returns quietly when a branch has not been selected yet", () => {
      const { elements } = diffControls();
      (elements["head-branch"] as { value: string }).value = "";
      const harness = loadDiffScript(render(), elements);
      harness.runDiff();
      expect(harness.fetchCalls).toEqual([]);
    });

    it("still requests and reports the diff when the controls are present", async () => {
      const { elements, status } = diffControls();
      const harness = loadDiffScript(render(), elements);
      harness.runDiff();
      expect(harness.fetchCalls).toEqual([
        {
          url: "/api/diff-branches",
          body: { base: "main", head: "dev", repo: "octo/app" }
        }
      ]);
      expect(status.className).toBe("status info");
      await vi.waitFor(() => expect(status.textContent).toBe("Diff ready"));
    });

    it("debounces through the timer the navigation cancel hook clears", () => {
      const { elements } = diffControls();
      const harness = loadDiffScript(render(), elements);
      harness.queueDiff();
      harness.queueDiff();
      expect(harness.cleared).toEqual([1]);
      expect(harness.win.__radiusDiffTimeout).toBe(2);
      expect(harness.scheduled[1].delay).toBe(500);
    });

    it("survives a debounced diff that fires after the controls are gone", () => {
      const { elements } = diffControls();
      const harness = loadDiffScript(render(), elements);
      harness.queueDiff();
      for (const id of Object.keys(elements)) delete elements[id];
      expect(() => harness.scheduled[0].fn()).not.toThrow();
      expect(harness.fetchCalls).toEqual([]);
      expect(harness.win.__radiusDiffTimeout).toBeNull();
    });
  }
);
