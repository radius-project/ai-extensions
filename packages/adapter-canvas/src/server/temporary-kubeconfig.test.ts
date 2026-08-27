import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createTemporaryKubeconfig } from "./temporary-kubeconfig.js";

describe("createTemporaryKubeconfig", () => {
  it("creates a private file in an isolated directory and removes it idempotently", () => {
    const kubeconfig = createTemporaryKubeconfig();
    const directory = dirname(kubeconfig.path);

    expect(existsSync(kubeconfig.path)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(kubeconfig.path).mode & 0o777).toBe(0o600);
    }

    kubeconfig.remove();
    expect(existsSync(directory)).toBe(false);
    expect(() => kubeconfig.remove()).not.toThrow();
  });

  it("removes its directory when private file creation fails", () => {
    const removed: string[] = [];

    expect(() =>
      createTemporaryKubeconfig({
        mkdtemp: () => "/tmp/radius-kubeconfig-failed",
        write: () => {
          throw new Error("disk full");
        },
        remove: (path) => {
          removed.push(path);
        }
      })
    ).toThrow("disk full");
    expect(removed).toEqual(["/tmp/radius-kubeconfig-failed"]);
  });
});
