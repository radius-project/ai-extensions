// Canvas adapter — browser-side client JavaScript, served as inline <script>
// text inside the page shell. Three cohesive blocks: the shared repo/branch
// dropdown library, the shared cytoscape/dagre graph renderer, and the client
// heartbeat / auto-reconnect watchdog. Authored as ES5 the webview runs
// directly; embedded verbatim by pageShell. No server-side interpolation here.

export const CLIENT_REPO_BRANCH_JS = `
// ─── Shared Repo/Branch Library ───────────────────────────────────────────────
// Provides consistent repo/branch dropdowns across all panes (matches diff pane style).

function radiusPopulateRepos(selectId, defaultRepo) {
    var sel = document.getElementById(selectId);
    if (!sel) return Promise.resolve();
    function doFetch() {
        return fetch('/api/user-repos?_t=' + Date.now()).then(function(r) { return r.json(); }).then(function(d) {
            sel.innerHTML = '<option value="">-- Select repository --</option>';
            var found = false;
            (d.repos || []).forEach(function(r) {
                var o = document.createElement('option');
                o.value = r; o.textContent = r;
                if (r === defaultRepo) { o.selected = true; found = true; }
                sel.appendChild(o);
            });
            if (defaultRepo && !found) {
                var o = document.createElement('option');
                o.value = defaultRepo; o.textContent = defaultRepo; o.selected = true;
                sel.insertBefore(o, sel.children[1]);
            }
        });
    }
    return doFetch().catch(function() { return new Promise(function(r) { setTimeout(r, 1000); }).then(doFetch); });
}

function radiusPopulateBranches(selectIds, repo, defaults) {
    if (!repo) return Promise.resolve();
    if (typeof selectIds === 'string') { selectIds = [selectIds]; defaults = [defaults]; }
    return fetch('/api/discover-branches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({repo: repo}) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.error) return;
            var branches = data.branches || [];
            for (var i = 0; i < selectIds.length; i++) {
                var sel = document.getElementById(selectIds[i]);
                if (!sel) continue;
                var defaultVal = (defaults && defaults[i]) || 'main';
                sel.innerHTML = '';
                var found = false;
                for (var j = 0; j < branches.length; j++) {
                    var o = document.createElement('option');
                    o.value = branches[j].name;
                    o.textContent = branches[j].name + ' (' + branches[j].sha.slice(0,7) + ')';
                    if (branches[j].name === defaultVal) { o.selected = true; found = true; }
                    sel.appendChild(o);
                }
                if (!found && branches.length > 0) {
                    sel.selectedIndex = 0;
                }
            }
        });
}

function radiusSetupRepoBranch(repoSelectId, branchSelectIds, defaultRepo, defaultBranches) {
    if (typeof branchSelectIds === 'string') { branchSelectIds = [branchSelectIds]; defaultBranches = [defaultBranches]; }
    radiusPopulateRepos(repoSelectId, defaultRepo).then(function() {
        var repoSel = document.getElementById(repoSelectId);
        if (repoSel && repoSel.value) {
            radiusPopulateBranches(branchSelectIds, repoSel.value, defaultBranches);
        }
    });
    var repoSel = document.getElementById(repoSelectId);
    if (repoSel) {
        repoSel.addEventListener('change', function() {
            if (this.value) radiusPopulateBranches(branchSelectIds, this.value, defaultBranches);
        });
    }
}
`;

