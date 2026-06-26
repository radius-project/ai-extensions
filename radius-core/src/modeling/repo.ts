// @ts-nocheck — verbatim-moved orchestration from the canvas monolith.
// Reaches the outside world only through the injected GitHub port; full
// strict-mode typing is deferred to a follow-up (see design doc Goal 5).
// Repository modeling that needs GitHub access — generate app.bicep from a
// repo's structure and discover source-code references for graph nodes. Pure
// product logic that reaches GitHub only through the injected {@link GitHub}
// port; the canvas adapter supplies the concrete `gh`-CLI implementation.

import type { GitHub } from "../ports/index.js";
import { parseComposeServices } from "./compose.js";

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

export async function generateBicepFromRepo(gh, repo, branch = 'main') {
    const fetchRepoTree = (r, br = "main") => gh.treePaths(r, br);
    const fetchFileFromRepo = (r, p, br = "main") => gh.getContent(`/repos/${r}/contents/${p}?ref=${br}`);
    // Step 1: Fetch repo tree to find key files
    const tree = await fetchRepoTree(repo, branch);
    if (!tree || tree.length === 0) return null;

    // Find key files
    const dockerfiles = tree.filter(p => /^(.*\/)?Dockerfile$/i.test(p));
    const composeFiles = tree.filter(p => /^(.*\/)?(docker-)?compose\.(ya?ml)$/i.test(p));
    const packageJsons = tree.filter(p => /^(.*\/)?package\.json$/i.test(p) && !p.includes('node_modules'));
    const requirementsTxts = tree.filter(p => /^(.*\/)?requirements\.txt$/i.test(p));
    const goMods = tree.filter(p => /^(.*\/)?go\.mod$/i.test(p));

    // Step 2: Fetch compose file and root package.json
    const [composeContent, rootPkgJson] = await Promise.all([
        composeFiles.length > 0 ? fetchFileFromRepo(repo, composeFiles[0], branch) : Promise.resolve(null),
        packageJsons.find(p => !p.includes('/')) ? fetchFileFromRepo(repo, packageJsons.find(p => !p.includes('/')), branch) : Promise.resolve(null),
    ]);

    const appName = repo.split('/').pop() || 'app';
    const shortName = appName.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/-/g, '');
    const appSymName = `${shortName}App`;

    // Step 3: Parse services from compose file or Dockerfiles
    let services = [];
    let dbType = null;
    let dbVersion = null;
    let dbName = null;
    let hasRedis = false;
    let hasRabbitMQ = false;
    let hasMongo = false;

    if (composeContent) {
        // Simple YAML parser for compose services
        services = parseComposeServices(composeContent);
        // Detect database and infrastructure services
        for (const svc of services) {
            if (/mysql|mariadb/i.test(svc.image || svc.name)) {
                dbType = 'mysql';
                const verMatch = (svc.image || '').match(/:(\d+\.?\d*)/);
                if (verMatch) dbVersion = verMatch[1];
                const dbNameMatch = composeContent.match(/MYSQL_DATABASE[=: ]+['"]?(\w+)/i);
                if (dbNameMatch) dbName = dbNameMatch[1];
            } else if (/postgres/i.test(svc.image || svc.name)) {
                dbType = dbType || 'postgres';
                const verMatch = (svc.image || '').match(/:(\d+\.?\d*)/);
                if (verMatch) dbVersion = verMatch[1];
                const dbNameMatch = composeContent.match(/POSTGRES_DB[=: ]+['"]?(\w+)/i);
                if (dbNameMatch) dbName = dbNameMatch[1];
            } else if (/neo4j/i.test(svc.image || svc.name)) {
                dbType = dbType || 'neo4j';
            } else if (/redis|valkey/i.test(svc.image || svc.name)) {
                hasRedis = true;
            } else if (/rabbitmq|amqp/i.test(svc.image || svc.name)) {
                hasRabbitMQ = true;
            } else if (/mongo/i.test(svc.image || svc.name)) {
                hasMongo = true;
            }
        }
        // Filter out database/infra services from container list
        services = services.filter(svc => {
            const name = (svc.name || '').toLowerCase();
            const img = (svc.image || '').toLowerCase();
            return !/^(mysql|mariadb|postgres|redis|valkey|mongo|neo4j|rabbitmq|kafka|zookeeper|elasticsearch|memcached)/i.test(img) &&
                   !/^(database|db|redis|cache|queue|broker|rabbitmq|mongo|mongodb)$/i.test(name);
        });
    } else if (dockerfiles.length > 0) {
        // No compose — infer services from Dockerfile locations
        for (const df of dockerfiles) {
            const dir = df.includes('/') ? df.split('/').slice(0, -1).join('/') : '';
            const svcName = dir || appName;
            services.push({ name: svcName, port: 3000, hasDockerfile: true });
        }
    }

    // If no services detected at all, create a single-service app
    if (services.length === 0) {
        services.push({ name: appName, port: 3000, hasDockerfile: dockerfiles.length > 0 });
    }

    // Detect infrastructure from package.json if not found in compose
    if (rootPkgJson) {
        try {
            const pkg = JSON.parse(rootPkgJson);
            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            if (!dbType) {
                if (allDeps.mysql || allDeps.mysql2) dbType = 'mysql';
                else if (allDeps.pg || allDeps.sequelize || allDeps.prisma) dbType = 'postgres';
                else if (allDeps.neo4j || allDeps['neo4j-driver']) dbType = 'neo4j';
            }
            if (!hasRedis && (allDeps.redis || allDeps.ioredis)) hasRedis = true;
            if (!hasRabbitMQ && (allDeps.amqplib || allDeps.amqp || allDeps['@nestjs/microservices'])) hasRabbitMQ = true;
            if (!hasMongo && (allDeps.mongoose || allDeps.mongodb)) hasMongo = true;
        } catch (e) { /* ignore */ }
    }

    // Step 4: Generate bicep
    const hasDockerfile = dockerfiles.length > 0;
    // The single published `radius` bicep extension provides ALL Radius.* namespaces
    // (Compute, Data, Security, Messaging, ...). bicepconfig.json registers only
    // `radius`, so emit just that — the split radiusCompute/radiusData/... aliases
    // are not published extensions and cause BCP204 "Extension not recognized".
    const extensions = ['radius'];

    let bicep = '';

    // Extensions
    for (const ext of extensions) { bicep += `extension ${ext}\n`; }
    bicep += '\n';

    // Params
    bicep += `param environment string\nparam application string\n`;
    if (dbType) { bicep += `@secure()\nparam password string\n`; }
    if (hasDockerfile) { bicep += `@description('The full container image reference to build and push.')\nparam image string\n`; }
    bicep += '\n';

    // Database resource
    if (dbType) {
        const dbTypeName = dbType === 'mysql' ? 'mySqlDatabases' : dbType === 'postgres' ? 'postgreSqlDatabases' : 'neo4jDatabases';
        // Find the source file where the DB connection/init is actually defined.
        // We collect all plausible candidates, then rank them so the link points
        // at the file containing the initialization code — preferring a file named
        // after the DB engine (e.g. mysql.js) over a barrel/re-export file like
        // index.js that merely forwards to it.
        const dbInitPatterns = [
            /^(.*\/)?(db|database|persistence|connection|datastore)\.(js|ts|mjs|cjs|py|go|java|rb)$/i,
            /^(.*\/)?src\/(.*\/)?(db|database|persistence|connection)\.(js|ts|mjs|cjs|py|go|java|rb)$/i,
            /^(.*\/)?config\/(.*\/)?(database|db)\.(js|ts|mjs|cjs|py|yml|yaml|json)$/i,
            /^(.*\/)?models?\/(index|db)\.(js|ts|mjs|cjs|py)$/i,
            /^(.*\/)?prisma\/schema\.prisma$/i,
            /^(.*\/)?knexfile\.(js|ts)$/i,
            /^(.*\/)?sequelize.*\.(js|ts)$/i,
            /^(.*\/)?src\/.*persistence.*\.(js|ts|mjs|cjs|java)$/i,
        ];
        // Match a file whose basename is the DB engine name itself (mysql.js, …).
        const dbEngineRe = new RegExp('(^|/)' + dbType + '\\.(js|ts|mjs|cjs|py|go|java|rb)$', 'i');
        const dbCandidates = [];
        const addCand = (p) => { if (p && !dbCandidates.includes(p)) dbCandidates.push(p); };
        for (const p of tree) { if (dbEngineRe.test(p)) addCand(p); }
        for (const pattern of dbInitPatterns) {
            for (const p of tree) { if (pattern.test(p)) addCand(p); }
        }
        // Rank: engine-named file first, barrel/index files last.
        const dbRank = (p) => {
            const base = (p.split('/').pop() || '').toLowerCase();
            if (dbEngineRe.test(p)) return 0;
            if (/^index\.(js|ts|mjs|cjs|py)$/.test(base)) return 2;
            return 1;
        };
        dbCandidates.sort((a, b) => dbRank(a) - dbRank(b));
        let dbCodeRef = dbCandidates[0] || '';

        // Pinpoint the line where the DB connection is initialized for a precise
        // deep link (mirrors the quality of a hand-authored codeReference).
        const dbInitContentPatterns = {
            mysql: ['createconnection', 'createpool', 'mysql.connect', 'mysql2', 'new mysql'],
            postgres: ['new pool', 'pg.connect', 'new client', 'createclient', 'postgres('],
            neo4j: ['neo4j.driver', 'graphdatabase', 'new driver'],
        }[dbType] || [];
        if (dbCodeRef && !dbCodeRef.includes('#L') && dbInitContentPatterns.length) {
            try {
                const text = await fetchFileFromRepo(repo, dbCodeRef, branch);
                if (text) {
                    const srcLines = text.split('\n');
                    for (let i = 0; i < srcLines.length; i++) {
                        const lower = srcLines[i].toLowerCase();
                        if (dbInitContentPatterns.some(pat => lower.includes(pat))) { dbCodeRef += '#L' + (i + 1); break; }
                    }
                }
            } catch { /* ignore — fall back to file-level link */ }
        }
        // Fall back to compose file if no source init file found
        if (!dbCodeRef && composeFiles.length > 0) dbCodeRef = composeFiles[0];

        bicep += `resource database 'Radius.Data/${dbTypeName}@2025-08-01-preview' = {\n`;
        bicep += `  name: '${dbType}'\n`;
        bicep += `  properties: {\n`;
        bicep += `    environment: environment\n`;
        bicep += `    application: application\n`;
        if (dbCodeRef) bicep += `    codeReference: '${dbCodeRef}'\n`;
        if (dbName) bicep += `    database: '${dbName}'\n`;
        if (dbVersion) bicep += `    version: '${dbVersion}'\n`;
        bicep += `    secretName: dbSecret.name\n`;
        bicep += `  }\n`;
        bicep += `}\n\n`;

        bicep += `resource dbSecret 'Radius.Security/secrets@2025-08-01-preview' = {\n`;
        bicep += `  name: 'dbsecret'\n`;
        bicep += `  properties: {\n`;
        bicep += `    environment: environment\n`;
        bicep += `    application: application\n`;
        bicep += `    data: {\n`;
        bicep += `      USERNAME: {\n`;
        bicep += `        value: '${appName}_user'\n`;
        bicep += `      }\n`;
        bicep += `      PASSWORD: {\n`;
        bicep += `        value: password\n`;
        bicep += `      }\n`;
        bicep += `    }\n`;
        bicep += `  }\n`;
        bicep += `}\n\n`;
    }

    // Redis cache resource
    if (hasRedis) {
        bicep += `resource redisCache 'Radius.Data/redisCaches@2025-08-01-preview' = {\n`;
        bicep += `  name: 'redis'\n`;
        bicep += `  properties: {\n`;
        bicep += `    environment: environment\n`;
        bicep += `    application: application\n`;
        bicep += `  }\n`;
        bicep += `}\n\n`;
    }

    // MongoDB resource
    if (hasMongo) {
        bicep += `resource mongoDb 'Radius.Data/mongoDatabases@2025-08-01-preview' = {\n`;
        bicep += `  name: 'mongo'\n`;
        bicep += `  properties: {\n`;
        bicep += `    environment: environment\n`;
        bicep += `    application: application\n`;
        bicep += `  }\n`;
        bicep += `}\n\n`;
    }

    // RabbitMQ resource
    if (hasRabbitMQ) {
        bicep += `resource rabbitMQ 'Radius.Messaging/rabbitMQQueues@2025-08-01-preview' = {\n`;
        bicep += `  name: 'rabbitmq'\n`;
        bicep += `  properties: {\n`;
        bicep += `    environment: environment\n`;
        bicep += `    application: application\n`;
        bicep += `  }\n`;
        bicep += `}\n\n`;
    }

    // Container resources — one per service
    for (const svc of services) {
        const svcName = svc.name.replace(/[^a-zA-Z0-9-]/g, '-');
        const symName = svcName.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/-/g, '') + 'Container';
        const containerKey = svcName.replace(/-/g, '');
        const port = svc.port || 3000;

        // Determine source code reference for this service
        let codeRef = '';
        if (svc.dockerfilePath) {
            codeRef = svc.dockerfilePath;
        } else if (composeFiles.length > 0) {
            codeRef = composeFiles[0];
        } else if (dockerfiles.length > 0) {
            const dir = svc.name === appName ? '' : svc.name + '/';
            const match = dockerfiles.find(df => df.startsWith(dir));
            codeRef = match || dockerfiles[0];
        }

        bicep += `resource ${symName} 'Radius.Compute/containers@2025-08-01-preview' = {\n`;
        bicep += `  name: '${svcName}'\n`;
        bicep += `  properties: {\n`;
        bicep += `    environment: environment\n`;
        bicep += `    application: application\n`;
        if (codeRef) bicep += `    codeReference: '${codeRef}'\n`;
        bicep += `    containers: {\n`;
        bicep += `      ${containerKey}: {\n`;
        bicep += `        image: '${repo.split('/').pop()}/${svcName}:latest'\n`;
        bicep += `        ports: {\n`;
        bicep += `          http: {\n`;
        bicep += `            containerPort: ${port}\n`;
        bicep += `            protocol: 'TCP'\n`;
        bicep += `          }\n`;
        bicep += `        }\n`;

        // Inject standard environment variables for connected infrastructure so
        // the app can reach each backing service. Values are sourced from the
        // resource's own properties (host/port) and the generated DB secret,
        // mirroring the proven hand-authored app model.
        const envVars = [];
        if (dbType && svc.dependsOnDb) {
            const prefix = dbType === 'postgres' ? 'POSTGRES' : dbType === 'neo4j' ? 'NEO4J' : 'MYSQL';
            envVars.push([`${prefix}_HOST`, `database.properties.host`]);
            envVars.push([`${prefix}_PORT`, `string(database.properties.port)`]);
            envVars.push([`${prefix}_USER`, `'${appName}_user'`]);
            envVars.push([`${prefix}_PASSWORD`, `password`]);
            if (dbName) envVars.push([`${prefix}_DB`, `'${dbName}'`]);
        }
        if (hasRedis) {
            envVars.push([`REDIS_HOST`, `redisCache.properties.host`]);
            envVars.push([`REDIS_PORT`, `string(redisCache.properties.port)`]);
        }
        if (hasMongo) envVars.push([`MONGO_HOST`, `mongoDb.properties.host`]);
        if (hasRabbitMQ) envVars.push([`RABBITMQ_HOST`, `rabbitMQ.properties.host`]);

        if (envVars.length > 0) {
            bicep += `        env: {\n`;
            for (const [name, expr] of envVars) {
                bicep += `          ${name}: {\n`;
                bicep += `            value: ${expr}\n`;
                bicep += `          }\n`;
            }
            bicep += `        }\n`;
        }

        bicep += `      }\n`;
        bicep += `    }\n`;

        // Add connections for detected infrastructure
        const connections = [];
        if (dbType && svc.dependsOnDb) connections.push({ key: `${dbType}db`, ref: 'database' });
        if (hasRedis) connections.push({ key: 'cache', ref: 'redisCache' });
        if (hasMongo) connections.push({ key: 'mongodb', ref: 'mongoDb' });
        if (hasRabbitMQ) connections.push({ key: 'queue', ref: 'rabbitMQ' });

        if (connections.length > 0) {
            bicep += `    connections: {\n`;
            for (const conn of connections) {
                bicep += `      ${conn.key}: {\n`;
                bicep += `        source: ${conn.ref}.id\n`;
                bicep += `      }\n`;
            }
            bicep += `    }\n`;
        }

        bicep += `  }\n`;
        bicep += `}\n\n`;
    }

    return bicep;
}
