import { describe, expect, it } from "vitest";
import {
  appBicepNoDockerfileMessage,
  appBicepRefusalReason,
  isDockerfilePath
} from "./app-bicep-support.js";

describe("isDockerfilePath", () => {
  it.each([
    ["Dockerfile", true],
    ["dockerfile", true],
    ["DOCKERFILE", true],
    ["Dockerfile.dev", true],
    ["services/api/Dockerfile", true],
    ["build/api.Dockerfile", true],
    ["build/api.dockerfile", true],
    ["docs/Dockerfile-notes.md", false],
    ["src/dockerfiles.ts", false],
    ["not-a-dockerfile.txt", false],
    ["services/api/", false],
    ["", false]
  ])("classifies %s as %s", (path, expected) => {
    expect(isDockerfilePath(path)).toBe(expected);
  });
});

describe("appBicepRefusalReason", () => {
  it("refuses a readable tree with no Dockerfile", () => {
    expect(
      appBicepRefusalReason(["README.md", "src/index.ts"], "octo/app", "main")
    ).toBe(appBicepNoDockerfileMessage("octo/app", "main"));
  });

  it("names the repository and branch it refused", () => {
    const reason = appBicepRefusalReason(["README.md"], "octo/app", "feat/x");
    expect(reason).toContain("octo/app");
    expect(reason).toContain("feat/x");
  });

  it.each([
    ["a root Dockerfile", ["Dockerfile", "README.md"]],
    ["a nested Dockerfile", ["services/api/Dockerfile"]],
    ["a suffixed Dockerfile", ["build/api.Dockerfile"]]
  ])("proceeds when the tree has %s", (_label, paths) => {
    expect(appBicepRefusalReason(paths, "octo/app", "main")).toBeNull();
  });

  it("fails open on an unreadable tree rather than treating it as absence", () => {
    // fetchRepoTree resolves empty on any error, so an empty list means
    // "unknown". Refusing here would let one transient listing failure
    // permanently reject a repository the skill can model.
    expect(appBicepRefusalReason([], "octo/app", "main")).toBeNull();
  });
});
