import { describe, expect, it } from "vitest";
import {
  describeMissingGitHubAppAccess,
  GITHUB_APP_ACCESS_PROBES,
  gitHubAppAccessProbePaths,
  isGitHubAppBotLogin,
  isGitHubAppUserEndpointFailure
} from "./github-app-installation.js";

describe("GitHub App installation identity", () => {
  it.each([
    "radius-cloud-e2e[bot]",
    "dependabot[bot]",
    "A1-B2[bot]",
    " radius-cloud-e2e[bot] "
  ])("recognizes the installation bot login %s", (login) => {
    expect(isGitHubAppBotLogin(login)).toBe(true);
  });

  it.each([
    "",
    "[bot]",
    "-app[bot]",
    "app-[bot]",
    "app",
    "app[Bot]extra",
    "app name[bot]"
  ])("rejects the non-installation login %s", (login) => {
    expect(isGitHubAppBotLogin(login)).toBe(false);
  });

  it("recognizes the user-endpoint refusal returned for installation tokens", () => {
    expect(
      isGitHubAppUserEndpointFailure(
        "gh: Resource not accessible by integration (HTTP 403)"
      )
    ).toBe(true);
  });

  it("does not classify an ordinary authorization failure as an installation token", () => {
    expect(isGitHubAppUserEndpointFailure("gh: Forbidden (HTTP 403)")).toBe(
      false
    );
  });

  it("probes one resource for every permission category the setup flow writes", () => {
    expect(gitHubAppAccessProbePaths("octo/app")).toEqual([
      "repos/octo/app/actions/permissions",
      "repos/octo/app/environments",
      "repos/octo/app/actions/secrets",
      "repos/octo/app/actions/variables",
      "repos/octo/app/commits?per_page=1",
      "repos/octo/app/pulls?per_page=1"
    ]);
  });

  it("probes every permission it names as verifiable", () => {
    const probed = new Set(
      GITHUB_APP_ACCESS_PROBES.map((probe) => probe.permission)
    );
    expect(probed).toEqual(
      new Set([
        "Administration",
        "Environments",
        "Secrets",
        "Variables",
        "Contents",
        "Pull requests"
      ])
    );
  });

  it("names the installation and the complete permission union it needs", () => {
    const detail = describeMissingGitHubAppAccess(
      "radius-cloud-e2e[bot]",
      "octo/app"
    );
    expect(detail).toContain("radius-cloud-e2e[bot]");
    expect(detail).toContain("octo/app");
    // Naming only the probed permissions would send an operator back for a
    // second failure at the first unmentioned mutation.
    for (const permission of [
      "Actions (write)",
      "Administration (write)",
      "Contents (write)",
      "Deployments (read)",
      "Environments (write)",
      "Pull requests (write)",
      "Secrets (write)",
      "Variables (write)",
      "Workflows (write)"
    ])
      expect(detail).toContain(permission);
  });

  it("names the specific permission when one probe identified the failure", () => {
    expect(
      describeMissingGitHubAppAccess(
        "radius-cloud-e2e[bot]",
        "octo/app",
        "Secrets"
      )
    ).toContain("cannot exercise its Secrets permission on octo/app");
  });
});
