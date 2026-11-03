import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

interface PluginUpdateIdentity {
  marketplace: string;
  version: string;
}

export interface PluginUpdatePreferences {
  hasDeclined(identity: PluginUpdateIdentity): Promise<boolean>;
  rememberDecline(identity: PluginUpdateIdentity): Promise<void>;
}

export function createPluginUpdatePreferences(
  directory: string
): PluginUpdatePreferences {
  function markerPath(identity: PluginUpdateIdentity): string {
    const key = createHash("sha256")
      .update(JSON.stringify([identity.marketplace, identity.version]))
      .digest("hex");
    return join(directory, key);
  }

  return {
    async hasDeclined(identity) {
      try {
        const root = await stat(directory);
        if (!root.isDirectory()) {
          throw new Error(
            "Invalid Radius plugin update preferences directory."
          );
        }
        const marker = await stat(markerPath(identity));
        if (!marker.isDirectory()) {
          throw new Error("Invalid Radius plugin update decline record.");
        }
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return false;
        }
        throw error;
      }
    },
    async rememberDecline(identity) {
      // An empty directory is an atomic, idempotent marker across processes.
      await mkdir(markerPath(identity), { recursive: true });
    }
  };
}
