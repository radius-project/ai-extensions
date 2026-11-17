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

/** Call publication and invalidation only after synchronous request admission. */
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
    publish() {
      if (!compilerPath) {
        remove(destination);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(compilerPath);
      } catch (error) {
        report("read staged graph output", error);
        remove(destination);
        return;
      }
      const sibling = join(
        dirname(destination),
        `.app-graph-${randomUUID()}.tmp`
      );
      // The compiler's temporary directory may be on a different filesystem.
      // Only this sibling rename replaces the published file.
      let owned = false;
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
        renameSync(sibling, destination);
        owned = false;
      } catch (error) {
        report("publish graph output", error);
      } finally {
        if (owned) remove(sibling);
      }
    },
    dispose() {
      if (directory) remove(directory, true);
    }
  };
}
