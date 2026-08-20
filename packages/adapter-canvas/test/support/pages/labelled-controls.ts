// Every rendered <select> must have a programmatic name, or assistive
// technology announces it as an unlabeled combo box (WCAG 4.1.2). Returns the
// ids of selects that no <label for=...> or inline ARIA name covers, so a page
// renderer can assert the empty set instead of spot-checking one control.
export function unlabelledSelectIds(html: string): string[] {
  return unnamedControlIds(html, /<select\b([^>]*)>/g);
}

// Text-entry inputs need the same programmatic name. These are easy to miss
// because a sibling <label for=...> may point at a neighbouring <select>, which
// names that select and leaves the input silently unnamed. A `placeholder` is
// deliberately not accepted here: it disappears on input and is not a label.
// Types that carry their own name (buttons) or are never announced (hidden) are
// skipped.
const UNNAMED_INPUT_TYPES = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image"
]);

export function unlabelledTextInputIds(html: string): string[] {
  return unnamedControlIds(html, /<input\b([^>]*?)\/?>/g, (attributes) => {
    const type = /\btype="([^"]+)"/.exec(attributes)?.[1] ?? "text";
    return !UNNAMED_INPUT_TYPES.has(type);
  });
}

function unnamedControlIds(
  html: string,
  pattern: RegExp,
  include: (attributes: string) => boolean = () => true
): string[] {
  const labelledFor = new Set<string>();
  for (const match of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g))
    labelledFor.add(match[1]);

  const missing: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1];
    if (!include(attributes)) continue;
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1] ?? "";
    const hasAriaName =
      /\baria-label="[^"]+"/.test(attributes) ||
      /\baria-labelledby="[^"]+"/.test(attributes);
    if (hasAriaName) continue;
    if (id === "" || !labelledFor.has(id)) missing.push(id || "(no id)");
  }
  return missing;
}
