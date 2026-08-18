// Every rendered <select> must have a programmatic name, or assistive
// technology announces it as an unlabeled combo box (WCAG 4.1.2). Returns the
// ids of selects that no <label for=...> or inline ARIA name covers, so a page
// renderer can assert the empty set instead of spot-checking one control.
export function unlabelledSelectIds(html: string): string[] {
  const labelledFor = new Set<string>();
  for (const match of html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g))
    labelledFor.add(match[1]);

  const missing: string[] = [];
  for (const match of html.matchAll(/<select\b([^>]*)>/g)) {
    const attributes = match[1];
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1] ?? "";
    const hasAriaName =
      /\baria-label="[^"]+"/.test(attributes) ||
      /\baria-labelledby="[^"]+"/.test(attributes);
    if (hasAriaName) continue;
    if (id === "" || !labelledFor.has(id)) missing.push(id || "(no id)");
  }
  return missing;
}
