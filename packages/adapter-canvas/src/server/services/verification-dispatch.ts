export * from "@radius-project/core/github-radius/environments/verification-dispatch";
import {
  runVerificationDispatch as runSharedDispatch,
  type VerificationDispatchPorts as SharedPorts,
  type VerificationDispatchInput as SharedInput
} from "@radius-project/core/github-radius/environments/verification-dispatch";
import * as operationDomain from "../../operations.js";

export type VerificationDispatchPorts = Omit<SharedPorts, "operationDomain">;
export interface VerificationDispatchInput extends Omit<SharedInput, "ports"> {
  ports: VerificationDispatchPorts;
}
export function runVerificationDispatch(input: VerificationDispatchInput) {
  return runSharedDispatch({
    ...input,
    ports: { ...input.ports, operationDomain }
  });
}
