import { describe, expect, it, vi } from "vitest";
import { createDeployModelSource } from "./deploy-model-source.js";
import type { DeploymentFileResult } from "@radius-project/adapter-shared";

const request = [
  { state: {} },
  "acme/app",
  "feature/model",
  ".radius/app.bicep"
] as const;

describe("deployment model source", () => {
  it.each(["readWorkspace", "readRepository", "redactDiagnostic"] as const)(
    "requires the %s port at construction",
    (name) => {
      const ports = {
        readWorkspace: async () => null,
        readRepository: async () => ({
          content: null,
          error: "missing",
          status: 404
        }),
        redactDiagnostic: String
      };
      Reflect.deleteProperty(ports, name);
      expect(() => createDeployModelSource(ports)).toThrow(name);
    }
  );

  it.each(["local model", "", "  "])(
    "preserves eligible workspace content %j without a remote read",
    async (content) => {
      const readRepository = vi.fn(async () => {
        throw new Error("Local content must not read GitHub");
      });
      const readWorkspace = vi.fn(async () => content);
      expect(
        await createDeployModelSource({
          readWorkspace,
          readRepository,
          redactDiagnostic: String
        })(...request)
      ).toEqual({ status: "available", content, fromWorkspace: true });
      expect(readWorkspace).toHaveBeenCalledExactlyOnceWith(
        request[0].state,
        ...request.slice(1)
      );
      expect(readRepository).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      { content: "remote model", error: null, status: 200 },
      { status: "available", content: "remote model", fromWorkspace: false }
    ],
    [
      { content: "", error: null, status: 200 },
      { status: "available", content: "", fromWorkspace: false }
    ],
    [{ content: null, error: "Not Found", status: 404 }, { status: "missing" }],
    [
      { content: null, error: "empty response from gh api", status: 200 },
      { status: "available", content: "", fromWorkspace: false }
    ],
    [
      {
        content: null,
        error: "failed to decode response: malformed",
        status: 200
      },
      { status: "unavailable", error: "failed to decode response: malformed" }
    ],
    [
      { content: null, error: "permission denied", status: 403 },
      { status: "unavailable", error: "permission denied" }
    ],
    [
      { content: null, error: "service unavailable", status: 503 },
      { status: "unavailable", error: "service unavailable" }
    ],
    [
      { content: null, error: "transport timeout", status: null },
      { status: "unavailable", error: "transport timeout" }
    ],
    [
      { content: null, error: null, status: 200 },
      { status: "unavailable", error: "The model source could not be read." }
    ]
  ] satisfies [DeploymentFileResult, object][])(
    "classifies the repository result %j without mistaking failure for absence",
    async (result, expected) => {
      const readRepository = vi.fn(async () => result);
      const read = createDeployModelSource({
        readWorkspace: async () => null,
        readRepository,
        redactDiagnostic: String
      });
      expect(await read(...request)).toEqual(expected);
      expect(readRepository).toHaveBeenCalledExactlyOnceWith(
        "acme/app",
        ".radius/app.bicep",
        "feature/model"
      );
    }
  );

  it.each([new Error("private diagnostic"), "private diagnostic"])(
    "reports and sanitizes unexpected reader failures (%s)",
    async (failure) => {
      const read = createDeployModelSource({
        readWorkspace: async () => null,
        readRepository: async () => {
          throw failure;
        },
        redactDiagnostic: () => "[redacted]"
      });
      expect(await read(...request)).toEqual({
        status: "unavailable",
        error: "[redacted]"
      });
    }
  );

  it("sanitizes an unavailable repository response", async () => {
    const read = createDeployModelSource({
      readWorkspace: async () => null,
      readRepository: async () => ({
        content: null,
        status: 500,
        error: "private diagnostic"
      }),
      redactDiagnostic: () => "[redacted]"
    });
    expect(await read(...request)).toEqual({
      status: "unavailable",
      error: "[redacted]"
    });
  });
});
