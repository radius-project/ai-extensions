// A deterministic `CloudCommandPort` for the fixture's own unit tests.
//
// It throws on any invocation a scenario did not specify. That is the point: a
// fake that silently returned success would let `assertCleanSlate()` pass
// because a probe was never wired up, which is the precise failure mode this
// whole layer exists to prevent. Every command a test expects must be declared,
// and every command a test did not expect is a loud failure naming the argv.
import type {
  CloudCommandPort,
  CloudCommandResult,
  CloudFixturePorts
} from "./cloud-command-port.js";

export type CloudTool = "az" | "gh" | "git";

/** A recorded invocation, for asserting what the fixture actually ran. */
export interface RecordedCommand {
  readonly tool: CloudTool;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export interface FakeCommandStub {
  readonly tool: CloudTool;
  /**
   * Every token that must appear, in order but not necessarily adjacently, in
   * the invocation. `["ad", "app", "list"]` matches
   * `az ad app list --display-name x`.
   */
  readonly match: readonly string[];
  /** The result to return, or a function of the actual argv. */
  readonly respond:
    | Partial<CloudCommandResult>
    | ((args: readonly string[]) => Partial<CloudCommandResult>);
  /** When set, the stub is consumed after this many matches. */
  readonly times?: number;
}

export interface FakeCloudCommands {
  readonly port: CloudCommandPort;
  /** Every invocation, in order. */
  readonly calls: readonly RecordedCommand[];
  /** Invocations of one tool, as space-joined argv, for readable assertions. */
  commandLines(tool: CloudTool): string[];
}

/**
 * True when `match` appears as an ordered subsequence of `args`.
 *
 * Subsequence rather than prefix matching keeps stubs readable — a scenario
 * declares the verbs it cares about and stays stable when the fixture adds a
 * `--query` or `--output` flag it does not need to assert on.
 */
export function argsMatch(
  args: readonly string[],
  match: readonly string[]
): boolean {
  let index = 0;
  for (const token of args) {
    if (index < match.length && token === match[index]) index += 1;
  }
  return index === match.length;
}

export function createFakeCloudCommands(
  stubs: readonly FakeCommandStub[]
): FakeCloudCommands {
  const calls: RecordedCommand[] = [];
  const remaining = stubs.map((stub) => ({
    stub,
    left: stub.times ?? Number.POSITIVE_INFINITY
  }));

  const run = (
    tool: CloudTool,
    args: readonly string[],
    cwd?: string
  ): Promise<CloudCommandResult> => {
    calls.push({ tool, args: [...args], cwd });
    const entry = remaining.find(
      (candidate) =>
        candidate.left > 0 &&
        candidate.stub.tool === tool &&
        argsMatch(args, candidate.stub.match)
    );
    if (!entry)
      return Promise.reject(
        new Error(
          `The cloud command fake has no stub for: ${tool} ${args.join(" ")}\n` +
            `Declared stubs: ${
              stubs.length === 0 ?
                "(none)"
              : stubs
                  .map((stub) => `${stub.tool} ${stub.match.join(" ")}`)
                  .join(", ")
            }`
        )
      );
    entry.left -= 1;
    const responder = entry.stub.respond;
    const response =
      typeof responder === "function" ? responder([...args]) : responder;
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      ...response
    });
  };

  return {
    port: {
      runAz: (args) => run("az", args),
      runGh: (args) => run("gh", args),
      runGit: (args, cwd) => run("git", args, cwd)
    },
    calls,
    commandLines: (tool) =>
      calls
        .filter((call) => call.tool === tool)
        .map((call) => call.args.join(" "))
  };
}

export interface FakeFixturePortsOptions {
  readonly stubs?: readonly FakeCommandStub[];
  readonly uniqueId?: string;
  readonly now?: Date;
  readonly workspaceDir?: string;
  readonly makeWorkspaceDir?: (prefix: string) => Promise<string>;
  readonly removeDir?: (dir: string) => Promise<void>;
}

export interface FakeFixturePorts {
  readonly ports: CloudFixturePorts;
  readonly commands: FakeCloudCommands;
  /** Directories `removeDir` was asked to delete, in order. */
  readonly removed: readonly string[];
}

/** The whole port surface, fake, with the filesystem and clock pinned. */
export function createFakeFixturePorts(
  options: FakeFixturePortsOptions = {}
): FakeFixturePorts {
  const commands = createFakeCloudCommands(options.stubs ?? []);
  const removed: string[] = [];
  const workspaceDir = options.workspaceDir ?? "/tmp/radtest-workspace";
  const now = options.now ?? new Date("2026-08-29T00:00:00.000Z");
  const uniqueId = options.uniqueId ?? "run0000000a";

  return {
    ports: {
      commands: commands.port,
      makeWorkspaceDir:
        options.makeWorkspaceDir ?? (() => Promise.resolve(workspaceDir)),
      removeDir:
        options.removeDir ??
        ((dir) => {
          removed.push(dir);
          return Promise.resolve();
        }),
      now: () => now,
      newUniqueId: () => uniqueId
    },
    commands,
    removed
  };
}
