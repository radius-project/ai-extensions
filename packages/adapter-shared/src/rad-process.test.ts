import { describe, expect, it } from "vitest";
import {
  managedBicepEnv,
  RadProcessError,
  radSpawnOptions
} from "./rad-process.mjs";

describe("rad process spawn policy", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "keeps ignored stdin and piped output while choosing the %s cleanup boundary",
    (platform) => {
      expect(radSpawnOptions(platform)).toEqual({
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: platform !== "win32"
      });
    }
  );

  it("selects the current platform without an override", () => {
    expect(radSpawnOptions()).toEqual(radSpawnOptions(process.platform));
  });

  it("pins managed Bicep without mutating the caller's explicit environment", () => {
    const env = { BICEP: "unmanaged", PATH: "owned-bin" };
    expect(managedBicepEnv(env, "managed-bicep")).toEqual({
      PATH: "owned-bin",
      BICEP: "managed-bicep"
    });
    expect(env).toEqual({ BICEP: "unmanaged", PATH: "owned-bin" });
    expect(managedBicepEnv(undefined, "managed-bicep")).toEqual({
      BICEP: "managed-bicep"
    });
  });

  it.each([false, true])(
    "preserves diagnostics and cleanup ownership when cleanupIncomplete is %s",
    (cleanupIncomplete) => {
      const error = new RadProcessError(
        "compiler failed",
        "compile diagnostic",
        "stderr diagnostic",
        cleanupIncomplete
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: "RadProcessError",
        message: "compiler failed",
        stdout: "compile diagnostic",
        stderr: "stderr diagnostic",
        cleanupIncomplete
      });
    }
  );
});
