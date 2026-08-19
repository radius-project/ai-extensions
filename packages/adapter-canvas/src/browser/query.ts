// Canvas adapter — reading values out of a page entry's query string.
//
// Shared rather than duplicated per entry because the failure mode below is
// identical everywhere and must not be fixed in only some of the copies.

// The query strings these entries read are not always ones we produced. Every
// redirect this adapter builds encodes with encodeURIComponent, but a
// hand-edited, truncated or copy-pasted URL can carry a malformed escape such
// as `?application=%`, and decodeURIComponent throws URIError on it.
//
// Throwing here is not survivable. Page entries read the query after
// beginEntry has claimed their key and before they return a teardown, and
// runBrowserEntry does not wrap install(), so a URIError escapes the compiled
// entry IIFE with the claim still held. The key then stays claimed for the
// life of the document, every re-bind returns NOOP_TEARDOWN, and the page is
// left dead with its listeners leaked.
//
// The legacy implementation parsed with URLSearchParams, which yields the raw
// text for a malformed escape instead of throwing, and still wrapped its uses
// in try/catch. Falling back to the raw substring restores exactly that
// behavior: a bad escape degrades to a value that simply will not match,
// rather than bricking the page.
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function queryValue(search: string, name: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeComponent(key) !== name) continue;
    return decodeComponent(
      (separator < 0 ? "" : pair.slice(separator + 1)).replace(/\+/g, " ")
    );
  }
  return "";
}
