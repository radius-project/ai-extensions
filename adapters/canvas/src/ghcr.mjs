import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BOOTSTRAP_TAG = "bootstrap";
export const BOOTSTRAP_ARTIFACT_TYPE = "application/vnd.radius.statearchive.bootstrap.v1";
export const BOOTSTRAP_CONTENT = "Harmless bootstrap for private Repo Radius state package.";

const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_IMAGE_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const OCI_EMPTY_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const PACKAGE_AUTH_GUIDANCE =
    "Refresh the stored GitHub CLI credential with: gh auth refresh -s read:packages -s write:packages";

// Artifact type the producer's publish-deploy-status action stamps on the
// deployed graph/status OCI artifact (radius-project/radius PR #12591).
export const DEPLOY_STATUS_ARTIFACT_TYPE = "application/vnd.radius.deploy-status.v1+json";

async function defaultRunKeyringCommand(args) {
    const { runGhKeyringCommand } = await import("./gh.mjs");
    return runGhKeyringCommand(args);
}

function sha256(bytes) {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function descriptor(mediaType, bytes, annotations) {
    return {
        mediaType,
        digest: sha256(bytes),
        size: bytes.byteLength,
        ...(annotations ? { annotations } : {}),
    };
}

function parseRegistry(registry, registryOrigin) {
    if (!registry || registry.includes("://") || registry.includes("@")) {
        throw new Error(`Invalid GHCR state repository "${registry}".`);
    }
    const parsed = new URL(`https://${registry}`);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname.toLowerCase() !== "ghcr.io" || parsed.port || segments.length < 2) {
        throw new Error(`State repository "${registry}" must be an untagged ghcr.io/owner/package path.`);
    }
    if (segments.some((segment) => segment.includes(":"))) {
        throw new Error(`State repository "${registry}" must not include an OCI tag.`);
    }
    return {
        owner: segments[0],
        packageName: segments.slice(1).join("/"),
        repositoryPath: segments.join("/"),
        registryOrigin: (registryOrigin || "https://ghcr.io").replace(/\/+$/, ""),
    };
}

async function responseDetail(response) {
    const text = (await response.text().catch(() => "")).trim();
    return text ? `: ${text.slice(0, 1000)}` : "";
}

function packageAuthError(message) {
    const error = new Error(`${message}. ${PACKAGE_AUTH_GUIDANCE}`);
    // Tag so callers can distinguish a permission problem from a transient/HTTP
    // failure and surface auth-specific guidance.
    error.code = "GHCR_AUTH";
    return error;
}

function parseBearerChallenge(header) {
    if (!header || !/^Bearer\s+/i.test(header)) {
        throw new Error("GHCR did not return a Bearer authentication challenge.");
    }
    const params = {};
    const expression = /([a-zA-Z]+)="([^"]*)"/g;
    let match;
    while ((match = expression.exec(header)) !== null) {
        params[match[1].toLowerCase()] = match[2];
    }
    if (!params.realm) {
        throw new Error("GHCR authentication challenge did not include a token realm.");
    }
    return params;
}

async function getRegistryBearerToken({ fetchImpl, registryOrigin, repositoryPath, username, token, scope = "pull,push" }) {
    const challengeResponse = await fetchImpl(`${registryOrigin}/v2/`, {
        headers: { Accept: "application/json" },
        redirect: "error",
    });
    if (challengeResponse.status !== 401) {
        throw new Error(`GHCR authentication probe returned HTTP ${challengeResponse.status}.`);
    }

    const challenge = parseBearerChallenge(challengeResponse.headers.get("www-authenticate"));
    const tokenUrl = new URL(challenge.realm);
    if (tokenUrl.origin !== registryOrigin) {
        throw new Error("GHCR authentication challenge pointed to an unexpected origin.");
    }
    tokenUrl.searchParams.set("service", challenge.service || "ghcr.io");
    tokenUrl.searchParams.set("scope", `repository:${repositoryPath}:${scope}`);

    const response = await fetchImpl(tokenUrl, {
        headers: {
            Accept: "application/json",
            Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
        },
        redirect: "error",
    });
    if (response.status === 401 || response.status === 403) {
        throw packageAuthError(`GHCR rejected package access for ${repositoryPath}`);
    }
    if (!response.ok) {
        throw new Error(`Failed to obtain a GHCR upload token (HTTP ${response.status})${await responseDetail(response)}`);
    }
    const body = await response.json();
    const bearerToken = body.token || body.access_token;
    if (!bearerToken) {
        throw new Error("GHCR token response did not include an access token.");
    }
    return bearerToken;
}

