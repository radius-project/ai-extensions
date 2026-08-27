import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "./gh-command-display.js";

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
    signal?: AbortSignal;
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
  requests: RequestContext;
  registryOrigin: string;
  repositoryPath: string;
  scope?: string;
  ghCommandPresentation?: GhCommandPresentation;
}

interface BlobOptions {
  requests: RequestContext;
  registryOrigin: string;
  repositoryPath: string;
  bearerToken: string;
  bytes: Buffer;
  digest: string;
}

interface BootstrapManifestOptions {
  requests: RequestContext;
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
  ghCommandPresentation?: GhCommandPresentation;
  requestTimeoutMs?: number;
  bootstrapTimeoutMs?: number;
  now?: () => number;
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
  if (typeof value.visibility !== "string") {
    throw new Error(
      "GitHub Packages API response did not include a valid visibility."
    );
  }
  if (
    value.repository !== undefined &&
    value.repository !== null &&
    (!isRecord(value.repository) ||
      typeof value.repository.full_name !== "string")
  ) {
    throw new Error(
      "GitHub Packages API response included an invalid repository."
    );
  }
  const repository = isRecord(value.repository) ? value.repository : undefined;
  return {
    visibility: value.visibility,
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
function packageAuthGuidance(
  presentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): string {
  const switchCommand = displayGhCommand(presentation, [
    "auth",
    "switch",
    "--hostname",
    "github.com",
    "--user",
    "<selected-login>"
  ]);
  const refreshCommand = displayGhCommand(presentation, [
    "auth",
    "refresh",
    "--hostname",
    "github.com",
    "--scopes",
    "read:packages,write:packages"
  ]);
  if (!switchCommand || !refreshCommand) return presentation.installationNote;
  return `In the terminal, make the selected account active with: ${switchCommand}. Then run: ${refreshCommand}. The first command changes your active GitHub CLI account if needed. ${presentation.installationNote}`.trim();
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 90_000;
const MAX_IDEMPOTENT_ATTEMPTS = 3;

interface RequestContext {
  fetchImpl: FetchImplementation;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  deadline: number;
  requestTimeoutMs: number;
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  redirect?: "error" | "follow";
}

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

function remainingBudget(requests: RequestContext): number {
  return requests.deadline - requests.now();
}

function ensureBudget(requests: RequestContext): number {
  const remaining = remainingBudget(requests);
  if (remaining <= 0) {
    throw new Error("GHCR bootstrap exceeded its overall elapsed-time budget.");
  }
  return remaining;
}

function retryDelay(
  response: HttpResponse,
  now: number,
  attempt: number
): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - now);
  }
  return Math.min(500 * 2 ** attempt, 4000);
}

