// Compact bootstrap for the radius-app-bicep skill packaged beside the Canvas.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGeneratorVersion } from "./generator-version.js";

const SKILL_INSTRUCTION =
  "Continue with the loaded skill. If it is unavailable, read SKILL.md from skillBase. Substitute skillBase for <loaded-skill-base>. Substitute skillVersion for <loaded-skill-version> only when skillVersion is present; otherwise leave <loaded-skill-version> unchanged so the skill omits the flag.";

export interface RadiusAppBicepSkillDependencies {
  moduleDir: string;
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

export function createRadiusAppBicepSkill(
  dependencies: RadiusAppBicepSkillDependencies
): (repoPath?: string, brief?: string) => string {
  const skillBase = path.join(
    dependencies.moduleDir,
    "skills",
    "radius-app-bicep"
  );
  const skillEntry = path.join(skillBase, "SKILL.md");

  return (repoPath?: string, brief?: string): string => {
    if (!dependencies.pathExists(skillEntry)) {
      throw new Error(
        `The packaged radius-app-bicep skill is missing ${skillEntry}. Reinstall or rebuild the Radius extension.`
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
  pathExists: existsSync,
  generatorVersion: resolveGeneratorVersion
});

export const radiusAppBicepSkill = defaultRadiusAppBicepSkill;
