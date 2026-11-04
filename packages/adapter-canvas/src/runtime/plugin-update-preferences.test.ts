import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginUpdatePreferences } from "./plugin-update-preferences.js";

const marketplace = "radius-plugins";
const answeredAt = Date.UTC(2026, 0, 1);

describe("persistent plugin update answers", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "radius-update-preferences-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(["root", "record"])(
    "returns no timestamp for a missing %s",
    async (missing) => {
      const preferences = createPluginUpdatePreferences(
        missing === "root" ? join(directory, "missing") : directory
      );
      expect(await preferences.lastAnsweredAt(marketplace)).toBeUndefined();
    }
  );

  it("retains the answer timestamp when the adapter is recreated", async () => {
    await createPluginUpdatePreferences(directory).rememberAnswer(
      marketplace,
      answeredAt
    );
    expect(
      await createPluginUpdatePreferences(directory).lastAnsweredAt(marketplace)
    ).toBe(answeredAt);
  });

  it("replaces an expired answer timestamp with the new answer", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    await preferences.rememberAnswer(marketplace, answeredAt);
    const nextAnswer = answeredAt + 7 * 24 * 60 * 60 * 1000;
    await preferences.rememberAnswer(marketplace, nextAnswer);
    expect(await preferences.lastAnsweredAt(marketplace)).toBe(nextAnswer);
  });

  it("creates missing parent directories and handles concurrent saves", async () => {
    const preferences = createPluginUpdatePreferences(
      join(directory, "nested", "responses")
    );
    await Promise.all([
      preferences.rememberAnswer(marketplace, answeredAt),
      preferences.rememberAnswer(marketplace, answeredAt)
    ]);
    expect(await preferences.lastAnsweredAt(marketplace)).toBe(answeredAt);
  });

  it("keeps answers from different marketplaces separate", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    await preferences.rememberAnswer(marketplace, answeredAt);
    expect(
      await preferences.lastAnsweredAt("another-marketplace")
    ).toBeUndefined();
  });

  it("confines a path-like marketplace to a fixed-length record name", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    const pathLike = "../outside\\marketplace";
    await preferences.rememberAnswer(pathLike, answeredAt);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(await preferences.lastAnsweredAt(pathLike)).toBe(answeredAt);
  });

  it("rejects a file in place of an answer record", async () => {
    const preferences = createPluginUpdatePreferences(directory);
    await preferences.rememberAnswer(marketplace, answeredAt);
    const [name] = await readdir(directory);
    const marker = join(directory, name);
    await rmdir(marker);
    await writeFile(marker, "invalid marker");
    await expect(preferences.lastAnsweredAt(marketplace)).rejects.toThrow(
      "Invalid Radius plugin update answer record"
    );
  });

  it("propagates read and save failures", async () => {
    const blocked = join(directory, "not-a-directory");
    await writeFile(blocked, "blocked");
    const preferences = createPluginUpdatePreferences(blocked);
    await expect(preferences.lastAnsweredAt(marketplace)).rejects.toThrow(
      "Invalid Radius plugin update preferences directory"
    );
    await expect(
      preferences.rememberAnswer(marketplace, answeredAt)
    ).rejects.toThrow();
  });

  it("propagates invalid filesystem path errors rather than reporting no saved answer", async () => {
    const preferences = createPluginUpdatePreferences("\0");
    await expect(preferences.lastAnsweredAt(marketplace)).rejects.toThrow();
  });
});