async function sleepWithinBudget(
  requests: RequestContext,
  milliseconds: number
): Promise<void> {
  const remaining = ensureBudget(requests);
  if (milliseconds >= remaining) {
    throw new Error("GHCR bootstrap exceeded its overall elapsed-time budget.");
  }
  await requests.sleep(milliseconds);
  ensureBudget(requests);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function request(
  requests: RequestContext,
  input: string | URL,
  options: RequestOptions = {}
): Promise<HttpResponse> {
  const method = (options.method || "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const attempts = idempotent ? MAX_IDEMPOTENT_ATTEMPTS : 1;
  let attempt = 0;
  while (true) {
    const remaining = ensureBudget(requests);
    const signal = AbortSignal.timeout(
      Math.max(1, Math.ceil(Math.min(requests.requestTimeoutMs, remaining)))
    );
    let response: HttpResponse;
    try {
      response = await requests.fetchImpl(input, {
        ...options,
        signal
      });
    } catch (error) {
      if (!idempotent || attempt + 1 === attempts) throw error;
      await sleepWithinBudget(requests, Math.min(500 * 2 ** attempt, 4000));
      attempt++;
      continue;
    }
    ensureBudget(requests);
    if (!isRetryableStatus(response.status) || attempt + 1 === attempts) {
      return response;
    }
    await sleepWithinBudget(
      requests,
      retryDelay(response, requests.now(), attempt)
    );
    attempt++;
  }
}

function parseDigestHeader(response: HttpResponse, subject: string): string {
  const digest = response.headers.get("docker-content-digest");
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${subject} returned an invalid Docker-Content-Digest.`);
  }
  return digest;
}

function validateLocation(
  response: HttpResponse,
  registryOrigin: string,
  subject: string
): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`${subject} did not include a location.`);
  }
  let url: URL;
  try {
    url = new URL(location, registryOrigin);
  } catch {
    throw new Error(`${subject} returned an invalid location.`);
  }
  if (url.origin !== registryOrigin) {
    throw new Error(`${subject} pointed to an unexpected origin.`);
  }
  return url;
}

function packageAuthError(
  message: string,
  presentation: GhCommandPresentation
): GhcrAuthError {
  return new GhcrAuthError(`${message}. ${packageAuthGuidance(presentation)}`);
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
  requests,
  registryOrigin,
  repositoryPath,
  username,
  token,
  scope = "pull,push",
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
}: RegistryTokenOptions): Promise<string> {
  const challengeResponse = await request(requests, `${registryOrigin}/v2/`, {
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

  const response = await request(requests, tokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`
    },
    redirect: "error"
  });
  if (response.status === 401 || response.status === 403) {
    throw packageAuthError(
      `GHCR rejected package access for ${repositoryPath}`,
      ghCommandPresentation
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to obtain a GHCR upload token (HTTP ${response.status})${await responseDetail(response)}`
    );
  }
  const body = await response.json();
  if (!isRecord(body)) {
    throw new Error("GHCR token endpoint returned an invalid response.");
  }
  const bearerToken =
    typeof body.token === "string" ? body.token
    : typeof body.access_token === "string" ? body.access_token
    : "";
  if (!bearerToken.trim()) {
    throw new Error("GHCR token response did not include an access token.");
  }
  return bearerToken;
}

function registryPath(repositoryPath: string): string {
  return repositoryPath.split("/").map(encodeURIComponent).join("/");
}

async function registryFetch(
  requests: RequestContext,
  registryOrigin: string,
  bearerToken: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  } = {}
): Promise<HttpResponse> {
  return request(requests, `${registryOrigin}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      ...(options.headers || {})
    },
    redirect: "error"
  });
}

async function pushBlob({
  requests,
  registryOrigin,
  repositoryPath,
  bearerToken,
  bytes,
  digest
}: BlobOptions): Promise<void> {
  const encodedPath = registryPath(repositoryPath);
  const blobPath = `/v2/${encodedPath}/blobs/${digest}`;
  const readBlob = async (): Promise<boolean> => {
    const response = await registryFetch(
      requests,
      registryOrigin,
      bearerToken,
      blobPath,
      { method: "HEAD" }
    );
    if (response.status === 404) return false;
    if (response.status !== 200) {
      throw new Error(
        `Failed to check GHCR blob ${digest} (HTTP ${response.status})${await responseDetail(response)}`
      );
    }
    const actualDigest = parseDigestHeader(response, `GHCR blob ${digest}`);
    if (actualDigest !== digest) {
      throw new Error(
        `GHCR blob ${digest} returned conflicting digest ${actualDigest}.`
      );
    }
    return true;
  };

  if (await readBlob()) return;

  for (let attempt = 0; attempt < 2; attempt++) {
    const start = await registryFetch(
      requests,
      registryOrigin,
      bearerToken,
      `/v2/${encodedPath}/blobs/uploads/`,
      { method: "POST" }
    ).catch(() => null);
    if (!start || start.status >= 500) {
      if (await readBlob()) return;
      if (attempt === 0) continue;
      throw new Error(
        `GHCR blob upload for ${digest} remained absent after reconciliation.`
      );
    }
    if (start.status !== 202) {
      throw new Error(
        `Failed to start GHCR blob upload (HTTP ${start.status})${await responseDetail(start)}`
      );
    }
    const uploadUrl = validateLocation(
      start,
      registryOrigin,
      "GHCR blob upload response"
    );
    uploadUrl.searchParams.set("digest", digest);

    const upload = await request(requests, uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/octet-stream"
      },
      body: bytes,
      redirect: "error"
    }).catch(() => null);
    if (!upload || upload.status >= 500) {
      if (await readBlob()) return;
      if (attempt === 0) continue;
      throw new Error(
        `GHCR blob upload for ${digest} remained absent after reconciliation.`
      );
    }
    if (upload.status !== 201) {
      throw new Error(
        `Failed to upload GHCR blob ${digest} (HTTP ${upload.status})${await responseDetail(upload)}`
      );
    }
    const actualDigest = parseDigestHeader(
      upload,
      `GHCR blob upload ${digest}`
    );
    if (actualDigest !== digest) {
      throw new Error(
        `GHCR blob upload returned conflicting digest ${actualDigest}.`
      );
    }
    validateLocation(upload, registryOrigin, "GHCR blob upload response");
    return;
  }
}

