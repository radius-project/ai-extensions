import { createPrivateKey, sign } from "node:crypto";
import { CLOUD_MINIMUM_REFRESHED_TOKEN_LIFETIME_MS } from "./cloud-timeout-budget.js";

type GitHubApiRequest = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubAppTokenOptions {
  readonly clientId: string;
  readonly privateKey: string;
  readonly repository: string;
  readonly now?: () => Date;
  readonly request?: GitHubApiRequest;
}

const API_ROOT = "https://api.github.com";
const INSTALLATION_PERMISSIONS = {
  actions: "read",
  administration: "read",
  contents: "write",
  environments: "write",
  pull_requests: "write",
  variables: "write",
  workflows: "write"
} as const;

function required(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} is required.`);
  return value;
}

function repositoryParts(repository: string): {
  readonly owner: string;
  readonly name: string;
} {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
  if (!match)
    throw new Error("Fixture repository must be canonical owner/name.");
  const [, owner = "", name = ""] = match;
  return { owner, name };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createAppJwt(clientId: string, privateKey: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60;
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: clientId
  })}`;
  return `${unsigned}.${sign(
    "RSA-SHA256",
    Buffer.from(unsigned),
    createPrivateKey(privateKey)
  ).toString("base64url")}`;
}

async function readObject(
  response: Response,
  operation: string
): Promise<Record<string, unknown>> {
  if (!response.ok)
    throw new Error(
      `${operation} failed with HTTP ${response.status} ${response.statusText}.`
    );
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new Error(`${operation} returned a malformed response.`);
  return payload as Record<string, unknown>;
}

/**
 * Mints a fresh repository-scoped installation token before each serial stage.
 *
 * The private key is used only for the short-lived App JWT and is never passed
 * to a child command or included in an error message.
 */
export async function renewGitHubAppInstallationToken(
  options: GitHubAppTokenOptions
): Promise<string> {
  const clientId = required(options.clientId, "GitHub App client ID").trim();
  const privateKey = required(options.privateKey, "GitHub App private key");
  const { owner, name } = repositoryParts(options.repository);
  const now = options.now ?? (() => new Date());
  const request = options.request ?? fetch;
  const jwt = createAppJwt(clientId, privateKey, now());
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${jwt}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };

  const installation = await readObject(
    await request(`${API_ROOT}/repos/${owner}/${name}/installation`, {
      headers
    }),
    "GitHub App installation lookup"
  );
  if (
    typeof installation.id !== "number" ||
    !Number.isSafeInteger(installation.id) ||
    installation.id <= 0
  )
    throw new Error(
      "GitHub App installation lookup returned no valid installation id."
    );

  const tokenResponse = await readObject(
    await request(
      `${API_ROOT}/app/installations/${installation.id}/access_tokens`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          repositories: [name],
          permissions: INSTALLATION_PERMISSIONS
        })
      }
    ),
    "GitHub App token renewal"
  );
  if (
    typeof tokenResponse.token !== "string" ||
    tokenResponse.token.trim() === ""
  )
    throw new Error("GitHub App token renewal returned no token.");
  if (
    typeof tokenResponse.expires_at !== "string" ||
    Date.parse(tokenResponse.expires_at) - now().getTime() <
      CLOUD_MINIMUM_REFRESHED_TOKEN_LIFETIME_MS
  )
    throw new Error(
      "GitHub App token renewal returned a token with insufficient lifetime."
    );
  return tokenResponse.token;
}
