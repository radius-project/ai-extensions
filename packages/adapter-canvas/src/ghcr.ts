import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "./gh-command-display.js";

import { ghcrBootstrap } from "@radius-project/adapter-shared";
export type GhCredentials = ghcrBootstrap.GhCredentials;
export type FetchImplementation = ghcrBootstrap.FetchImplementation;
type RequestContext = ghcrBootstrap.RequestContext;
const {
  GITHUB_API_VERSION,
  parseRegistry,
  packageEndpoint,
  githubJson,
  GITHUB_NOT_FOUND,
  packageAuthError,
  validatePackage,
  parsePackageMetadata,
  request,
  githubAuthorization,
  responseDetail,
  sleepWithinBudget,
  GhcrAuthError
} = ghcrBootstrap;
export const { BOOTSTRAP_TAG, BOOTSTRAP_ARTIFACT_TYPE, BOOTSTRAP_CONTENT } =
  ghcrBootstrap;
type CredentialLoader = () => Promise<GhCredentials>;
type KeyringCommand = (args: string[]) => Promise<string>;

export interface BootstrapGhcrOptions {
  targetRepository: string;
  registry: string;
  credentials?: GhCredentials;
  assertActive?(): void;
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

export interface DeleteGhcrOptions {
  targetRepository: string;
  registry: string;
  credentials?: GhCredentials;
  runKeyringCommand?: (args: string[]) => Promise<string>;
  fetchImpl?: FetchImplementation;
  apiBaseUrl?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  confirmationAttempts?: number;
  ghCommandPresentation?: GhCommandPresentation;
  requestTimeoutMs?: number;
  deletionTimeoutMs?: number;
  now?: () => number;
}

export type DeleteGhcrOutcome =
  | { outcome: "deleted"; registry: string }
  | { outcome: "not_found"; registry: string };

function packageAuthGuidance(
  presentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION,
  scopes = "read:packages,write:packages",
  credentialSource?: GhCredentials["source"]
): string {
  if (credentialSource === "injected-token") {
    const source =
      process.env.GH_PACKAGES_TOKEN?.trim() ?
        "GH_PACKAGES_TOKEN"
      : "GH_TOKEN or GITHUB_TOKEN";
    return `The selected package credential comes from ${source}, so gh auth refresh cannot change it. Update that injected token to include ${scopes}, or remove it and sign in to the selected account with GitHub CLI. ${presentation.installationNote}`.trim();
  }
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
    scopes
  ]);
  if (!switchCommand || !refreshCommand) return presentation.installationNote;
  return `In the terminal, make the selected account active with: ${switchCommand}. Then run: ${refreshCommand}. The first command changes your active GitHub CLI account if needed. ${presentation.installationNote}`.trim();
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DELETION_TIMEOUT_MS = 30_000;
async function defaultRunKeyringCommand(args: string[]): Promise<string> {
  const { runGhKeyringCommand } = await import("./gh.js");
  const value = await runGhKeyringCommand(args);
  if (typeof value !== "string") {
    throw new Error("GitHub CLI returned an invalid credential response.");
  }
  return value;
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

export async function bootstrapGHCRStatePackage(
  options: BootstrapGhcrOptions
): Promise<{
  registry: string;
  bootstrapTag: string;
  visibility: string | undefined;
}> {
  const {
    credentials,
    ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION,
    ...io
  } = options;
  return ghcrBootstrap.bootstrapGHCRStatePackage({
    ...io,
    loadCredentials: async () =>
      credentials ||
      (await loadGhKeyringCredentials({ ghCommandPresentation })),
    authGuidance: (scopes, source) =>
      packageAuthGuidance(ghCommandPresentation, scopes, source)
  });
}

export async function deleteGHCRStatePackage({
  targetRepository,
  registry,
  credentials,
  runKeyringCommand,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = "https://api.github.com",
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  confirmationAttempts = 4,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  deletionTimeoutMs = DEFAULT_DELETION_TIMEOUT_MS,
  now = Date.now,
  ghCommandPresentation = BARE_GH_COMMAND_PRESENTATION
}: DeleteGhcrOptions): Promise<DeleteGhcrOutcome> {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch.");
  }
  if (
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    !Number.isFinite(deletionTimeoutMs) ||
    deletionTimeoutMs <= 0 ||
    !Number.isInteger(confirmationAttempts) ||
    confirmationAttempts <= 0
  ) {
    throw new Error(
      "GHCR timeout values and confirmation attempts must be positive finite numbers."
    );
  }

  const auth =
    credentials ||
    (await loadGhKeyringCredentials({
      runKeyringCommand,
      ghCommandPresentation
    }));
  const requests: RequestContext = {
    fetchImpl,
    sleep,
    now,
    deadline: now() + deletionTimeoutMs,
    requestTimeoutMs,
    operation: "deletion",
    credentialSource: auth.source
  };
  const parsed = parseRegistry(registry);
  const endpoint = await packageEndpoint({
    requests,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    owner: parsed.owner,
    packageName: parsed.packageName,
    token: auth.token,
    authGuidance: (scopes, source) =>
      packageAuthGuidance(ghCommandPresentation, scopes, source)
  });
  const existingValue = await githubJson(
    requests,
    endpoint,
    auth.token,
    true,
    (scopes, source) =>
      packageAuthGuidance(ghCommandPresentation, scopes, source)
  );
  if (existingValue === GITHUB_NOT_FOUND) {
    const scopes = auth.scopes || [];
    if (!scopes.includes("read:packages")) {
      throw packageAuthError(
        "GitHub returned HTTP 404 for the state package, but the selected credential does not prove package read access",
        (scopes, source) =>
          packageAuthGuidance(ghCommandPresentation, scopes, source),
        "read:packages",
        auth.source
      );
    }
    return { outcome: "not_found", registry };
  }
  validatePackage(
    parsePackageMetadata(existingValue),
    targetRepository.toLowerCase()
  );

  let deletionError: unknown = null;
  try {
    const response = await request(requests, endpoint, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: githubAuthorization(auth.token),
        "X-GitHub-Api-Version": GITHUB_API_VERSION
      },
      redirect: "error"
    });
    if (response.status === 401 || response.status === 403) {
      throw packageAuthError(
        `GitHub Packages API rejected package deletion (HTTP ${response.status})`,
        (scopes, source) =>
          packageAuthGuidance(ghCommandPresentation, scopes, source),
        "delete:packages",
        auth.source
      );
    }
    if (!response.ok && response.status !== 404) {
      deletionError = new Error(
        `GitHub Packages deletion failed (HTTP ${response.status})${await responseDetail(response)}`
      );
    }
  } catch (error) {
    if (error instanceof GhcrAuthError) throw error;
    deletionError = error;
  }

  for (let attempt = 0; attempt < confirmationAttempts; attempt++) {
    const value = await githubJson(
      requests,
      endpoint,
      auth.token,
      true,
      (scopes, source) =>
        packageAuthGuidance(ghCommandPresentation, scopes, source)
    );
    if (value === GITHUB_NOT_FOUND) {
      return { outcome: "deleted", registry };
    }
    validatePackage(
      parsePackageMetadata(value),
      targetRepository.toLowerCase()
    );
    if (attempt + 1 < confirmationAttempts) {
      await sleepWithinBudget(requests, Math.min(500 * 2 ** attempt, 4000));
    }
  }

  const detail =
    deletionError instanceof Error ? ` ${deletionError.message}` : "";
  throw new Error(
    `GHCR state package "${registry}" is still present after deletion.${detail}`.trim()
  );
}
