import { expect, it } from "vitest";
import { createEnvironmentDiscovery } from "./environments-read.js";
import { portSuccess, portForbidden } from "./errors.js";

it("guards construction, list scope, cancellation and context shutdown", async () => {
  expect(() =>
    Reflect.apply(createEnvironmentDiscovery, undefined, [{}])
  ).toThrow("requires");
  const target = { repo: "owner/repo" };
  let aborted = false;
  const service = createEnvironmentDiscovery({
    ids: { next: () => "cursor" },
    clock: { now: () => "2026-09-15T00:00:00Z" },
    read: {
      list: async () =>
        portSuccess({
          target,
          items: [],
          observation: {
            quality: "current",
            completeness: "complete",
            evidence: "configuration"
          }
        }),
      inspect: async () => {
        aborted = true;
        return portForbidden();
      }
    }
  });
  const scope = {
    operation: "environment.list" as const,
    target,
    principalRef: "reader",
    authorizationRef: "auth"
  };
  const caller = {
    principalRef: "reader",
    identityRef: "identity",
    sessionRef: "session",
    responder: "user" as const
  };
  const control = {
    requestId: "read",
    cancellation: {
      get aborted() {
        return aborted;
      },
      onAbort: () => () => {}
    }
  };
  expect(await service.list(scope, {}, caller, control)).toMatchObject({
    status: "ok",
    value: { items: [] }
  });
  expect(
    await service.list(
      { ...scope, operation: "application.list" },
      {},
      caller,
      control
    )
  ).toMatchObject({ status: "failed" });
  const selected = {
    ...scope,
    operation: "environment.inspect" as const,
    target: { ...target, environment: "dev" }
  };
  expect(await service.inspect(selected, control)).toMatchObject({
    status: "cancelled"
  });
  expect(await service.inspect(selected, control)).toMatchObject({
    status: "cancelled"
  });
  aborted = false;
  service.close();
  expect(await service.inspect(selected, control)).toMatchObject({
    status: "cancelled"
  });
});
