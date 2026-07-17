// Repository modeling that needs GitHub access — fetch the skill-generated
// app.bicep. Pure product logic that reaches GitHub only through the injected
// {@link GitHub} port; the canvas adapter supplies the concrete `gh`-CLI
// implementation.
//
// Source-code reference discovery for graph nodes is now handled by the AI
// agent via the radius-app-graph skill (see source-code-references.md). The
// hard-coded heuristics that lived here have been removed in favor of the
// agent-driven approach, which can adapt to any repo layout without
// maintaining a static pattern list.

import type { GitHub } from "../ports/index.js";

export async function fetchBicepFromRepo(gh: GitHub, repo: string, branch = 'main'): Promise<string | null> {
    const ghApiGetContent = (p: string) => gh.getContent(p);
    // Try .radius/app.bicep first (standard Radius location), then app.bicep at root.
    const radiusPath = await ghApiGetContent(`/repos/${repo}/contents/.radius/app.bicep?ref=${branch}`);
    if (radiusPath) return radiusPath;
    return ghApiGetContent(`/repos/${repo}/contents/app.bicep?ref=${branch}`);
}
