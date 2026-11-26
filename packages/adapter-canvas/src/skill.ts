// Compact bootstrap for the Radius modeling skills packaged with the Canvas:
// radius-app-model (Stage 1), radius-app-plan (Stage 2), and
// radius-app-complete (Stage 3).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultNodeExecutable,
  MINIMUM_NODE_MAJOR,
  type NodeResolution
} from "./node-executable.js";
import { resolvePluginRoot } from "./plugin-root.js";

export type RadiusModelingSkill =
  "radius-app-model" | "radius-app-plan" | "radius-app-complete";

// The files a skill directory must have to be usable: its instructions and the
// scripts its workflow runs.
const REQUIRED_SKILL_FILES = {
  "radius-app-model": ["SKILL.md", "scripts/model.mjs", "scripts/common.mjs"],
  "radius-app-plan": ["SKILL.md", "scripts/plan.mjs", "scripts/common.mjs"],
  "radius-app-complete": [
    "SKILL.md",
    "scripts/complete.mjs",
    "scripts/common.mjs"
  ]
} satisfies Record<RadiusModelingSkill, readonly string[]>;
const SKILL_INSTRUCTION =
  "Continue with the loaded skill. If it is not loaded, read SKILL.md from skillBase. Use skillBase as <skill-dir>, and run the skill's scripts with nodeCommand instead of node. Put nodeCommand and each script path in double quotes, because either can contain spaces, such as C:\\Program Files\\nodejs\\node.exe. In PowerShell, start the command with &.";
// Returned instead of the handoff when the machine has no Node.js interpreter
// the scripts can run. The run cannot start, and the only permitted next step
// is to ask the user — never to download or install a runtime on their behalf.
const MISSING_NODE_INSTRUCTION = `Do not start the modeling run: the skill's scripts need Node.js ${MINIMUM_NODE_MAJOR} or newer and the Radius extension found none on this machine. Never download, install, unpack, or otherwise obtain a Node.js runtime, and never run the scripts through another runtime. Report this to the user, ask them to install Node.js ${MINIMUM_NODE_MAJOR} or newer (or to make their existing installation visible to the Copilot app), and stop. Only a fresh user request may start another run.`;

export interface RadiusSkillDependencies {
  moduleDir: string;
  homeDir: string;
  pathExists(filePath: string): boolean;
  // Where the skill scripts run: an existing Node.js interpreter new enough for
  // them, or none. They are never invoked as a bare `node`, because the Copilot
  // app's own runtime is not on the agent's PATH.
  nodeExecutable(): NodeResolution;
}

export type RadiusSkillHandoff = (
  skill: RadiusModelingSkill,
  repoPath?: string,
  brief?: string
) => string;

function describeRejected(
  resolution: NodeResolution
): readonly string[] | undefined {
  if (resolution.rejected.length === 0) return undefined;
  return resolution.rejected.map(({ executable, version, reason }) => {
    if (reason === "unsupported-version")
      return `${executable} (${version}, older than Node.js ${MINIMUM_NODE_MAJOR})`;
    if (reason === "unsafe-path")
      return `${executable} (path contains characters that are unsafe in a shell command)`;
    return `${executable} (did not report a Node.js version)`;
  });
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

// Where a skill can be, in probe order: the installed plugin bundle, the
// repository source for a development run, and the reinstalled plugin.
function skillBaseCandidates(
  moduleDir: string,
  homeDir: string,
  skill: RadiusModelingSkill
): readonly string[] {
  return [
    path.join(resolvePluginRoot(moduleDir), "skills", skill),
    path.resolve(moduleDir, "../../../extensions/radius/skills", skill),
    path.join(
      homeDir,
      ".copilot",
      "installed-plugins",
      "radius-plugins",
      "radius",
      "skills",
      skill
    )
  ];
}

// Returns the JSON handoff that starts a modeling skill: where the skill is,
// which Node.js runs its scripts, and how to continue. Throws when no complete
// copy of the skill is installed.
export function createRadiusSkillHandoff(
  dependencies: RadiusSkillDependencies
): RadiusSkillHandoff {
  return (skill, repoPath, brief) => {
    const resolution = dependencies.nodeExecutable();
    const nodeCommand = resolution.executable;
    if (!nodeCommand) {
      const rejectedRuntimes = describeRejected(resolution);
      return JSON.stringify({
        skill,
        repoPath: sanitizeRepoPath(repoPath),
        nodeCommand: null,
        // What was found and refused, so the report names the user's actual
        // installation instead of claiming the machine has no Node.js at all.
        ...(rejectedRuntimes ? { rejectedRuntimes } : {}),
        instruction: MISSING_NODE_INSTRUCTION
      });
    }
    const candidates = skillBaseCandidates(
      dependencies.moduleDir,
      dependencies.homeDir,
      skill
    );
    const required = REQUIRED_SKILL_FILES[skill];
    const skillBase = candidates.find((candidate) =>
      required.every((file) =>
        dependencies.pathExists(path.join(candidate, file))
      )
    );
    if (!skillBase) {
      throw new Error(
        [
          `Unable to locate a usable ${skill} skill.`,
          "Checked candidates:",
          ...candidates.map((candidate) => `- ${candidate}`),
          "Each candidate must include:",
          ...required.map((file) => `- ${file}`),
          "Repair the Radius plugin installation or run the extension from its source checkout."
        ].join("\n")
      );
    }
    return JSON.stringify({
      skill,
      repoPath: sanitizeRepoPath(repoPath),
      skillBase,
      nodeCommand,
      instruction: SKILL_INSTRUCTION,
      ...(brief ? { brief } : {})
    });
  };
}

export const radiusSkillHandoff: RadiusSkillHandoff = createRadiusSkillHandoff({
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  homeDir: homedir(),
  pathExists: existsSync,
  nodeExecutable: defaultNodeExecutable
});
