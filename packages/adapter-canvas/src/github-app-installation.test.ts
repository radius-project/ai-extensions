import { describe, expect, it } from "vitest";
import {
  describeMissingGitHubAppAccess,
  gitHubAppAccessProbePath,
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

  it("probes the deployment environments the setup flow goes on to configure", () => {
    expect(gitHubAppAccessProbePath("octo/app")).toBe(
      "repos/octo/app/environments"
    );
  });

  it("names the installation and the permissions the repository is missing", () => {
    const detail = describeMissingGitHubAppAccess(
      "radius-cloud-e2e[bot]",
      "octo/app"
    );
    expect(detail).toContain("radius-cloud-e2e[bot]");
    expect(detail).toContain("octo/app");
    expect(detail).toContain("Environments");
  });
});
