import path from "node:path";
// These test-only APIs are locked by pnpm-lock.yaml. TypeScript upgrades must
// pass typecheck and this suite's positive/negative fixtures; import/API failures
// fail the gate rather than disabling the check.
import * as ts from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

export interface ContractSource {
  /** Path relative to adapter-canvas/src. */
  fileName: string;
  text: string;
}

export interface ContractViolation {
  fileName: string;
  line: number;
  message: string;
}

const producer = "pages/page-state.ts";
const idsModule = "pages/browser-state-ids.ts";
const reader = "browser/pages/state.ts";
const obsoleteNames = new Set([
  "inlineJson",
  "inlineJsString",
  "serializeBrowserFunction"
]);
const obsoleteModules = new Set([
  "pages/browser-function.ts",
  "browser/page-state-ids.ts"
]);

interface TextPart {
  text: string;
  expression?: ts.Expression;
}

function textParts(expression: ts.Expression): TextPart[] {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return [{ text: expression.text }];
  }
  if (ts.isTemplateExpression(expression)) {
    return [
      { text: expression.head.text },
      ...expression.templateSpans.flatMap((span) => [
        { text: "\u0000", expression: span.expression },
        { text: span.literal.text }
      ])
    ];
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    return [...textParts(expression.left), ...textParts(expression.right)];
  }
  if (ts.isParenthesizedExpression(expression)) {
    return textParts(expression.expression);
  }
  return [{ text: "\u0000", expression }];
}

function isTextConstruction(node: ts.Node): node is ts.Expression {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  );
}

function resolvedModule(fileName: string, specifier: string): string {
  return path.posix
    .normalize(path.posix.join(path.posix.dirname(fileName), specifier))
    .replace(/\.js$/, ".ts");
}

/**
 * A structural convention check, not a JavaScript evaluator or an HTML sanitizer.
 * Inspect literal/template/concatenated markup and direct DOM state access;
 * executable renderer/HTML-parser tests cover the actual transport semantics.
 */
export function checkPageStateContract(
  input: ContractSource,
  stateIds: ReadonlySet<string>
): ContractViolation[] {
  return checkPageStateContracts([input], stateIds);
}

