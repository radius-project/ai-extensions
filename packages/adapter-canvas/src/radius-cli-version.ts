// Reads the Radius version the installed Radius CLI compiles with, in the form
// the origin record saves it (`0.60`, `0.61.0-rc1`, `latest`). The canvas
// compares it with the record's `radiusVersion` to notice a Radius upgrade.
//
// The read itself is adapter-shared's resolveInstalledRadiusVersion, injected
// here. It waits for the plugin's load-time CLI update, starting it if needed,
// so it never reports a CLI that update is about to replace.

// Shares a read only while it is in flight, so the branches of one diff view
// spawn the CLI once. A finished answer is never kept: the managed CLI lives in
// a directory every plugin process on the machine shares, and another session's
// load-time update can replace it at any time. Graph builds read the release on
// every compile for the same reason, so a kept answer could disagree with the
// version the graph actually compiles against. A failed read reports "", which
// is unknown and skips the check.
export function createRadiusCliVersionReader(
  readVersion: () => Promise<string>
): () => Promise<string> {
  let pending: Promise<string> | null = null;

  return () => {
    pending ??= readVersion()
      .catch(() => "")
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
