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
                stderr: `failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
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

  function readContentResult(
    apiPath: string,
    timeout = 15000
  ): Promise<DeploymentFileResult> {
    return new Promise((resolve) =>
      ports.execute(
        "gh",
        ["api", apiPath, "--jq", ".content"],
        { timeout },
        (error, stdout, stderr) => {
          if (error) {
            const detail = ports.redactDiagnostic(
              (stderr && stderr.trim()) || error.message || String(error)
            );
            const status = detail.match(/\bHTTP\s+(\d{3})\b/i);
            resolve({
              content: null,
              error: detail.trim(),
              status: status ? Number(status[1]) : null
            });
          } else if (!stdout || !stdout.trim()) {
            resolve({
              content: null,
              error: "empty response from gh api",
              status: 200
            });
          } else {
            try {
              resolve({
                content: Buffer.from(stdout.trim(), "base64").toString("utf8"),
                error: null,
                status: 200
              });
            } catch (error) {
              resolve({
                content: null,
                error: `failed to decode response: ${error instanceof Error ? error.message : String(error)}`,
                status: 200
              });
            }
          }
        }
      )
    );
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
