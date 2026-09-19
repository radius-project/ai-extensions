import { describe, expect, it } from "vitest";
import { createWorkflowScopeGhRunner } from "./create-environment-gh-runner.js";
import {
  createOperation,
  operationDomain
} from "../../../../core/test/support/environment-operation-domain.js";

describe("Node environment variable identity adapter", () => {
  it("passes the SHA256 value identity and pinned executor to the shared sequence", async () => {
    const operation = createOperation();
    const records: object[] = [];
    const writes: string[][] = [];
    const unexpected = (): never => {
      throw new Error("Unexpected Node adapter call");
    };
    const runner = createWorkflowScopeGhRunner(
      {
        operationDomain,
        cliExec: unexpected,
        readProcessEnv: unexpected
      },
      {
        targetRepo: "octo/app",
        envName: "dev",
        environmentProviderId: "env-1",
        mutationRecovery: {
          operation,
          persist: async () => {},
          recordVariable: (entry) => {
            records.push(entry);
          }
        }
      },
      {
        login: "octocat",
        credentialSource: "keyring",
        requiresKeyringSwitch: false,
        scopes: ["repo"],
        run: async (args) => {
          if (args[0] === "variable") {
            writes.push(args);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[1]?.includes("/variables/A"))
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
          if (args[1] === "/repos/octo/app/environments/dev")
            return {
              code: 0,
              stdout: '{"id":"env-1","name":"dev"}',
              stderr: ""
            };
          return unexpected();
        },
        runOrThrow: unexpected,
        verifyIdentity: unexpected,
        packageCredentials: unexpected,
        redact: (value) => value,
        errorMessage: String
      }
    );
    expect(await runner.setEnvironmentVariable("A", "1")).toBe(true);
    expect(writes).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        name: "A",
        valueSha256:
          "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
        previousKnown: true
      })
    ]);
  });
});
