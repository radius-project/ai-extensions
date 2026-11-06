import {
  RADIUS_REF,
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeployWorkflow,
  deployWorkflowFiles,
  stripAwsDispatcherJob,
  stripWorkflowRunTrigger,
  assertTrustedGeneratedWorkflow,
  type DeployWorkflowOptions
} from "@radius-project/core";
import { parse } from "yaml";

export interface DeploymentTemplatePorts {
  readRepositoryFile(
    repo: string,
    path: string,
    ref: string
  ): Promise<{ content: string | null; error?: string | null }>;
  now(): number;
}

export function createDeploymentTemplates(ports: DeploymentTemplatePorts) {
  const cache = new Map<string, { at: number; body: string }>();
  const readTemplate = async (file: string): Promise<string> => {
    const cached = cache.get(file);
    if (cached && ports.now() - cached.at < 60_000) return cached.body;
    const source = `${RADIUS_WORKFLOW_REPO}/${RADIUS_WORKFLOW_DIR}/${file} at "${RADIUS_REF}"`;
    const { content, error } = await ports.readRepositoryFile(
      RADIUS_WORKFLOW_REPO,
      `${RADIUS_WORKFLOW_DIR}/${file}`,
      RADIUS_REF
    );
    if (error)
      throw new Error(`Failed to fetch workflow template ${source}: ${error}`);
    if (!content || !content.trim())
      throw new Error(`Workflow template ${source} is empty.`);
    cache.set(file, { at: ports.now(), body: content });
    return content;
  };
  return async (
    environment: string,
    appFile: string,
    options: DeployWorkflowOptions & { includeAws?: boolean } = {}
  ): Promise<Record<string, string>> => {
    const { includeAws = false, ...deployOptions } = options;
    const files = deployWorkflowFiles(includeAws);
    const bodies = await Promise.all(files.map(readTemplate));
    const templates: Record<string, string> = {};
    files.forEach((file, index) => {
      templates[file] = bodies[index];
    });
    if (!includeAws) templates[DEPLOY_AWS_FILE] = templates[DEPLOY_AZURE_FILE];
    const generated = generateDeployWorkflow(
      environment,
      appFile,
      templates,
      deployOptions
    );
    if (!includeAws) delete generated[DEPLOY_AWS_FILE];
    if (typeof generated[DEPLOY_DISPATCHER_FILE] === "string") {
      generated[DEPLOY_DISPATCHER_FILE] = stripWorkflowRunTrigger(
        generated[DEPLOY_DISPATCHER_FILE]
      );
      if (!includeAws)
        generated[DEPLOY_DISPATCHER_FILE] = stripAwsDispatcherJob(
          generated[DEPLOY_DISPATCHER_FILE]
        );
    }
    for (const [file, workflow] of Object.entries(generated)) {
      assertTrustedGeneratedWorkflow(
        parse,
        workflow,
        file === DEPLOY_DISPATCHER_FILE ? "dispatcher" : "provider",
        `deploy workflow "${file}"`,
        file === DEPLOY_DISPATCHER_FILE ? files.slice(1) : []
      );
    }
    return generated;
  };
}
