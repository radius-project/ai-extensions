import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  stateRegistryForEnvironment
} from "./state.js";

describe("stateRegistryForEnvironment", () => {
  it("uses the Radius OCI state defaults", () => {
    expect(OCI_STATE_BACKEND).toBe("oci");
    expect(DEFAULT_STATE_ARCHIVE).toBe("radius-state");
  });

  it("builds a stable lowercase repository without an OCI tag", () => {
    const registry = stateRegistryForEnvironment("Acme/My-App", "Production");

    expect(registry).toMatch(
      /^ghcr\.io\/acme\/my-app-radius-state-production-[a-f0-9]{12}$/
    );
    expect(registry).toBe(
      stateRegistryForEnvironment("acme/my-app", "production")
    );
    expect(registry).not.toMatch(/:[^/]+$/);
  });

  it("keeps sanitized environment names collision resistant", () => {
    const slashName = stateRegistryForEnvironment("acme/app", "prod/us");
    const hyphenName = stateRegistryForEnvironment("acme/app", "prod-us");

    expect(slashName).toContain("-radius-state-prod-us-");
    expect(hyphenName).toContain("-radius-state-prod-us-");
    expect(slashName).not.toBe(hyphenName);
  });

  it("caps long package names within the OCI repository limit", () => {
    const registry = stateRegistryForEnvironment(
      `owner/${"r".repeat(100)}`,
      "environment-".repeat(30)
    );
    const repositoryPath = registry.slice("ghcr.io/".length);

    expect(repositoryPath.length).toBeLessThanOrEqual(255);
    expect(registry).toMatch(/[a-f0-9]{12}$/);
  });

  it.each(["owner", "owner/repo/extra", "/repo", "owner/"])(
    "rejects invalid repository %j",
    (repository) => {
      expect(() => stateRegistryForEnvironment(repository, "dev")).toThrow(
        /expected owner\/repo/
      );
    }
  );

  it("rejects an empty environment name", () => {
    expect(() => stateRegistryForEnvironment("owner/repo", "   ")).toThrow(
      /Environment name is required/
    );
  });
});
