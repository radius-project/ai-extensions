// Reads the Radius version the installed Radius CLI compiles with, in the form
// the origin record saves it (`0.60`, `0.61.0-rc1`, `latest`). The canvas
// compares it with the record's `radiusVersion` to notice a Radius upgrade.
//
// The version comes from the same two steps a graph build uses, so the canvas
// and the compile always agree on it: resolve the `rad` binary, waiting for the
// plugin's own load-time CLI update to finish, then map its release to the
// Radius Bicep extension. An edge release maps only when the user set the
// developer override, the same rule the skill follows.

import { radiusVersionFromExtensionRef } from "@radius-project/adapter-shared";

export interface RadiusCliVersionOptions {
  resolveRadPath(): Promise<string>;
  resolveExtensionRef(radPath: string): Promise<string | null>;
}

// Reads once per plugin load and reuses the answer, since the managed CLI only
// changes when the plugin loads. A failed read is not kept: "" means unknown,
// which skips the check, so the next graph open asks again.
export function createRadiusCliVersionReader(
  options: RadiusCliVersionOptions
): () => Promise<string> {
  let pending: Promise<string> | null = null;

  async function read(): Promise<string> {
    try {
      const radPath = await options.resolveRadPath();
      return radiusVersionFromExtensionRef(
        await options.resolveExtensionRef(radPath)
      );
    } catch {
      return "";
    }
  }

  return () => {
    pending ??= read().then((version) => {
      if (!version) pending = null;
      return version;
    });
    return pending;
  };
}