export function checkPageStateContracts(
  inputs: readonly ContractSource[],
  stateIds: ReadonlySet<string>
): ContractViolation[] {
  // TypeScript 7 exposes parsing through its native compiler API. The virtual
  // project is isolated from disk and avoids resolving production dependencies.
  const root = path.resolve(".page-state-contract").replace(/\\/g, "/");
  const config = `${root}/tsconfig.json`;
  const files = Object.fromEntries(
    inputs.map((input) => [
      `${root}/${input.fileName.replace(/\\/g, "/")}`,
      input.text
    ])
  );
  const api = new API({
    cwd: root,
    fs: createVirtualFileSystem({
      ...files,
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, allowJs: true },
        files: Object.keys(files)
      })
    })
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (!project) {
        throw new Error(
          "The page-state contract virtual project was not loaded."
        );
      }
      return inputs.flatMap((input) => {
        const fileName = input.fileName.replace(/\\/g, "/");
        const fullPath = `${root}/${fileName}`;
        const source = project.program.getSourceFile(fullPath);
        if (!source) {
          throw new Error(
            `Cannot parse page-state contract source: ${fileName}`
          );
        }
        if (project.program.getSyntacticDiagnostics(fullPath).length > 0) {
          return [
            {
              fileName,
              line: 1,
              message:
                "Fix TypeScript syntax before checking the page-state contract."
            }
          ];
        }
        return checkSource(fileName, source, stateIds);
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function checkSource(
  fileName: string,
  source: ts.SourceFile,
  stateIds: ReadonlySet<string>
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  const report = (node: ts.Node, message: string): void => {
    violations.push({
      fileName,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      message
    });
  };
  const imports = new Map<string, { module: string; name: string }>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const module = resolvedModule(fileName, statement.moduleSpecifier.text);
    if (obsoleteModules.has(module)) {
      report(
        statement,
        "Import the canonical page-state producer/ID contract."
      );
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        imports.set(binding.name.text, {
          module,
          name: (binding.propertyName ?? binding.name).text
        });
      }
    }
  }
  if (obsoleteModules.has(fileName)) {
    report(source, "Remove this obsolete page-state alternative.");
  }
  const isStateId = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      return imports.get(expression.text)?.module === idsModule;
    }
    return (
      (ts.isStringLiteral(expression) ||
        ts.isNoSubstitutionTemplateLiteral(expression)) &&
      stateIds.has(expression.text)
    );
  };
  const checkMarkup = (node: ts.Expression): void => {
    const parts = textParts(node);
    const markup = parts.map((part) => part.text).join("");
    const expressions = new Map<number, ts.Expression>();
    let offset = 0;
    for (const part of parts) {
      if (part.expression) expressions.set(offset, part.expression);
      offset += part.text.length;
    }
    const containsJsonSerialization = (expression: ts.Node): boolean =>
      (ts.isCallExpression(expression) &&
        ts.isPropertyAccessExpression(expression.expression) &&
        ts.isIdentifier(expression.expression.expression) &&
        expression.expression.expression.text === "JSON" &&
        expression.expression.name.text === "stringify") ||
      expression.forEachChild(containsJsonSerialization) === true;
    if (fileName !== producer) {
      // Hidden controls, status placeholders, and navigation chips are not
      // state. Recognize canonical IDs and state-named containers instead.
      for (const tag of markup.matchAll(/<([a-z][\w:-]*)\b([^<>]*)>/gi)) {
        const name = tag[1]?.toLowerCase();
        const attributes = tag[2] ?? "";
        const id = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i.exec(
          attributes
        );
        const idValue = id?.[1] ?? id?.[2] ?? id?.[3] ?? "";
        const contentStart = tag.index + tag[0].length;
        const contentEnd = markup
          .toLowerCase()
          .indexOf(`</${name}`, contentStart);
        const serializedContent =
          /(?:^|\s)hidden(?:\s|=|$)/i.test(attributes) &&
          [...expressions].some(
            ([position, expression]) =>
              position >= contentStart &&
              position < contentEnd &&
              containsJsonSerialization(expression)
          );
        const canonicalStateId =
          stateIds.has(idValue) ||
          (idValue.includes("\u0000") &&
            [...expressions].some(
              ([position, expression]) =>
                position >= tag.index &&
                position < contentStart &&
                isStateId(expression)
            ));
        const stateElement =
          canonicalStateId ||
          (idValue !== "" && serializedContent) ||
          (/(?:^|[-_])state(?:$|[-_])/i.test(idValue) &&
            /(?:^|\s)hidden(?:\s|=|$)/i.test(attributes));
        if (stateElement && (name !== "input" || canonicalStateId)) {
          report(
            node,
            "Use renderPageState(id, state), not handwritten hidden state markup."
          );
        }
      }
    }
    // Only the compiled browser-script emitter may interpolate script content;
    // it still cannot construct page-state elements. All other adapter sources
    // are inspected, including routes and browser-created markup.
    if (fileName === "browser/scripts.ts") return;
    // Reconstruct holes before inspecting tags, so dynamic script attributes
    // cannot hide subsequent interpolation by splitting the opening tag.
    for (const script of markup.matchAll(
      /<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi
    )) {
      if (script[0].includes("\u0000")) {
        report(
          node,
          "Do not interpolate data into page scripts; use renderPageState and readPageState."
        );
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      fileName === producer &&
      ((ts.isFunctionDeclaration(node) &&
        node.name?.text !== "renderPageState") ||
        (ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            (declaration) =>
              !ts.isIdentifier(declaration.name) ||
              declaration.name.text !== "renderPageState"
          ))) &&
      node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      )
    ) {
      report(
        node,
        "Keep serialization private; renderPageState is the only public producer."
      );
    }
    if (
      fileName === producer &&
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly
    ) {
      report(
        node,
        "Keep serialization private; renderPageState is the only public producer."
      );
    }
    if (ts.isIdentifier(node) && obsoleteNames.has(node.text)) {
      report(
        node,
        "Remove obsolete serialization helpers; use renderPageState."
      );
    }
    if (
      fileName !== idsModule &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      [...stateIds].some((id) => node.text.includes(id))
    ) {
      report(
        node,
        "Import state IDs from pages/browser-state-ids.ts; do not duplicate their literals."
      );
    }
    if (isTextConstruction(node)) {
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) {
        parent = parent.parent;
      }
      if (!(
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )) {
        checkMarkup(node);
      }
    }
    if (fileName.startsWith("browser/") && ts.isCallExpression(node)) {
      const second = node.arguments[1];
      const binding =
        ts.isIdentifier(node.expression) ?
          imports.get(node.expression.text)
        : undefined;
      if (
        binding?.name === "readPageState" &&
        (binding.module !== reader ||
          !second ||
          !ts.isIdentifier(second) ||
          !imports.has(second.text))
      ) {
        report(
          node,
          "Read page state with the canonical reader and an imported state ID."
        );
      }
      const first = node.arguments[0];
      if (
        fileName !== reader &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["byId", "getElementById"].includes(node.expression.name.text) &&
        first &&
        isStateId(first) &&
        ts.isPropertyAccessExpression(node.parent) &&
        ["textContent", "innerHTML", "innerText", "value"].includes(
          node.parent.name.text
        )
      ) {
        report(
          node,
          "Use readPageState instead of reading a page-state element directly."
        );
      }
    }
    node.forEachChild(visit);
  };
  visit(source);
  return violations;
}
