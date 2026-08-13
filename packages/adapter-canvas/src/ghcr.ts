import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GhCredentials {
  token: string;
  username: string;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchImplementation = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
    redirect?: "error" | "follow";
  }
) => Promise<HttpResponse>;

interface OciDescriptor {
  mediaType?: string;
  digest: string;
  size?: number;
  annotations?: Record<string, string>;
}

interface GitHubPackageMetadata {
  visibility?: string;
  repository?: { full_name?: string };
}

interface RegistryCoordinates {
  owner: string;
  packageName: string;
  repositoryPath: string;
  registryOrigin: string;
}

interface RegistryTokenOptions extends GhCredentials {
  fetchImpl: FetchImplementation;
  registryOrigin: string;
  repositoryPath: string;
  scope?: string;
}

interface BlobOptions {
  fetchImpl: FetchImplementation;
  registryOrigin: string;
  repositoryPath: string;
  bearerToken: string;
  bytes: Buffer;
  digest: string;
}

interface BootstrapManifestOptions {
  fetchImpl: FetchImplementation;
  registryOrigin: string;
  repositoryPath: string;
  bearerToken: string;
  targetRepository: string;
}

type CredentialLoader = () => Promise<GhCredentials>;
type KeyringCommand = (args: string[]) => Promise<string>;

export interface BootstrapGhcrOptions {
  targetRepository: string;
  registry: string;
  credentials?: GhCredentials;
  fetchImpl?: FetchImplementation;
  registryOrigin?: string;
  apiBaseUrl?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  metadataAttempts?: number;
}

class GhcrAuthError extends Error {
  readonly code = "GHCR_AUTH";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePackageMetadata(value: unknown): GitHubPackageMetadata {
  if (!isRecord(value)) {
    throw new Error("GitHub Packages API returned an invalid response.");
  }
  const repository = isRecord(value.repository) ? value.repository : undefined;
  return {
    visibility:
      typeof value.visibility === "string" ? value.visibility : undefined,
    repository:
      repository && typeof repository.full_name === "string" ?
        { full_name: repository.full_name }
      : undefined
  };
}

export const BOOTSTRAP_TAG = "bootstrap";
export const BOOTSTRAP_ARTIFACT_TYPE =
  "application/vnd.radius.statearchive.bootstrap.v1";
export const BOOTSTRAP_CONTENT =
  "Harmless bootstrap for private Repo Radius state package.";

const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_EMPTY_CONFIG_MEDIA_TYPE = "application/vnd.oci.empty.v1+json";
const PACKAGE_AUTH_GUIDANCE =
  "Refresh the stored GitHub CLI credential with: gh auth refresh -s read:packages -s write:packages";

async function defaultRunKeyringCommand(args: string[]): Promise<string> {
  const { runGhKeyringCommand } = await import("./gh.js");
  const value = await runGhKeyringCommand(args);
  if (typeof value !== "string") {
    throw new Error("GitHub CLI returned an invalid credential response.");
  }
  return value;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function descriptor(
  mediaType: string,
  bytes: Buffer,
  annotations?: Record<string, string>
): OciDescriptor {
  return {
    mediaType,
    digest: sha256(bytes),
    size: bytes.byteLength,
    ...(annotations ? { annotations } : {})
  };
}

function parseRegistry(
  registry: string,
  registryOrigin?: string
): RegistryCoordinates {
  if (!registry || registry.includes("://") || registry.includes("@")) {
    throw new Error(`Invalid GHCR state repository "${registry}".`);
  }
  const parsed = new URL(`https://${registry}`);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (
    parsed.hostname.toLowerCase() !== "ghcr.io" ||
    parsed.port ||
    segments.length < 2
  ) {
    throw new Error(
      `State repository "${registry}" must be an untagged ghcr.io/owner/package path.`
    );
  }
  if (segments.some((segment) => segment.includes(":"))) {
    throw new Error(
      `State repository "${registry}" must not include an OCI tag.`
    );
  }
  return {
    owner: segments[0],
    packageName: segments.slice(1).join("/"),
    repositoryPath: segments.join("/"),
    registryOrigin: (registryOrigin || "https://ghcr.io").replace(/\/+$/, "")
  };
}

async function responseDetail(response: HttpResponse): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  return text ? `: ${text.slice(0, 1000)}` : "";
}

function packageAuthError(message: string): GhcrAuthError {
  return new GhcrAuthError(`${message}. ${PACKAGE_AUTH_GUIDANCE}`);
}

function parseBearerChallenge(
  header: string | null
): Record<string, string> & { realm: string } {
  if (!header || !/^Bearer\s+/i.test(header)) {
    throw new Error("GHCR did not return a Bearer authentication challenge.");
  }
  const params: Record<string, string> = {};
  const expression = /([a-zA-Z]+)="([^"]*)"/g;
  let match;
  while ((match = expression.exec(header)) !== null) {
    params[match[1].toLowerCase()] = match[2];
  }
  if (!params.realm) {
    throw new Error(
      "GHCR authentication challenge did not include a token realm."
    );
  }
  return { ...params, realm: params.realm };
}

