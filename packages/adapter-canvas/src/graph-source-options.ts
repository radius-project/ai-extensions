import { tmpdir } from "node:os";
import type { GraphSourceBindingOptions } from "@radius-project/adapter-shared";
import { redactGhCredentials } from "./gh.js";

export function graphSourceOptions(
  execute: GraphSourceBindingOptions["execute"]
): GraphSourceBindingOptions {
  return {
    execute,
    redactDiagnostic: redactGhCredentials,
    stagingRoot: tmpdir(),
    diagnostic: (message) => console.error(message)
  };
}
