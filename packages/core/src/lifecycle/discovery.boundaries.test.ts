import { expect, it } from "vitest";
import { createApplicationDiscovery } from "./discovery.js";
import { portSuccess, portUnavailable } from "./errors.js";
import type { ApplicationPage, ApplicationReadPort } from "./discovery.js";
import type {
  AuthorizedScope,
  CallerContext,
  RequestControl
} from "./ports.js";

const caller: CallerContext = {
  principalRef: "reader",
  identityRef: "identity",
  sessionRef: "session",
  responder: "user"
};
const scope: AuthorizedScope<"application.list"> = {
  principalRef: "reader",
  authorizationRef: "auth",
  operation: "application.list",
  target: { repo: "owner/repo", environment: "dev" }
};
const inspect: AuthorizedScope<"application.inspect"> = {
  ...scope,
  operation: "application.inspect",
  target: { ...scope.target, environment: "dev", application: "app" }
};
const control: RequestControl = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const observation = {
  quality: "current" as const,
  completeness: "complete" as const,
  evidence: "radius" as const
};
const item = {
  target: { repo: "owner/repo", application: "app" },
  observation
};
it("fences an inspection result completed after the discovery context closes", async () => {
  const service = fixture({
    read: {
      inspect: async () => {
        await Promise.resolve();
        return portSuccess(item);
      }
    }
  });
  const pending = service.inspect(inspect, control);
  service.close();
  expect(await pending).toMatchObject({ status: "cancelled" });
});
function fixture(
  options: {
    count?: number;
    id?: () => string;
    now?: string;
    read?: Partial<ApplicationReadPort>;
  } = {}
) {
  let sequence = 0;
  const read: ApplicationReadPort = {
    list: async () =>
      portSuccess({
        target: scope.target,
        observation,
        items: Array.from({ length: options.count ?? 2 }, () => item)
      }),
    inspect: async () => portSuccess(item),
    ...options.read
  };
  return createApplicationDiscovery({
    read,
    ids: { next: options.id ?? (() => `cursor-${++sequence}`) },
    clock: { now: () => options.now ?? "2026-09-15T00:00:00Z" }
  });
}
it("requires complete dependencies, authorized caller and a usable clock", async () => {
  expect(() =>
    Reflect.apply(createApplicationDiscovery, undefined, [{}])
  ).toThrow("requires");
  expect(
    await fixture().list(
      scope,
      {},
      { ...caller, principalRef: "other" },
      control
    )
  ).toMatchObject({ status: "forbidden" });
  expect(
    await fixture({ now: "invalid" }).list(scope, {}, caller, control)
  ).toMatchObject({ status: "failed" });
  expect(
    await fixture().list(
      { ...scope, operation: "environment.list" },
      {},
      caller,
      control
    )
  ).toMatchObject({ status: "failed" });
});
it.each([0, 1, 100])(
  "returns bounded empty/small/maximum pages of %s without a cursor",
  async (count) => {
    const result = await fixture({ count }).list(scope, {}, caller, control);
    if (result.status !== "ok") throw new Error("Expected page");
    expect(result.value.items).toHaveLength(count);
    expect(result.value.continuationToken).toBeUndefined();
  }
);
it("isolates caller mutations from subsequent pages and rejects duplicate cursor IDs", async () => {
  const service = fixture({ count: 3, id: () => "cursor" });
  const first = await service.list(scope, { pageSize: 1 }, caller, control);
  if (first.status !== "ok") throw new Error("Expected page");
  first.value.observation.quality = "unknown";
  const next = await service.list(
    scope,
    { pageSize: 1, continuationToken: first.value.continuationToken },
    caller,
    control
  );
  expect(next).toMatchObject({
    status: "failed",
    error: { code: "PRECONDITION_FAILED" }
  });
  const stable = fixture();
  const start = await stable.list(scope, { pageSize: 1 }, caller, control);
  if (start.status !== "ok") throw new Error("Expected page");
  start.value.observation.quality = "unknown";
  expect(
    await stable.list(
      scope,
      { pageSize: 1, continuationToken: start.value.continuationToken },
      caller,
      control
    )
  ).toMatchObject({
    status: "ok",
    value: { observation: { quality: "current" } }
  });
});
it("bounds session cursor retention without evicting a known cursor or restarting a read", async () => {
  const service = fixture();
  for (let index = 0; index < 100; index++)
    expect(
      (await service.list(scope, { pageSize: 1 }, caller, control)).status
    ).toBe("ok");
  expect(
    await service.list(scope, { pageSize: 1 }, caller, control)
  ).toMatchObject({ status: "failed" });
});
it("fences pending reads and all reads after context close", async () => {
  let finish:
    | ((value: ReturnType<typeof portSuccess<ApplicationPage>>) => void)
    | undefined;
  const service = fixture({
    read: {
      list: () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    }
  });
  const pending = service.list(scope, {}, caller, control);
  service.close();
  if (!finish) throw new Error("Read did not start");
  finish(portSuccess({ target: scope.target, observation, items: [] }));
  expect(await pending).toMatchObject({ status: "cancelled" });
  expect(await service.list(scope, {}, caller, control)).toMatchObject({
    status: "cancelled"
  });
  expect(await service.inspect(inspect, control)).toMatchObject({
    status: "cancelled"
  });
});
it("checks inspection shape and cancellation and retains explicit unavailable evidence", async () => {
  const unavailable = portUnavailable("RESULT_UNAVAILABLE", {
    quality: "unknown",
    completeness: "unavailable",
    evidence: "radius"
  });
  expect(
    await fixture({ read: { inspect: async () => unavailable } }).inspect(
      inspect,
      control
    )
  ).toEqual(unavailable);
  expect(
    await Reflect.apply(fixture().inspect, undefined, [
      { ...inspect, target: { repo: "owner/repo", application: "app" } },
      control
    ])
  ).toMatchObject({ status: "failed", error: { code: "INVALID_REQUEST" } });
  let aborted = false;
  const cancel = {
    ...control,
    cancellation: {
      ...control.cancellation,
      get aborted() {
        return aborted;
      }
    }
  };
  const service = fixture({
    read: {
      inspect: async () => {
        aborted = true;
        return portSuccess(item);
      }
    }
  });
  expect(await service.inspect(inspect, cancel)).toMatchObject({
    status: "cancelled"
  });
  expect(await service.inspect(inspect, cancel)).toMatchObject({
    status: "cancelled"
  });
});

it("rejects apparently valid observations returned for another scope", async () => {
  for (const target of [
    { repo: "other/repo", application: "app" },
    { repo: "owner/repo", application: "other" }
  ])
    expect(
      await fixture({
        read: { inspect: async () => portSuccess({ ...item, target }) }
      }).inspect(inspect, control)
    ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  expect(
    await fixture({
      read: {
        list: async () =>
          portSuccess({
            target: { repo: "other/repo" },
            items: [],
            observation
          })
      }
    }).list(scope, {}, caller, control)
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
});
