import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { removeArtifactWorkspace } from "./cleanup.js";

describe("artifact workspace teardown", () => {
  it("removes only its temporary workspace and permits repeated cleanup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-cleanup-"));
    const workspace = path.join(root, "workspace");
    try {
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, "owned"), "owned");
      fs.writeFileSync(path.join(root, "neighbor"), "keep");
      await removeArtifactWorkspace(workspace);
      await removeArtifactWorkspace(workspace);
      expect(fs.readdirSync(root)).toEqual(["neighbor"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"])(
    "waits for transient %s to clear before retrying only removal",
    async (code) => {
      const events: string[] = [];
      let release: (() => void) | undefined;
      const pending = removeArtifactWorkspace("owned-workspace", {
        remove(directory) {
          events.push(`remove:${directory}`);
          if (events.length === 1)
            throw Object.assign(new Error("temporarily busy"), { code });
        },
        delay(milliseconds) {
          events.push(`delay:${milliseconds}`);
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      });
      expect(events).toEqual(["remove:owned-workspace", "delay:100"]);
      expect(release).toBeTypeOf("function");
      release?.();
      await pending;
      expect(events).toEqual([
        "remove:owned-workspace",
        "delay:100",
        "remove:owned-workspace"
      ]);
    }
  );

  it("reports the final filesystem error after five bounded retries", async () => {
    const delays: number[] = [];
    const errors: Error[] = [];
    const pending = removeArtifactWorkspace("owned-workspace", {
      remove(directory) {
        const error = Object.assign(new Error("persistent lock"), {
          code: "EPERM",
          path: directory,
          syscall: "rm"
        });
        errors.push(error);
        throw error;
      },
      async delay(milliseconds) {
        delays.push(milliseconds);
      }
    });
    const failure = await pending.then(
      () => {
        throw new Error("Persistent removal unexpectedly succeeded");
      },
      (error: unknown) => error
    );
    expect(errors).toHaveLength(6);
    expect(failure).toBe(errors[5]);
    expect(delays).toEqual([100, 200, 300, 400, 500]);
  });

  it.each([
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    new Error("unclassified removal failure"),
    "non-error failure",
    null
  ])("does not retry a non-transient failure: %s", async (failure) => {
    let removals = 0;
    await expect(
      removeArtifactWorkspace("owned-workspace", {
        remove() {
          removals++;
          throw failure;
        },
        async delay() {
          throw new Error("Unexpected delay");
        }
      })
    ).rejects.toBe(failure);
    expect(removals).toBe(1);
  });

  it("reports a failed wait without attempting another removal", async () => {
    const failure = new Error("wait cancelled");
    let removals = 0;
    await expect(
      removeArtifactWorkspace("owned-workspace", {
        remove() {
          removals++;
          throw Object.assign(new Error("busy"), { code: "EPERM" });
        },
        async delay() {
          throw failure;
        }
      })
    ).rejects.toBe(failure);
    expect(removals).toBe(1);
  });

  it.runIf(process.platform === "win32")(
    "removes a workspace after an external Windows delete-sharing lock is released",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-locked-"));
      const file = path.join(root, "locked.txt");
      fs.writeFileSync(file, "temporary");
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:RADIUS_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('locked'); [Console]::ReadLine(); $f.Dispose()"
        ],
        { env: { ...process.env, RADIUS_LOCK_FILE: file }, windowsHide: true }
      );
      const closed = once(child, "close");
      try {
        await new Promise<void>((resolve, reject) => {
          child.once("error", reject);
          child.stdout.once("data", (chunk: Buffer) => {
            if (chunk.toString().trim() === "locked") resolve();
            else reject(new Error(`Unexpected lock readiness: ${chunk}`));
          });
          child.once("exit", () =>
            reject(new Error("Lock holder exited before readiness"))
          );
        });
        expect(() => fs.rmSync(root, { recursive: true, force: true })).toThrow(
          expect.objectContaining({ code: "EPERM" })
        );
        const delays: number[] = [];
        await removeArtifactWorkspace(root, {
          remove(target) {
            fs.rmSync(target, { recursive: true, force: true });
          },
          async delay(milliseconds) {
            delays.push(milliseconds);
            if (!child.stdin.writableEnded) child.stdin.end("\n");
            expect(await closed).toEqual([0, null]);
          }
        });
        expect(delays).toEqual([100]);
        expect(fs.existsSync(root)).toBe(false);
      } finally {
        if (!child.stdin.writableEnded) child.stdin.end("\n");
        await closed;
        await removeArtifactWorkspace(root);
      }
    }
  );
});
