/**
 * Fill `{{TOKEN}}` placeholders in a static workflow template.
 *
 * Substitution uses a replacer function (not `String.replaceAll` with a string
 * replacement) so that `$` sequences in the injected values — GitHub Actions
 * expressions like `${{ ... }}`, shell `$VAR`, `$(...)` — are inserted verbatim
 * and never interpreted as replacement patterns (`$&`, `$$`, …). Only known
 * `{{UPPER_SNAKE}}` tokens are replaced; anything else (including GitHub's
 * `${{ ... }}` expressions, which always have a space after `{{`) is left as-is.
 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

/**
 * Return the distinct unresolved `{{UPPER_SNAKE}}` tokens still present in
 * `text`, in first-seen order. Uses the same token pattern as `fillTemplate`, so
 * GitHub Actions `${{ ... }}` expressions (which always have a space after
 * `{{`) are never reported.
 */
export function findUnresolvedPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{\{[A-Z_]+\}\}/g)) {
    seen.add(match[0]);
  }
  return [...seen];
}

/**
 * Throw if `text` still contains any unresolved `{{UPPER_SNAKE}}` placeholder.
 * Used to fail workflow generation before a broken file is committed, so an
 * unfilled placeholder (e.g. a new template token the generator forgot to
 * supply) surfaces immediately instead of being rejected later by GitHub.
 */
export function assertNoUnresolvedPlaceholders(
  text: string,
  context: string
): void {
  const unresolved = findUnresolvedPlaceholders(text);
  if (unresolved.length > 0) {
    throw new Error(
      `Unresolved template placeholder(s) ${unresolved.join(", ")} remain in ${context}. Every {{...}} placeholder must be filled before the workflow is committed.`
    );
  }
}
