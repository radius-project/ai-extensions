import { createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function workflowContentDigest(contentB64: string): string {
  return createHash("sha256")
    .update(Buffer.from(contentB64, "base64"))
    .digest("hex");
}

export function workflowBlobSha(contentB64: string): string {
  const bytes = Buffer.from(contentB64, "base64");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

export function encodeWorkflowContent(content: string): string {
  return Buffer.from(content).toString("base64");
}

export function setupValueDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const workflowTempFile = {
  write(contents: string): string {
    const path = join(
      tmpdir(),
      "radius-wf-commit-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2) +
        ".json"
    );
    writeFileSync(path, contents);
    return path;
  },
  remove(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      /* Preserve best-effort removal of the request-local contents file. */
    }
  }
};
