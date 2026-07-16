// @ts-nocheck — verbatim-moved orchestration from the canvas monolith.
// Reaches the outside world only through the injected GitHub port; full
// strict-mode typing is deferred to a follow-up (see design doc Goal 5).
// Repository modeling that needs GitHub access — fetch the skill-generated
// app.bicep and discover source-code references for graph nodes. Pure product
// logic that reaches GitHub only through the injected {@link GitHub} port; the
// canvas adapter supplies the concrete `gh`-CLI implementation. app.bicep
// generation is owned by the radius-app-bicep skill, not this module.

import type { GitHub } from "../ports/index.js";

export async function discoverSourceCodeRefs(gh, resources, tree, repo, branch) {
    const fetchFileFromRepo = (r, p, br = "main") => gh.getContent(`/repos/${r}/contents/${p}?ref=${br}`);
    if (!tree || tree.length === 0) return resources;

    // Source code patterns per resource category
    const SOURCE_PATTERNS = {
        mysql: {
            filePatterns: [
                /^(.*\/)?(db|database|persistence|connection|datastore|mysql)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(.*\/)?(db|database|persistence|connection|mysql)\.(js|ts|mjs|py|go|java)$/i,
                /^(.*\/)?config\/(.*\/)?(database|db)\.(js|ts|mjs|py|yml|yaml|json)$/i,
                /^(.*\/)?models?\/(index|db)\.(js|ts|mjs|py)$/i,
                /^(.*\/)?prisma\/schema\.prisma$/i,
                /^(.*\/)?knexfile\.(js|ts|mjs)$/i,
            ],
            contentPatterns: ['createConnection', 'createPool', 'mysql.connect', 'new MySQL', 'mysql2']
        },
        postgres: {
            filePatterns: [
                /^(.*\/)?(db|database|persistence|connection|datastore|postgres|pg)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(.*\/)?(db|database|persistence|connection|pg)\.(js|ts|mjs|py|go|java)$/i,
                /^(.*\/)?config\/(.*\/)?(database|db)\.(js|ts|mjs|py|yml|yaml|json)$/i,
                /^(.*\/)?prisma\/schema\.prisma$/i,
                /^(.*\/)?knexfile\.(js|ts|mjs)$/i,
            ],
            contentPatterns: ['new Pool', 'pg.connect', 'createClient', 'psycopg', 'sqlalchemy']
        },
        redis: {
            filePatterns: [
                /^(.*\/)?(redis|cache|session)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(.*\/)?(redis|cache|session)\.(js|ts|mjs|py|go|java)$/i,
                /^(.*\/)?config\/(.*\/)?(redis|cache)\.(js|ts|mjs|py|yml|yaml|json)$/i,
            ],
            contentPatterns: ['createClient', 'Redis(', 'new Redis', 'redis.connect', 'ioredis']
        },
        mongo: {
            filePatterns: [
                /^(.*\/)?(db|database|mongo|mongoose)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(.*\/)?(db|database|mongo|mongoose)\.(js|ts|mjs|py|go|java)$/i,
                /^(.*\/)?models?\/(index|db)\.(js|ts|mjs|py)$/i,
            ],
            contentPatterns: ['mongoose.connect', 'MongoClient', 'mongo.connect', 'new Mongo']
        },
        rabbitmq: {
            filePatterns: [
                /^(.*\/)?(queue|messaging|rabbitmq|amqp|broker|events?)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(.*\/)?(queue|messaging|rabbitmq|amqp|broker)\.(js|ts|mjs|py|go|java)$/i,
            ],
            contentPatterns: ['amqp.connect', 'createChannel', 'RabbitMQ', 'pika.']
        },
        neo4j: {
            filePatterns: [
                /^(.*\/)?(db|database|neo4j|graph)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(.*\/)?(db|database|neo4j|graph)\.(js|ts|mjs|py|go|java)$/i,
            ],
            contentPatterns: ['neo4j.driver', 'GraphDatabase', 'new Driver']
        },
        container: {
            filePatterns: [
                /^(.*\/)?Dockerfile$/i,
                /^(.*\/)?(server|app|main|index)\.(js|ts|mjs|py|go|java|rb)$/i,
                /^(.*\/)?src\/(server|app|main|index)\.(js|ts|mjs|py|go|java)$/i,
            ],
            contentPatterns: ['listen(', 'createServer', 'app.listen', 'http.ListenAndServe', 'Flask(']
        },
        secret: {
            filePatterns: [
                /^(.*\/)?(secrets?|credentials?|auth|env)\.(js|ts|mjs|py|go|java|rb|yml|yaml)$/i,
                /^(.*\/)?config\/(.*\/)?(secrets?|credentials?)\.(js|ts|mjs|py|yml|yaml|json)$/i,
                /^\.env(\.example|\.sample)?$/i,
            ],
            contentPatterns: ['getSecret', 'SECRET_', 'process.env', 'os.environ']
        }
    };

    // Map resource types to categories
    function typeToCategory(type) {
        const lower = (type || '').toLowerCase();
        if (lower.includes('mysql')) return 'mysql';
        if (lower.includes('postgre') || lower.includes('pgsql')) return 'postgres';
        if (lower.includes('redis') || lower.includes('cache')) return 'redis';
        if (lower.includes('mongo')) return 'mongo';
        if (lower.includes('rabbit') || lower.includes('queue') || lower.includes('messaging')) return 'rabbitmq';
        if (lower.includes('neo4j')) return 'neo4j';
        if (lower.includes('secret')) return 'secret';
        if (lower.includes('container') || lower.includes('compute')) return 'container';
        return null;
    }

    // Bounded cache of fetched file contents so we don't re-download or hammer
    // the API while pinpointing initialization lines / scanning for patterns.
    const contentCache = new Map();
    let fetchBudget = 25;
    async function getContent(path) {
        if (contentCache.has(path)) return contentCache.get(path);
        if (fetchBudget <= 0) return null;
        fetchBudget--;
        let text = null;
        try { text = await fetchFileFromRepo(repo, path, branch); } catch { text = null; }
        contentCache.set(path, text);
        return text;
    }

    // Find the 1-based line number where the resource is most likely initialized
    // by locating the first occurrence of any content pattern (case-insensitive).
    function findInitLine(text, contentPatterns) {
        if (!text || !contentPatterns || contentPatterns.length === 0) return 0;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const lower = lines[i].toLowerCase();
            for (const pat of contentPatterns) {
                if (lower.includes(pat.toLowerCase())) return i + 1;
            }
        }
        return 0;
    }

    const SOURCE_EXT = /\.(js|ts|mjs|cjs|jsx|tsx|py|go|java|rb)$/i;
    const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|\.git|test|tests|__tests__|spec|specs|__mocks__|e2e|cypress|fixtures)\//i;
    // Test/spec/mock files frequently reference env vars and connection helpers,
    // but they are never the resource's real initialization site — exclude them.
    const SKIP_FILE = /\.(spec|test|stories|mock|d)\.[a-z]+$/i;

    for (const r of resources) {
        if (r.codeReference) continue; // already has a source link
        const category = typeToCategory(r.type);
        if (!category || !SOURCE_PATTERNS[category]) continue;

        const patterns = SOURCE_PATTERNS[category];
        // Find best matching file from tree (never a test/spec/mock file).
        let bestMatch = '';
        for (const pattern of patterns.filePatterns) {
            const match = tree.find(p => pattern.test(p) && !SKIP_FILE.test(p) && !SKIP_DIR.test(p));
            if (match) { bestMatch = match; break; }
        }

        // For containers, prefer Dockerfile in same dir as service name
        if (category === 'container' && r.name) {
            const svcDockerfile = tree.find(p =>
                p.toLowerCase().includes(r.name.toLowerCase()) && /Dockerfile$/i.test(p)
            );
            if (svcDockerfile) bestMatch = svcDockerfile;
        }

        // Content-based fallback: when no filename matched, scan a bounded set of
        // source files for the initialization pattern so the code link still
        // points at where the resource type is actually created. Barrel/re-export
        // files (index.*) are scanned last so links prefer the real usage site.
        if (!bestMatch && patterns.contentPatterns && patterns.contentPatterns.length) {
            const isBarrel = (p) => /(^|\/)index\.(js|ts|mjs|cjs|py)$/i.test(p);
            const candidates = tree
                .filter(p => SOURCE_EXT.test(p) && !SKIP_DIR.test(p) && !SKIP_FILE.test(p))
                .sort((a, b) => (isBarrel(a) ? 1 : 0) - (isBarrel(b) ? 1 : 0))
                .slice(0, 40);
            for (const path of candidates) {
                const text = await getContent(path);
                const line = findInitLine(text, patterns.contentPatterns);
                if (line) { bestMatch = path + '#L' + line; break; }
            }
        }

        if (bestMatch) {
            // If we matched by filename (no line yet), try to pinpoint the
            // initialization line within that file for a more precise link.
            if (!bestMatch.includes('#L') && patterns.contentPatterns && patterns.contentPatterns.length) {
                const text = await getContent(bestMatch);
                const line = findInitLine(text, patterns.contentPatterns);
                if (line) bestMatch = bestMatch + '#L' + line;
            }
            r.codeReference = bestMatch;
        }
    }
    return resources;
}

export async function fetchBicepFromRepo(gh, repo, branch = 'main') {
    const ghApiGetContent = (p) => gh.getContent(p);
    // Try .radius/app.bicep first (standard Radius location), then app.bicep at root.
    const radiusPath = await ghApiGetContent(`/repos/${repo}/contents/.radius/app.bicep?ref=${branch}`);
    if (radiusPath) return radiusPath;
    return ghApiGetContent(`/repos/${repo}/contents/app.bicep?ref=${branch}`);
}
