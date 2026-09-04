import { sign } from "node:crypto";
import { CLOUD_MINIMUM_REFRESHED_TOKEN_LIFETIME_MS } from "./cloud-timeout-budget.js";

export interface GitHubAppTokenConfig {
  readonly clientId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly repository: string;
  readonly apiUrl: string;
}

export interface GitHubAppTokenPorts {
  readonly now: () => Date;
  readonly request: (
    url: string,
    init: RequestInit
  ) => Promise<Pick<Response, "ok" | "status" | "statusText" | "json">>;
  readonly signJwt: (content: string, privateKey: string) => string;
}

function requireValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed)
    throw new Error(
      `${name} is required to refresh the cloud journey's GitHub App token.`
    );
  return trimmed;
}

export function readGitHubAppTokenConfig(
  env: NodeJS.ProcessEnv = process.env
): GitHubAppTokenConfig | null {
  const configured = [
    env.CLOUD_E2E_BOT_CLIENT_ID,
    env.CLOUD_E2E_BOT_INSTALLATION_ID,
    env.CLOUD_E2E_BOT_PRIVATE_KEY
  ].some((value) => value?.trim());
  if (!configured) return null;

  const installationId = requireValue(
    env.CLOUD_E2E_BOT_INSTALLATION_ID,
    "CLOUD_E2E_BOT_INSTALLATION_ID"
  );
  if (!/^[1-9][0-9]*$/.test(installationId))
    throw new Error(
      "CLOUD_E2E_BOT_INSTALLATION_ID must be a positive integer."
    );

  const repository = requireValue(
    env.AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY,
    "AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY"
  );
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository))
    throw new Error(
      "AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY must be an owner/name repository."
    );

  return {
    clientId: requireValue(
      env.CLOUD_E2E_BOT_CLIENT_ID,
      "CLOUD_E2E_BOT_CLIENT_ID"
    ),
    installationId,
    privateKey: requireValue(
      env.CLOUD_E2E_BOT_PRIVATE_KEY,
      "CLOUD_E2E_BOT_PRIVATE_KEY"
    ).replace(/\\n/g, "\n"),
    repository,
    apiUrl: (env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(
      /\/+$/,
      ""
    )
  };
}

export function takeGitHubAppTokenConfig(
  env: NodeJS.ProcessEnv = process.env
): GitHubAppTokenConfig | null {
  try {
    return readGitHubAppTokenConfig(env);
  } finally {
    delete env.CLOUD_E2E_BOT_PRIVATE_KEY;
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createNodeGitHubAppTokenPorts(): GitHubAppTokenPorts {
  return {
    now: () => new Date(),
    request: (url, init) => fetch(url, init),
    signJwt: (content, privateKey) =>
      sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")
  };
}

export async function mintGitHubAppToken(
  config: GitHubAppTokenConfig,
  ports: GitHubAppTokenPorts = createNodeGitHubAppTokenPorts()
): Promise<string> {
  const nowSeconds = Math.floor(ports.now().getTime() / 1000);
  const unsignedJwt = [
    encodeJson({ alg: "RS256", typ: "JWT" }),
    encodeJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: config.clientId
    })
  ].join(".");
  const jwt = `${unsignedJwt}.${ports.signJwt(unsignedJwt, config.privateKey)}`;
  const repositoryName = config.repository.split("/")[1];
  if (!repositoryName)
    throw new Error(
      "The GitHub App token repository must include an owner and name."
    );

  const response = await ports.request(
    `${config.apiUrl}/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify({
        repositories: [repositoryName],
        permissions: {
          actions: "write",
          administration: "read",
          contents: "write",
          deployments: "read",
          environments: "write",
          pull_requests: "write",
          variables: "write",
          workflows: "write"
        }
      })
    }
  );
  if (!response.ok)
    throw new Error(
      `GitHub App token refresh failed with HTTP ${response.status} ${response.statusText}.`
    );

  const payload = (await response.json()) as unknown;
  if (typeof payload !== "object" || payload === null)
    throw new Error(
      "GitHub App token refresh returned no token or expiration time."
    );
  const token = "token" in payload ? payload.token : undefined;
  const expiresAt = "expires_at" in payload ? payload.expires_at : undefined;
  if (
    typeof token !== "string" ||
    token.trim() === "" ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) - ports.now().getTime() <
      CLOUD_MINIMUM_REFRESHED_TOKEN_LIFETIME_MS
  )
    throw new Error(
      "GitHub App token refresh returned no usable unexpired token."
    );
  return token.trim();
}

export async function refreshProcessGitHubToken(
  config: GitHubAppTokenConfig,
  env: NodeJS.ProcessEnv = process.env,
  ports?: GitHubAppTokenPorts
): Promise<void> {
  const token = await mintGitHubAppToken(config, ports);
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
}
