import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it("ignores a non-object credential file and persists a new profile to the isolated store", async () => {
  const directory = mkdtempSync(join(tmpdir(), "radius-credential-init-"));
  const credentialsFile = join(directory, "credentials.json");
  const stored = '[{"name":"not-a-profile-map"}]';
  try {
    writeFileSync(credentialsFile, stored);
    vi.stubEnv("RADIUS_CREDENTIALS_FILE", credentialsFile);
    // The isolated test module loads the store once, after configuring its path.
    const shared = await import("./shared.js");

    expect(shared.sharedCredentials).toEqual({});
    expect(readFileSync(credentialsFile, "utf8")).toBe(stored);
    expect(shared.listCredentialProfiles("fixture/app")).toEqual([]);

    const profile = { name: "local-fixture", provider: "aws" };
    expect(shared.saveCredentialProfile("fixture/app", profile)).toMatchObject(
      profile
    );
    const saved = shared.listCredentialProfiles("fixture/app");
    expect(saved).toEqual([expect.objectContaining(profile)]);
    expect(JSON.parse(readFileSync(credentialsFile, "utf8"))).toEqual({
      profiles: { "fixture/app": saved }
    });
  } finally {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
