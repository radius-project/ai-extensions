// Compact bootstrap for the radius-app-bicep skill packaged beside the Canvas.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGeneratorVersion } from "./generator-version.js";

const REQUIRED_SKILL_FILES = [
  "SKILL.md",
  path.join("scripts", "promote-app-model.mjs"),
  path.join("scripts", "validate-bicep.mjs"),
  path.join("scripts", "write-app-origin.mjs"),
  path.join("..", "radius-app-graph", "references", "source-code-references.md")
];
const SKILL_INSTRUCTION =
  "Continue with the loaded skill. If it is unavailable, read SKILL.md from skillBase. Substitute skillBase for <loaded-skill-base>. Substitute skillVersion for <loaded-skill-version> only when skillVersion is present; otherwise leave <loaded-skill-version> unchanged so the skill omits the flag.";

export interface RadiusAppBicepSkillDependencies {
  moduleDir: string;
  homeDir: string;
  pathExists(filePath: string): boolean;
  generatorVersion(): string;
}

interface RadiusAppBicepHandoff {
  skill: "radius-app-bicep";
  repoPath: string;
  skillBase: string;
  skillVersion?: string;
  instruction: string;
  brief?: string;
}

function sanitizeRepoPath(repoPath: unknown): string {
  const FALLBACK = "the current workspace";
  if (typeof repoPath !== "string") return FALLBACK;
  const cleaned = repoPath
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256);
  return cleaned || FALLBACK;
}

function skillBaseCandidates(
  moduleDir: string,
  homeDir: string
): readonly string[] {
  return [
    path.join(moduleDir, "skills", "radius-app-bicep"),
    path.resolve(moduleDir, "../../../plugins/radius/skills/radius-app-bicep"),
    path.join(
      homeDir,
      ".copilot",
      "installed-plugins",
      "radius-plugins",
      "radius",
      "skills",
      "radius-app-bicep"
    )
  ];
}

export function createRadiusAppBicepSkill(
  dependencies: RadiusAppBicepSkillDependencies
): (repoPath?: string, brief?: string) => string {
  const candidates = skillBaseCandidates(
    dependencies.moduleDir,
    dependencies.homeDir
  );

  return (repoPath?: string, brief?: string): string => {
    const skillBase = candidates.find((candidate) =>
      REQUIRED_SKILL_FILES.every((requiredFile) =>
        dependencies.pathExists(path.join(candidate, requiredFile))
      )
    );
    if (!skillBase) {
      throw new Error(
        [
          "Unable to locate a usable radius-app-bicep skill.",
          "Checked candidates:",
          ...candidates.map((candidate) => `- ${candidate}`),
          "Each candidate must include:",
          ...REQUIRED_SKILL_FILES.map((requiredFile) => `- ${requiredFile}`),
          "Repair the Radius plugin installation or run the extension from its source checkout."
        ].join("\n")
      );
    }

    const skillVersion = dependencies.generatorVersion().trim();
    const handoff: RadiusAppBicepHandoff = {
      skill: "radius-app-bicep",
      repoPath: sanitizeRepoPath(repoPath),
      skillBase,
      ...(skillVersion ? { skillVersion } : {}),
      instruction: SKILL_INSTRUCTION,
      ...(brief ? { brief } : {})
    };
    return JSON.stringify(handoff);
  };
}

const defaultRadiusAppBicepSkill = createRadiusAppBicepSkill({
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  homeDir: homedir(),
  pathExists: existsSync,
  generatorVersion: resolveGeneratorVersion
});

export function radiusAppBicepSkill(repoPath?: string, brief?: string): string {
  return defaultRadiusAppBicepSkill(repoPath, brief);
}
