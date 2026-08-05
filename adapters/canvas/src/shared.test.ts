// Tests for credential-profile persistence (Environments → Credentials tab).
import { describe, it, expect, beforeEach } from "vitest";
import {
  listCredentialProfiles,
  saveCredentialProfile,
  deleteCredentialProfile,
  getPreferredGitHubLogin,
  setPreferredGitHubLogin
} from "./shared.js";

const REPO = "octo-test/creds-" + Math.random().toString(36).slice(2);

describe("credential profiles", () => {
  beforeEach(() => {
    for (const p of listCredentialProfiles(REPO))
      deleteCredentialProfile(REPO, p.name);
  });

  it("returns an empty list for an unknown repo", () => {
    expect(listCredentialProfiles(REPO)).toEqual([]);
  });

  it("saves an azure profile with normalized fields and 'verified' status", () => {
    const saved = saveCredentialProfile(REPO, {
      name: "azure-staging",
      provider: "azure",
      user: "u@d.com",
      tenantId: "t1",
      subscriptionId: "s1"
    });
    expect(saved).toMatchObject({
      name: "azure-staging",
      provider: "azure",
      status: "verified",
      user: "u@d.com"
    });
    const list = listCredentialProfiles(REPO);
    expect(list).toHaveLength(1);
    expect(list[0].tenantId).toBe("t1");
  });

  it("persists the friendly subscription/tenant display names for the env picker", () => {
    const saved = saveCredentialProfile(REPO, {
      name: "azure-prod",
      provider: "azure",
      user: "u@d.com",
      tenantId: "t1",
      tenantName: "Contoso",
      subscriptionId: "s1",
      subscriptionName: "Radius Test"
    });
    expect(saved?.subscriptionName).toBe("Radius Test");
    expect(saved?.tenantName).toBe("Contoso");
    // Older profiles saved without the display names round-trip as empty strings.
    const bare = saveCredentialProfile(REPO, {
      name: "azure-bare",
      provider: "azure",
      subscriptionId: "s2"
    });
    expect(bare?.subscriptionName).toBe("");
    expect(bare?.tenantName).toBe("");
  });

  it("upserts by name (case-insensitive) instead of duplicating", () => {
    saveCredentialProfile(REPO, {
      name: "prod",
      provider: "azure",
      subscriptionId: "s1"
    });
    saveCredentialProfile(REPO, {
      name: "PROD",
      provider: "azure",
      subscriptionId: "s2"
    });
    const list = listCredentialProfiles(REPO);
    expect(list).toHaveLength(1);
    expect(list[0].subscriptionId).toBe("s2");
  });

  it("defaults an unknown provider to azure and keeps aws when given", () => {
    expect(
      saveCredentialProfile(REPO, { name: "a", provider: "gcp" })?.provider
    ).toBe("azure");
    expect(
      saveCredentialProfile(REPO, {
        name: "b",
        provider: "aws",
        accountId: "123"
      })?.provider
    ).toBe("aws");
  });

  it("deletes a profile by name", () => {
    saveCredentialProfile(REPO, { name: "gone", provider: "aws" });
    expect(deleteCredentialProfile(REPO, "gone")).toBe(true);
    expect(listCredentialProfiles(REPO)).toEqual([]);
  });
});

describe("preferred GitHub login", () => {
  beforeEach(() => setPreferredGitHubLogin(""));

  it("is empty by default", () => {
    expect(getPreferredGitHubLogin()).toBe("");
  });

  it("persists and trims the chosen login so it survives a restart", () => {
    setPreferredGitHubLogin("  chosen-user  ");
    expect(getPreferredGitHubLogin()).toBe("chosen-user");
  });

  it("clears the preference when set to blank", () => {
    setPreferredGitHubLogin("chosen-user");
    setPreferredGitHubLogin("");
    expect(getPreferredGitHubLogin()).toBe("");
  });
});