function registryPath(repositoryPath) {
    return repositoryPath.split("/").map(encodeURIComponent).join("/");
}

async function registryFetch(fetchImpl, registryOrigin, bearerToken, path, options = {}) {
    return fetchImpl(`${registryOrigin}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            ...(options.headers || {}),
        },
        redirect: "error",
    });
}

async function pushBlob({ fetchImpl, registryOrigin, repositoryPath, bearerToken, bytes, digest }) {
    const encodedPath = registryPath(repositoryPath);
    const blobPath = `/v2/${encodedPath}/blobs/${digest}`;
    const existing = await registryFetch(fetchImpl, registryOrigin, bearerToken, blobPath, { method: "HEAD" });
    if (existing.ok) return;
    if (existing.status !== 404) {
        throw new Error(`Failed to check GHCR blob ${digest} (HTTP ${existing.status})${await responseDetail(existing)}`);
    }

    const start = await registryFetch(
        fetchImpl,
        registryOrigin,
        bearerToken,
        `/v2/${encodedPath}/blobs/uploads/`,
        { method: "POST" },
    );
    if (start.status !== 202) {
        throw new Error(`Failed to start GHCR blob upload (HTTP ${start.status})${await responseDetail(start)}`);
    }
    const location = start.headers.get("location");
    if (!location) {
        throw new Error("GHCR blob upload response did not include a location.");
    }
    const uploadUrl = new URL(location, registryOrigin);
    if (uploadUrl.origin !== registryOrigin) {
        throw new Error("GHCR blob upload location pointed to an unexpected origin.");
    }
    uploadUrl.searchParams.set("digest", digest);

    const upload = await fetchImpl(uploadUrl, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${bearerToken}`,
            "Content-Type": "application/octet-stream",
        },
        body: bytes,
        redirect: "error",
    });
    if (upload.status !== 201) {
        throw new Error(`Failed to upload GHCR blob ${digest} (HTTP ${upload.status})${await responseDetail(upload)}`);
    }
}

async function pushBootstrapManifest({
    fetchImpl,
    registryOrigin,
    repositoryPath,
    bearerToken,
    targetRepository,
}) {
    const configBytes = Buffer.from("{}");
    const layerBytes = Buffer.from(BOOTSTRAP_CONTENT);
    const config = descriptor(OCI_EMPTY_CONFIG_MEDIA_TYPE, configBytes);
    const layer = descriptor("text/plain", layerBytes, {
        "org.opencontainers.image.title": "bootstrap.txt",
    });
    const manifest = {
        schemaVersion: 2,
        mediaType: OCI_MANIFEST_MEDIA_TYPE,
        artifactType: BOOTSTRAP_ARTIFACT_TYPE,
        config,
        layers: [layer],
        annotations: {
            "org.opencontainers.image.source": `https://github.com/${targetRepository}`,
        },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));

    await pushBlob({
        fetchImpl,
        registryOrigin,
        repositoryPath,
        bearerToken,
        bytes: configBytes,
        digest: config.digest,
    });
    await pushBlob({
        fetchImpl,
        registryOrigin,
        repositoryPath,
        bearerToken,
        bytes: layerBytes,
        digest: layer.digest,
    });

    const response = await registryFetch(
        fetchImpl,
        registryOrigin,
        bearerToken,
        `/v2/${registryPath(repositoryPath)}/manifests/${BOOTSTRAP_TAG}`,
        {
            method: "PUT",
            headers: { "Content-Type": OCI_MANIFEST_MEDIA_TYPE },
            body: manifestBytes,
        },
    );
    if (response.status !== 201 && response.status !== 202) {
        throw new Error(`Failed to push the GHCR bootstrap manifest (HTTP ${response.status})${await responseDetail(response)}`);
    }
}

async function githubJson(fetchImpl, url, token, allowNotFound = false) {
    const response = await fetchImpl(url, {
        headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
    });
    if (allowNotFound && response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
        throw packageAuthError(`GitHub Packages API rejected access (HTTP ${response.status})`);
    }
    if (!response.ok) {
        throw new Error(`GitHub API request failed (HTTP ${response.status})${await responseDetail(response)}`);
    }
    return response.json();
}

async function packageEndpoint({ fetchImpl, apiBaseUrl, owner, packageName, token }) {
    const ownerMetadata = await githubJson(
        fetchImpl,
        `${apiBaseUrl}/users/${encodeURIComponent(owner)}`,
        token,
    );
    const scope = ownerMetadata.type === "Organization" ? "orgs" : ownerMetadata.type === "User" ? "users" : null;
    if (!scope) {
        throw new Error(`Unsupported GitHub account type "${ownerMetadata.type}" for GHCR owner "${owner}".`);
    }
    return `${apiBaseUrl}/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}`;
}

