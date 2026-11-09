import {
  configureOperationStore,
  operations
} from "../../../src/operations.js";
import type {
  OperationStore,
  PersistedOperationsEnvelope
} from "../../../src/operation-store.js";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import type { GitHubJsonResponse } from "../../../src/azure-oidc.js";
import { awsCommand, FakeAws, isFakeAwsWrite } from "./fake-aws.js";
import { FakeGitHub, type FakeGitHubCommandResult } from "./fake-github.js";

// Drives a multi-step operation and stops it at one outside call: a Stop the
// customer asks for while the call is in flight, or a crash just before the
// call reaches AWS or GitHub, or just after it lands with its answer lost.
// Every AWS and GitHub call goes through one recorder, so a test can name the
// call by its place in the run, and check what was written after it.

export type StopKind = "stop" | "crash-before" | "crash-after";

export interface OutsideCall {
  readonly index: number;
  readonly service: "aws" | "github";
  // `iam create-role`, `gh variable set`, or `GET <path>`.
  readonly command: string;
  readonly args: readonly string[];
  readonly write: boolean;
  // How many saves had reached the disk when this call was sent.
  readonly savesBefore: number;
  // The service applied it.
  applied: boolean;
  // The caller got the answer.
  answered: boolean;
  succeeded: boolean;
  stdout: string;
  // Sent after the process crashed, which a real crash makes impossible.
  readonly afterCrash: boolean;
}

/**
 * The operation store's disk. Saves stop reaching it once the process
 * crashes, as they would after a kill.
 */
export class MemoryDisk implements OperationStore {
  private envelope: string | null = null;
  saves = 0;
  frozen = false;

  async load(): Promise<PersistedOperationsEnvelope | null> {
    return this.envelope === null ? null : JSON.parse(this.envelope);
  }

  async save(envelope: PersistedOperationsEnvelope): Promise<void> {
    if (this.frozen) return;
    this.envelope = JSON.stringify(envelope);
    this.saves += 1;
  }

  // The saved record for one operation, as the disk holds it.
  record(operationId: string): Record<string, unknown> | undefined {
    if (this.envelope === null) return undefined;
    const envelope: unknown = JSON.parse(this.envelope);
    const list =
      (
        typeof envelope === "object" &&
        envelope !== null &&
        "operations" in envelope &&
        Array.isArray(envelope.operations)
      ) ?
        envelope.operations
      : [];
    return list.find(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "operationId" in entry &&
        entry.operationId === operationId
    );
  }
}

interface Plan {
  // The call's index, or the first later call that matches.
  at: number;
  readonly match?: (call: OutsideCall) => boolean;
  readonly kind: StopKind;
  // Called when a Stop lands, while its call is answered.
  readonly onStop: () => void;
}

