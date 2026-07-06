// Canvas adapter — deploy monitoring + log parsing.
// Polls GitHub Actions runs and the orphan radius-deploy-status branch for live
// deploy/activity/control-plane logs and the deployed graph, then parses rad
// deploy output into per-resource progress/status the deployingPage renders.
// Reads GitHub via the gh CLI; portal links come from ./infra.mjs.

import { ghApiGetContent, cliExec } from "./gh.mjs";
import { generatePortalUrl } from "./infra.mjs";

export function ghJson(args, fallback = null, timeout = 15000) {
    return new Promise((resolve) => {
        cliExec("gh", args, { timeout }, (err, stdout) => {
            if (err) { resolve(fallback); return; }
            try { resolve(JSON.parse(stdout.trim())); } catch (e) { resolve(fallback); }
        });
    });
}

export async function findWorkflowRun(repo, workflowFile, sinceMs, knownId) {
    if (knownId) return knownId;
    const runs = await ghJson(
        ["run", "list", "--workflow=" + workflowFile, "--limit", "5",
         "--json", "databaseId,status,createdAt", "--repo", repo],
        []
    );
    if (!Array.isArray(runs)) return null;
    // Newest first; accept the first run created within ~60s before dispatch
    // (clock skew tolerance) to avoid picking up stale prior runs.
    const cutoff = (sinceMs || 0) - 60000;
    for (const r of runs) {
        const created = Date.parse(r.createdAt || '') || 0;
        if (created >= cutoff) return r.databaseId;
    }
    return null;
}

export async function getRunDetail(repo, runId) {
    const data = await ghJson(
        ["run", "view", String(runId), "--json", "status,conclusion,jobs", "--repo", repo],
        null
    );
    if (!data) return null;
    const steps = [];
    for (const job of (data.jobs || [])) {
        for (const s of (job.steps || [])) {
            steps.push({ name: s.name, status: s.status, conclusion: s.conclusion });
        }
    }
    return { status: data.status, conclusion: data.conclusion, jobs: data.jobs || [], steps };
}

export function fetchRunLog(repo, runId) {
    return new Promise((resolve) => {
        cliExec("gh", ["run", "view", String(runId), "--log", "--repo", repo],
            { timeout: 30000, maxBuffer: 1024 * 1024 * 20 }, (err, stdout) => {
            if (err || !stdout) { resolve(null); return; }
            resolve(stdout);
        });
    });
}

export function fetchLiveDeployLog(repo) {
    return ghApiGetContent(`/repos/${repo}/contents/deploy-progress.log?ref=radius-deploy-status`, 12000);
}

export function fetchLiveActivityLog(repo) {
    return ghApiGetContent(`/repos/${repo}/contents/deploy-activity.log?ref=radius-deploy-status`, 12000);
}

export function fetchLiveControlPlaneLog(repo) {
    return ghApiGetContent(`/repos/${repo}/contents/deploy-controlplane.log?ref=radius-deploy-status`, 12000);
}

export function fetchDeployState(repo) {
    return ghApiGetContent(`/repos/${repo}/contents/deploy-state.txt?ref=radius-deploy-status`, 10000)
        .then(t => (t ? t.trim() : null));
}

export function fetchDeployGraph(repo) {
    return ghApiGetContent(`/repos/${repo}/contents/deploy-graph.json?ref=radius-deploy-status`, 12000)
        .then(t => { if (!t) return null; try { return JSON.parse(t); } catch (e) { return null; } });
}

export function normalizeDeployedGraph(resources) {
    if (!Array.isArray(resources) || resources.length < 2) return resources;
    const keyOf = r => r.id || r.name;
    const hasConn = (r, otherKey) => Array.isArray(r.connections)
        && r.connections.some(c => (c.id || c.name) === otherKey);
    for (let a = 0; a < resources.length; a++) {
        for (let b = a + 1; b < resources.length; b++) {
            const A = resources[a], B = resources[b];
            const aOut = Array.isArray(A.outputResources) ? A.outputResources : [];
            const bOut = Array.isArray(B.outputResources) ? B.outputResources : [];
            let shared = null;
            for (const oa of aOut) {
                if (!oa || !oa.id) continue;
                if (bOut.some(ob => ob && ob.id === oa.id)) { shared = oa; break; }
            }
            if (!shared) continue;
            if (hasConn(A, keyOf(B)) || hasConn(B, keyOf(A))) continue;
            // Orient the edge toward the resource whose name matches the shared
            // concrete resource (its owner); else toward the one with fewer outputs.
            const sharedName = shared.name || '';
            let src = A, dst = B;
            if (B.name === sharedName && A.name !== sharedName) { src = A; dst = B; }
            else if (A.name === sharedName && B.name !== sharedName) { src = B; dst = A; }
            else if (aOut.length < bOut.length) { src = B; dst = A; }
            src.connections = Array.isArray(src.connections) ? src.connections : [];
            dst.connections = Array.isArray(dst.connections) ? dst.connections : [];
            src.connections.push({ id: keyOf(dst), direction: 'Outbound' });
            dst.connections.push({ id: keyOf(src), direction: 'Inbound' });
        }
    }
    return resources;
}

