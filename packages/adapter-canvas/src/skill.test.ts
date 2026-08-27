import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRadiusAppBicepSkill } from "./skill.js";

const MODULE_DIR = path.join(
  path.parse(process.cwd()).root,
  "repo",
  "packages",
  "adapter-canvas",
  "src"
);
const SKILL_BASE = path.join(MODULE_DIR, "skills", "radius-app-bicep");
const SKILL_ENTRY = path.join(SKILL_BASE, "SKILL.md");
const INSTRUCTION =
  "Continue with the loaded skill. If it is unavailable, read SKILL.md from skillBase. Substitute skillBase for <loaded-skill-base>. Substitute skillVersion for <loaded-skill-version> only when skillVersion is present; otherwise leave <loaded-skill-version> unchanged so the skill omits the flag.";

function createSkill(skillPresent = true, skillVersion = "1.2.3") {
  const pathExists = vi.fn(
    (filePath: string) => skillPresent && filePath === SKILL_ENTRY
  );
  const generatorVersion = vi.fn(() => skillVersion);
  return {
    pathExists,
    generatorVersion,
    skill: createRadiusAppBicepSkill({
      moduleDir: MODULE_DIR,
      pathExists,
      generatorVersion
    })
  };
}

function parseHandoff(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

describe("radiusAppBicepSkill", () => {
  it("uses only the skill packaged beside the extension", () => {
    const { skill, pathExists } = createSkill();

    expect(parseHandoff(skill("/workspace")).skillBase).toBe(SKILL_BASE);
    expect(pathExists).toHaveBeenCalledOnce();
    expect(pathExists).toHaveBeenCalledWith(SKILL_ENTRY);
  });

  it("fails when the packaged skill entry point is missing", () => {
    const { skill } = createSkill(false);

    expect(() => skill("/workspace")).toThrowError(
      `The packaged radius-app-bicep skill is missing ${SKILL_ENTRY}. Reinstall or rebuild the Radius extension.`
    );
  });

  it("returns the exact supported-repository JSON contract and sanitizes the repository path", () => {
    const { skill } = createSkill();

    expect(skill("/workspace/\n```ignore\t now\u0000")).toBe(
      JSON.stringify({
        skill: "radius-app-bicep",
        repoPath: "/workspace/ ignore now",
        skillBase: SKILL_BASE,
        skillVersion: "1.2.3",
        instruction: INSTRUCTION
      })
    );
  });

  it("returns the exact ambiguity JSON contract without trailing Markdown", () => {
    const { skill } = createSkill();
    const brief =
      "Model these services as one application.\nAsk only if needed.";

    expect(skill("/workspace", brief)).toBe(
      JSON.stringify({
        skill: "radius-app-bicep",
        repoPath: "/workspace",
        skillBase: SKILL_BASE,
        skillVersion: "1.2.3",
        instruction: INSTRUCTION,
        brief
      })
    );
  });

  it("omits an empty generator version and leaves its placeholder unchanged", () => {
    const { skill } = createSkill(true, " \n ");

    expect(skill()).toBe(
      JSON.stringify({
        skill: "radius-app-bicep",
        repoPath: "the current workspace",
        skillBase: SKILL_BASE,
        instruction: INSTRUCTION
      })
    );
  });

  it("uses the workspace fallback for a repository path emptied by sanitization", () => {
    const { skill } = createSkill();

    expect(parseHandoff(skill(" \t```")).repoPath).toBe(
      "the current workspace"
    );
  });

  it("bounds the sanitized repository path", () => {
    const { skill } = createSkill();

    expect(String(parseHandoff(skill("a".repeat(300))).repoPath)).toHaveLength(
      256
    );
  });
});
