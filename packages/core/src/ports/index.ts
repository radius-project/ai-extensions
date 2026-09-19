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
  /** Decoded UTF-8 contents (including ""), or null for confirmed absence.
   * Rejects when source access or response validity cannot be established.
   */
  getContent(apiPath: string): Promise<string | null>;
  /** Directory entry names; [] for empty or confirmed absent directories.
   * Rejects on access failures or invalid responses.
   */
  listNames(apiPath: string): Promise<string[]>;
  /** Complete recursive file listing, including [] for a confirmed empty tree.
   * Rejects on unavailable branches, access failures, or incomplete responses.
   */
  treePaths(repo: string, branch: string): Promise<string[]>;
}
