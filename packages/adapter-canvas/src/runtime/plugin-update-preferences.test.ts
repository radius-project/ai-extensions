import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginUpdatePreferences } from "./plugin-update-preferences.js";

const identity = { marketplace: "radius-plugins", version: "0.4.0" };

describe("persistent plugin update declines", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "radius-update-preferences-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("does not report a decline before one is saved", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    expect(await preferences.hasDeclined(identity)).toBe(false);
  });

  it("retains a decline when the preferences adapter is recreated", async () => {
    await createPluginUpdatePreferences(directory).rememberDecline(identity);
    expect(
      await createPluginUpdatePreferences(directory).hasDeclined(identity)
    ).toBe(true);
  });

  it("creates missing parent directories and handles concurrent saves", async () => {
    const preferences = createPluginUpdatePreferences(
      join(directory, "nested", "declines")
    );
    await Promise.all([
      preferences.rememberDecline(identity),
      preferences.rememberDecline(identity)
    ]);
    expect(await preferences.hasDeclined(identity)).toBe(true);
  });

  it.each([
    { ...identity, marketplace: "another-marketplace" },
    { ...identity, version: "0.5.0" }
  ])("does not suppress a changed installation: %j", async (changed) => {
    const preferences = createPluginUpdatePreferences(directory);
    await preferences.rememberDecline(identity);
    expect(await preferences.hasDeclined(changed)).toBe(false);
  });

  it("confines path-like identity values to a fixed-length marker name", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    const pathLike = {
      marketplace: "../outside-marketplace",
      version: "..\\outside-version"
    };
    await preferences.rememberDecline(pathLike);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(await preferences.hasDeclined(pathLike)).toBe(true);
  });

  it("rejects a corrupt decline marker instead of treating it as a saved choice", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    await preferences.rememberDecline(identity);
    const [name] = await readdir(directory);
    const marker = join(directory, name);
    await rmdir(marker);
    await writeFile(marker, "invalid marker");
    await expect(preferences.hasDeclined(identity)).rejects.toThrow(
      "Invalid Radius plugin update decline record"
    );
  });

  it("propagates read and save failures", async () => {
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "blocked");
    const preferences = createPluginUpdatePreferences(blocked);
    await expect(preferences.hasDeclined(identity)).rejects.toThrow();
    await expect(preferences.rememberDecline(identity)).rejects.toThrow();
  });

  it("propagates invalid filesystem path errors rather than reporting no saved decline", async () => {
    const preferences = createPluginUpdatePreferences("\0");
    await expect(preferences.hasDeclined(identity)).rejects.toThrow();
  });
});
