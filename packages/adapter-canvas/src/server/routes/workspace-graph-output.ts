import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactGhCredentials } from "../../gh.js";
import type { CanvasState } from "../../shared.js";

type GraphSaveOutcome =
  | { status: "saved" }
  | {
      status: "failed";
      phase: "stage" | "read" | "validate" | "write" | "rename";
    };

export function recordModeledGraphSave(
  state: CanvasState,
  repo: string,
  branch: string,
  definitionHash: string,
  outcome: GraphSaveOutcome | undefined
): void {
  if (outcome?.status === "failed") {
    state.graphSaveWarning = {
      workspacePath: state.workspacePath,
      repo,
      branch,
      definitionHash
    };
  } else {
    delete state.graphSaveWarning;
  }
}

/** Recheck request ownership after verifying the selected workspace branches. */
export async function ownsWorkspaceGraphOutput(
  isCurrent: () => boolean,
  ...verifyBranches: Array<(() => Promise<boolean>) | undefined>
): Promise<boolean> {
  if (!isCurrent()) return false;
  for (const verifyBranch of verifyBranches) {
    if (verifyBranch && !(await verifyBranch().catch(() => false)))
      return false;
  }
  return isCurrent();
}

export function stageWorkspaceGraphOutput(
  destination: string,
  logError: (message: string) => void
) {
  if (!destination) return undefined;
  const report = (operation: string, error: unknown) =>
    logError(
      `[radius graph] Could not ${operation}: ${redactGhCredentials(String(error))}`
    );
  const remove = (file: string, recursive = false) => {
    try {
      rmSync(file, { force: true, recursive });
    } catch (error) {
      report("remove graph output", error);
    }
  };
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "radius-graph-output-"));
  } catch (error) {
    report("stage graph output", error);
  }
  const compilerPath = directory && join(directory, "app-graph.json");
  return {
    compilerPath,
    invalidate() {
      remove(destination);
    },
    publish(): GraphSaveOutcome {
      if (!compilerPath) {
        return { status: "failed", phase: "stage" };
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(compilerPath);
      } catch (error) {
        report("read staged graph output", error);
        return { status: "failed", phase: "read" };
      }
      try {
        const document: unknown = JSON.parse(bytes.toString("utf8"));
        if (
          !document ||
          typeof document !== "object" ||
          Array.isArray(document)
        )
          throw new Error("Expected a graph JSON object.");
      } catch {
        report("validate staged graph output", "Invalid graph JSON.");
        return { status: "failed", phase: "validate" };
      }
      const sibling = join(
        dirname(destination),
        `.app-graph-${randomUUID()}.tmp`
      );
      // The compiler's temporary directory may be on a different filesystem.
      // Only this sibling rename replaces the published file.
      let owned = false;
      let phase: "write" | "rename" = "write";
      try {
        // A random name is not an ownership guarantee; exclusive creation is.
        // A failed write after creation is cleaned up by the descriptor owner.
        const fd = openSync(sibling, "wx", 0o600);
        owned = true;
        try {
          writeFileSync(fd, bytes);
        } finally {
          closeSync(fd);
        }
        phase = "rename";
        renameSync(sibling, destination);
        owned = false;
        return { status: "saved" };
      } catch (error) {
        report("publish graph output", error);
        return { status: "failed", phase };
      } finally {
        if (owned) remove(sibling);
      }
    },
    dispose() {
      if (directory) remove(directory, true);
    }
  };
}
