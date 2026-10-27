import { rmSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

interface CleanupPorts {
  remove(directory: string): void;
  delay(milliseconds: number): Promise<void>;
}

// Match the artifact harness's five linear 100ms filesystem retries, only
// after the caller has settled every owned subprocess.
export async function removeArtifactWorkspace(
  directory: string,
  ports: CleanupPorts = {
    remove: (target) => rmSync(target, { recursive: true, force: true }),
    delay: setTimeout
  }
): Promise<void> {
  for (let retry = 0; ; retry++) {
    try {
      ports.remove(directory);
      return;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ?
          error.code
        : undefined;
      if (
        retry === 5 ||
        typeof code !== "string" ||
        !["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"].includes(code)
      )
        throw error;
      await ports.delay(100 * (retry + 1));
    }
  }
}