function validatePackage(metadata, targetRepository, allowMissingLink = false) {
    if (metadata.visibility !== "private" && metadata.visibility !== "internal") {
        throw new Error(
            `GHCR state package must be private or internal; current visibility is "${metadata.visibility || "unknown"}".`,
        );
    }
    const linkedRepository = metadata.repository?.full_name || "";
    if (!linkedRepository && allowMissingLink) return false;
    if (linkedRepository.toLowerCase() !== targetRepository.toLowerCase()) {
        throw new Error(
            linkedRepository
                ? `GHCR state package is linked to "${linkedRepository}", not "${targetRepository}".`
                : `GHCR state package is not linked to "${targetRepository}".`,
        );
    }
    return true;
}

export async function loadGhKeyringCredentials({
    runKeyringCommand = defaultRunKeyringCommand,
} = {}) {
    try {
        const [token, username] = await Promise.all([
            runKeyringCommand(["auth", "token", "--hostname", "github.com"]),
            runKeyringCommand(["api", "--hostname", "github.com", "user", "--jq", ".login"]),
        ]);
        if (!token || !username) throw new Error("empty credential");
        return { token, username };
    } catch {
        throw new Error(
            `A stored GitHub CLI login with package access is required. ${PACKAGE_AUTH_GUIDANCE}`,
        );
    }
}

/**
 * withGhcrDockerConfig - run `fn(env)` with a throwaway DOCKER_CONFIG directory
 * authenticated to ghcr.io from the stored GitHub CLI credential, then delete
 * it. `rad bicep publish` shells out to ORAS, which reads registry credentials
 * from a docker `config.json`; this hands it GHCR auth without a user
 * `docker login`. The temp config holds the credential and is removed in
 * `finally`, so the token never persists on disk beyond the publish call.
 */
