import { describe, expect, it } from "vitest";
import {
  missingGitHubAppSetupPermissions,
  parseGitHubAppInstallation
} from "./github-app-installation.js";

const REQUIRED_PERMISSIONS = {
  actions: "write",
  actions_variables: "write",
  contents: "write",
  deployments: "read",
  environments: "write",
  pull_requests: "write",
  secrets: "write",
  workflows: "write"
};

describe("GitHub App installation metadata", () => {
  it("parses the bot login and string permissions", () => {
    expect(
      parseGitHubAppInstallation({
        app_slug: "radius-cloud-e2e",
        permissions: { ...REQUIRED_PERMISSIONS, metadata: "read", ignored: 1 }
      })
    ).toEqual({
      login: "radius-cloud-e2e[bot]",
      permissions: { ...REQUIRED_PERMISSIONS, metadata: "read" }
    });
  });

  it.each([
    null,
    {},
    { app_slug: "", permissions: {} },
    { app_slug: "radius-cloud-e2e" },
    { app_slug: "radius-cloud-e2e", permissions: null }
  ])("rejects malformed installation metadata %#", (value) => {
    expect(parseGitHubAppInstallation(value)).toBeNull();
  });

  it("accepts every permission required by environment setup", () => {
    const installation = parseGitHubAppInstallation({
      app_slug: "radius-cloud-e2e",
      permissions: REQUIRED_PERMISSIONS
    });
    if (!installation) throw new Error("installation fixture was not parsed");

    expect(missingGitHubAppSetupPermissions(installation)).toEqual([]);
  });

  it("reports missing and read-only mutation permissions", () => {
    const installation = parseGitHubAppInstallation({
      app_slug: "radius-cloud-e2e",
      permissions: {
        ...REQUIRED_PERMISSIONS,
        actions: "read",
        environments: "read",
        workflows: undefined
      }
    });
    if (!installation) throw new Error("installation fixture was not parsed");

    expect(missingGitHubAppSetupPermissions(installation)).toEqual([
      "actions",
      "environments",
      "workflows"
    ]);
  });
});
