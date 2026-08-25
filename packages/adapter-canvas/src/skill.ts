// Compact bootstrap for the radius-app-bicep skill packaged beside the Canvas.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGeneratorVersion } from "./generator-version.js";

// The repo path is caller-controlled and embedded in agent instructions, so
// reduce it to a single, inert, length-bounded token.
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

function bundledSkillBase(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const installed = path.join(moduleDir, "skills", "radius-app-bicep");
  if (existsSync(path.join(installed, "SKILL.md"))) return installed;

  const source = path.resolve(
    moduleDir,
    "../../../plugins/radius/skills/radius-app-bicep"
  );
  return existsSync(path.join(source, "SKILL.md")) ? source : installed;
}

export function radiusAppBicepSkill(repoPath?: string): string {
  return JSON.stringify({
    skill: "radius-app-bicep",
    repoPath: sanitizeRepoPath(repoPath),
    skillBase: bundledSkillBase(),
    skillVersion: resolveGeneratorVersion(),
    instruction:
      "Continue with the loaded skill. If it is unavailable, read SKILL.md from skillBase. Substitute skillBase and skillVersion for its placeholders."
  });
}
