import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const require = createRequire(import.meta.url);
// ESLint ships JavaScript; keep its narrow result contract explicit.
const { ESLint } = require("eslint") as {
  ESLint: new (options: { cwd: string }) => {
    lintText(
      text: string,
      options: { filePath: string }
    ): Promise<
      {
        messages: { ruleId: string | null }[];
      }[]
    >;
  };
};

function reachableFiles(
  files: Record<string, string>,
  entry: string
): string[] {
  const virtualRoot = "/workflow-boundary";
  const config = virtualRoot + "/tsconfig.json";
  const api = new API({
    cwd: virtualRoot,
    fs: createVirtualFileSystem({
      ...Object.fromEntries(
        Object.entries(files).map(([name, text]) => [
          virtualRoot + "/" + name,
          text
        ])
      ),
      [config]: JSON.stringify({
        compilerOptions: {
          noLib: true,
          types: [],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          paths: { "@radius-project/core": ["./packages/core/src/index.ts"] }
        },
        files: [entry]
      })
    })
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project) throw new Error("Workflow boundary project did not load");
      return project.program
        .getSourceFileNames()
        .map((file) => file.slice(virtualRoot.length + 1));
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

async function sources(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await sources(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      result[path.relative(root, full).replaceAll("\\", "/")] = await readFile(
        full,
        "utf8"
      );
    }
  }
  return result;
}

async function boundaryViolations(
  files: Record<string, string>,
  entry: string
): Promise<string[]> {
  const owner = entry.includes("/core/") ? "core" : "adapter-shared";
  const eslint = new ESLint({ cwd: root });
  const violations: string[] = [];
  for (const file of reachableFiles(files, entry)) {
    if (
      file.includes("adapter-canvas") ||
      (owner === "core" && file.includes("adapter-shared"))
    ) {
      violations.push(file);
    }
    const results = await eslint.lintText(files[file], {
      // Apply the originating entry's boundary even to a neutral intermediary.
      filePath: `packages/${owner}/src/transitive-fixture.ts`
    });
    if (
      results.some((result) =>
        result.messages.some((message) =>
          message.ruleId?.startsWith("no-restricted-")
        )
      )
    ) {
      violations.push(file);
    }
  }
  return violations;
}

describe("workflow package boundaries", () => {
  it.each(["core", "adapter-shared"])(
    "executes positive and negative ESLint fixtures for %s",
    async (owner) => {
      const eslint = new ESLint({ cwd: root });
      const filePath = `packages/${owner}/src/workflow-fixture.ts`;
      const denied =
        owner === "core" ?
          [
            "@radius-project/adapter-shared",
            "@radius-project/adapter-shared/reads",
            "../../adapter-canvas/src/deploy.js",
            "@github/copilot-sdk/extension",
            "node:http"
          ]
        : [
            "@radius-project/adapter-canvas",
            "@radius-project/adapter-canvas/deploy",
            "../../adapter-canvas/src/deploy.js"
          ];
      for (const specifier of denied) {
        for (const text of [
          `import "${specifier}";`,
          `export * from "${specifier}";`,
          `export { value } from "${specifier}";`,
          `void import("${specifier}");`
        ]) {
          const results = await eslint.lintText(text, { filePath });
          expect(
            results.flatMap((result) => result.messages),
            text
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                ruleId: expect.stringMatching(/^no-restricted-/)
              })
            ])
          );
        }
      }
      const allowed =
        owner === "core" ? "./workflow-observation.js" : "@radius-project/core";
      const results = await eslint.lintText(
        `export * from "${allowed}"; void import("${allowed}");`,
        { filePath }
      );
      expect(results.flatMap((result) => result.messages)).toEqual([]);
    }
  );

  it("uses TypeScript resolution to catch a forbidden transitive edge through an intermediate module", async () => {
    const entry = "packages/core/src/workflow-observation.ts";
    const files = {
      [entry]: 'export * from "./intermediate.js";',
      "packages/core/src/intermediate.ts":
        'export * from "../../adapter-canvas/src/hidden.js";',
      "packages/adapter-canvas/src/hidden.ts": "export const hidden = true;",
      "packages/adapter-canvas/src/unreachable.ts":
        "export const unused = true;"
    };
    expect(reachableFiles(files, entry)).toEqual([
      "packages/adapter-canvas/src/hidden.ts",
      "packages/core/src/intermediate.ts",
      entry
    ]);
    expect(
      reachableFiles(
        {
          ...files,
          "packages/core/src/intermediate.ts": "export const safe = true;"
        },
        entry
      )
    ).toEqual(["packages/core/src/intermediate.ts", entry]);
    expect(await boundaryViolations(files, entry)).toContain(
      "packages/adapter-canvas/src/hidden.ts"
    );
    expect(
      await boundaryViolations(
        {
          ...files,
          "packages/core/src/intermediate.ts":
            'import "node:http"; export const unsafe = true;'
        },
        entry
      )
    ).toContain("packages/core/src/intermediate.ts");
    expect(
      await boundaryViolations(
        {
          ...files,
          "packages/core/src/intermediate.ts": "export const safe = true;"
        },
        entry
      )
    ).toEqual([]);
  });

  it("resolves the real core and shared entry closures without reaching Canvas", async () => {
    const files = {
      ...(await sources(path.join(root, "packages", "core", "src"))),
      ...(await sources(path.join(root, "packages", "adapter-shared", "src"))),
      ...(await sources(path.join(root, "packages", "adapter-canvas", "src")))
    };
    for (const entry of [
      "packages/core/src/workflow-observation.ts",
      "packages/core/src/workflow-diagnostics.ts",
      "packages/adapter-shared/src/workflow-reads.ts"
    ]) {
      expect(reachableFiles(files, entry)).toContain(entry);
      expect(await boundaryViolations(files, entry)).toEqual([]);
    }
  });
});