export function deployedResourceCategory(type) {
    const t = (type || '').toLowerCase();
    if ((t.includes('container') && !t.includes('image') && !t.includes('registry')) || t.includes('compute')) return 'compute';
    if (t.includes('redis') || t.includes('cache') || t.includes('elasticache') || t.includes('memorydb')) return 'cache';
    if (t.includes('mysql') || t.includes('postgres') || t.includes('/sql') || t.includes('rds')
        || t.includes('mongo') || t.includes('cosmos') || t.includes('documentdb') || t.includes('docdb') || t.includes('neo4j')) return 'data';
    if (t.includes('secret') || t.includes('keyvault') || t.includes('secretsmanager')) return 'secret';
    return 'other';
}

export function rewireDeployedGraphChain(resources) {
    if (!Array.isArray(resources)) return resources;
    const byKey = {};
    for (const r of resources) byKey[r.id || r.name] = r;
    const keyOf = r => r.id || r.name;
    const catOf = r => deployedResourceCategory(r && r.type);
    for (const c of resources) {
        if (catOf(c) !== 'compute' || !Array.isArray(c.connections)) continue;
        const caches = [], dbs = [];
        for (const conn of c.connections) {
            if (conn.direction !== 'Outbound') continue;
            const dst = byKey[conn.id || conn.name];
            if (!dst) continue;
            if (catOf(dst) === 'cache') caches.push(dst);
            else if (catOf(dst) === 'data') dbs.push(dst);
        }
        if (caches.length === 0 || dbs.length === 0) continue;
        const cache = caches[0];
        const cKey = keyOf(c), cacheKey = keyOf(cache);
        for (const db of dbs) {
            const dbKey = keyOf(db);
            // Drop container → db (both directions).
            c.connections = c.connections.filter(x => (x.id || x.name) !== dbKey);
            if (Array.isArray(db.connections)) db.connections = db.connections.filter(x => (x.id || x.name) !== cKey);
            // Insert cache → db.
            cache.connections = cache.connections || [];
            if (!cache.connections.some(x => (x.id || x.name) === dbKey)) cache.connections.push({ id: dbKey, direction: 'Outbound' });
            db.connections = db.connections || [];
            if (!db.connections.some(x => (x.id || x.name) === cacheKey)) db.connections.push({ id: cacheKey, direction: 'Inbound' });
        }
    }
    return resources;
}

export function azureTypeFromResourceId(rid) {
    if (!rid) return { type: '', name: '' };
    const idx = rid.toLowerCase().indexOf('/providers/');
    if (idx < 0) return { type: '', name: '' };
    const segs = rid.slice(idx + '/providers/'.length).split('/').filter(Boolean);
    if (segs.length < 2) return { type: '', name: '' };
    const ns = segs[0];
    const rest = segs.slice(1);
    const typeParts = [];
    let name = '';
    for (let i = 0; i < rest.length; i += 2) {
        typeParts.push(rest[i]);
        if (rest[i + 1] !== undefined) name = rest[i + 1];
    }
    return { type: ns + '/' + typeParts.join('/'), name };
}

export function reduceActivityLog(text) {
    if (!text) return [];
    const rank = { in_progress: 1, success: 2, failed: 3 };
    const map = new Map();
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|');
        if (parts.length < 2) continue;
        const sRaw = (parts[0] || '').toLowerCase();
        const rid = parts[1] || '';
        const op = parts[2] || '';
        if (!rid) continue;
        let status = 'in_progress';
        if (/succeed|resolv/.test(sRaw)) status = 'success';
        else if (/fail|error|cancel|denied/.test(sRaw)) status = 'failed';
        const { type, name } = azureTypeFromResourceId(rid);
        if (!type) continue;
        const prev = map.get(rid);
        if (!prev || rank[status] >= rank[prev.status]) map.set(rid, { status, rid, op, type, name });
    }
    return [...map.values()];
}

