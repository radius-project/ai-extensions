import {
  E2E_TMP_ROOT,
  removeDirectoryWithRetries
} from "./support/canvas-harness.js";

// Each journey removes its own isolated workspace, but Windows can still hold a
// lock on a fake CLI executable when the last case finishes. Sweeping the root
// once here guarantees the suite leaves no temporary workspace behind without
// letting a transient lock fail a journey.
export default async function globalTeardown(): Promise<void> {
  await removeDirectoryWithRetries(E2E_TMP_ROOT);
}
