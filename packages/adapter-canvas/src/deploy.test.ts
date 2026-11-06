import { describe, expect, it } from "vitest";
import {
  explainNoSubscriptions,
  cloudCredentialsComplete,
  explainRepoAccessForEnvSetup,
  isRepoNotFoundError
} from "./deploy.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "./repository-access-guidance.js";

describe("explainNoSubscriptions", () => {
  it("explains the Azure Login failure and points at the missing role assignment", () => {
    const out = explainNoSubscriptions(
      "Running Azure CLI Login.\nError: No subscriptions found for ***.\nError: Login failed with Error: The process '/usr/bin/az' failed with exit code 1."
    );
    for (const detail of ["no subscriptions", "role", "subscription"])
      expect(out.toLowerCase()).toContain(detail);
    expect(out).toContain("Contributor");
  });
  it.each(["some unrelated error: forbidden", "", undefined, null])(
    "ignores unrelated or absent evidence %j",
    (value) => expect(explainNoSubscriptions(value)).toBe("")
  );
});

describe("cloudCredentialsComplete", () => {
  it.each([
    ["azure", { clientId: "c", tenantId: "t", subscriptionId: "s" }, true],
    ["azure", { clientId: "c", tenantId: "t" }, false],
    ["azure", { clientId: "c", tenantId: "t", subscriptionId: "" }, false],
    ["azure", {}, false],
    ["azure", { roleArn: "arn:aws:iam::x" }, false],
    ["aws", { roleArn: "arn:aws:iam::123:role/r" }, true],
    ["aws", { roleArn: "" }, false],
    ["aws", {}, false],
    ["aws", { clientId: "c", tenantId: "t", subscriptionId: "s" }, false]
  ])(
    "preserves %s provider credential requirements: %j",
    (provider, credentials, expected) => {
      expect(cloudCredentialsComplete(provider, credentials)).toBe(expected);
    }
  );
});

describe("explainRepoAccessForEnvSetup", () => {
  const repo = "azure-cto/app";
  it("names the account and repository when a read failure requires switching", () => {
    const out = explainRepoAccessForEnvSetup({
      repo,
      login: "ryanwaite",
      readFailed: true,
      permissions: null
    });
    for (const detail of [
      "ryanwaite",
      repo,
      "gh auth switch",
      FORK_REPOSITORY_SETUP_GUIDANCE
    ])
      expect(out).toContain(detail);
  });
  it("uses the bundled CLI path and installation guidance", () => {
    const out = explainRepoAccessForEnvSetup(
      { repo, login: "ryanwaite", readFailed: true, permissions: null },
      {
        kind: "absolute",
        shell: "powershell",
        executablePath: "C:\\Copilot Tools\\gh.exe",
        installationNote: "Install GitHub CLI system-wide."
      }
    );
    expect(out).toContain(
      "& 'C:\\Copilot Tools\\gh.exe' auth switch --user <account>"
    );
    expect(out).toContain("Install GitHub CLI system-wide.");
  });
  it("handles an unknown active login and accepts admin access", () => {
    expect(
      explainRepoAccessForEnvSetup({
        repo,
        login: "",
        readFailed: true,
        permissions: null
      })
    ).toContain("the active gh account");
    expect(
      explainRepoAccessForEnvSetup({
        repo,
        login: "ryanwaite",
        readFailed: false,
        permissions: { admin: true }
      })
    ).toBe("");
  });
  it("explains Maintain access without suggesting an unrelated account switch", () => {
    const out = explainRepoAccessForEnvSetup({
      repo,
      login: "ryanwaite_microsoft",
      readFailed: false,
      permissions: { admin: false, maintain: true, push: true }
    });
    for (const detail of [
      "Admin",
      "Maintain",
      "grant",
      FORK_REPOSITORY_SETUP_GUIDANCE
    ])
      expect(out).toContain(detail);
    expect(out).not.toContain("gh auth switch");
  });
  it.each([
    [{ admin: false, maintain: false, push: true }, "Write"],
    [{ admin: false, pull: true }, "Read"]
  ])("names the actual lower role %j", (permissions, expected) => {
    expect(
      explainRepoAccessForEnvSetup({
        repo,
        login: "ryanwaite",
        readFailed: false,
        permissions
      })
    ).toContain(expected);
  });
  it("explains unknown permissions without inventing a role", () => {
    const out = explainRepoAccessForEnvSetup({
      repo,
      login: "ryanwaite",
      readFailed: false,
      permissions: null
    });
    expect(out).not.toContain("no direct");
    expect(out).toContain("does not have Admin");
    expect(out).toContain("could not be determined");
  });
  it("addresses the user when a readable repository has no known login", () => {
    expect(
      explainRepoAccessForEnvSetup({
        repo,
        login: "",
        readFailed: false,
        permissions: { admin: false, pull: true }
      })
    ).toContain("you");
  });
});

describe("isRepoNotFoundError", () => {
  it.each([
    ["gh: Not Found (HTTP 404)", true],
    ["request failed: HTTP 404", true],
    ["the repository was not found", true],
    ["gh: Forbidden (HTTP 403)", false],
    ["dial tcp: i/o timeout", false],
    ["", false],
    [undefined, false],
    [null, false]
  ])("retains advisory classification for %j", (value, expected) => {
    expect(isRepoNotFoundError(value)).toBe(expected);
  });
});
