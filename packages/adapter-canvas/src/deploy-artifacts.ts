import os from "node:os";
import {
  createDeployStatusReader as createSharedReader,
  type DeployStatusReaderOptions as SharedReaderOptions
} from "@radius-project/core/github-radius/deployments/deploy-artifacts";
import { createArtifactExecution } from "@radius-project/adapter-shared/github-radius/deployments/deploy-artifacts";
import { cliExec } from "./gh.js";

export * from "@radius-project/core/github-radius/deployments/deploy-artifacts";

const execution = createArtifactExecution({
  scratchDirectory: os.tmpdir(),
  runGh: (args, timeout) =>
    new Promise((resolve, reject) => {
      cliExec("gh", args, { timeout }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      });
    })
});

export const { listWorkflowArtifacts, downloadWorkflowArtifact } = execution;

export interface DeployStatusReaderOptions extends Omit<
  SharedReaderOptions,
  "listArtifacts" | "downloadArtifact"
> {
  listArtifacts?: SharedReaderOptions["listArtifacts"];
  downloadArtifact?: SharedReaderOptions["downloadArtifact"];
}

export function createDeployStatusReader(options: DeployStatusReaderOptions) {
  return createSharedReader({
    ...options,
    listArtifacts: options.listArtifacts || listWorkflowArtifacts,
    downloadArtifact: options.downloadArtifact || downloadWorkflowArtifact
  });
}
