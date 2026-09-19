import { createHash } from "node:crypto";
import {
  createWorkflowFileCommitter as createSharedCommitter,
  type WorkflowFileCommitterPorts,
  type WorkflowFileCommitterTarget
} from "@radius-project/core/github-radius/environments/create-environment-workflow-committer";

export * from "@radius-project/core/github-radius/environments/create-environment-workflow-committer";

export function workflowContentDigest(contentB64: string): string {
  return createHash("sha256")
    .update(Buffer.from(contentB64, "base64"))
    .digest("hex");
}

export function createWorkflowFileCommitter(
  ports: WorkflowFileCommitterPorts,
  target: WorkflowFileCommitterTarget
) {
  return createSharedCommitter(ports, target, {
    workflowContentDigest,
    workflowBlobSha(contentB64) {
      const bytes = Buffer.from(contentB64, "base64");
      return createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    }
  });
}
