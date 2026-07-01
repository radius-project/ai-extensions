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
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}