async function getRegistryBearerToken({
  fetchImpl,
  registryOrigin,
  repositoryPath,
  username,
  token,
  scope = "pull,push"
}: RegistryTokenOptions): Promise<string> {
  const challengeResponse = await fetchImpl(`${registryOrigin}/v2/`, {
    headers: { Accept: "application/json" },
    redirect: "error"
  });
  if (challengeResponse.status !== 401) {
    throw new Error(
      `GHCR authentication probe returned HTTP ${challengeResponse.status}.`
    );
  }

  const challenge = parseBearerChallenge(
    challengeResponse.headers.get("www-authenticate")
  );
  const tokenUrl = new URL(challenge.realm);
  if (tokenUrl.origin !== registryOrigin) {
    throw new Error(
      "GHCR authentication challenge pointed to an unexpected origin."
    );
  }
  tokenUrl.searchParams.set("service", challenge.service || "ghcr.io");
  tokenUrl.searchParams.set("scope", `repository:${repositoryPath}:${scope}`);

  const response = await fetchImpl(tokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`
    },
    redirect: "error"
  });
  if (response.status === 401 || response.status === 403) {
    throw packageAuthError(
      `GHCR rejected package access for ${repositoryPath}`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to obtain a GHCR upload token (HTTP ${response.status})${await responseDetail(response)}`
    );
  }
  const body = await response.json();
  const tokenBody = isRecord(body) ? body : {};
  const bearerToken =
    typeof tokenBody.token === "string" ? tokenBody.token
    : typeof tokenBody.access_token === "string" ? tokenBody.access_token
    : "";
  if (!bearerToken) {
    throw new Error("GHCR token response did not include an access token.");
  }
  return bearerToken;
}

function registryPath(repositoryPath: string): string {
  return repositoryPath.split("/").map(encodeURIComponent).join("/");
}

