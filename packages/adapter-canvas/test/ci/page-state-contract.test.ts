import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as stateContract from "../../src/pages/browser-state-ids.js";
import {
  checkPageStateContract,
  checkPageStateContracts
} from "./page-state-contract.js";

const stateIds = new Set(
  Object.values(stateContract).filter((value) => typeof value === "string")
);
const [stateName, stateId] = Object.entries(stateContract)[0] ?? [];
if (!stateName || !stateId) {
  throw new Error("The canonical page-state contract must declare state IDs.");
}
const idImport = `import { ${stateName} as ID } from "../pages/browser-state-ids.js";`;
const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return productionSources(fullPath);
      }
      return (
          /\.(?:ts|mjs|js)$/.test(entry.name) &&
            !/\.(?:test|spec|d)\.ts$/.test(entry.name)
        ) ?
          [fullPath]
        : [];
    })
  );
  return files.flat();
}

describe("page-state architecture contract", () => {
  it.each([
    {
      name: "the canonical hidden-element producer",
      fileName: "pages/page-state.ts",
      text: 'export function renderPageState(id, state) { return `<div hidden id="${id}">${JSON.stringify(state)}</div>`; }'
    },
    {
      name: "a future renderer using the helper",
      fileName: "pages/future/nested-page.ts",
      text: 'import { renderPageState } from "../page-state.js"; export const render = () => `<main>${renderPageState(ID, state)}</main>`;'
    },
    {
      name: "hidden form controls and escaped HTML attributes",
      fileName: "pages/new-page.ts",
      text: 'const html = `<input type="hidden" id="repo" value="${escapeHtml(repo)}"><div id="status">${escapeHtml(message)}</div>`;'
    },
    {
      name: "ordinary hidden inputs with a state-named form field",
      fileName: "pages/new-page.ts",
      text: 'const html = `<input hidden id="form-state" value="${escapeHtml(value)}">`;'
    },
    {
      name: "aria-hidden presentation elements",
      fileName: "pages/new-page.ts",
      text: 'const html = `<div aria-hidden="true" id="decoration">${icon}</div>`;'
    },
    {
      name: "hidden status placeholders and navigation chips",
      fileName: "pages/new-page.ts",
      text: 'const html = `<div id="error" hidden></div><a hidden id="chip"><span>${escapeHtml(label)}</span></a>`;'
    },
    {
      name: "visible state progress controls",
      fileName: "pages/new-page.ts",
      text: 'const html = `<div id="progress-state">${escapeHtml(status)}</div>`;'
    },
    {
      name: "a static feedback script",
      fileName: "ui.ts",
      text: "const html = `<script>window.feedback = () => true;</script>`;"
    },
    {
      name: "markup interpolation after a static script",
      fileName: "pages/new-page.ts",
      text: "const html = `<script>start()</script><main>${body}</main>`;"
    },
    {
      name: "compiled browser scripts",
      fileName: "browser/scripts.ts",
      text: "const html = `<script>${browserScript(name)}</script>`;"
    },
    {
      name: "compiled source build embedding",
      fileName: "browser/build.ts",
      text: "const result = JSON.stringify(source);"
    },
    {
      name: "ordinary HTTP JSON and SSE",
      fileName: "server/routes/status.ts",
      text: "response.end(JSON.stringify(state)); response.write(`data: ${JSON.stringify(state)}\\n\\n`);"
    },
    {
      name: "ordinary browser storage JSON",
      fileName: "browser/storage.ts",
      text: 'storage.setItem("view", JSON.stringify(state)); const state = JSON.parse(storage.getItem("view"));'
    },
    {
      name: "canonical ID declarations",
      fileName: "pages/browser-state-ids.ts",
      text: `export const ${stateName} = "${stateId}";`
    },
    {
      name: "the reader with an aliased canonical import",
      fileName: "browser/future.ts",
      text: `${idImport} import { readPageState as read } from "./pages/state.js"; const state = read(context, ID);`
    },
    {
      name: "unrelated DOM reads and JSON parsing",
      fileName: "browser/future.ts",
      text: 'const label = context.dom.byId("status").textContent; const state = JSON.parse(response);'
    },
    {
      name: "ordinary form value reads",
      fileName: "browser/future.ts",
      text: 'const repo = context.dom.byId("repo").value; const branch = document.getElementById("branch").value;'
    },
    {
      name: "state presence checks for lifecycle and heartbeat",
      fileName: "browser/future.ts",
      text: `${idImport} if (!context.dom.byId(ID)) return; const exists = document.getElementById(ID) !== null;`
    },
    {
      name: "reader callers using an imported ID re-export",
      fileName: "browser/entries/future.ts",
      text: 'import { ID } from "../future.js"; import { readPageState } from "../pages/state.js"; readPageState(context, ID);'
    }
  ])("allows $name", ({ fileName, text }) => {
    expect(checkPageStateContract({ fileName, text }, stateIds)).toEqual([]);
  });

  it.each([
    {
      name: "manual hidden state",
      text: `${idImport} const html = \`<div hidden id="\${ID}">\${escapeHtml(JSON.stringify(state))}</div>\`;`,
      message: "Use renderPageState"
    },
    {
      name: "a hidden input with an imported state ID",
      text: `${idImport} const html = \`<input type="hidden" id="\${ID}" value="\${escapeHtml(JSON.stringify(state))}">\`;`,
      message: "Use renderPageState"
    },
    {
      name: "a self-closing mixed-case input with an imported state ID",
      text: `${idImport} const html = \`<INPUT id="\${ID}" hidden value="\${value}" />\`;`,
      message: "Use renderPageState"
    },
    {
      name: "a hidden input with a literal canonical state ID",
      text: `const html = '<input type="hidden" id="${stateId}" value="state">';`,
      message: "Use renderPageState"
    },
    {
      name: "reordered hidden attributes",
      text: `${idImport} const html = \`<DIV id="\${ID}" hidden="">\${value}</DIV>\`;`,
      message: "Use renderPageState"
    },
    {
      name: "a new unknown hidden container",
      text: 'const html = `<section hidden id="future-state">${state}</section>`;',
      message: "Use renderPageState"
    },
    {
      name: "an arbitrarily named hidden JSON container",
      text: 'const html = `<div hidden id="future">${escapeHtml(JSON.stringify(payload))}</div>`;',
      message: "Use renderPageState"
    },
    {
      name: "a canonical state element without the hidden attribute",
      text: `${idImport} const html = \`<section id="\${ID}">\${value}</section>\`;`,
      message: "Use renderPageState"
    },
    {
      name: "concatenated hidden state",
      text: `${idImport} const html = "<div hidden id=\\"" + ID + "\\">" + state + "</div>";`,
      message: "Use renderPageState"
    },
    {
      name: "raw JSON in a script",
      text: "const html = `<script>const state = ${JSON.stringify(state)};</script>`;",
      message: "Do not interpolate data"
    },
    {
      name: "quoted HTML escaping in a script",
      text: 'const html = `<script>const repo = "${escapeHtml(repo)}";</script>`;',
      message: "Do not interpolate data"
    },
    {
      name: "other dynamic script expressions",
      text: 'const html = `<ScRiPt nonce="static">start(${value})</sCrIpT>`;',
      message: "Do not interpolate data"
    },
    {
      name: "concatenated script data",
      text: 'const html = "<script>start(" + JSON.stringify(state) + ")</script>";',
      message: "Do not interpolate data"
    },
    {
      name: "a second script after a static one",
      text: "const html = `<script>start()</script><script>${state}</script>`;",
      message: "Do not interpolate data"
    },
    {
      name: "dynamic script attributes before embedded data",
      text: 'const html = `<script nonce="${nonce}">start(${state})</script>`;',
      message: "Do not interpolate data"
    },
    {
      name: "an obsolete serializer import with an alias",
      text: 'import { inlineJson as encode } from "./encoding.js";',
      message: "Remove obsolete serialization"
    },
    {
      name: "the obsolete quoted JavaScript encoder",
      text: "inlineJsString(value);",
      message: "Remove obsolete serialization"
    },
    {
      name: "the obsolete function serializer",
      text: "serializeBrowserFunction(callback);",
      message: "Remove obsolete serialization"
    },
    {
      name: "an obsolete module import",
      text: 'import * as legacy from "./browser-function.js";',
      message: "Import the canonical"
    },
    {
      name: "a duplicate ID declaration",
      text: `const ID = "${stateId}";`,
      message: "Import state IDs"
    },
    {
      name: "a state ID literal inside markup",
      text: `const html = '<div id="${stateId}">data</div>';`,
      message: "Import state IDs"
    }
  ])("rejects $name with an actionable location", ({ text, message }) => {
    const violations = checkPageStateContract(
      { fileName: "pages/future.ts", text: `// fixture\n${text}` },
      stateIds
    );
    expect(violations).toContainEqual({
      fileName: "pages/future.ts",
      line: 2,
      message: expect.stringContaining(message)
    });
  });

  it.each([
    "server/routes/future.ts",
    "browser/future.ts",
    "runtime/future.ts",
    "browser/build.ts"
  ])("checks markup outside page renderers in %s", (fileName) => {
    for (const text of [
      "const html = `<script>const state = ${JSON.stringify(state)};</script>`;",
      'const html = `<script>const repo = "${escapeHtml(repo)}";</script>`;',
      'const html = `<div hidden id="future-state">${escapeHtml(JSON.stringify(state))}</div>`;'
    ]) {
      expect(checkPageStateContract({ fileName, text }, stateIds)).toEqual([
        {
          fileName,
          line: 1,
          message: expect.stringMatching(/renderPageState/)
        }
      ]);
    }
  });

  it("does not exempt hidden state construction in the compiled script emitter", () => {
    expect(
      checkPageStateContract(
        {
          fileName: "browser/scripts.ts",
          text: 'const html = `<div hidden id="future-state">${JSON.stringify(state)}</div>`;'
        },
        stateIds
      )
    ).toEqual([
      {
        fileName: "browser/scripts.ts",
        line: 1,
        message: expect.stringContaining("Use renderPageState")
      }
    ]);
  });

  it.each([
    "context.dom.byId(ID).textContent;",
    "document.getElementById(ID).textContent;",
    "context.dom.byId(ID).value;",
    "document.getElementById(ID).value;",
    'import { readPageState } from "./pages/state.js"; readPageState(context, otherId);',
    'import { readPageState } from "./pages/state.js"; readPageState(context);',
    'import { readPageState } from "./other-reader.js"; readPageState(context, ID);'
  ])("rejects bypassed or inconsistent browser reading: %s", (text) => {
    expect(
      checkPageStateContract(
        { fileName: "browser/future.ts", text: `${idImport}\n${text}` },
        stateIds
      )
    ).toEqual([
      {
        fileName: "browser/future.ts",
        line: 2,
        message: expect.stringMatching(/readPageState|canonical reader/)
      }
    ]);
  });

  it("rejects a restored obsolete module even when empty", () => {
    expect(
      checkPageStateContract(
        { fileName: "browser\\page-state-ids.ts", text: "" },
        stateIds
      )
    ).toEqual([
      {
        fileName: "browser/page-state-ids.ts",
        line: 1,
        message: "Remove this obsolete page-state alternative."
      }
    ]);
  });

  it.each([
    "export function serialize(state) { return JSON.stringify(state); }",
    "export const serialize = JSON.stringify;",
    "const serialize = JSON.stringify; export { serialize };"
  ])("keeps helper serialization private: %s", (text) => {
    expect(
      checkPageStateContract(
        { fileName: "pages/page-state.ts", text },
        stateIds
      )
    ).toEqual([
      {
        fileName: "pages/page-state.ts",
        line: 1,
        message:
          "Keep serialization private; renderPageState is the only public producer."
      }
    ]);
  });

  it("keeps all production sources on the canonical state boundary", async () => {
    const files = await productionSources(sourceRoot);
    expect(files.length).toBeGreaterThan(0);
    const sources = await Promise.all(
      files.map(async (file) => ({
        fileName: path.relative(sourceRoot, file),
        text: await readFile(file, "utf8")
      }))
    );
    expect(checkPageStateContracts(sources, stateIds)).toEqual([]);
  });

  it("reports malformed TypeScript instead of silently accepting partial markup", () => {
    expect(
      checkPageStateContract(
        { fileName: "pages/broken.ts", text: "const html = `<script>${" },
        stateIds
      )
    ).toEqual([
      {
        fileName: "pages/broken.ts",
        line: 1,
        message:
          "Fix TypeScript syntax before checking the page-state contract."
      }
    ]);
  });

  it("releases a failed virtual parse and isolates the next project", () => {
    expect(() =>
      checkPageStateContract(
        { fileName: "unsupported.txt", text: "" },
        stateIds
      )
    ).toThrow("Cannot parse page-state contract source: unsupported.txt");
    expect(
      checkPageStateContract(
        { fileName: "pages/clean.ts", text: "export const clean = true;" },
        stateIds
      )
    ).toEqual([]);
  });
});