export const CLIENT_GRAPH_JS = `
// ─── Shared Graph Renderer ───────────────────────────────────────────────────
if (typeof cytoscape !== 'undefined' && typeof cytoscapeDagre !== 'undefined') {
    cytoscape.use(cytoscapeDagre);
}

window.__cyInstances = window.__cyInstances || {};

function radiusGetIconSvg(type) {
    if (!type) return '';
    var t = type.toLowerCase();
    var svg;
    if (t.includes('container') && !t.includes('image') && !t.includes('registry')) {
        // Container / K8s Deployment
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#326ce5"><path d="M10.204 14.35l.007.01-.999 2.413a5.171 5.171 0 01-2.075-2.597l2.578-.437.489.611zm4.159.613l-.502.504-.467-.467 2.528.46a5.18 5.18 0 01-2.12 2.63l-.95-2.326.511-.801zm-2.246 1.807l.006-.007 1.06 2.594a5.275 5.275 0 01-3.381.015l1.074-2.59.627-.019.614.007zm3.63-5.017l-.564.396-.6-.395 2.68.124a5.18 5.18 0 01-.694 3.304l-1.822-2.028v-1.401zm-7.88-.598l-.598.396 .002 1.396-1.822 2.03a5.18 5.18 0 01-.694-3.305l2.548-.121.564.404v-.8zm4.318-2.834l.6.393-.006 1.393.564.397-2.55.122a5.18 5.18 0 01.694-3.305l.698 1zm-1.64.027l.696-.998a5.18 5.18 0 01.694 3.304l-2.55-.122.564-.396-.005-1.394.601-.394zm-.948-.652l-.627.019-.614-.007.006.007-1.06-2.594a5.275 5.275 0 013.381-.015l-1.074 2.59h-.012zM12 6.042a5.97 5.97 0 015.958 5.958A5.97 5.97 0 0112 17.958 5.97 5.97 0 016.042 12 5.97 5.97 0 0112 6.042M12 4a8 8 0 100 16 8 8 0 000-16z"/></svg>';
    } else if (t.includes('image') || t.includes('registry') || /(^|[^a-z])ecr([^a-z]|$)/.test(t)) {
        // Container Registry (ACR / ECR). 'ecr' matched as a delimited token so
        // it does not match words like "secrets".
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#0969da"><path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 010-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1h-6a1 1 0 00-1 1v6.708A2.486 2.486 0 017.5 9h5V1.5zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/></svg>';
    } else if (t.includes('gateway') || t.includes('applicationgateway')) {
        // Gateway / App Gateway
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8250df"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM2.07 7.5h3.46c.05-1.2.24-2.3.56-3.18.15-.43.34-.8.56-1.1A5.96 5.96 0 002.07 7.5zm4.47 0h2.92c-.05-1.07-.22-2.03-.49-2.78-.27-.75-.6-1.22-.89-1.47-.29.25-.62.72-.89 1.47-.27.75-.44 1.71-.49 2.78H6.54zm2.92 1H6.54c.05 1.07.22 2.03.49 2.78.27.75.6 1.22.89 1.47.29-.25.62-.72.89-1.47.27-.75.44-1.71.49-2.78zm.91 0c-.05 1.2-.24 2.3-.56 3.18-.15.43-.34.8-.56 1.1a5.96 5.96 0 004.58-4.28h-3.46zm3.46-1h-3.46c-.05-1.2-.24-2.3-.56-3.18a3.9 3.9 0 00-.56-1.1 5.96 5.96 0 014.58 4.28zM6.65 3.22c-.22.3-.41.67-.56 1.1-.32.88-.51 1.98-.56 3.18H2.07a5.96 5.96 0 014.58-4.28zm-3.58 5.28h3.46c.05 1.2.24 2.3.56 3.18.15.43.34.8.56 1.1a5.96 5.96 0 01-4.58-4.28z"/></svg>';
    } else if (t.includes('route') || t.includes('ingress') || t.includes('lb') || t.includes('loadbalancer')) {
        // Route / Ingress / Load Balancer
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8250df"><path d="M4 2a2 2 0 100 4 2 2 0 000-4zm-1 2a1 1 0 112 0 1 1 0 01-2 0zm9 6a2 2 0 100 4 2 2 0 000-4zm-1 2a1 1 0 112 0 1 1 0 01-2 0zM6 4h4.5a2.5 2.5 0 010 5H5.5a1.5 1.5 0 000 3H10v-1l2.5 1.5L10 14v-1H5.5a2.5 2.5 0 010-5h5a1.5 1.5 0 000-3H6V4z"/></svg>';
    } else if (t.includes('mysql') || t.includes('dbformysql')) {
        // MySQL
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#00758f"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
    } else if (t.includes('postgres') || t.includes('dbforpostgresql')) {
        // PostgreSQL
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#336791"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
    } else if (t.includes('redis') || t.includes('cache') || t.includes('elasticache') || t.includes('memorydb')) {
        // Redis / Cache — stacked diamond shape
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#d82c20"><path d="M8 2L14 5.5 8 9 2 5.5 8 2z"/><path d="M2 7.5L8 11l6-3.5L8 4 2 7.5z" opacity="0.7"/><path d="M2 10L8 13.5 14 10 8 6.5 2 10z" opacity="0.5"/></svg>';
    } else if (t.includes('sql') || t.includes('rds') || t.includes('db_instance')) {
        // SQL / RDS generic
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#e48400"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2"/><path d="M2.5 3.5v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V3.5c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 6.7v3.2c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V6.7c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/><path d="M2.5 9.9v2.6c0 1.21 2.46 2.2 5.5 2.2s5.5-.99 5.5-2.2V9.9c0 1.21-2.46 2.2-5.5 2.2s-5.5-.99-5.5-2.2z"/></svg>';
    } else if (t.includes('mongo') || t.includes('cosmos') || t.includes('documentdb') || t.includes('docdb')) {
        // MongoDB / CosmosDB / DocumentDB
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#13aa52"><path d="M8.5 1.2c-.2-.3-.5-.3-.7 0C6.5 3 5 5 5 7.5c0 1.4.7 2.6 1.7 3.3l-.2 3.5c0 .4.3.7.7.7h1.6c.4 0 .7-.3.7-.7l-.2-3.5c1-.7 1.7-1.9 1.7-3.3 0-2.5-1.5-4.5-2.5-6.3zM8 9.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>';
    } else if (t.includes('neo4j')) {
        // Neo4j graph database
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#018bff"><circle cx="5" cy="4" r="2"/><circle cx="11" cy="4" r="2"/><circle cx="8" cy="11" r="2"/><line x1="5" y1="4" x2="11" y2="4" stroke="#018bff" stroke-width="1.2"/><line x1="5" y1="4" x2="8" y2="11" stroke="#018bff" stroke-width="1.2"/><line x1="11" y1="4" x2="8" y2="11" stroke="#018bff" stroke-width="1.2"/></svg>';
    } else if (t.includes('rabbit') || t.includes('amqp') || t.includes('servicebus') || t.includes('sqs')) {
        // Messaging (RabbitMQ / Service Bus / SQS)
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#ff6600"><path d="M14 4H2a1 1 0 00-1 1v6a1 1 0 001 1h12a1 1 0 001-1V5a1 1 0 00-1-1zM5 10H3V6h2v4zm4 0H7V6h2v4zm4 0h-2V6h2v4z"/></svg>';
    } else if (t.includes('secret') || t.includes('keyvault') || t.includes('secretsmanager')) {
        // Secrets / Key Vault / Secrets Manager
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#1a7f37"><path d="M8 1a4 4 0 00-4 4v2H3a1 1 0 00-1 1v6a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1V5a4 4 0 00-4-4zm-3 6V5a3 3 0 116 0v2H5zm3 3a1.5 1.5 0 01.5 2.91V13.5a.5.5 0 01-1 0v-.59A1.5 1.5 0 018 10z"/></svg>';
    } else if (t.includes('volume') || t.includes('persistent') || t.includes('disk') || t.includes('ebs')) {
        // Storage / Volumes / Disks
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#8764b8"><path d="M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v2A1.5 1.5 0 0112.5 7h-9A1.5 1.5 0 012 5.5v-2zm1.5-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 00-.5-.5h-9zM2 9.5A1.5 1.5 0 013.5 8h9A1.5 1.5 0 0114 9.5v2a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-2zm1.5-.5a.5.5 0 00-.5.5v2a.5.5 0 00.5.5h9a.5.5 0 00.5-.5v-2a.5.5 0 00-.5-.5h-9zM11 4.5a.5.5 0 11-1 0 .5.5 0 011 0zm1 0a.5.5 0 11-1 0 .5.5 0 011 0zm-1 6a.5.5 0 11-1 0 .5.5 0 011 0zm1 0a.5.5 0 11-1 0 .5.5 0 011 0z"/></svg>';
    } else if (t.includes('subnet') || t.includes('security_group') || t.includes('securitygroup') || t.includes('vpc') || t.includes('network')) {
        // Networking / Security Groups / Subnets
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#0078d4"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8z"/><path d="M8 4a.75.75 0 01.75.75v2.5h2.5a.75.75 0 010 1.5h-2.5v2.5a.75.75 0 01-1.5 0v-2.5h-2.5a.75.75 0 010-1.5h2.5v-2.5A.75.75 0 018 4z"/></svg>';
    } else if (t.includes('service') && !t.includes('servicebus')) {
        // K8s Service
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#326ce5"><path d="M1 8a7 7 0 1114 0A7 7 0 011 8zm7-6a6 6 0 100 12A6 6 0 008 2zm0 2a1 1 0 110 2 1 1 0 010-2zm0 3.5a1 1 0 110 2 1 1 0 010-2zm0 3.5a1 1 0 110 2 1 1 0 010-2z"/></svg>';
    } else if (t.includes('deployment')) {
        // K8s Deployment
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#326ce5"><path d="M8 1l6.5 3.75v7.5L8 16l-6.5-3.75v-7.5L8 1zm0 1.15L2.5 5.25v6.5L8 14.85l5.5-3.1v-6.5L8 2.15z"/><path d="M8 5l3.5 2v3.5L8 12.5 4.5 10.5V7L8 5z"/></svg>';
    } else {
        // Generic/fallback — cloud resource cube
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="#6639ba"><path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7L8 1.5zm0 1.2L3.5 5.5v5.4L8 13.3l4.5-2.4V5.5L8 2.7z"/><path d="M8 5.8L5.5 7.2v2.6L8 11.2l2.5-1.4V7.2L8 5.8z"/></svg>';
    }
    // Inject explicit width/height for sharper rendering when Cytoscape rasterizes
    svg = svg.replace('<svg ', '<svg width="64" height="64" ');
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// Maps a resource type to a node fill/border color and Cytoscape shape so that
// each category reads at a glance. Color encodes the category (and matches the
// graph legend); shape is a secondary cue (cylinder=data, hexagon=cache,
// cut-corner=secret, tag=networking/messaging, rounded box=compute). Substring
// matching mirrors radiusGetIconSvg so icon + chrome always agree. All shapes
// chosen are wide-label friendly so wrapped text stays inside the node.
function radiusGetTypeStyle(type) {
    var t = (type || '').toLowerCase();
    // Compute / workloads
    if ((t.includes('container') && !t.includes('image') && !t.includes('registry'))
        || t.includes('deployment') || (t.includes('service') && !t.includes('servicebus'))) {
        return { bg: '#e8f0fe', border: '#326ce5', shape: 'roundrectangle', category: 'Compute' };
    }
    // Container registry (ACR / ECR). The 'ecr' token is matched only as a
    // delimited segment so it does not trip on words like "secrets" (s-ecr-ets).
    if (t.includes('image') || t.includes('registry') || /(^|[^a-z])ecr([^a-z]|$)/.test(t)) {
        return { bg: '#ddf4ff', border: '#0969da', shape: 'roundrectangle', category: 'Registry' };
    }
    // Cache (Redis / ElastiCache / MemoryDB)
    if (t.includes('redis') || t.includes('cache') || t.includes('elasticache') || t.includes('memorydb')) {
        return { bg: '#fdeceb', border: '#d82c20', shape: 'hexagon', category: 'Cache' };
    }
    // Databases / data stores (relational, document, graph)
    if (t.includes('mysql') || t.includes('dbformysql') || t.includes('postgres') || t.includes('dbforpostgresql')
        || t.includes('sql') || t.includes('rds') || t.includes('db_instance')
        || t.includes('mongo') || t.includes('cosmos') || t.includes('documentdb') || t.includes('docdb')
        || t.includes('neo4j')) {
        return { bg: '#fdf0e3', border: '#e48400', shape: 'barrel', category: 'Data Store' };
    }
    // Secrets / Key Vault / Secrets Manager
    if (t.includes('secret') || t.includes('keyvault') || t.includes('secretsmanager')) {
        return { bg: '#e9f5ee', border: '#1a7f37', shape: 'cut-rectangle', category: 'Secrets' };
    }
    // Networking (gateways, routes, ingress, load balancers, VPC/subnets)
    if (t.includes('gateway') || t.includes('applicationgateway') || t.includes('route') || t.includes('ingress')
        || t.includes('lb') || t.includes('loadbalancer') || t.includes('subnet') || t.includes('security_group')
        || t.includes('securitygroup') || t.includes('vpc') || t.includes('network')) {
        return { bg: '#f2ecfb', border: '#8250df', shape: 'tag', category: 'Networking' };
    }
    // Messaging (RabbitMQ / Service Bus / SQS)
    if (t.includes('rabbit') || t.includes('amqp') || t.includes('servicebus') || t.includes('sqs')) {
        return { bg: '#fff1e6', border: '#ff6600', shape: 'tag', category: 'Messaging' };
    }
    // Storage / volumes / disks
    if (t.includes('volume') || t.includes('persistent') || t.includes('disk') || t.includes('ebs')) {
        return { bg: '#f0ebf9', border: '#8764b8', shape: 'barrel', category: 'Storage' };
    }
    // Fallback / other cloud resource
    return { bg: '#ede9f7', border: '#6639ba', shape: 'roundrectangle', category: 'Other' };
}

function radiusRenderGraph(containerId, resources, options) {
    options = options || {};
    var container = document.getElementById(containerId);
    if (!container) return null;

    // The graph libraries are loaded from a CDN (see vendor.mjs). If that fetch
    // failed (offline / blocked network), cytoscape is undefined — surface a
    // recoverable message instead of throwing and breaking the whole panel.
    if (typeof cytoscape === 'undefined') {
        container.innerHTML = '<div style="padding:16px;color:#cf222e;font-size:13px;">Graph library failed to load (network unavailable). Reopen the panel once connectivity is restored to render the graph.</div>';
        return null;
    }

    // Destroy previous instance
    if (window.__cyInstances[containerId]) {
        window.__cyInstances[containerId].destroy();
        delete window.__cyInstances[containerId];
    }

    // Remove any legend(s) left over from a previous render so re-rendering the
    // same container (e.g. switching repos on the deployed page) doesn't stack
    // multiple legends.
    if (container.parentNode) {
        var oldLegends = container.parentNode.querySelectorAll('.legend');
        for (var ol = 0; ol < oldLegends.length; ol++) oldLegends[ol].parentNode.removeChild(oldLegends[ol]);
    }

    if (!resources || resources.length === 0) {
        container.innerHTML = '';
        return null;
    }

    container.innerHTML = '';
    container.style.position = 'relative';
    container.style.display = 'block';
    container.style.minHeight = '450px';

    var diffMode = options.diffMode || false;
    var repoUrl = options.repoUrl || '';
    var branch = options.branch || 'main';
    var bicepGenerated = options.bicepGenerated || false;
    var lineType = options.lineType || options.curveStyle || 'taxi';

    function getNodeColors(r, typeStyle) {
        if (diffMode && r.diffStatus) {
            switch (r.diffStatus) {
                case 'added': return { bg: '#dcfce7', border: '#16a34a' };
                case 'removed': return { bg: '#fee2e2', border: '#dc2626' };
                case 'modified': return { bg: '#fef9c3', border: '#ca8a04' };
                default: return { bg: '#f3f4f6', border: '#9ca3af' };
            }
        }
        return { bg: typeStyle.bg, border: typeStyle.border };
    }

    var elements = [];
    // Map a concrete outputResource id → the top-level resource that "owns" it
    // (its name matches the output's name, e.g. the Radius.Security/secret
    // "mysql-secret" owns the concrete core/Secret "mysql-secret"). Used to skip
    // rendering that same concrete resource as a duplicate output child under
    // OTHER resources (e.g. the database), which otherwise produces two nodes for
    // one secret and a tangled, overlapping layout.
    var ownedOutputIds = {};
    for (var oi = 0; oi < resources.length; oi++) {
        var orr = resources[oi];
        var oid = orr.id || orr.name;
        var oouts = orr.outputResources || [];
        for (var oj = 0; oj < oouts.length; oj++) {
            if (oouts[oj] && oouts[oj].id && oouts[oj].name === orr.name) {
                ownedOutputIds[oouts[oj].id] = oid;
            }
        }
    }
    for (var i = 0; i < resources.length; i++) {
        var r = resources[i];
        var typeStyle = radiusGetTypeStyle(r.type);
        var colors = getNodeColors(r, typeStyle);
        var shortType = r.type ? r.type.split('/').pop().split('@')[0] : '';
        var label = r.name + '\\n' + shortType;
        // Collect any cloud (ARM) output resources so the node popup can link to
        // the live resource in the Azure portal.
        var cloudOutputs = [];
        if (r.outputResources) {
            for (var ci = 0; ci < r.outputResources.length; ci++) {
                var co = r.outputResources[ci];
                if (co.id && co.id.indexOf('/subscriptions/') === 0) {
                    cloudOutputs.push({ name: co.name || '', type: co.type || '', id: co.id });
                }
            }
        }
        elements.push({
            group: 'nodes',
            data: {
                id: r.id || r.name,
                label: label,
                borderColor: colors.border,
                borderWidth: 2,
                bgColor: colors.bg,
                shape: typeStyle.shape,
                icon: radiusGetIconSvg(r.type),
                codeRef: r.codeReference || '',
                defFile: r.definitionFile || '.radius/app.bicep',
                defLine: r.definitionLine || 0,
                defGenerated: bicepGenerated,
                resourceType: r.type || '',
                diffStatus: r.diffStatus || '',
                cloudResources: JSON.stringify(cloudOutputs)
            }
        });
        if (r.connections) {
            for (var j = 0; j < r.connections.length; j++) {
                var conn = r.connections[j];
                var dir = conn.direction || 'Outbound';
                if (dir === 'Outbound') {
                    var targetExists = resources.some(function(x) { return (x.id||x.name) === (conn.id||conn.name); });
                    if (targetExists) {
                        elements.push({
                            group: 'edges',
                            data: {
                                id: (r.id||r.name) + '-->' + (conn.id||conn.name),
                                source: r.id || r.name,
                                target: conn.id || conn.name
                            }
                        });
                    }
                }
            }
        }
        // Render output resources (concrete cloud types from recipes)
        if (r.outputResources && r.outputResources.length > 0) {
            for (var k = 0; k < r.outputResources.length; k++) {
                var out = r.outputResources[k];
                // Skip a concrete resource that another top-level resource owns
                // (and is therefore already drawn as its own connected node), so
                // we don't render the same secret/resource twice.
                if (out.id && ownedOutputIds[out.id] && ownedOutputIds[out.id] !== (r.id || r.name)) {
                    continue;
                }
                var outId = (r.id || r.name) + '/output/' + k + '/' + out.name;
                var outLabel = out.displayType || out.type || out.name;
                elements.push({
                    group: 'nodes',
                    data: {
                        id: outId,
                        label: outLabel,
                        borderColor: '#8c959f',
                        borderWidth: 1,
                        bgColor: '#f6f8fa',
                        shape: radiusGetTypeStyle(out.type || out.displayType || '').shape,
                        icon: radiusGetIconSvg(out.type || out.displayType || ''),
                        resourceType: out.type || '',
                        diffStatus: '',
                        cloudId: (out.id && out.id.indexOf('/subscriptions/') === 0) ? out.id : ''
                    }
                });
                elements.push({
                    group: 'edges',
                    data: {
                        id: (r.id || r.name) + '-->output-' + k,
                        source: r.id || r.name,
                        target: outId,
                        lineStyle: 'dashed'
                    }
                });
            }
        }
    }

    // Group edges by source so bezier sibling connectors can be fanned to
    // opposite sides later. Taxi is the default line type, but the existing
    // bezier routing remains available through options.lineType.
    var edgeEls = elements.filter(function(e) { return e.group === 'edges'; });
    var bySource = {};
    edgeEls.forEach(function(e) {
        (bySource[e.data.source] = bySource[e.data.source] || []).push(e);
    });
    var fanInfo = {};
    var maxFan = 1;
    Object.keys(bySource).forEach(function(src) {
        var arr = bySource[src];
        maxFan = Math.max(maxFan, arr.length);
        arr.forEach(function(e, idx) {
            fanInfo[e.data.id] = { idx: idx, n: arr.length };
            e.data.cpd = [0];
            e.data.cpw = [0.5];
            e.data.curveStyle = lineType;
        });
    });

    var cy = cytoscape({
        container: container,
        pixelRatio: 2,
        elements: elements,
        layout: { name: 'preset' },
        style: [
            { selector: 'node', style: {
                'label': 'data(label)',
                'text-valign': 'center',
                'text-halign': 'center',
                'text-margin-x': 8,
                'font-size': '11px',
                'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
                'color': '#1f2328',
                'background-color': 'data(bgColor)',
                'border-color': 'data(borderColor)',
                'border-width': 'data(borderWidth)',
                'shape': 'data(shape)',
                'width': 155,
                'height': 55,
                'text-wrap': 'wrap',
                'text-max-width': '110px',
                'background-image': 'data(icon)',
                'background-image-opacity': 1,
                'background-width': '20px',
                'background-height': '20px',
                'background-position-x': '8px',
                'background-position-y': '8px',
                'background-clip': 'none',
                'background-image-containment': 'over',
                'background-image-smoothing': 'yes'
            }},
            { selector: 'edge', style: {
                'width': 2,
                'line-color': '#8c959f',
                'target-arrow-color': '#8c959f',
                'target-arrow-shape': 'triangle',
                'curve-style': 'data(curveStyle)',
                'control-point-distances': 'data(cpd)',
                'control-point-weights': 'data(cpw)',
                'edge-distances': 'node-position',
                'arrow-scale': 0.8
            }},
            { selector: 'edge[curveStyle="taxi"]', style: {
                'taxi-direction': 'downward',
                'taxi-turn': '50%',
                'taxi-turn-min-distance': 10
            }},
            { selector: 'edge[lineStyle="dashed"]', style: { 'line-style': 'dashed', 'line-color': '#57606a', 'target-arrow-color': '#57606a' }},
            { selector: 'node:active', style: { 'overlay-opacity': 0.1 }},
            { selector: 'node.hover', style: { 'border-width': 3, 'border-color': '#0550ae' }}
        ],
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        autoungrabify: false,
        minZoom: 0.3,
        maxZoom: 3
    });

    // ── Layout + edge routing via dagre (with bend-point waypoints) ──────────
    // cytoscape-dagre discards the per-edge bend points dagre computes to route
    // long, multi-rank edges AROUND intervening boxes — which is exactly why
    // those edges used to cut straight through nodes. We run dagre directly so
    // we can both position the nodes AND feed those waypoints back as bezier
    // control points, giving smooth, Mermaid-like curves that never cross a box.
    // All spacing is derived from measured node dimensions (never hard-coded).
    var nodeW = 0, nodeH = 0;
    cy.nodes().forEach(function(n) {
        nodeW = Math.max(nodeW, n.outerWidth());
        nodeH = Math.max(nodeH, n.outerHeight());
    });
    if (!nodeW) nodeW = cy.width() || 160;
    if (!nodeH) nodeH = 56;

    // The curve bow allowed for simple (non-routed) edges is a fraction of node
    // height; separations must exceed it so fanned sibling curves still clear
    // their neighbours. Kept deliberately tight so the graph stays compact while
    // dagre's network-simplex ranker still minimises edge crossings.
    var maxBow = nodeH * 0.30;
    var fanRoom = (maxFan - 1) * maxBow * 0.6;
    var nodeSep = Math.round(nodeW * 0.42 + maxBow * 1.5 + fanRoom);
    var rankSep = Math.round(nodeH * 1.15 + maxBow * 1.5);
    var edgeSep = Math.round(maxBow * 0.8 + nodeW * 0.08);

    var edgeWaypoints = {}; // cy edge id → dagre interior bend points [{x,y}]
    var positioned = false;
    if (typeof dagre !== 'undefined' && dagre.graphlib) {
        try {
            var g = new dagre.graphlib.Graph({ multigraph: true });
            g.setGraph({
                rankdir: 'TB', nodesep: nodeSep, ranksep: rankSep,
                edgesep: edgeSep, ranker: 'network-simplex',
                marginx: 24, marginy: 24
            });
            g.setDefaultEdgeLabel(function() { return {}; });
            cy.nodes().forEach(function(n) {
                g.setNode(n.id(), { width: n.outerWidth(), height: n.outerHeight() });
            });
            cy.edges().forEach(function(e) {
                g.setEdge(e.source().id(), e.target().id(), {}, e.id());
            });
            dagre.layout(g);
            cy.nodes().forEach(function(n) {
                var gn = g.node(n.id());
                if (gn) n.position({ x: gn.x, y: gn.y });
            });
            cy.edges().forEach(function(e) {
                var ge = g.edge(e.source().id(), e.target().id(), e.id());
                if (ge && ge.points && ge.points.length > 2) {
                    // Drop the first/last points (node-boundary anchors); keep
                    // only the interior bends that define the routing.
                    edgeWaypoints[e.id()] = ge.points.slice(1, ge.points.length - 1);
                }
            });
            positioned = true;
        } catch (err) { positioned = false; }
    }
    if (!positioned) {
        // Fallback: let cytoscape-dagre lay out (no waypoints available).
        cy.layout({
            name: 'dagre', rankDir: 'TB', nodeSep: nodeSep, rankSep: rankSep,
            edgeSep: edgeSep, ranker: 'network-simplex', padding: 24, animate: false
        }).run();
    }

    // ── Calibrate cytoscape's perpendicular sign at runtime ───────────────────
    // controlPoints() returns absolute model positions, and cytoscape places a
    // control point at midpoint + normal * distance. We set a known offset on a
    // probe edge and measure which side it lands so our waypoint-derived
    // distances map to the correct side regardless of the internal convention.
    var cpSign = 1;
    try {
        var probe = cy.edges()[0];
        if (probe) {
            var ps = probe.source().position(), pt = probe.target().position();
            var pdx = pt.x - ps.x, pdy = pt.y - ps.y;
            var plen = Math.sqrt(pdx * pdx + pdy * pdy) || 1;
            var pnx = -pdy / plen, pny = pdx / plen;
            var savedD = probe.data('cpd'), savedW = probe.data('cpw');
            probe.data('cpd', [20]); probe.data('cpw', [0.5]);
            cy.style().update();
            var cps = probe.controlPoints && probe.controlPoints();
            if (cps && cps.length) {
                var midx = (ps.x + pt.x) / 2, midy = (ps.y + pt.y) / 2;
                var dot = (cps[0].x - midx) * pnx + (cps[0].y - midy) * pny;
                if (dot < 0) cpSign = -1;
            }
            probe.data('cpd', savedD); probe.data('cpw', savedW);
        }
    } catch (err) { cpSign = 1; }

    // ── Map each edge to bezier control points ────────────────────────────────
    // Edges with dagre bend points follow that routing (curving around boxes);
    // simple single-rank edges get a gentle bow, with siblings fanned to
    // alternating sides for separation.
    try {
        cy.edges().forEach(function(e) {
            var s = e.source().position(), t = e.target().position();
            var dx = t.x - s.x, dy = t.y - s.y;
            var len = Math.sqrt(dx * dx + dy * dy) || 1;
            var ux = dx / len, uy = dy / len;
            var nx = -uy, ny = ux;
            var wps = edgeWaypoints[e.id()];
            if (wps && wps.length) {
                var cpd = [], cpw = [];
                for (var wi = 0; wi < wps.length; wi++) {
                    var rx = wps[wi].x - s.x, ry = wps[wi].y - s.y;
                    var along = (rx * ux + ry * uy) / len;
                    var perp = rx * nx + ry * ny;
                    cpw.push(Math.max(0.02, Math.min(0.98, along)));
                    cpd.push(cpSign * perp);
                }
                e.data('cpd', cpd);
                e.data('cpw', cpw);
            } else {
                var bow = maxBow;
                var info = fanInfo[e.id()] || { idx: 0, n: 1 };
                if (info.n > 1) {
                    var spread = info.idx - (info.n - 1) / 2;
                    bow = maxBow * (0.5 + Math.abs(spread) * 0.5);
                    if (spread < 0) bow = -bow;
                }
                e.data('cpd', [bow]);
                e.data('cpw', [0.5]);
            }
        });
        cy.style().update();
        cy.fit(undefined, 40);
    } catch (err) { try { cy.fit(undefined, 40); } catch (e2) {} }

    // Node click popup
    if (options.enablePopup !== false) {
        var popup = document.createElement('div');
        popup.id = 'node-popup';
        popup.style.cssText = 'display:none; position:absolute; z-index:1000; background:var(--background-color-default, #fff); border:1px solid var(--border-color-default, #d1d9e0); border-radius:8px; padding:12px; box-shadow:0 4px 12px rgba(0,0,0,0.15); font-size:12px; min-width:200px; max-width:320px;';
        container.appendChild(popup);

        cy.on('tap', 'node', function(e) {
            var node = e.target;
            var d = node.data();
            var links = [];
            var escLocal = function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
            if (repoUrl && d.codeRef) {
                var codeUrl = repoUrl + '/blob/' + branch + '/' + d.codeRef.split('#')[0] + (d.codeRef.includes('#L') ? '#L' + d.codeRef.split('#L')[1] : '');
                links.push('<a href="' + codeUrl + '" onclick="window.open(this.href); return false;" style="color:#0969da; text-decoration:none; display:block; padding:4px 0; border-bottom:1px solid #eee;">📄 View code</a>');
            } else if (repoUrl) {
                // No precise location discovered — fall back to a repo-scoped code
                // search for the resource name/type so a code link is always present.
                var term = (d.label ? d.label.split('\\n')[0] : '') || d.resourceType || '';
                var searchUrl = repoUrl + '/search?q=' + encodeURIComponent(term) + '&type=code';
                links.push('<a href="' + searchUrl + '" onclick="window.open(this.href); return false;" style="color:#0969da; text-decoration:none; display:block; padding:4px 0; border-bottom:1px solid #eee;">🔎 Search code</a>');
            }
            if (d.defGenerated && d.defFile) {
                // No committed app.bicep in the repo — link to a local viewer that
                // renders the generated bicep (with the resource's line highlighted).
                var genUrl = '/generated-bicep' + (d.defLine ? '?line=' + d.defLine : '');
                links.push('<a href="' + genUrl + '" onclick="window.open(this.href); return false;" style="color:#0969da; text-decoration:none; display:block; padding:4px 0;">📋 View app definition</a>');
            } else if (repoUrl && d.defFile) {
                var defUrl = repoUrl + '/blob/' + branch + '/' + d.defFile + (d.defLine ? '#L' + d.defLine : '');
                links.push('<a href="' + defUrl + '" onclick="window.open(this.href); return false;" style="color:#0969da; text-decoration:none; display:block; padding:4px 0;">📋 View app definition</a>');
            }
            if (diffMode && d.diffStatus) {
                var statusLabel = d.diffStatus.charAt(0).toUpperCase() + d.diffStatus.slice(1);
                links.push('<div style="padding:4px 0; color:var(--text-color-muted, #656d76);">Status: <strong>' + statusLabel + '</strong></div>');
            }
            // Azure portal links for live cloud resources (from the deployed graph).
            function azurePortalUrl(armId) { return 'https://portal.azure.com/#@/resource' + armId + '/overview'; }
            if (d.cloudId) {
                links.push('<a href="' + escLocal(azurePortalUrl(d.cloudId)) + '" onclick="window.open(this.href); return false;" style="color:#0969da; text-decoration:none; display:block; padding:4px 0; border-bottom:1px solid #eee;">🔗 View in Azure portal</a>');
            }
            if (d.cloudResources) {
                try {
                    var cloudList = JSON.parse(d.cloudResources);
                    for (var ci = 0; ci < cloudList.length; ci++) {
                        var cr = cloudList[ci];
                        var crLabel = cr.name || (cr.type ? cr.type.split('/').pop() : 'resource');
                        links.push('<a href="' + escLocal(azurePortalUrl(cr.id)) + '" onclick="window.open(this.href); return false;" style="color:#0969da; text-decoration:none; display:block; padding:4px 0; border-bottom:1px solid #eee;">🔗 ' + escLocal(crLabel) + ' in Azure portal</a>');
                    }
                } catch (err) { /* ignore */ }
            }
            links.push('<div style="padding:4px 0; color:var(--text-color-muted, #656d76); font-size:11px;">Type: ' + escLocal(d.resourceType || 'unknown') + '</div>');
            var safeTitle = escLocal((d.label || '').replace('\\n', ' — '));
            popup.innerHTML = '<div style="font-weight:600; margin-bottom:6px; font-size:13px;">' + safeTitle + '</div>' + links.join('');
            var pos = node.renderedPosition();
            popup.style.left = (pos.x + 20) + 'px';
            popup.style.top = (pos.y - 20) + 'px';
            popup.style.display = '';
        });

        cy.on('tap', function(e) {
            if (e.target === cy) popup.style.display = 'none';
        });
    }

    // Show legend for diff mode
    if (diffMode) {
        var legend = document.createElement('div');
        legend.className = 'legend';
        legend.innerHTML = '<div class="legend-item"><span class="legend-dot" style="background:#16a34a;"></span>Added</div>' +
            '<div class="legend-item"><span class="legend-dot" style="background:#dc2626;"></span>Removed</div>' +
            '<div class="legend-item"><span class="legend-dot" style="background:#ca8a04;"></span>Modified</div>' +
            '<div class="legend-item"><span class="legend-dot" style="background:#9ca3af;"></span>Unchanged</div>';
        container.parentNode.insertBefore(legend, container);
    } else if (options.showLegend) {
        // Build a resource-type legend from the categories actually present in
        // the graph. Each category has its own color AND shape (see
        // radiusGetTypeStyle), so the legend renders a small glyph matching the
        // node shape. Order is first-seen so it only lists what's on screen.
        var seen = {};
        var cats = [];
        function noteCategory(type) {
            var st = radiusGetTypeStyle(type || '');
            if (!st.category || seen[st.category]) return;
            seen[st.category] = true;
            cats.push({ name: st.category, bg: st.bg, border: st.border, shape: st.shape });
        }
        function legendShapeSvg(shape, bg, border) {
            var inner;
            switch (shape) {
                case 'hexagon':
                    inner = '<polygon points="4,2 12,2 15,7 12,12 4,12 1,7"/>'; break;
                case 'cut-rectangle':
                    inner = '<polygon points="5,2 11,2 14.5,5 14.5,9 11,12 5,12 1.5,9 1.5,5"/>'; break;
                case 'tag':
                    inner = '<polygon points="1.5,2 9,2 14.5,7 9,12 1.5,12"/>'; break;
                case 'barrel':
                    inner = '<path d="M2,4 C2,2.4 14,2.4 14,4 L14,10 C14,11.6 2,11.6 2,10 Z"/>' +
                            '<path d="M2,4 C2,5.6 14,5.6 14,4" fill="none"/>'; break;
                default: // roundrectangle and fallbacks
                    inner = '<rect x="1.5" y="2" width="13" height="10" rx="2.5"/>';
            }
            return '<svg width="16" height="14" viewBox="0 0 16 14" style="vertical-align:middle; fill:' + bg + '; stroke:' + border + '; stroke-width:1.5;">' + inner + '</svg>';
        }
        for (var li = 0; li < resources.length; li++) {
            noteCategory(resources[li].type);
            var oR = resources[li].outputResources || [];
            for (var lo = 0; lo < oR.length; lo++) noteCategory(oR[lo].type || oR[lo].displayType || '');
        }
        if (cats.length > 0) {
            var legend2 = document.createElement('div');
            legend2.className = 'legend';
            var html = '';
            for (var lc = 0; lc < cats.length; lc++) {
                html += '<div class="legend-item">' + legendShapeSvg(cats[lc].shape, cats[lc].bg, cats[lc].border) + cats[lc].name + '</div>';
            }
            legend2.innerHTML = html;
            container.parentNode.insertBefore(legend2, container);
        }
    }

    window.__cyInstances[containerId] = cy;
    return cy;
}

function radiusSetGraphLoading(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div style="padding:20px; max-width:500px; margin:0 auto;">' +
        '<div style="display:flex; align-items:center; gap:10px; margin-bottom:16px;">' +
        '<div class="spinner"></div>' +
        '<span style="font-size:14px; font-weight:600; color:var(--text-color-default, #1f2328);">Generating Application Graph</span>' +
        '</div>' +
        '<div id="progress-steps" style="font-size:13px; color:var(--text-color-muted, #656d76); line-height:2;"></div>' +
        '</div>' +
        '<style>.spinner{width:20px;height:20px;border:3px solid var(--border-color-default,#d0d7de);border-top-color:#0969da;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.step-done::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#1a7f37;margin-right:8px;vertical-align:1px}.step-active::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;border:2px solid #0969da;box-sizing:border-box;margin-right:8px;vertical-align:1px}.step-active{color:var(--text-color-default,#1f2328);font-weight:500}</style>';
}

function radiusSetGraphError(containerId, message) {
    var container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div class="status error">' + message + '</div>';
}

// SPA-style navigation for graph sub-pages (no full page reload)
function radiusNavTo(e, pageId) {
    e.preventDefault();
    var contentEl = document.getElementById('graph-page-content');
    if (!contentEl) { window.location.href = '?page=' + pageId; return; }
    // Fetch the new page HTML
    fetch('/?page=' + pageId)
        .then(function(r) { return r.text(); })
        .then(function(html) {
            // Extract just the graph-page-content div's innerHTML
            var parser = new DOMParser();
            var doc = parser.parseFromString(html, 'text/html');
            var newContent = doc.getElementById('graph-page-content');
            var newNav = doc.getElementById('graph-nav');
            if (newContent) {
                contentEl.innerHTML = newContent.innerHTML;
                // Execute scripts in the new content
                var scripts = contentEl.querySelectorAll('script');
                scripts.forEach(function(oldScript) {
                    var newScript = document.createElement('script');
                    if (oldScript.src) {
                        newScript.src = oldScript.src;
                    } else {
                        newScript.textContent = oldScript.textContent;
                    }
                    oldScript.parentNode.replaceChild(newScript, oldScript);
                });
            }
            // Update nav active state
            if (newNav) {
                document.getElementById('graph-nav').innerHTML = newNav.innerHTML;
            }
            // Update URL without reload
            history.pushState(null, '', '?page=' + pageId);
        })
        .catch(function() { window.location.href = '?page=' + pageId; });
}
// Handle back/forward browser buttons
window.addEventListener('popstate', function() {
    var params = new URLSearchParams(window.location.search);
    var page = params.get('page') || 'graph';
    if (['graph', 'planned', 'graph-diff', 'deployed'].indexOf(page) !== -1) {
        radiusNavTo({preventDefault: function(){}}, page);
    }
});
`;

export const CLIENT_HEARTBEAT_JS = `
// ─── Client Heartbeat / Auto-reconnect ───────────────────────────────────────
// Each canvas instance is backed by a local HTTP server that may be suspended or
// killed after the extension goes idle. Ping it periodically; if it stops
// responding, show a reconnecting overlay and, once the server is back (it now
// rebinds the same stable port), reload once to restore a live page.
(function() {
  var overlay = document.getElementById('radius-reconnect-overlay');
  var down = false;
  var misses = 0;
  function ping() {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, 4000) : null;
    fetch('/api/ping', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function(r) {
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('bad status');
        if (down) {
          // Server is back after an outage — reload to get fresh state.
          window.location.reload();
          return;
        }
        misses = 0;
      })
      .catch(function() {
        if (timer) clearTimeout(timer);
        misses++;
        // Require two consecutive misses before declaring an outage to avoid
        // flapping on a single slow/dropped request.
        if (misses >= 2 && !down) {
          down = true;
          if (overlay) overlay.style.display = 'flex';
        }
      });
  }
  setInterval(ping, 5000);
  // Also probe immediately when the tab/panel regains focus after idle.
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') ping();
  });
  window.addEventListener('focus', ping);
})();
`;