async function registryFetch(
  fetchImpl: FetchImplementation,
  registryOrigin: string,
  bearerToken: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  } = {}
): Promise<HttpResponse> {
  return fetchImpl(`${registryOrigin}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...(options.headers || {})
    },
    redirect: "error"
  });
}

async function pushBlob({
  fetchImpl,
  registryOrigin,
  repositoryPath,
  bearerToken,
  bytes,
  digest
}: BlobOptions): Promise<void> {
  const encodedPath = registryPath(repositoryPath);
  const blobPath = `/v2/${encodedPath}/blobs/${digest}`;
  const existing = await registryFetch(
    fetchImpl,
    registryOrigin,
    bearerToken,
    blobPath,
    { method: "HEAD" }
  );
  if (existing.ok) return;
  if (existing.status !== 404) {
    throw new Error(
      `Failed to check GHCR blob ${digest} (HTTP ${existing.status})${await responseDetail(existing)}`
    );
  }

  const start = await registryFetch(
    fetchImpl,
    registryOrigin,
    bearerToken,
    `/v2/${encodedPath}/blobs/uploads/`,
    { method: "POST" }
  );
  if (start.status !== 202) {
    throw new Error(
      `Failed to start GHCR blob upload (HTTP ${start.status})${await responseDetail(start)}`
    );
  }
  const location = start.headers.get("location");
  if (!location) {
    throw new Error("GHCR blob upload response did not include a location.");
  }
  const uploadUrl = new URL(location, registryOrigin);
  if (uploadUrl.origin !== registryOrigin) {
    throw new Error(
      "GHCR blob upload location pointed to an unexpected origin."
    );
  }
  uploadUrl.searchParams.set("digest", digest);

  const upload = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/octet-stream"
    },
    body: bytes,
    redirect: "error"
  });
  if (upload.status !== 201) {
    throw new Error(
      `Failed to upload GHCR blob ${digest} (HTTP ${upload.status})${await responseDetail(upload)}`
    );
  }
}

async function pushBootstrapManifest({
  fetchImpl,
  registryOrigin,
  repositoryPath,
  bearerToken,
  targetRepository
}: BootstrapManifestOptions): Promise<void> {
  const configBytes = Buffer.from("{}");
  const layerBytes = Buffer.from(BOOTSTRAP_CONTENT);
  const config = descriptor(OCI_EMPTY_CONFIG_MEDIA_TYPE, configBytes);
  const layer = descriptor("text/plain", layerBytes, {
    "org.opencontainers.image.title": "bootstrap.txt"
  });
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: BOOTSTRAP_ARTIFACT_TYPE,
    config,
    layers: [layer],
    annotations: {
      "org.opencontainers.image.source": `https://github.com/${targetRepository}`
    }
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));

  await pushBlob({
    fetchImpl,
    registryOrigin,
    repositoryPath,
    bearerToken,
    bytes: configBytes,
    digest: config.digest
  });
  await pushBlob({
    fetchImpl,
    registryOrigin,
    repositoryPath,
    bearerToken,
    bytes: layerBytes,
    digest: layer.digest
  });

  const response = await registryFetch(
    fetchImpl,
    registryOrigin,
    bearerToken,
    `/v2/${registryPath(repositoryPath)}/manifests/${BOOTSTRAP_TAG}`,
    {
      method: "PUT",
      headers: { "Content-Type": OCI_MANIFEST_MEDIA_TYPE },
      body: manifestBytes
    }
  );
  if (response.status !== 201 && response.status !== 202) {
    throw new Error(
      `Failed to push the GHCR bootstrap manifest (HTTP ${response.status})${await responseDetail(response)}`
    );
  }
}

