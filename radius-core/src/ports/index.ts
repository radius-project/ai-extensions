// Ports — the interfaces the core depends on for all outside-world access.
//
// The core never imports the Copilot SDK, opens an HTTP server, or touches the
// DOM. Every side effect (running a CLI, calling the GitHub API, persisting
// state, reading the clock, logging) is reached through one of these ports.
// Each UI adapter injects concrete implementations; tests inject fakes.

/** Result of running an external command through the Shell port. */
export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs external CLIs (gh, az, aws, kubectl, rad). The only port that spawns. */
export interface Shell {
  /** Run argv with a timeout; resolves with captured output and exit code. */
  run(
    command: string,
    args: string[],
    opts?: { timeoutMs?: number }
  ): Promise<ShellResult>;
}

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

/** Durable, domain-id-keyed state. The only path-aware port. */
export interface StateStore<T = any> {
  get(domainId: string): T | undefined;
  set(domainId: string, value: T): void;
}

/** Wall clock, injected so time-dependent logic stays deterministic in tests. */
export interface Clock {
  now(): number;
}

/** Structured logging — never `console.*`; the adapter wraps `session.log`. */
export interface Logger {
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/** The full set of ports a use-case may require, injected by an adapter. */
export interface Ports {
  shell: Shell;
  github: GitHub;
  state: StateStore;
  clock: Clock;
  logger: Logger;
}
