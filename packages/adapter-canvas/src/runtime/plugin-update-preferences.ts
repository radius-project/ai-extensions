import { createHash } from "node:crypto";
import { mkdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

export interface PluginUpdatePreferences {
  lastAnsweredAt(marketplace: string): Promise<number | undefined>;
  rememberAnswer(marketplace: string, answeredAt: number): Promise<void>;
}

export function createPluginUpdatePreferences(
  directory: string
): PluginUpdatePreferences {
  function markerPath(marketplace: string): string {
    const key = createHash("sha256").update(marketplace).digest("hex");
    return join(directory, key);
  }

  return {
    async lastAnsweredAt(marketplace) {
      try {
        const root = await stat(directory);
        if (!root.isDirectory()) {
          throw new Error(
            "Invalid Radius plugin update preferences directory."
          );
        }
        const marker = await stat(markerPath(marketplace));
        if (!marker.isDirectory()) {
          throw new Error("Invalid Radius plugin update answer record.");
        }
        return marker.mtimeMs;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      }
    },
    async rememberAnswer(marketplace, answeredAt) {
      // Directory metadata avoids partially written timestamp files.
      const marker = markerPath(marketplace);
      await mkdir(marker, { recursive: true });
      const timestamp = new Date(answeredAt);
      await utimes(marker, timestamp, timestamp);
    }
  };
}