async function githubJson(
  fetchImpl: FetchImplementation,
  url: string,
  token: string,
  allowNotFound = false
): Promise<unknown | null> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10"
    },
    redirect: "error"
  });
  if (allowNotFound && response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw packageAuthError(
      `GitHub Packages API rejected access (HTTP ${response.status})`
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API request failed (HTTP ${response.status})${await responseDetail(response)}`
    );
  }
  return response.json();
}

async function packageEndpoint({
  fetchImpl,
  apiBaseUrl,
  owner,
  packageName,
  token
}: {
  fetchImpl: FetchImplementation;
  apiBaseUrl: string;
  owner: string;
  packageName: string;
  token: string;
}): Promise<string> {
  const ownerMetadata = await githubJson(
    fetchImpl,
    `${apiBaseUrl}/users/${encodeURIComponent(owner)}`,
    token
  );
  const ownerType =
    isRecord(ownerMetadata) && typeof ownerMetadata.type === "string" ?
      ownerMetadata.type
    : "";
  const scope =
    ownerType === "Organization" ? "orgs"
    : ownerType === "User" ? "users"
    : null;
  if (!scope) {
    throw new Error(
      `Unsupported GitHub account type "${ownerType}" for GHCR owner "${owner}".`
    );
  }
  return `${apiBaseUrl}/${scope}/${encodeURIComponent(owner)}/packages/container/${encodeURIComponent(packageName)}`;
}

function validatePackage(
  metadata: GitHubPackageMetadata,
  targetRepository: string,
  allowMissingLink = false
): boolean {
  if (metadata.visibility !== "private" && metadata.visibility !== "internal") {
    throw new Error(
      `GHCR state package must be private or internal; current visibility is "${metadata.visibility || "unknown"}".`
    );
  }
  const linkedRepository = metadata.repository?.full_name || "";
  if (!linkedRepository && allowMissingLink) return false;
  if (linkedRepository.toLowerCase() !== targetRepository.toLowerCase()) {
    throw new Error(
      linkedRepository ?
        `GHCR state package is linked to "${linkedRepository}", not "${targetRepository}".`
      : `GHCR state package is not linked to "${targetRepository}".`
    );
  }
  return true;
}

export async function loadGhKeyringCredentials({
  runKeyringCommand = defaultRunKeyringCommand
}: { runKeyringCommand?: KeyringCommand } = {}): Promise<GhCredentials> {
  try {
    const [token, username] = await Promise.all([
      runKeyringCommand(["auth", "token", "--hostname", "github.com"]),
      runKeyringCommand([
        "api",
        "--hostname",
        "github.com",
        "user",
        "--jq",
        ".login"
      ])
    ]);
    if (!token || !username) throw new Error("empty credential");
    return { token, username };
  } catch {
    throw new Error(
      `A stored GitHub CLI login with package access is required. ${PACKAGE_AUTH_GUIDANCE}`
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
export async function withGhcrDockerConfig(
  fn: (env: { DOCKER_CONFIG: string }) => Promise<unknown>,
  {
    loadCredentials = loadGhKeyringCredentials
  }: {
    loadCredentials?: CredentialLoader;
  } = {}
): Promise<unknown> {
  const { token, username } = await loadCredentials();
  const dir = mkdtempSync(path.join(os.tmpdir(), "radius-ghcr-"));
  try {
    const auth = Buffer.from(`${username}:${token}`).toString("base64");
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ auths: { "ghcr.io": { auth } } }),
      { mode: 0o600 }
    );
    return await fn({ DOCKER_CONFIG: dir });
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export async function bootstrapGHCRStatePackage({
  targetRepository,
  registry,
  credentials,
  fetchImpl = globalThis.fetch,
  registryOrigin,
  apiBaseUrl = "https://api.github.com",
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  metadataAttempts = 6
}: BootstrapGhcrOptions): Promise<{
  registry: string;
  bootstrapTag: string;
  visibility: string | undefined;
}> {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }
  const parsed = parseRegistry(registry, registryOrigin);
  const auth = credentials || (await loadGhKeyringCredentials());
  const endpoint = await packageEndpoint({
    fetchImpl,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    owner: parsed.owner,
    packageName: parsed.packageName,
    token: auth.token
  });

  const existingValue = await githubJson(fetchImpl, endpoint, auth.token, true);
  if (existingValue)
    validatePackage(
      parsePackageMetadata(existingValue),
      targetRepository,
      true
    );

  const bearerToken = await getRegistryBearerToken({
    fetchImpl,
    registryOrigin: parsed.registryOrigin,
    repositoryPath: parsed.repositoryPath,
    username: auth.username,
    token: auth.token
  });
  await pushBootstrapManifest({
    fetchImpl,
    registryOrigin: parsed.registryOrigin,
    repositoryPath: parsed.repositoryPath,
    bearerToken,
    targetRepository
  });

  let metadata: GitHubPackageMetadata | null = null;
  for (let attempt = 0; attempt < metadataAttempts; attempt++) {
    const value = await githubJson(fetchImpl, endpoint, auth.token, true);
    metadata = value ? parsePackageMetadata(value) : null;
    // validatePackage fails fast on public visibility and on a wrong repository
    // link; a not-yet-propagated (missing) link returns false so we keep retrying.
    if (metadata && validatePackage(metadata, targetRepository, true)) {
      return {
        registry,
        bootstrapTag: BOOTSTRAP_TAG,
        visibility: metadata.visibility
      };
    }
    if (attempt + 1 < metadataAttempts) {
      await sleep(Math.min(500 * 2 ** attempt, 4000));
    }
  }

  if (!metadata) {
    throw new Error(
      `GHCR state package "${registry}" was not visible through the GitHub Packages API after bootstrap.`
    );
  }
  validatePackage(metadata, targetRepository);
  return {
    registry,
    bootstrapTag: BOOTSTRAP_TAG,
    visibility: metadata.visibility
  };
}
