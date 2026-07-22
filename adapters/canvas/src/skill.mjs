// Bundled radius-app-bicep skill content.
//
// The extension can be installed on its own (as a Copilot canvas extension)
// without the sibling `plugins/radius/skills/` being present on disk. When that
// happens the agent never sees the authoritative `radius-app-bicep` skill, and
// tools like `radius_generate_app` have to fall back to a hand-maintained
// summary that inevitably drifts from the real schema rules.
//
// To keep a single source of truth, the build (adapters/canvas/build.mjs) loads
// these Markdown files as text and inlines them here, so the extension always
// ships the exact skill content it points the agent at — no separate skills
// install required.
//
// Source of truth: plugins/radius/skills/radius-app-bicep/

import skillMd from "../../../plugins/radius/skills/radius-app-bicep/SKILL.md";
import runtimeContract from "../../../plugins/radius/skills/radius-app-bicep/references/runtime-contract.md";
import componentCatalog from "../../../plugins/radius/skills/radius-app-bicep/references/component-catalog.md";
import architecturePatterns from "../../../plugins/radius/skills/radius-app-bicep/references/architecture-patterns.md";
import connectionConventions from "../../../plugins/radius/skills/radius-app-bicep/references/connection-conventions.md";
import secretsHandling from "../../../plugins/radius/skills/radius-app-bicep/references/secrets-handling.md";
import bicepStructureRules from "../../../plugins/radius/skills/radius-app-bicep/references/bicep-structure-rules.md";
import namingConventions from "../../../plugins/radius/skills/radius-app-bicep/references/naming-conventions.md";
import customResourceTypes from "../../../plugins/radius/skills/radius-app-bicep/references/custom-resource-types.md";
import todoListAppExample from "../../../plugins/radius/skills/radius-app-bicep/references/todo-list-app-example.md";

// Ordered to match the paths referenced from SKILL.md so the inlined content
// reads the same way the progressive-disclosure skill would.
const REFERENCES = [
    ["references/runtime-contract.md", runtimeContract],
    ["references/component-catalog.md", componentCatalog],
    ["references/architecture-patterns.md", architecturePatterns],
    ["references/connection-conventions.md", connectionConventions],
    ["references/secrets-handling.md", secretsHandling],
    ["references/bicep-structure-rules.md", bicepStructureRules],
    ["references/naming-conventions.md", namingConventions],
    ["references/custom-resource-types.md", customResourceTypes],
    ["references/todo-list-app-example.md", todoListAppExample],
];

/**
 * The `repoPath` argument is caller-controlled and gets embedded in the returned
 * string, which the agent consumes as instructions. An unsanitized value with
 * newlines or backticks could inject additional prompt content, so reduce it to
 * a single, inert, length-bounded token before echoing it. Returns a safe
 * placeholder when the input is empty or has no usable characters.
 *
 * @param {unknown} repoPath
 * @returns {string}
 */
function sanitizeRepoPath(repoPath) {
    const FALLBACK = "the current workspace";
    if (typeof repoPath !== "string") return FALLBACK;
    // Collapse any whitespace (including newlines/tabs) to single spaces, drop
    // control characters and backticks so the value can't break out of the
    // surrounding prose or open a code fence, then bound the length.
    const cleaned = repoPath
        .replace(/[\u0000-\u001F\u007F]+/g, " ")
        .replace(/`/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 256);
    return cleaned || FALLBACK;
}

/**
 * Returns the full radius-app-bicep skill (SKILL.md plus every reference file it
 * links to) as a single string, so the agent has the authoritative, schema-
 * accurate, compile-tested guidance even when only the extension is installed.
 *
 * @param {string} [repoPath] Path to the repository to model.
 * @returns {string}
 */
export function radiusAppBicepSkill(repoPath) {
    const target = sanitizeRepoPath(repoPath);
    const intro =
        `# radius-app-bicep skill (bundled with the Radius extension)\n\n` +
        `Model the repository at ${target} by following the skill below. This is ` +
        `the authoritative skill content — its SKILL.md and all reference files ` +
        `are inlined here so nothing is lost when the extension is installed on ` +
        `its own. The referenced files (\`references/*.md\`) are appended after ` +
        `SKILL.md under matching \`--- Reference: ... ---\` headers instead of ` +
        `being opened separately.\n\n` +
        `Do not stop at "looks correct": the skill requires compiling the ` +
        `generated \`.radius/app.bicep\` with the configured Radius extension ` +
        `(e.g. \`rad app graph\`) and closing every validation-checklist item ` +
        `before reporting success.\n`;

    const refs = REFERENCES
        .map(([name, body]) => `\n\n--- Reference: ${name} ---\n\n${body.trim()}`)
        .join("");

    return `${intro}\n---\n\n${skillMd.trim()}${refs}\n`;
}
