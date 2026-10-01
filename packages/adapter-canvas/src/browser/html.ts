// Canvas status chips carry a space-separated class list. The graph library has
// no use for this, so it stays with the shell rather than on a shared subpath.
export function hasClassToken(className: string, token: string): boolean {
  return className.split(/\s+/).includes(token);
}
