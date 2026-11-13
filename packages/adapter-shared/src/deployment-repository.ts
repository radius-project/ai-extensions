import {
  classifyProvider,
  parseGitHubEnvironmentVariables,
  type ClassifiedProvider
} from "@radius-project/core";
import {
  createDeploymentCommandBindings,
  type DeploymentCommandExecutor
} from "./deployment-command-bindings.js";
import { workflowBlobSha } from "./setup-workflow-content.js";

export interface DeploymentFileResult {
  content: string | null;
  error: string | null;
  status: number | null;
  encoding?: string;
  size?: number;
}

export interface DeploymentJsonResult {
  ok: boolean;
  status: number | null;
  json: unknown;
  stderr: string;
}

export function createDeploymentRepository(ports: {
  execute: DeploymentCommandExecutor;
  redactDiagnostic(message: string): string;
}) {
  const commands = createDeploymentCommandBindings(ports);
  function readJson(
    apiPath: string,
    {
      headers = {},
      timeout = 15000
    }: {
      headers?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<DeploymentJsonResult> {
    const args = ["api", apiPath];
    for (const [key, value] of Object.entries(headers))
      args.push("-H", `${key}: ${value}`);
    return new Promise((resolve) => {
      const child = ports.execute(
        "gh",
        args,
        { timeout },
        (error, stdout, stderr) => {
          if (!error) {
            try {
              resolve({
                ok: true,
                status: 200,
                json: JSON.parse(stdout || "null"),
                stderr: ""
              });
            } catch (parseError) {
              resolve({
                ok: false,
                status: 200,
                json: null,
                stderr: ports.redactDiagnostic(
                  `failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
                )
              });
            }
            return;
          }
          const detail = ports.redactDiagnostic(
            ((stderr && stderr.trim()) || error.message || "").trim()
          );
          const status =
            detail.match(/\(HTTP (\d{3})\)/) ||
            detail.match(/\bHTTP (\d{3})\b/);
          resolve({
            ok: false,
            status: status ? Number(status[1]) : null,
            json: null,
            stderr: detail
          });
        }
      );
      try {
        child.stdin?.end();
      } catch {
        // The process callback remains authoritative if stdin already closed.
      }
    });
  }
  const readText = (args: string[], timeout: number): Promise<string> =>
    new Promise((resolve) =>
      ports.execute("gh", args, { timeout }, (error, stdout) =>
        resolve(error ? "" : (stdout || "").trim())
      )
    );

  async function readContentResult(
    apiPath: string,
    timeout = 15000
  ): Promise<DeploymentFileResult> {
    const response = await readJson(apiPath, { timeout });
    const unavailable = (
      error: string,
      metadata: Pick<DeploymentFileResult, "encoding" | "size"> = {}
    ): DeploymentFileResult => ({
      content: null,
      error: ports.redactDiagnostic(error),
      status: response.status,
      ...metadata
    });
    if (!response.ok)
      return unavailable(
        response.stderr || "The repository file could not be read."
      );
    const value = response.json;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return unavailable("Invalid repository file metadata.");
    const encoding =
      "encoding" in value && typeof value.encoding === "string" ?
        value.encoding
      : undefined;
    const size =
      (
        "size" in value &&
        typeof value.size === "number" &&
        Number.isSafeInteger(value.size) &&
        value.size >= 0
      ) ?
        value.size
      : undefined;
    const metadata = {
      ...(encoding !== undefined ? { encoding } : {}),
      ...(size !== undefined ? { size } : {})
    };
    if (encoding === undefined || size === undefined)
      return unavailable(
        "Invalid repository file encoding or size metadata.",
        metadata
      );
    if (encoding !== "base64")
      return unavailable(
        "Repository file content is unavailable in a supported encoding. GitHub must return the complete base64 model or workflow content before deployment.",
        metadata
      );
    if (!("content" in value) || typeof value.content !== "string")
      return unavailable(
        "Repository file content is missing or malformed.",
        metadata
      );
    const encoded = value.content.replace(/\s/g, "");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded || decoded.length !== size)
      return unavailable(
        "Repository file content is incomplete or invalid base64. GitHub must return the complete model or workflow content before deployment.",
        metadata
      );
    return {
      content: decoded.toString("utf8"),
      error: null,
      status: response.status,
      ...metadata
    };
  }
  const readFileResult = (repo: string, path: string, branch: string) =>
    readContentResult(`/repos/${repo}/contents/${path}?ref=${branch}`);
  const readContent = async (apiPath: string, timeout = 15000) =>
    (await readContentResult(apiPath, timeout)).content;
  const readFile = async (repo: string, path: string, branch: string) =>
    (await readFileResult(repo, path, branch)).content;
  const defaultBranch = (repo: string, timeout = 15000) =>
    readText(["api", `/repos/${repo}`, "--jq", ".default_branch"], timeout);
  const branchHead = (repo: string, branch: string, timeout = 15000) =>
    readText(
      [
        "api",
        `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        "--jq",
        ".object.sha"
      ],
      timeout
    );

  async function commitFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string,
    timeout = 30000
  ): Promise<boolean> {
    const sha = await readText(
      ["api", `/repos/${repo}/contents/${path}?ref=${branch}`, "--jq", ".sha"],
      10000
    );
    const encoded = Buffer.from(content, "utf8").toString("base64");
    if (sha && sha === workflowBlobSha(encoded)) return false;
    const body = JSON.stringify({
      message,
      content: encoded,
      branch,
      ...(sha ? { sha } : {})
    });
    return new Promise((resolve, reject) => {
      const child = ports.execute(
        "gh",
        [
          "api",
          "--method",
          "PUT",
          `/repos/${repo}/contents/${path}`,
          "--input",
          "-"
        ],
        { timeout },
        (error, _stdout, stderr) => {
          if (error)
            reject(
              new Error(
                ports.redactDiagnostic(
                  (stderr && stderr.trim()) || error.message || String(error)
                )
              )
            );
          else resolve(true);
        }
      );
      try {
        child.stdin?.end(body);
      } catch {
        // Preserve best-effort stdin close; the executor callback owns the result.
      }
    });
  }
  async function environmentProvider(
    repo: string,
    environment: string
  ): Promise<ClassifiedProvider> {
    const output = await commands.ghOrThrow(
      [
        "api",
        `/repos/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
        "--jq",
        '.variables[] | .name + "\\t" + (.value // "")'
      ],
      15000
    );
    const variables = parseGitHubEnvironmentVariables(output);
    return classifyProvider(
      Object.fromEntries(Object.entries(variables).filter(([, value]) => value))
    );
  }
  return {
    ...commands,
    readJson,
    readContent,
    readContentResult,
    readFile,
    readFileResult,
    defaultBranch,
    branchHead,
    commitFile,
    environmentProvider
  };
}
