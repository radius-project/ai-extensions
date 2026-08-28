import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGhCommandPresentation } from "./gh-command-resolution.js";
import { GH_SYSTEM_INSTALL_ALTERNATIVE } from "./gh-command-display.js";

function existing(...files: string[]): (file: string) => boolean {
  const normalized = new Set(files.map((file) => file.replaceAll("\\", "/")));
  return (file) => normalized.has(file.replaceAll("\\", "/"));
}

describe("resolveGhCommandPresentation", () => {
  it("uses bare gh when a normal Windows installation is available", () => {
    const presentation = resolveGhCommandPresentation({
      platform: "win32",
      env: {
        Path: [
          '"C:\\Users\\Taylor\\AppData\\Local\\copilot-desktop-gh-2.96.0"',
          "",
          "C:\\Program Files\\GitHub CLI"
        ].join(";")
      },
      canExecute: existing(
        "C:\\Users\\Taylor\\AppData\\Local\\copilot-desktop-gh-2.96.0\\gh.exe",
        "C:\\Program Files\\GitHub CLI\\gh.exe"
      )
    });

    expect(presentation).toEqual({
      kind: "bare",
      shell: "powershell",
      installationNote: ""
    });
  });

  it("uses the discovered bundled Windows executable when it is the only candidate", () => {
    const executable =
      "C:\\Users\\Taylor\\AppData\\Local\\copilot-desktop-gh-3.1.4\\gh.exe";
    const presentation = resolveGhCommandPresentation({
      platform: "win32",
      env: {
        PATH: "C:\\Missing;C:\\Users\\Taylor\\AppData\\Local\\copilot-desktop-gh-3.1.4"
      },
      canExecute: existing(executable)
    });

    expect(presentation).toEqual({
      kind: "absolute",
      shell: "powershell",
      executablePath: executable,
      installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
    });
  });

  it.each([
    ["darwin", "/Applications/Copilot.app/copilot-desktop-gh-2.96.0/gh"],
    ["linux", "/opt/copilot-desktop-gh-2.96.0/gh"]
  ] as const)("uses the bundled executable on %s", (platform, executable) => {
    const directory = executable.slice(0, executable.lastIndexOf("/"));
    const presentation = resolveGhCommandPresentation({
      platform,
      env: { PATH: `/missing:${directory}` },
      canExecute: existing(executable)
    });

    expect(presentation).toEqual({
      kind: "absolute",
      shell: "posix",
      executablePath: executable,
      installationNote: GH_SYSTEM_INSTALL_ALTERNATIVE
    });
  });

  it("uses bare gh when a normal POSIX candidate follows the bundled one", () => {
    expect(
      resolveGhCommandPresentation({
        platform: "linux",
        env: { PATH: "/opt/copilot-desktop-gh-2.96.0:/usr/local/bin" },
        canExecute: existing(
          "/opt/copilot-desktop-gh-2.96.0/gh",
          "/usr/local/bin/gh"
        )
      })
    ).toEqual({ kind: "bare", shell: "posix", installationNote: "" });
  });

  it("reports GitHub CLI unavailable when no executable candidate exists", () => {
    expect(
      resolveGhCommandPresentation({
        platform: "linux",
        env: { PATH: "/usr/local/bin:/usr/bin" },
        canExecute: () => false
      })
    ).toEqual({
      kind: "unavailable",
      shell: "posix",
      installationNote:
        "GitHub CLI is not available. Install GitHub CLI system-wide, then retry."
    });
  });

  it("handles an absent PATH", () => {
    expect(
      resolveGhCommandPresentation({
        platform: "win32",
        env: {},
        canExecute: () => {
          throw new Error("No candidate should be checked.");
        }
      }).kind
    ).toBe("unavailable");
  });

  it("handles an undefined PATH value", () => {
    expect(
      resolveGhCommandPresentation({
        platform: "win32",
        env: { PATH: undefined },
        canExecute: () => {
          throw new Error("No candidate should be checked.");
        }
      }).kind
    ).toBe("unavailable");
  });

  it("uses the current platform and environment defaults", () => {
    expect(
      resolveGhCommandPresentation({
        canExecute: () => false
      }).kind
    ).toBe("unavailable");
    expect(["bare", "absolute", "unavailable"]).toContain(
      resolveGhCommandPresentation().kind
    );
  });

  it("uses the real filesystem boundary when no probe is injected", async () => {
    const root = await mkdtemp(join(tmpdir(), "radius-gh-resolution-"));
    const directory = join(root, "copilot-desktop-gh-fixture");
    const executable = join(
      directory,
      process.platform === "win32" ? "gh.exe" : "gh"
    );
    await mkdir(directory);
    await writeFile(executable, "");
    if (process.platform !== "win32") await chmod(executable, 0o700);
    try {
      const presentation = resolveGhCommandPresentation({
        platform: process.platform,
        env: { PATH: directory }
      });
      expect(presentation).toMatchObject({
        kind: "absolute",
        executablePath: executable
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a real missing filesystem candidate as unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "radius-gh-missing-"));
    try {
      expect(
        resolveGhCommandPresentation({
          platform: process.platform,
          env: { PATH: root }
        }).kind
      ).toBe("unavailable");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
