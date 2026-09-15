import { describe, expect, it } from "vitest";
import {
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
});
