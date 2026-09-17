import { expect, it } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createDeployedApplicationRead } from "./deployed-application-read.js";
it("never invents an application identity from an uncorrelated GitHub deployment", async () => {
  const read = createDeployedApplicationRead({
    clock: { now: () => "2026-09-15T00:00:00Z" },
    get: async () => portSuccess([{ environment: "dev", payload: {} }])
  });
  expect(
    await read(
      {
        operation: "application.list",
        principalRef: "reader",
        authorizationRef: "auth",
        target: { repo: "owner/repo", environment: "dev" }
      },
      {
        requestId: "read",
        cancellation: { aborted: false, onAbort: () => () => {} }
      }
    )
  ).toMatchObject({
    status: "unavailable",
    error: { code: "RESULT_UNAVAILABLE" }
  });
});
