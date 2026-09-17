import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createDiscoveryGitHubRead } from "./discovery-github-read.js";
it("pins the authorized account and uses only GET without exposing malformed response bytes", async () => {
  const calls: string[][] = [];
  const get = createDiscoveryGitHubRead({
    verify: async () => portSuccess(undefined),
    executor: async (login) => ({
      login,
      run: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "invalid json", stderr: "" };
      }
    })
  });
  const result = await get(
    "/repos/owner/repo/environments",
    {
      requestId: "read",
      cancellation: { aborted: false, onAbort: () => () => {} }
    },
    {
      operation: "environment.list",
      principalRef: "github:reader",
      authorizationRef: "auth",
      target: { repo: "owner/repo" }
    }
  );
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "EVIDENCE_MISMATCH" }
  });
  expect(JSON.stringify(result)).not.toContain("invalid json");
  expect(calls).toEqual([
    [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "/repos/owner/repo/environments"
    ]
  ]);
});

it.each([
  "forbidden",
  "wrong-repo",
  "wrong-principal",
  "wrong-account",
  "http-403",
  "http-404",
  "throw",
  "cancelled",
  "late-cancel"
] as const)(
  "fails closed on %s without exposing upstream diagnostics",
  async (kind) => {
    const { portForbidden } = await import("@radius-project/core/lifecycle");
    let aborted = kind === "cancelled";
    const scope = {
      operation: "environment.list" as const,
      principalRef: kind === "wrong-principal" ? "unbound" : "github:reader",
      authorizationRef: "auth",
      target: { repo: "owner/repo" }
    };
    const get = createDiscoveryGitHubRead({
      verify: async () =>
        kind === "forbidden" ? portForbidden() : portSuccess(undefined),
      executor: async (login) => {
        if (kind === "throw") throw new Error("Private upstream details");
        return {
          login: kind === "wrong-account" ? "other" : login,
          run: async () => {
            if (kind === "late-cancel") aborted = true;
            return {
              code: kind.startsWith("http") ? 1 : 0,
              stdout: "{}",
              stderr:
                kind === "http-403" ?
                  "HTTP 403 Private upstream details"
                : "HTTP 404 Private upstream details"
            };
          }
        };
      }
    });
    const result = await get(
      kind === "wrong-repo" ?
        "/repos/other/repo/environments"
      : "/repos/owner/repo/environments",
      {
        requestId: "read",
        cancellation: {
          get aborted() {
            return aborted;
          },
          onAbort: () => () => {}
        }
      },
      scope
    );
    expect(result.status).not.toBe("ok");
    expect(JSON.stringify(result)).not.toContain("Private upstream details");
  }
);
