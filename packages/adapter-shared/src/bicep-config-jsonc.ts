import { parseTree, type Node, type ParseError } from "jsonc-parser";

/** Match JSON.parse's own-property semantics, including for "__proto__". */
function materialize(node: Node): unknown {
  if (node.type === "object") {
    const entries: Array<[string, unknown]> = [];
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (key && typeof key.value === "string" && value)
        entries.push([key.value, materialize(value)]);
    }
    return Object.fromEntries(entries);
  }
  if (node.type === "array") return (node.children ?? []).map(materialize);
  return node.value;
}

export function readBicepConfigJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });
  if (!root || errors.length) throw new SyntaxError("Not valid JSON.");
  return materialize(root);
}
