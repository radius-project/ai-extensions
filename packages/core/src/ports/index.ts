// Ports — the interfaces the core depends on for outside-world access.
//
// The core never imports the Copilot SDK, opens an HTTP server, or touches the
// DOM. Reading a repository is the one side effect its use-cases need, so it is
// reached through the GitHub port below. Each UI adapter injects a concrete
// implementation; tests inject fakes.

/**
 * GitHub REST access, scoped to the read paths the modeling layer needs. Backed
 * by the `gh` CLI in the canvas adapter; fakeable from recorded fixtures.
 */
export interface GitHub {
  /** Decoded UTF-8 contents of a repo file, or null on any error/empty body. */
  getContent(apiPath: string): Promise<string | null>;
  /** Entry names of a contents directory ([] on error). */
  listNames(apiPath: string): Promise<string[]>;
  /** Recursive list of every path in a repo tree ([] on error). */
  treePaths(repo: string, branch: string): Promise<string[]>;
}