export async function withGhcrDockerConfig(fn, { loadCredentials = loadGhKeyringCredentials } = {}) {
    const { token, username } = await loadCredentials();
    const dir = mkdtempSync(path.join(os.tmpdir(), "radius-ghcr-"));
    try {
        const auth = Buffer.from(`${username}:${token}`).toString("base64");
        writeFileSync(
            path.join(dir, "config.json"),
            JSON.stringify({ auths: { "ghcr.io": { auth } } }),
            { mode: 0o600 },
        );
        return await fn({ DOCKER_CONFIG: dir });
    } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

export async function bootstrapGHCRStatePackage({
    targetRepository,
    registry,
    credentials,
    fetchImpl = globalThis.fetch,
    registryOrigin,
    apiBaseUrl = "https://api.github.com",
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    metadataAttempts = 6,
}) {
    if (typeof fetchImpl !== "function") {
        throw new Error("This Node.js runtime does not provide fetch.");
    }
    const parsed = parseRegistry(registry, registryOrigin);
    const auth = credentials || await loadGhKeyringCredentials();
    const endpoint = await packageEndpoint({
        fetchImpl,
        apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
        owner: parsed.owner,
        packageName: parsed.packageName,
        token: auth.token,
    });

    const existing = await githubJson(fetchImpl, endpoint, auth.token, true);
    if (existing) validatePackage(existing, targetRepository, true);

    const bearerToken = await getRegistryBearerToken({
        fetchImpl,
        registryOrigin: parsed.registryOrigin,
        repositoryPath: parsed.repositoryPath,
        username: auth.username,
        token: auth.token,
    });
    await pushBootstrapManifest({
        fetchImpl,
        registryOrigin: parsed.registryOrigin,
        repositoryPath: parsed.repositoryPath,
        bearerToken,
        targetRepository,
    });

    let metadata = null;
    for (let attempt = 0; attempt < metadataAttempts; attempt++) {
        metadata = await githubJson(fetchImpl, endpoint, auth.token, true);
        // validatePackage fails fast on public visibility and on a wrong repository
        // link; a not-yet-propagated (missing) link returns false so we keep retrying.
        if (metadata && validatePackage(metadata, targetRepository, true)) {
            return { registry, bootstrapTag: BOOTSTRAP_TAG, visibility: metadata.visibility };
        }
        if (attempt + 1 < metadataAttempts) {
            await sleep(Math.min(500 * 2 ** attempt, 4000));
        }
    }

    if (!metadata) {
        throw new Error(`GHCR state package "${registry}" was not visible through the GitHub Packages API after bootstrap.`);
    }
    validatePackage(metadata, targetRepository);
}

/**
 * pullOciArtifactFiles - pull a single-manifest OCI artifact from an untagged
 * GHCR repository and return its layer blobs keyed by their
 * `org.opencontainers.image.title` annotation (the file name ORAS records when
 * it pushes each file). This is the read-side counterpart to the producer's
 * `oras push` in the publish-deploy-status action.
 *
 * Resolves `null` when the tag does not exist (HTTP 404 on the manifest) so the
 * caller can fall back to an older source. Throws a `GHCR_AUTH`-coded error on
 * 401/403 so the caller can surface package-permission guidance distinctly from
 * a missing artifact.
 */
export async function pullOciArtifactFiles({
    registry,
    tag,
    credentials,
    loadCredentials = loadGhKeyringCredentials,
    fetchImpl = globalThis.fetch,
    registryOrigin,
}) {
    if (typeof fetchImpl !== "function") {
        throw new Error("This Node.js runtime does not provide fetch.");
    }
    if (!tag) {
        throw new Error("An OCI tag is required to pull a GHCR artifact.");
    }
    const parsed = parseRegistry(registry, registryOrigin);
    const auth = credentials || await loadCredentials();
    const bearerToken = await getRegistryBearerToken({
        fetchImpl,
        registryOrigin: parsed.registryOrigin,
        repositoryPath: parsed.repositoryPath,
        username: auth.username,
        token: auth.token,
        // Read-only pull; consumers may only hold read:packages.
        scope: "pull",
    });

    const encodedPath = registryPath(parsed.repositoryPath);

    // fetchManifest - GET a manifest/index by reference (tag or digest). Returns
    // { manifest } on success, or null on 404 (so a missing tag is a clean
    // fallback signal rather than an error).
    async function fetchManifest(reference) {
        const response = await registryFetch(
            fetchImpl,
            parsed.registryOrigin,
            bearerToken,
            `/v2/${encodedPath}/manifests/${reference}`,
            {
                headers: { Accept: `${OCI_MANIFEST_MEDIA_TYPE}, ${OCI_IMAGE_INDEX_MEDIA_TYPE}` },
            },
        );
        if (response.status === 404) return null;
        if (response.status === 401 || response.status === 403) {
            throw packageAuthError(`GHCR rejected package access for ${parsed.repositoryPath}`);
        }
        if (!response.ok) {
            throw new Error(`Failed to read GHCR manifest "${reference}" (HTTP ${response.status})${await responseDetail(response)}`);
        }
        return response.json();
    }

    let manifest = await fetchManifest(encodeURIComponent(tag));
    if (!manifest) return null;

    // GHCR may answer with an image index (fat manifest) rather than the artifact
    // manifest directly. Follow the first non-attestation child descriptor to the
    // concrete manifest that actually carries the layers.
    if (manifest.mediaType === OCI_IMAGE_INDEX_MEDIA_TYPE || Array.isArray(manifest.manifests)) {
        const children = Array.isArray(manifest.manifests) ? manifest.manifests : [];
        // Skip referrers/attestation entries (they annotate a subject digest).
        const child = children.find((entry) => entry?.digest && !entry?.annotations?.["vnd.docker.reference.type"])
            || children.find((entry) => entry?.digest);
        if (!child) {
            return { files: {}, manifest, artifactType: manifest.artifactType || "" };
        }
        manifest = await fetchManifest(child.digest);
        if (!manifest) return null;
    }

    const layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    const files = {};
    for (const layer of layers) {
        const title = layer?.annotations?.["org.opencontainers.image.title"];
        if (!title || !layer.digest) continue;
        // Blob GETs are commonly answered with a 307 to a pre-signed storage URL;
        // follow it (fetch strips Authorization on the cross-origin hop per spec,
        // and the redirect target is already signed).
        const blobResponse = await fetchImpl(
            `${parsed.registryOrigin}/v2/${encodedPath}/blobs/${layer.digest}`,
            { headers: { Authorization: `Bearer ${bearerToken}` }, redirect: "follow" },
        );
        if (blobResponse.status === 401 || blobResponse.status === 403) {
            throw packageAuthError(`GHCR rejected blob access for ${parsed.repositoryPath}`);
        }
        if (!blobResponse.ok) {
            throw new Error(`Failed to read GHCR blob ${layer.digest} (HTTP ${blobResponse.status})${await responseDetail(blobResponse)}`);
        }
        files[title] = Buffer.from(await blobResponse.arrayBuffer()).toString("utf8");
    }

    return { files, manifest, artifactType: manifest.artifactType || "" };
}
