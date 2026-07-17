const SOURCE_REF_BUCKETS = {
    graph: "graphResources",
    planned: "plannedResources",
    diff: "diffResources",
};

function sourceRefToken(view, context) {
    const branch = view === "diff"
        ? `${context.baseBranch || ""}...${context.headBranch || ""}`
        : context.branch || "";
    return `${view}|${context.repo || ""}|${branch}`;
}

export function prepareSourceRefResources(entry, view, context) {
    const bucket = SOURCE_REF_BUCKETS[view];
    if (!bucket) throw new Error(`Unknown graph view: ${view}`);

    const token = sourceRefToken(view, context);
    if (!entry.state.sourceRefContexts) entry.state.sourceRefContexts = {};
    const previousToken = entry.state.sourceRefContexts[view]?.token;
    entry.state.sourceRefContexts[view] = { ...context, view, token };
    if (previousToken && previousToken !== token) {
        entry.state[bucket] = null;
        if (Array.isArray(entry.state.pendingSourceRefs)) {
            entry.state.pendingSourceRefs = entry.state.pendingSourceRefs.filter(
                (ref) => ref.contextToken !== previousToken,
            );
        }
    }
    return entry.state.sourceRefContexts[view];
}

export function setSourceRefResources(entry, view, resources, context, expectedToken) {
    const currentToken = entry.state.sourceRefContexts?.[view]?.token;
    if (expectedToken && currentToken !== expectedToken) return false;

    const sourceRefContext = prepareSourceRefResources(entry, view, context);
    entry.state[SOURCE_REF_BUCKETS[view]] = resources;

    if (!Array.isArray(entry.state.pendingSourceRefs)) return true;
    entry.state.pendingSourceRefs = entry.state.pendingSourceRefs.filter((ref) => {
        if (ref.contextToken !== sourceRefContext.token) return true;
        const resource = resources.find((candidate) => candidate.id === ref.id);
        if (resource && !resource.codeReference) resource.codeReference = ref.codeReference;
        return false;
    });
    return true;
}

export function getSourceRefResources(entry, requestedView) {
    const pageView = entry.page === "planned"
        ? "planned"
        : entry.page === "graph-diff" || entry.page === "graphDiff"
            ? "diff"
            : entry.page === "graph"
                ? "graph"
                : null;
    const view = requestedView || pageView || entry.state.activeGraphView || "graph";
    const bucket = SOURCE_REF_BUCKETS[view];
    const context = entry.state.sourceRefContexts?.[view];
    const resources = bucket ? entry.state[bucket] : null;
    if (!context || !Array.isArray(resources)) {
        return { ready: false, view, resources: [] };
    }
    return { ready: true, view, context, resources };
}

export function updateSourceRefs(entry, contextToken, refs) {
    const context = Object.values(entry.state.sourceRefContexts || {})
        .find((candidate) => candidate.token === contextToken);
    if (!context) {
        return {
            error: "Graph context is stale or unknown. Fetch graph resources again.",
            updated: 0,
            queued: 0,
            skipped: refs.length,
        };
    }

    const resources = entry.state[SOURCE_REF_BUCKETS[context.view]];
    if (!Array.isArray(entry.state.pendingSourceRefs)) entry.state.pendingSourceRefs = [];
    let updated = 0;
    let queued = 0;
    let skipped = 0;

    for (const ref of refs) {
        const resource = Array.isArray(resources)
            ? resources.find((candidate) => candidate.id === ref.id)
            : null;
        if (resource?.codeReference) {
            skipped++;
            continue;
        }
        if (resource) {
            resource.codeReference = ref.codeReference;
            updated++;
            continue;
        }

        const existing = entry.state.pendingSourceRefs.find(
            (candidate) => candidate.contextToken === contextToken && candidate.id === ref.id,
        );
        if (existing) existing.codeReference = ref.codeReference;
        else entry.state.pendingSourceRefs.push({ contextToken, id: ref.id, codeReference: ref.codeReference });
        queued++;
    }

    return { updated, queued, skipped, view: context.view };
}
