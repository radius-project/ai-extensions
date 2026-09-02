import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

// killChildTree is the only cleanup path for a rad tree, so its two layers are
// isolated here behind a spawn double. The Windows layer shells out to taskkill,
// which cannot be observed from a real process without terminating one, and the
// missing-taskkill case cannot be provoked by emptying PATH because CreateProcess
// still finds it in System32. Faking the seam makes both layers deterministic on
// every platform; the real executables are exercised by the Windows process
// integration suite.
const spawnCalls: Array<{
  command: string;
  args: readonly string[];
  child: EventEmitter;
}> = [];

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[]) => {
    const child = new EventEmitter();
    spawnCalls.push({ command, args, child });
    return child;
  }
}));

const { killChildTree, terminateChildTree } = await import("./rad-process.mjs");

// A pid that no live process can hold: Windows pids are small multiples of four
// and Linux caps pid_max far below the signed 32-bit maximum.
const UNUSED_PID = 0x7fffffff;

const originalPlatform = process.platform;

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  });
}

function fakeChild(pid: number | undefined, signals: string[]) {
  return {
    pid,
    kill: (signal: string) => {
      signals.push(signal);
      return true;
    }
  };
}

afterEach(() => {
  usePlatform(originalPlatform);
  spawnCalls.length = 0;
});

describe("Radius child tree termination", () => {
  it.each([
    ["a missing child", null],
    ["an undefined child", undefined],
    ["a child that never started", { pid: undefined }]
  ])("ignores %s", (_description, child) => {
    expect(() => killChildTree(child as never)).not.toThrow();
    expect(spawnCalls).toHaveLength(0);
  });

  it("walks the tree with taskkill on Windows", () => {
    usePlatform("win32");
    const signals: string[] = [];

    killChildTree(fakeChild(UNUSED_PID, signals) as never);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("taskkill");
    expect(spawnCalls[0].args).toEqual([
      "/pid",
      String(UNUSED_PID),
      "/t",
      "/f"
    ]);
  });

  it("survives a taskkill that fails to launch and falls back to a direct signal", () => {
    usePlatform("win32");
    const signals: string[] = [];
    killChildTree(fakeChild(UNUSED_PID, signals) as never);

    // Node reports an unspawnable binary asynchronously. An "error" event with
    // no listener throws out of emit, which no caller-side try/catch can
    // contain, so the listener is what keeps a cleanup failure from taking the
    // process down with it.
    expect(() =>
      spawnCalls[0].child.emit("error", new Error("spawn taskkill ENOENT"))
    ).not.toThrow();
    // A stranded rad tree outlives the extension, so losing the tail of the
    // captured output is the better trade once the tree layer is unavailable.
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("leaves the child unsignalled while taskkill is walking the tree", () => {
    usePlatform("win32");
    const signals: string[] = [];

    killChildTree(fakeChild(UNUSED_PID, signals) as never);

    // Terminating the launcher here would close its stdio before Node drains
    // it, truncating the stdout and stderr reported with the abort.
    expect(signals).toEqual([]);
  });

  it.each<NodeJS.Platform>(["linux", "darwin"])(
    "signals the whole process group on %s",
    (platform) => {
      usePlatform(platform);
      const groups: number[] = [];
      const originalKill = process.kill;
      process.kill = ((pid: number) => {
        groups.push(pid);
        return true;
      }) as typeof process.kill;
      const signals: string[] = [];

      try {
        killChildTree(fakeChild(UNUSED_PID, signals) as never);
      } finally {
        process.kill = originalKill;
      }

      // A detached rad leads its own group, so the negated pid reaches rad and
      // every descendant it spawned.
      expect(groups).toEqual([-UNUSED_PID]);
      expect(spawnCalls).toHaveLength(0);
      expect(signals).toEqual([]);
    }
  );

  it("still signals the child when the process group is already gone", () => {
    usePlatform("linux");
    const originalKill = process.kill;
    process.kill = (() => {
      throw new Error("ESRCH");
    }) as typeof process.kill;
    const signals: string[] = [];

    try {
      killChildTree(fakeChild(UNUSED_PID, signals) as never);
    } finally {
      process.kill = originalKill;
    }

    expect(signals).toEqual(["SIGKILL"]);
  });

  it("tolerates a child that refuses to be signalled", () => {
    usePlatform("linux");
    const originalKill = process.kill;
    process.kill = (() => {
      throw new Error("ESRCH");
    }) as typeof process.kill;

    try {
      // Both layers failing is still best-effort: cleanup never propagates an
      // error into the abort or timeout path that invoked it.
      expect(() =>
        killChildTree({
          pid: UNUSED_PID,
          kill: () => {
            throw new Error("EPERM");
          }
        } as never)
      ).not.toThrow();
    } finally {
      process.kill = originalKill;
    }
  });
});

describe("Radius child tree termination targeting", () => {
  // child.pid keeps its value after the process is reaped, and killChildTree
  // signals that raw id -- a process group on POSIX -- instead of going through
  // the handle, so it never gets Node's own post-exit guard. Signalling a reaped
  // id would reach whatever the OS has since assigned it.
  it.each<[NodeJS.Platform, string]>([
    ["win32", "taskkill"],
    ["linux", "the process group"]
  ])("does not signal %s for a child that already exited", async (platform) => {
    usePlatform(platform);
    const groups: number[] = [];
    const originalKill = process.kill;
    process.kill = ((pid: number) => {
      groups.push(pid);
      return true;
    }) as typeof process.kill;
    const signals: string[] = [];

    try {
      await terminateChildTree(
        {
          ...fakeChild(UNUSED_PID, signals),
          exitCode: 0,
          signalCode: null
        } as never,
        40
      );
    } finally {
      process.kill = originalKill;
    }

    expect(spawnCalls).toHaveLength(0);
    expect(groups).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("does not signal a child that was already killed by a signal", async () => {
    usePlatform("win32");
    const signals: string[] = [];

    await terminateChildTree(
      {
        ...fakeChild(UNUSED_PID, signals),
        exitCode: null,
        signalCode: "SIGKILL"
      } as never,
      40
    );

    expect(spawnCalls).toHaveLength(0);
  });

  it("still terminates a child that is running", async () => {
    usePlatform("win32");
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      ...fakeChild(UNUSED_PID, signals),
      exitCode: null,
      signalCode: null
    });

    const done = terminateChildTree(child as never, 200);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("taskkill");
    child.emit("exit", null, "SIGKILL");

    await expect(done).resolves.toBeUndefined();
  });
});