function hang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export class OutsideWorld {
  readonly calls: OutsideCall[] = [];
  private plan: Plan | null = null;
  private crashedAt: number | null = null;
  private crash = OutsideWorld.signal();

  constructor(
    readonly aws: FakeAws,
    readonly github: FakeGitHub,
    readonly disk: MemoryDisk
  ) {}

  private static signal(): { promise: Promise<void>; resolve: () => void } {
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  /**
   * A new process starts. Calls the crashed one left in flight stay
   * unanswered forever; the new one's calls are answered again.
   */
  startProcess(): void {
    this.crashedAt = null;
    this.plan = null;
    this.crash = OutsideWorld.signal();
    this.disk.frozen = false;
  }

  get crashed(): boolean {
    return this.crashedAt !== null;
  }

  /** Stop the run at the call `at` places after the calls made so far. */
  arm(at: number, kind: StopKind, onStop: () => void = () => {}): number {
    const index = this.calls.length + at;
    this.plan = { at: index, kind, onStop };
    return index;
  }

  /** Stop the run at the first call from now on that `match` accepts. */
  armWhen(
    match: (call: OutsideCall) => boolean,
    kind: StopKind,
    onStop: () => void = () => {}
  ): void {
    this.plan = { at: -1, match, kind, onStop };
  }

  /** Resolves once the planned crash ends the process. */
  whenCrashed(): Promise<void> {
    return this.crash.promise;
  }

  /** Run `work` until it finishes or the planned crash ends the process. */
  async until(work: () => Promise<unknown>): Promise<"done" | "crashed"> {
    return Promise.race([
      work().then(() => "done" as const),
      this.crash.promise.then(() => "crashed" as const)
    ]);
  }

  readonly runAws = (args: string[]): Promise<AwsCommandResult> =>
    this.call(
      "aws",
      awsCommand(args),
      args,
      isFakeAwsWrite(args),
      () => this.aws.run(args),
      (result) => ({
        succeeded: result.code === 0 || result.code === "0",
        stdout: result.stdout
      })
    );

  readonly readGitHubJson = (apiPath: string): Promise<GitHubJsonResponse> =>
    this.call(
      "github",
      `GET ${apiPath}`,
      [apiPath],
      false,
      () => this.github.readJson(apiPath),
      (result) => ({ succeeded: result.ok, stdout: "" })
    );

  readonly gh = (args: string[]): Promise<FakeGitHubCommandResult> =>
    this.call(
      "github",
      `gh ${args.slice(0, 2).join(" ")}`,
      args,
      FakeGitHub.isWrite(args),
      () => this.github.gh(args),
      (result) => ({ succeeded: result.code === 0, stdout: result.stdout })
    );

  /** An outside call that is not an AWS or `gh` command, such as a port. */
  outside<T>(
    command: string,
    write: boolean,
    apply: () => T,
    read: (result: T) => { succeeded: boolean; stdout: string } = () => ({
      succeeded: true,
      stdout: ""
    })
  ): Promise<T> {
    return this.call("github", command, [command], write, apply, read);
  }

  private async call<T>(
    service: OutsideCall["service"],
    command: string,
    args: readonly string[],
    write: boolean,
    apply: () => T,
    read: (result: T) => { succeeded: boolean; stdout: string }
  ): Promise<T> {
    const call: OutsideCall = {
      index: this.calls.length,
      service,
      command,
      args: [...args],
      write,
      savesBefore: this.disk.saves,
      applied: false,
      answered: false,
      succeeded: false,
      stdout: "",
      afterCrash: this.crashed
    };
    this.calls.push(call);
    // Let the caller's earlier work settle first, as a real process would
    // before it spawns the next command.
    await Promise.resolve();
    if (this.crashed) return hang();
    if (this.plan?.match && this.plan.at < 0 && this.plan.match(call)) {
      this.plan.at = call.index;
    }
    const plan = this.plan?.at === call.index ? this.plan : null;
    if (plan?.kind === "crash-before") return this.die(call);
    const result = apply();
    call.applied = true;
    Object.assign(call, read(result));
    if (plan?.kind === "crash-after") return this.die(call);
    call.answered = true;
    if (plan?.kind === "stop") plan.onStop();
    return result;
  }

  private die<T>(call: OutsideCall): Promise<T> {
    this.crashedAt = call.index;
    this.disk.frozen = true;
    this.crash.resolve();
    return hang();
  }

  /** The call the plan stopped at, once it has. */
  get stoppedAt(): number | null {
    const at = this.plan?.at ?? -1;
    return at >= 0 ? at : null;
  }

  callsAfter(index: number): OutsideCall[] {
    return this.calls.filter((call) => call.index > index);
  }
}

/**
 * Start the extension again over the same disk: every record in memory is
 * gone, and the store restores what it saved, as a real restart does.
 */
export async function restart(world: OutsideWorld): Promise<void> {
  world.startProcess();
  operations.clear();
  await configureOperationStore(world.disk);
}

/** A fresh, empty operation store, saved to `disk`. */
export async function freshStore(disk: MemoryDisk): Promise<void> {
  operations.clear();
  await configureOperationStore(disk);
}

/** The arguments' value after `--flag`. */
export function argument(call: OutsideCall, name: string): string {
  const index = call.args.indexOf(name);
  return index >= 0 ? (call.args[index + 1] ?? "") : "";
}

// A lock release a stopped run still sends: it gives back what it held.
export function isLockRelease(call: OutsideCall): boolean {
  return (
    call.command === "iam delete-policy" &&
    /:policy\/radius-lock-/.test(argument(call, "--policy-arn"))
  );
}

/**
 * Writes sent after the run stopped at `index`, other than releasing its own
 * lock, which a stopped run still does.
 */
export function writesAfterStop(
  world: OutsideWorld,
  index: number
): OutsideCall[] {
  return world
    .callsAfter(index)
    .filter((call) => call.write && !isLockRelease(call));
}

/** Writes in `calls`, as `command` labels, for a readable failure. */
export function writeLabels(calls: readonly OutsideCall[]): string[] {
  return calls
    .filter((call) => call.write)
    .map((call) => `${call.index}: ${call.command}`);
}
