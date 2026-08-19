import {
  prepareCredentialStoreIsolation,
  prepareWindowsShim
} from "./support/canvas-harness.js";

// Compiling the Canvas server module now inlines the packaged graph libraries,
// which is a large one-time transform. Doing it inside the first test spends
// that cost against a case's 30s budget and fails on a cold CI cache, so warm
// the loader here instead. This imports the real production module: it is not a
// test-only asset path and nothing about the server is stubbed.
export default async function globalSetup(): Promise<void> {
  await prepareCredentialStoreIsolation();
  await import("../../src/server.js");
  if (process.platform === "win32") await prepareWindowsShim();
}
