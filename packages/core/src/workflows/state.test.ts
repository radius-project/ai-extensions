import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  stateRegistryForEnvironment,
  stateRegistryPrefix
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

  it.each([
    ["an owner with no ASCII alphanumerics", "---/repo", "prod"],
    ["a repository with no ASCII alphanumerics", "owner/日本語", "prod"],
    ["an environment with no ASCII alphanumerics", "owner/repo", "!!!"]
  ])("rejects %s", (_label, repository, environment) => {
    expect(() => stateRegistryForEnvironment(repository, environment)).toThrow(
      /must contain an ASCII letter or number/
    );
  });

  it("trims surrounding whitespace before slugging", () => {
    expect(stateRegistryForEnvironment("  acme/app  ", "  prod  ")).toBe(
      stateRegistryForEnvironment("acme/app", "prod")
    );
  });

  it("derives a different repository for each environment of one repo", () => {
    const dev = stateRegistryForEnvironment("acme/app", "dev");
    const prod = stateRegistryForEnvironment("acme/app", "prod");

    expect(dev).not.toBe(prod);
    expect(dev.startsWith("ghcr.io/acme/app-radius-state-dev-")).toBe(true);
    expect(prod.startsWith("ghcr.io/acme/app-radius-state-prod-")).toBe(true);
  });

  it("derives a different repository for the same environment in different repos", () => {
    expect(stateRegistryForEnvironment("acme/app", "prod")).not.toBe(
      stateRegistryForEnvironment("other/app", "prod")
    );
  });

  it("caps the owner segment at the GitHub owner length limit", () => {
    const owner = "o".repeat(60);
    const registry = stateRegistryForEnvironment(`${owner}/app`, "prod");

    expect(registry.split("/")[1]).toHaveLength(39);
  });

  it("leaves no trailing hyphen after truncation", () => {
    const registry = stateRegistryForEnvironment(
      `${"a".repeat(38)}-extra/app`,
      "prod"
    );

    expect(registry.split("/")[1].endsWith("-")).toBe(false);
  });
});

describe("stateRegistryPrefix", () => {
  it("prefixes every package name the writer produces", () => {
    // The sweep recognises state by this prefix alone, so it must stay exactly
    // what stateRegistryForEnvironment writes or orphaned state goes unseen.
    const prefix = stateRegistryPrefix("radius-project/ai-extensions-fixture");
    const registry = stateRegistryForEnvironment(
      "radius-project/ai-extensions-fixture",
      "radtest-6fe9780807f4"
    );

    expect(prefix).toBe("ai-extensions-fixture-radius-state-");
    expect(registry.split("/").at(-1)).toMatch(
      new RegExp(`^${prefix}radtest-6fe9780807f4-[a-f0-9]{12}$`)
    );
  });

  it("sanitizes the repository the same way the registry does", () => {
    expect(stateRegistryPrefix("Acme/My-App")).toBe("my-app-radius-state-");
  });

  it("rejects a repository that is not owner/repo", () => {
    expect(() => stateRegistryPrefix("ai-extensions")).toThrow(
      /expected owner\/repo/
    );
  });

  it("rejects a repository with no usable characters", () => {
    expect(() => stateRegistryPrefix("acme/---")).toThrow(
      /must contain an ASCII letter or number/
    );
  });
});
