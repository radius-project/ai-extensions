import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createRadiusAppBicepSkill, radiusAppBicepSkill } from "./skill.js";

const MODULE_DIR = path.join(
  path.parse(process.cwd()).root,
  "repo",
  "packages",
  "adapter-canvas",
  "src"
);
const HOME_DIR = path.join(path.parse(process.cwd()).root, "home", "radius");
const REQUIRED_FILES = [
  "SKILL.md",
  path.join("scripts", "validate-bicep.mjs"),
  path.join("references", "source-code-references.md")
];
const INSTRUCTION =
  "Continue with the loaded skill. If it is unavailable, read SKILL.md from skillBase. Substitute skillBase for <loaded-skill-base>. Substitute skillVersion for <loaded-skill-version> only when skillVersion is present; otherwise leave <loaded-skill-version> unchanged so the skill omits the flag.";

const CANDIDATES = {
  installed: path.join(MODULE_DIR, "skills", "radius-app-bicep"),
  source: path.resolve(
    MODULE_DIR,
    "../../../extensions/radius/skills/radius-app-bicep"
  ),
  repaired: path.join(
    HOME_DIR,
    ".copilot",
    "installed-plugins",
    "radius-plugins",
    "radius",
    "skills",
    "radius-app-bicep"
  )
};

function requiredPaths(candidate: string): string[] {
  return REQUIRED_FILES.map((required) => path.join(candidate, required));
}

function createSkill(
  presentFiles: ReadonlyArray<string>,
  skillVersion = "1.2.3"
) {
  const present = new Set(presentFiles);
  const pathExists = vi.fn((filePath: string) => present.has(filePath));
  const generatorVersion = vi.fn(() => skillVersion);
  return {
    pathExists,
    generatorVersion,
    skill: createRadiusAppBicepSkill({
      moduleDir: MODULE_DIR,
      homeDir: HOME_DIR,
      pathExists,
      generatorVersion
    })
  };
}

function parseHandoff(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("radiusAppBicepSkill", () => {
  it("uses the complete source-checkout skill in the development runtime", () => {
    const expected = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../extensions/radius/skills/radius-app-bicep"
    );

    expect(parseHandoff(radiusAppBicepSkill("/workspace")).skillBase).toBe(
      expected
    );
  });

  it.each([
    [
      "installed extension",
      [
        ...requiredPaths(CANDIDATES.installed),
        ...requiredPaths(CANDIDATES.source),
        ...requiredPaths(CANDIDATES.repaired)
      ],
      CANDIDATES.installed
    ],
    [
      "source checkout",
      [
        ...requiredPaths(CANDIDATES.source),
        ...requiredPaths(CANDIDATES.repaired)
      ],
      CANDIDATES.source
    ],
    ["repaired plugin", requiredPaths(CANDIDATES.repaired), CANDIDATES.repaired]
  ])("selects the %s candidate in probe order", (_label, files, expected) => {
    const { skill } = createSkill(files);

    expect(parseHandoff(skill("/workspace")).skillBase).toBe(expected);
  });

  it.each(REQUIRED_FILES)(
    "skips a candidate missing %s",
    (missingRequiredFile) => {
      const installedFiles = requiredPaths(CANDIDATES.installed).filter(
        (filePath) =>
          filePath !== path.join(CANDIDATES.installed, missingRequiredFile)
      );
      const { skill } = createSkill([
        ...installedFiles,
        ...requiredPaths(CANDIDATES.source)
      ]);

      expect(parseHandoff(skill("/workspace")).skillBase).toBe(
        CANDIDATES.source
      );
    }
  );

  it("continues from an incomplete source checkout to the repaired plugin", () => {
    const { skill } = createSkill([
      path.join(CANDIDATES.source, "SKILL.md"),
      ...requiredPaths(CANDIDATES.repaired)
    ]);

    expect(parseHandoff(skill("/workspace")).skillBase).toBe(
      CANDIDATES.repaired
    );
  });

  it("reports every checked candidate when none is usable", () => {
    const { skill } = createSkill([]);

    expect(() => skill("/workspace")).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("radius-app-bicep")
      })
    );
    for (const candidate of Object.values(CANDIDATES)) {
      expect(() => skill("/workspace")).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(candidate)
        })
      );
    }
  });

  it("returns the exact supported-repository JSON contract and sanitizes the repository path", () => {
    const { skill } = createSkill(requiredPaths(CANDIDATES.installed));

    expect(skill("/workspace/\n```ignore\t now\u0000")).toBe(
      JSON.stringify({
        skill: "radius-app-bicep",
        repoPath: "/workspace/ ignore now",
        skillBase: CANDIDATES.installed,
        skillVersion: "1.2.3",
        instruction: INSTRUCTION
      })
    );
  });

  it("returns the exact ambiguity JSON contract without trailing Markdown", () => {
    const { skill } = createSkill(requiredPaths(CANDIDATES.installed));
    const brief =
      "Model these services as one application.\nAsk only if needed.";

    expect(skill("/workspace", brief)).toBe(
      JSON.stringify({
        skill: "radius-app-bicep",
        repoPath: "/workspace",
        skillBase: CANDIDATES.installed,
        skillVersion: "1.2.3",
        instruction: INSTRUCTION,
        brief
      })
    );
  });

  it("omits an empty generator version and leaves its placeholder unchanged", () => {
    const { skill } = createSkill(requiredPaths(CANDIDATES.installed), " \n ");

    expect(skill()).toBe(
      JSON.stringify({
        skill: "radius-app-bicep",
        repoPath: "the current workspace",
        skillBase: CANDIDATES.installed,
        instruction: INSTRUCTION
      })
    );
  });

  it("uses the workspace fallback for a repository path emptied by sanitization", () => {
    const { skill } = createSkill(requiredPaths(CANDIDATES.installed));

    expect(parseHandoff(skill(" \t```")).repoPath).toBe(
      "the current workspace"
    );
  });

  it("bounds the sanitized repository path", () => {
    const { skill } = createSkill(requiredPaths(CANDIDATES.installed));

    expect(String(parseHandoff(skill("a".repeat(300))).repoPath)).toHaveLength(
      256
    );
  });
});