export function applyActivityToResources(entries, resources, provider, state) {
    const rank = { pending: 0, in_progress: 1, success: 2, failed: 3 };
    const changes = [];
    for (const e of entries) {
        const etype = e.type.toLowerCase();
        for (const r of resources) {
            if (!Array.isArray(r.outputResources)) continue;
            for (const o of r.outputResources) {
                if (!o.type) continue;
                const otype = o.type.toLowerCase();
                // Match exact type or activity type ending with the output type
                // (handles namespace/casing differences and nested types).
                if (etype === otype || etype.endsWith('/' + otype) || otype.endsWith(etype) || etype.includes(otype)) {
                    const cur = o.deployStatus || 'pending';
                    // Never downgrade away from a terminal failure.
                    if (cur === 'failed' && e.status !== 'failed') continue;
                    if (rank[e.status] > rank[cur] || (e.status === 'failed' && cur !== 'failed')) {
                        o.deployStatus = e.status;
                        if (e.rid && !o.id) o.id = e.rid;
                        if (e.status === 'success') {
                            const portalUrlKey = provider === 'azure' ? (o.id || e.rid || o.type || o.displayType || '') : (o.type || o.displayType || o.id || e.rid || '');
                            o.portalUrl = generatePortalUrl(portalUrlKey, provider, state);
                        }
                        changes.push((e.status === 'failed' ? '✗' : e.status === 'success' ? '✓' : '▷') + ' ' + (o.displayType || o.type) + (e.name ? ' "' + e.name + '"' : '') + ' — ' + e.status);
                    }
                }
            }
        }
    }
    // Roll parent status up from its outputs (don't clobber a parent failure).
    for (const r of resources) {
        if (!Array.isArray(r.outputResources) || r.outputResources.length === 0) continue;
        const states = r.outputResources.map(o => o.deployStatus || 'pending');
        let parent = 'pending';
        if (states.some(s => s === 'failed')) parent = 'failed';
        else if (states.every(s => s === 'success')) parent = 'success';
        else if (states.some(s => s === 'in_progress' || s === 'success')) parent = 'in_progress';
        if (r.deployStatus === 'failed' && parent !== 'failed') continue;
        r.deployStatus = parent;
    }
    return changes;
}

export function extractErrorLines(logText, max = 12) {
    if (!logText) return [];
    const out = [];
    const re = /\b(error|errors|failed|failure|fatal|denied|unauthorized|forbidden|not\s+found|cannot|unable|panic|exception|invalid|timed?\s*out)\b/i;
    for (const raw of logText.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;
        if (re.test(line)) out.push(line.trim());
    }
    return out.slice(-max);
}

export function extractRadDeployError(logText, maxChars = 4000) {
    if (!logText) return '';
    // Strip the "job\tstep\ttimestamp " prefix `gh run view --log` adds, if present,
    // so the structured block is detectable regardless of the log source.
    const lines = logText.split(/\r?\n/).map(raw => {
        let l = raw.replace(/\s+$/, '');
        // gh run log prefix: tabs separate job/step, then "<ISO timestamp> <text>".
        const m = l.match(/^[^\t]*\t[^\t]*\t\S+\s(.*)$/);
        if (m) l = m[1];
        return l;
    });
    // Find the LAST structured rad error block ("Error: {").
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^\s*Error:\s*\{/.test(lines[i])) { start = i; break; }
    }
    if (start >= 0) {
        const block = [];
        for (let i = start; i < lines.length; i++) {
            const l = lines[i];
            if (/^\s*Error:\s*Process completed/.test(l)) break; // GitHub Actions wrapper line
            block.push(l);
            if (/^\s*TraceId:/.test(l)) break; // end of the rad error
        }
        const out = block.join('\n').trim();
        if (out) return out.slice(0, maxChars);
    }
    // Fallback: collect trailing error-ish lines.
    return extractErrorLines(lines.join('\n'), 20).join('\n').slice(0, maxChars);
}

export function parseResourceProgress(logText, resources) {
    const result = {};
    if (!logText) return result;
    const names = resources.map(r => r.name).filter(Boolean);
    const lines = logText.split(/\r?\n/);
    for (const line of lines) {
        const lower = line.toLowerCase();
        const isFail  = /\b(failed|failure|error|errored)\b/.test(lower);
        const isDone  = /\b(succeeded|completed|complete|created|provisioned|creation complete)\b/.test(lower);
        const isStart = /\b(creating|provisioning|processing|started|deploying|updating|accepted|in progress|inprogress|postponed|waiting|apply(ing)?)\b/.test(lower);
        if (!isFail && !isDone && !isStart) continue;
        for (const name of names) {
            const re = new RegExp('(^|[^A-Za-z0-9_-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_-]|$)');
            if (!re.test(line)) continue;
            if (isFail) result[name] = 'failed';
            else if (isDone) { if (result[name] !== 'failed') result[name] = 'success'; }
            else if (isStart) { if (!result[name]) result[name] = 'in_progress'; }
        }
    }
    return result;
}

export function parseRadDeployLog(logText, resources, opts = {}) {
    const stripPrefix = opts.stripPrefix !== false;
    const result = {};
    if (!logText) return result;
    const names = resources.map(r => r.name).filter(Boolean);
    const lines = logText.split(/\r?\n/);
    for (const raw of lines) {
        const line = stripPrefix ? raw.replace(/^\S+\s+\S+\s+/, '') : raw; // strip GH "job\tstep\t" prefix
        const lower = line.toLowerCase();
        const isDone = /\bcompleted\b/.test(lower) || /\bsucceeded\b/.test(lower);
        const isFail = /\bfailed\b/.test(lower) || /\berror\b/.test(lower);
        if (!isDone && !isFail) continue;
        for (const name of names) {
            // Match the resource name as a whole word in the status line
            const re = new RegExp('(^|[^A-Za-z0-9_-])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_-]|$)');
            if (re.test(line)) {
                if (isFail) result[name] = 'failed';
                else if (!result[name]) result[name] = 'success';
            }
        }
    }
    return result;
}
