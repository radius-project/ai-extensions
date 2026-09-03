// Cross-page contracts shared by the server-rendered page modules.

import { describe, it, expect } from "vitest";
import { browserScript } from "./browser/scripts.js";
import { BROWSER_ENTRIES } from "./browser/build.js";
import { pageShell } from "./pages/shell.js";
import { graphPage } from "./pages/graph-page.js";
import { plannedGraphPage } from "./pages/planned-graph-page.js";
import { graphDiffPage } from "./pages/graph-diff-page.js";
import { deployedGraphPage } from "./pages/deployed-graph-page.js";
import { environmentPage } from "./pages/environment-page.js";
import { deployingPage } from "./pages/deploying-page.js";
import {
  HOSTILE_STATE,
  expectSafeInlineScripts
} from "../test/support/pages/hostile-state.js";

const REMOVED_TOKENS = [
  "bicepGenerated",
  "generatedWarning",
  "defGenerated",
  "/generated-bicep"
];
const sampleResources = [
  {
    id: "app/web",
    name: "web",
    type: "Applications.Core/containers",
    connections: []
  }
];

function compiledApiPaths(
  entry: "deploy-result-page" | "deploying-page" | "environment-page"
): string[] {
  const observed = [
    ...browserScript(entry).matchAll(/['"`(](\/api\/[a-z0-9-]+)/g)
  ].map((match) => match[1]);
  return [...new Set(observed)];
}

describe("remaining pages smoke-render without removed tokens", () => {
  const cases: Array<readonly [string, () => string, (() => string) | null]> = [
    [
      "graphDiffPage",
      () =>
        graphDiffPage({
          branches: ["main", "dev"],
          branchShas: { main: "abcdef1234567" },
          diffBase: "main",
          diffHead: "dev"
        }),
      () => graphDiffPage({ diffResources: sampleResources })
    ],
    [
      "deployedGraphPage",
      () => deployedGraphPage({ deployedResources: sampleResources }),
      () => deployedGraphPage({})
    ],
    [
      "environmentPage empty",
      () => environmentPage({}),
      () => environmentPage(undefined)
    ],
    [
      "environmentPage result",
      () =>
        environmentPage({
          deployResult: { message: "ok", workflowUrl: "https://x" }
        }),
      null
    ],
    [
      "environmentPage error",
      () => environmentPage({ deployResult: { error: "boom" } }),
      null
    ],
    [
      "deployingPage",
      () => deployingPage({ deployRepo: "octo/app" }),
      () => deployingPage({})
    ]
  ];

  for (const [name, primary, secondary] of cases) {
    it(`${name} renders a string with no removed tokens`, () => {
      const html = primary();
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
      for (const token of REMOVED_TOKENS) expect(html).not.toContain(token);
      if (secondary) expect(typeof secondary()).toBe("string");
    });
  }

  it("does not render known light-only component surfaces", () => {
    const html = cases
      .flatMap(([, primary, secondary]) => [primary(), secondary?.() || ""])
      .join("\n");
    for (const literal of [
      "#ffebe9",
      "#ddf4ff",
      "#82071e",
      "#0a3069",
      "#54aeff",
      "#1e1e1e",
      "#edfaed",
      "#fff5b1",
      "#d73a49",
      "#b31d28"
    ]) {
      expect(html).not.toContain(literal);
    }
  });

  it("uses semantic danger tokens for delete button states", () => {
    const html = deployingPage({ deployRepo: "octo/app" });
    expect(html).toContain(".rad-ddlg__delete {");
    expect(html).toContain("background:var(--rad-danger-solid)");
    expect(html).toContain(
      ".rad-ddlg__delete:hover { background:var(--rad-danger-solid-border); }"
    );
    expect(html).not.toContain(
      ".rad-ddlg__delete:hover { background:#b31d28; }"
    );
  });

  it("references no --rad-* token that pageShell does not define", () => {
    // A var(--rad-foo, <fallback>) whose token is never defined silently
    // paints its light-only fallback in every theme (e.g. the --rad-muted
    // regression). Guard every page against undefined --rad-* references.
    const shell = pageShell("t", "");
    const defined = new Set(
      [...shell.matchAll(/(--rad-[a-z0-9-]+)\s*:/g)].map((m) => m[1])
    );
    const html = cases
      .flatMap(([, primary, secondary]) => [primary(), secondary?.() || ""])
      .join("\n");
    const referenced = new Set(
      [...html.matchAll(/var\((--rad-[a-z0-9-]+)/g)].map((m) => m[1])
    );
    const undefinedTokens = [...referenced].filter((t) => !defined.has(t));
    expect(undefinedTokens).toEqual([]);
  });
});

// Inline <script> blocks in the page modules are template-literal strings, so a syntax
// error in one is invisible to tsc, eslint and prettier — it surfaces only at
// runtime as a silently dead script (this has caused a real "perpetual
// Loading…" bug). Parsing every emitted block is the only cheap guard.
describe("inline scripts", () => {
  const renderers: Array<[string, () => string]> = [
    ["graphPage", () => graphPage({})],
    ["plannedGraphPage", () => plannedGraphPage({})],
    ["graphDiffPage", () => graphDiffPage({})],
    ["deployedGraphPage", () => deployedGraphPage({})],
    ["environmentPage", () => environmentPage({})],
    ["deployingPage", () => deployingPage({})]
  ];

  it.each(renderers)(
    "%s emits only parseable script blocks",
    (_name, render) => {
      const blocks = render().match(/<script>([\s\S]*?)<\/script>/g) || [];
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const src = block.slice("<script>".length, -"</script>".length);
        expect(() => new Function(src)).not.toThrow();
      }
    }
  );
});

describe("compiled page entry API contracts", () => {
  it.each([
    ["deploy-result-page", ["/api/deploy-reset"]],
    [
      "deploying-page",
      [
        "/api/run-remediation",
        "/api/delete-conflict",
        "/api/discover-branches",
        "/api/list-applications",
        "/api/list-environments",
        "/api/list-deployments",
        "/api/deploy",
        "/api/delete-deployment",
        "/api/deploy-status"
      ]
    ],
    [
      "environment-page",
      [
        "/api/run-remediation",
        "/api/list-environments",
        "/api/delete-environment",
        "/api/credential-profiles",
        "/api/delete-credential-profile",
        "/api/save-credential-profile",
        "/api/github-identity",
        "/api/verify-azure-login",
        "/api/verify-aws-login",
        "/api/discover",
        "/api/list-azure-app-registrations",
        "/api/azure-app-serves-repos",
        "/api/operations",
        "/api/verify-status",
        "/api/github-account"
      ]
    ]
  ] as const)(
    "%s exposes its exact ordered API path set",
    (entry, expected) => {
      expect(compiledApiPaths(entry)).toEqual(expected);
    }
  );
});

// Function declarations hoist within a <script> block but not across blocks, so
// a page whose body script uses a shared helper injected *after* it dies with a
// ReferenceError — taking every later statement with it, which surfaces as a
// permanently stuck "Loading…". Each block parses fine alone, so only an
// ordering check catches this. The shared behaviour is exactly the code that
// crosses block boundaries, so it is what this pins.
//
// The compiled entries publish their helpers by assignment rather than by
// declaration, so an entry's block must appear before any block that calls one
// of its names — the same ordering rule, checked against the names the entry
// declares it exports.
describe("shared client helpers are injected before the page body uses them", () => {
  const entryHelpers = BROWSER_ENTRIES.flatMap((entry) =>
    entry.globals.map((name) => [entry.name, name] as const)
  );

  const renderers: Array<[string, () => string]> = [
    ["graphPage", () => graphPage({})],
    ["plannedGraphPage", () => plannedGraphPage({})],
    ["graphDiffPage", () => graphDiffPage({})],
    ["deployedGraphPage", () => deployedGraphPage({})],
    ["environmentPage", () => environmentPage({})],
    ["deployingPage", () => deployingPage({})]
  ];

  it("finds the shared helpers to check", () => {
    const names = entryHelpers.map(([, name]) => name);
    expect(names).toContain("radiusRenderGraph");
  });

  it.each(renderers)(
    "%s calls no compiled entry helper before that entry's block",
    (_name, render) => {
      const blocks = (
        render().match(/<script>([\s\S]*?)<\/script>/g) || []
      ).map((b) => b.slice("<script>".length, -"</script>".length));
      const entryBlock = new Map<string, number>();
      for (const entry of BROWSER_ENTRIES) {
        const compiled = browserScript(entry.name);
        entryBlock.set(
          entry.name,
          blocks.findIndex((src) => src.includes(compiled))
        );
      }
      const violations: string[] = [];
      for (const [entryName, helper] of entryHelpers) {
        const definedIn = entryBlock.get(entryName) ?? -1;
        if (definedIn === -1) continue;
        const usedIn = blocks.findIndex(
          (src, index) =>
            index !== definedIn && new RegExp(`\\b${helper}\\b`).test(src)
        );
        if (usedIn !== -1 && usedIn < definedIn) {
          violations.push(
            `${helper} used in block ${usedIn} but published by ${entryName} in block ${definedIn}`
          );
        }
      }
      expect(violations).toEqual([]);
    }
  );
});

// Deleting a deployment tears down live infrastructure irreversibly. Every
// surface that offers it must use the same 3-step type-to-confirm dialog — a
// page shipping a lighter confirmation of its own lowers the bar product-wide.
describe("delete-deployment confirmation is uniform", () => {
  const DIALOG_IDS = [
    "deploy-delete-modal",
    "deploy-delete-body",
    "deploy-delete-app",
    "deploy-delete-env",
    "deploy-delete-close"
  ];

  it.each([
    ["deployedGraphPage", () => deployedGraphPage({})],
    ["deployingPage", () => deployingPage({})]
  ])("%s renders the shared dialog", (_name, render) => {
    const html = render();
    expect(html).toContain('class="rad-ddlg"');
    for (const id of DIALOG_IDS) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("radiusCreateDeleteDeploymentDialog");
  });

  it("the Deployed graph page no longer ships a one-click confirm", () => {
    const html = deployedGraphPage({});
    expect(html).not.toContain("deployed-delete-confirm");
    expect(html).not.toContain("deployed-delete-cancel");
    expect(html).not.toContain("Are you sure you want to delete");
  });

  it("both pages emit byte-identical dialog markup", () => {
    const extract = (html: string) => {
      const start = html.indexOf('<div id="deploy-delete-modal"');
      expect(start).toBeGreaterThan(-1);
      return html.slice(
        start,
        html.indexOf("</div>", html.indexOf('id="deploy-delete-body"'))
      );
    };
    expect(extract(deployedGraphPage({}))).toBe(extract(deployingPage({})));
  });
});

// The recipe-pack model removed singleton-recipe and on-demand-bicep UI: app
// models are authored by the Radius app-bicep skill, never generated by a
// server route. Every renderer is checked here, so no page can quietly bring
// one back.
describe("no page offers removed singleton-recipe or generated-bicep behaviour", () => {
  const REMOVED_ROUTES = [
    "/generated-bicep",
    "/api/generate-bicep",
    "/api/generate-recipe",
    "/api/recipes/generate"
  ];
  const guarded: Array<[string, () => string]> = [
    ["graphPage", () => graphPage({ contextRepo: "octo/app" })],
    [
      "graphPage with resources",
      () =>
        graphPage({ graphResources: sampleResources, contextRepo: "octo/app" })
    ],
    ["plannedGraphPage", () => plannedGraphPage({ contextRepo: "octo/app" })],
    [
      "plannedGraphPage with resources",
      () =>
        plannedGraphPage({
          plannedResources: sampleResources,
          plannedRepo: "octo/app"
        })
    ],
    ["graphDiffPage", () => graphDiffPage({ diffTargetRepo: "octo/app" })],
    [
      "graphDiffPage with resources",
      () => graphDiffPage({ diffResources: sampleResources })
    ],
    ["deployedGraphPage", () => deployedGraphPage({ contextRepo: "octo/app" })],
    ["environmentPage", () => environmentPage({ contextRepo: "octo/app" })],
    [
      "environmentPage credentials",
      () =>
        environmentPage({
          contextRepo: "octo/app",
          activeSubtab: "credentials"
        })
    ],
    [
      "environmentPage result",
      () => environmentPage({ deployResult: { message: "ok" } })
    ],
    ["deployingPage", () => deployingPage({ contextRepo: "octo/app" })]
  ];

  it.each(guarded)("%s emits no removed token or route", (_name, render) => {
    const html = render();
    for (const token of [...REMOVED_TOKENS, ...REMOVED_ROUTES]) {
      expect(html, token).not.toContain(token);
    }
    // The app model is authored by the skill, so no page ships a generate action.
    expect(html).not.toContain("Generate app.bicep");
    expect(html).not.toContain("singletonRecipe");
  });
});

// Every renderer composes server state into inline scripts, so each one must
// survive state that tries to close the script element. This is the whole-page
// counterpart to the encoding helpers' unit tests.
describe("no page lets state escape its inline scripts", () => {
  const hostileRenders: Array<[string, () => string]> = [
    [
      "graphPage",
      () =>
        graphPage({ contextRepo: HOSTILE_STATE, contextBranch: HOSTILE_STATE })
    ],
    [
      "graphPage with resources",
      () =>
        graphPage({
          graphResources: [
            { id: HOSTILE_STATE, name: HOSTILE_STATE, connections: [] }
          ],
          graphTargetRepo: HOSTILE_STATE
        })
    ],
    [
      "plannedGraphPage",
      () =>
        plannedGraphPage({
          contextRepo: HOSTILE_STATE,
          deployProvider: HOSTILE_STATE
        })
    ],
    [
      "plannedGraphPage with resources",
      () =>
        plannedGraphPage({
          plannedResources: [
            { id: HOSTILE_STATE, name: HOSTILE_STATE, connections: [] }
          ],
          plannedRepo: HOSTILE_STATE,
          plannedProvider: HOSTILE_STATE
        })
    ],
    [
      "graphDiffPage",
      () =>
        graphDiffPage({
          diffTargetRepo: HOSTILE_STATE,
          diffBase: HOSTILE_STATE,
          diffHead: HOSTILE_STATE,
          diffError: HOSTILE_STATE,
          branches: [HOSTILE_STATE],
          branchShas: { [HOSTILE_STATE]: HOSTILE_STATE }
        })
    ],
    [
      "graphDiffPage with resources",
      () =>
        graphDiffPage({
          diffResources: [
            { id: HOSTILE_STATE, name: HOSTILE_STATE, connections: [] }
          ],
          branches: [HOSTILE_STATE],
          branchShas: { [HOSTILE_STATE]: HOSTILE_STATE },
          diffBase: HOSTILE_STATE,
          diffHead: HOSTILE_STATE
        })
    ],
    [
      "deployedGraphPage",
      () =>
        deployedGraphPage({
          contextRepo: HOSTILE_STATE,
          contextBranch: HOSTILE_STATE,
          deployProvider: HOSTILE_STATE
        })
    ],
    [
      "environmentPage",
      () =>
        environmentPage({
          contextRepo: HOSTILE_STATE,
          contextBranch: HOSTILE_STATE,
          envName: HOSTILE_STATE
        })
    ],
    [
      "environmentPage result",
      () =>
        environmentPage({
          deployResult: {
            message: HOSTILE_STATE,
            workflow: HOSTILE_STATE,
            workflowUrl: "javascript:alert(1)"
          },
          deployAttempt: { id: HOSTILE_STATE }
        })
    ],
    [
      "deployingPage",
      () =>
        deployingPage({
          contextRepo: HOSTILE_STATE,
          contextBranch: HOSTILE_STATE
        })
    ],
    ["pageShell", () => pageShell(HOSTILE_STATE, "<p>trusted</p>")]
  ];

  it.each(hostileRenders)(
    "%s keeps every script block closed and parseable",
    (_name, render) => {
      const html = render();
      expectSafeInlineScripts(html);
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).not.toContain('href="javascript:');
    }
  );
});

describe("compiled graph page network contracts", () => {
  it.each([
    [
      "graph-page",
      [
        "/api/discover-branches",
        "/api/list-applications",
        "/api/list-environments",
        "/api/progress",
        "/api/load-graph"
      ]
    ],
    [
      "planned-graph-page",
      [
        "/api/discover-branches",
        "/api/list-applications",
        "/api/list-environments",
        "/api/list-deployments",
        "/api/deploy",
        "/api/progress",
        "/api/plan-graph"
      ]
    ],
    [
      "graph-diff-page",
      [
        "/api/discover-branches",
        "/api/list-applications",
        "/api/progress",
        "/api/diff-branches"
      ]
    ],
    [
      "deployed-graph-page",
      [
        "/api/delete-conflict",
        "/api/deploy",
        "/api/list-deployments",
        "/api/deployed-graph",
        "/api/deploy-status",
        "/api/list-applications",
        "/api/list-environments",
        "/api/delete-deployment",
        "/api/abandon-deployment"
      ]
    ]
  ] as const)(
    "%s exposes exactly its reviewed API path set",
    (entry, expected) => {
      const paths = [
        ...new Set(
          [...browserScript(entry).matchAll(/['"`(](\/api\/[a-z0-9-]+)/g)].map(
            (match) => match[1]
          )
        )
      ];
      expect(paths).toEqual(expected);
    }
  );
});