async function pushBootstrapManifest({
  requests,
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
  const manifestDigest = sha256(manifestBytes);

  const manifestPath = `/v2/${registryPath(repositoryPath)}/manifests/${BOOTSTRAP_TAG}`;
  const readManifest = async (): Promise<"absent" | "exact" | "conflict"> => {
    const response = await registryFetch(
      requests,
      registryOrigin,
      bearerToken,
      manifestPath,
      {
        method: "HEAD",
        headers: { Accept: OCI_MANIFEST_MEDIA_TYPE }
      }
    );
    if (response.status === 404) return "absent";
    if (response.status !== 200) {
      throw new Error(
        `Failed to check the GHCR bootstrap manifest (HTTP ${response.status})${await responseDetail(response)}`
      );
    }
    if (
      parseDigestHeader(response, "GHCR bootstrap manifest") === manifestDigest
    ) {
      return "exact";
    }
    const legacy = await registryFetch(
      requests,
      registryOrigin,
      bearerToken,
      manifestPath,
      { headers: { Accept: OCI_MANIFEST_MEDIA_TYPE } }
    );
    if (legacy.status !== 200) return "conflict";
    let legacyBody: unknown;
    try {
      legacyBody = await legacy.json();
    } catch {
      return "conflict";
    }
    if (!isRecord(legacyBody)) return "conflict";
    const annotations =
      isRecord(legacyBody.annotations) ? legacyBody.annotations : {};
    const legacySource =
      typeof annotations["org.opencontainers.image.source"] === "string" ?
        annotations["org.opencontainers.image.source"].toLowerCase()
      : "";
    const expectedSource =
      manifest.annotations["org.opencontainers.image.source"].toLowerCase();
    return (
        legacyBody.schemaVersion === manifest.schemaVersion &&
          legacyBody.mediaType === manifest.mediaType &&
          legacyBody.artifactType === manifest.artifactType &&
          JSON.stringify(legacyBody.config) ===
            JSON.stringify(manifest.config) &&
          JSON.stringify(legacyBody.layers) ===
            JSON.stringify(manifest.layers) &&
          legacySource === expectedSource
      ) ?
        "exact"
      : "conflict";
  };

  const initialState = await readManifest();
  if (initialState === "exact") return;
  if (initialState === "conflict") {
    throw new Error(
      "GHCR bootstrap tag already exists with a different digest; refusing to overwrite the external manifest."
    );
  }

  await pushBlob({
    requests,
    registryOrigin,
    repositoryPath,
    bearerToken,
    bytes: configBytes,
    digest: config.digest
  });
  await pushBlob({
    requests,
    registryOrigin,
    repositoryPath,
    bearerToken,
    bytes: layerBytes,
    digest: layer.digest
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await registryFetch(
      requests,
      registryOrigin,
      bearerToken,
      manifestPath,
      {
        method: "PUT",
        headers: {
          "Content-Type": OCI_MANIFEST_MEDIA_TYPE,
          "If-None-Match": "*"
        },
        body: manifestBytes
      }
    ).catch(() => null);
    if (response && response.status < 500) {
      if (response.status === 409 || response.status === 412) {
        const state = await readManifest();
        if (state === "exact") return;
        throw new Error(
          "GHCR bootstrap tag was published concurrently with a different manifest; refusing to overwrite it."
        );
      }
      if (response.status !== 201 && response.status !== 202) {
        throw new Error(
          `Failed to push the GHCR bootstrap manifest (HTTP ${response.status})${await responseDetail(response)}`
        );
      }
      const actualDigest = parseDigestHeader(
        response,
        "GHCR bootstrap manifest upload"
      );
      if (actualDigest !== manifestDigest) {
        throw new Error(
          `GHCR bootstrap manifest upload returned conflicting digest ${actualDigest}.`
        );
      }
      validateLocation(
        response,
        registryOrigin,
        "GHCR bootstrap manifest upload"
      );
      return;
    }

    const state = await readManifest();
    if (state === "exact") return;
    if (state === "conflict") {
      throw new Error(
        "GHCR bootstrap tag changed to a different digest during reconciliation; refusing to overwrite it."
      );
    }
    if (attempt === 0) ensureBudget(requests);
  }
  throw new Error(
    "GHCR bootstrap manifest remained absent after reconciliation."
  );
}

async function githubJson(
  requests: RequestContext,
  url: string,
  token: string,
  allowNotFound = false,
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): Promise<unknown | null> {
  const response = await request(requests, url, {
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
      `GitHub Packages API rejected access (HTTP ${response.status})`,
      ghCommandPresentation
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
  requests,
  apiBaseUrl,
  owner,
  packageName,
  token,
  ghCommandPresentation
}: {
  requests: RequestContext;
  apiBaseUrl: string;
  owner: string;
  packageName: string;
  token: string;
  ghCommandPresentation: GhCommandPresentation;
}): Promise<string> {
  const ownerMetadata = await githubJson(
    requests,
    `${apiBaseUrl}/users/${encodeURIComponent(owner)}`,
    token,
    false,
    ghCommandPresentation
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
  runKeyringCommand = defaultRunKeyringCommand,
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
}: {
  runKeyringCommand?: KeyringCommand;
  ghCommandPresentation?: GhCommandPresentation;
} = {}): Promise<GhCredentials> {
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
      `A stored GitHub CLI login with package access is required. ${packageAuthGuidance(
        ghCommandPresentation
      )}`
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
    ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION,
    loadCredentials = () => loadGhKeyringCredentials({ ghCommandPresentation })
  }: {
    loadCredentials?: CredentialLoader;
    ghCommandPresentation?: GhCommandPresentation;
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
  metadataAttempts = 6,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  now = Date.now,
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
}: BootstrapGhcrOptions): Promise<{
  registry: string;
  bootstrapTag: string;
  visibility: string | undefined;
}> {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }
  if (
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    !Number.isFinite(bootstrapTimeoutMs) ||
    bootstrapTimeoutMs <= 0
  ) {
    throw new Error("GHCR timeout values must be positive finite numbers.");
  }
  const requests: RequestContext = {
    fetchImpl,
    sleep,
    now,
    deadline: now() + bootstrapTimeoutMs,
    requestTimeoutMs
  };
  const canonicalTargetRepository = targetRepository.toLowerCase();
  const parsed = parseRegistry(registry, registryOrigin);
  const auth =
    credentials || (await loadGhKeyringCredentials({ ghCommandPresentation }));
  const endpoint = await packageEndpoint({
    requests,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    owner: parsed.owner,
    packageName: parsed.packageName,
    token: auth.token,
    ghCommandPresentation
  });

  const existingValue = await githubJson(
    requests,
    endpoint,
    auth.token,
    true,
    ghCommandPresentation
  );
  if (existingValue)
    validatePackage(
      parsePackageMetadata(existingValue),
      canonicalTargetRepository,
      true
    );

  const bearerToken = await getRegistryBearerToken({
    requests,
    registryOrigin: parsed.registryOrigin,
    repositoryPath: parsed.repositoryPath,
    username: auth.username,
    token: auth.token,
    ghCommandPresentation
  });
  await pushBootstrapManifest({
    requests,
    registryOrigin: parsed.registryOrigin,
    repositoryPath: parsed.repositoryPath,
    bearerToken,
    targetRepository: canonicalTargetRepository
  });

  let metadata: GitHubPackageMetadata | null = null;
  for (let attempt = 0; attempt < metadataAttempts; attempt++) {
    const value = await githubJson(
      requests,
      endpoint,
      auth.token,
      true,
      ghCommandPresentation
    );
    metadata = value ? parsePackageMetadata(value) : null;
    // validatePackage fails fast on public visibility and on a wrong repository
    // link; a not-yet-propagated (missing) link returns false so we keep retrying.
    if (
      metadata &&
      validatePackage(metadata, canonicalTargetRepository, true)
    ) {
      return {
        registry,
        bootstrapTag: BOOTSTRAP_TAG,
        visibility: metadata.visibility
      };
    }
    if (attempt + 1 < metadataAttempts) {
      await sleepWithinBudget(requests, Math.min(500 * 2 ** attempt, 4000));
    }
  }

  if (!metadata) {
    throw new Error(
      `GHCR state package "${registry}" was not visible through the GitHub Packages API after bootstrap.`
    );
  }
  validatePackage(metadata, canonicalTargetRepository);
  return {
    registry,
    bootstrapTag: BOOTSTRAP_TAG,
    visibility: metadata.visibility
  };
}
