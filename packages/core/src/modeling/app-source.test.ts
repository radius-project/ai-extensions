import { describe, it, expect } from "vitest";
import {
  IGNORED_SOURCE_DIRS,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
  evaluateAppSource,
  findDockerfiles,
  isDockerfilePath,
  isIgnoredSourcePath,
  unsupportedAppSourceReport
} from "./app-source.js";

describe("isDockerfilePath", () => {
  it.each([
    ["Dockerfile", true],
    ["dockerfile", true],
    ["DOCKERFILE", true],
    ["Dockerfile.dev", true],
    ["Dockerfile.PROD", true],
    ["prod.Dockerfile", true],
    ["api.dockerfile", true],
    ["services/api/Dockerfile", true],
    ["a/b/c/d/Dockerfile.test", true],
    ["my-Dockerfile-notes.md", false],
    ["docs/Dockerfile-guide.txt", false],
    ["Dockerfile.", false],
    [".Dockerfile", false],
    ["Dockerfilebackup", false],
    ["dockerfiles", false],
    ["Makefile", false],
    ["", false]
  ])("classifies %s as %s", (path, expected) => {
    expect(isDockerfilePath(path)).toBe(expected);
  });

  it("matches the basename regardless of directory naming", () => {
    expect(isDockerfilePath("Dockerfile/README.md")).toBe(false);
    expect(isDockerfilePath("dockerfile.d/Dockerfile")).toBe(true);
  });

  it("accepts Windows-style separators", () => {
    expect(isDockerfilePath("services\\api\\Dockerfile")).toBe(true);
  });

  it("rejects a non-string path", () => {
    expect(isDockerfilePath(undefined)).toBe(false);
    expect(isDockerfilePath(null)).toBe(false);
    expect(isDockerfilePath(42)).toBe(false);
  });
});

describe("isIgnoredSourcePath", () => {
  it.each([...IGNORED_SOURCE_DIRS])(
    "ignores anything under %s",
    (dir: string) => {
      expect(isIgnoredSourcePath(`${dir}/pkg/Dockerfile`)).toBe(true);
      expect(isIgnoredSourcePath(`services/api/${dir}/Dockerfile`)).toBe(true);
    }
  );

  // The local worktree walker has always hidden dot-directories while
  // descending; the remote listing prunes nothing. Applying the rule here is
  // what stops the two from reaching different verdicts on the same repository.
  it.each([
    ".devcontainer/Dockerfile",
    ".config/docker/Dockerfile",
    ".circleci/Dockerfile"
  ])("ignores the dot-directory path %s", (path: string) => {
    expect(isIgnoredSourcePath(path)).toBe(true);
  });

  it.each([".radius/Dockerfile", ".github/Dockerfile"])(
    "keeps %s, which the worktree walker also descends into",
    (path: string) => {
      expect(isIgnoredSourcePath(path)).toBe(false);
    }
  );

  it("keeps a dotfile that is not inside a dot-directory", () => {
    expect(isIgnoredSourcePath(".env")).toBe(false);
    expect(isIgnoredSourcePath("services/.dockerignore")).toBe(false);
  });

  it("keeps application paths", () => {
    expect(isIgnoredSourcePath("services/api/Dockerfile")).toBe(false);
    expect(isIgnoredSourcePath("Dockerfile")).toBe(false);
  });

  it("only inspects directory segments, not the file name", () => {
    expect(isIgnoredSourcePath("services/build")).toBe(false);
    expect(isIgnoredSourcePath("services/build/Dockerfile")).toBe(true);
  });

  it("rejects a non-string path", () => {
    expect(isIgnoredSourcePath(undefined)).toBe(false);
  });
});

describe("findDockerfiles", () => {
  it("returns matches shallowest first, then alphabetically", () => {
    expect(
      findDockerfiles([
        "services/web/Dockerfile",
        "README.md",
        "services/api/Dockerfile",
        "Dockerfile"
      ])
    ).toEqual([
      "Dockerfile",
      "services/api/Dockerfile",
      "services/web/Dockerfile"
    ]);
  });

  it("skips vendored and generated trees", () => {
    expect(
      findDockerfiles([
        "node_modules/some-pkg/Dockerfile",
        "dist/Dockerfile",
        ".git/modules/x/Dockerfile",
        "src/index.ts"
      ])
    ).toEqual([]);
  });

  it("normalizes separators and leading path noise before deduplicating", () => {
    expect(
      findDockerfiles([
        "./services/api/Dockerfile",
        "services\\api\\Dockerfile",
        "/services/api/Dockerfile"
      ])
    ).toEqual(["services/api/Dockerfile"]);
  });

  it("ignores non-string entries", () => {
    expect(findDockerfiles(["Dockerfile", null, 7, undefined])).toEqual([
      "Dockerfile"
    ]);
  });

  it("returns nothing for a missing listing", () => {
    expect(findDockerfiles(null)).toEqual([]);
    expect(findDockerfiles(undefined)).toEqual([]);
  });
});

describe("evaluateAppSource", () => {
  it("reports unknown when the listing could not be produced", () => {
    expect(evaluateAppSource(null)).toEqual({
      status: "unknown",
      dockerfiles: []
    });
    expect(evaluateAppSource(undefined)).toEqual({
      status: "unknown",
      dockerfiles: []
    });
  });

  it("reports unknown for an empty listing rather than claiming no Dockerfile", () => {
    expect(evaluateAppSource([])).toEqual({
      status: "unknown",
      dockerfiles: []
    });
  });

  it("reports none when a real listing has no Dockerfile", () => {
    expect(
      evaluateAppSource(["src/index.ts", "package.json", "README.md"])
    ).toEqual({ status: "none", dockerfiles: [] });
  });

  it("reports none when the only Dockerfile is in a dot-directory", () => {
    expect(
      evaluateAppSource(["src/index.ts", ".devcontainer/Dockerfile"])
    ).toEqual({ status: "none", dockerfiles: [] });
  });

  it("reports none when the only Dockerfile is vendored", () => {
    expect(
      evaluateAppSource(["src/index.ts", "node_modules/pkg/Dockerfile"])
    ).toEqual({ status: "none", dockerfiles: [] });
  });

  it("reports single for one Dockerfile in a subdirectory", () => {
    expect(evaluateAppSource(["src/index.ts", "app/Dockerfile"])).toEqual({
      status: "single",
      dockerfiles: ["app/Dockerfile"]
    });
  });

  it("reports ambiguous with every candidate when several exist", () => {
    expect(
      evaluateAppSource([
        "services/web/Dockerfile",
        "services/api/Dockerfile.dev",
        "src/index.ts"
      ])
    ).toEqual({
      status: "ambiguous",
      dockerfiles: ["services/api/Dockerfile.dev", "services/web/Dockerfile"]
    });
  });
});

describe("unsupportedAppSourceReport", () => {
  it("carries the single user-facing message verbatim", () => {
    expect(unsupportedAppSourceReport("acme/widgets")).toContain(
      UNSUPPORTED_NO_DOCKERFILE_MESSAGE
    );
  });

  it("names the repository when one is known", () => {
    expect(unsupportedAppSourceReport("acme/widgets")).toContain(
      "for acme/widgets"
    );
  });

  it("omits the repository phrase when none is known", () => {
    for (const repo of [undefined, null, ""]) {
      expect(unsupportedAppSourceReport(repo)).toContain(
        "Application modeling stopped before it began"
      );
    }
  });

  it("states that nothing was written and nothing should be authored", () => {
    const report = unsupportedAppSourceReport("acme/widgets");
    expect(report).toContain("no .radius files were written");
    expect(report).toMatch(/do not author/i);
  });
});
