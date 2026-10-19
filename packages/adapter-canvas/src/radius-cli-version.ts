// Remembers the Radius version the installed Radius CLI compiles with, in the
// form the origin record saves it (`0.60`, `0.61.0-rc1`, `latest`). The canvas
// compares it with the record's `radiusVersion` to notice a Radius upgrade.
//
// The read itself is adapter-shared's resolveInstalledRadiusVersion, injected
// here. It waits for the plugin's load-time CLI update, starting it if needed,
// so the version kept below is never the one that update is about to replace.

// Reads once per plugin load and reuses the answer, since the managed CLI only
// changes when the plugin loads. A failed or empty read is not kept: "" means
// unknown, which skips the check, so the next graph open asks again.
export function createRadiusCliVersionReader(
  readVersion: () => Promise<string>
): () => Promise<string> {
  let pending: Promise<string> | null = null;

  return () => {
    pending ??= readVersion().then(
      (version) => {
        if (!version) pending = null;
        return version;
      },
      () => {
        pending = null;
        return "";
      }
    );
    return pending;
  };
}
