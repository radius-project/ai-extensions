import { describe, expect, it } from "vitest";
import { createApplicationDiscovery } from "./discovery.js";
import { portForbidden, portSuccess, portUnavailable } from "./errors.js";
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
const control: RequestControl = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const observation = {
  quality: "current" as const,
  completeness: "complete" as const,
  evidence: "radius" as const,
  observedAt: "2026-09-15T00:00:00Z"
};
const scope: AuthorizedScope<"application.list"> = {
  authorizationRef: "authorization",
  principalRef: caller.principalRef,
  operation: "application.list",
  target: { repo: "owner/repo", environment: "dev" }
};
function fixture() {
  let sequence = 0;
  let now = observation.observedAt;
  let reads = 0;
  const service = createApplicationDiscovery({
    ids: { next: () => `cursor-${++sequence}` },
    clock: { now: () => now },
    read: {
      list: async () => {
        reads++;
        return portSuccess({
          target: scope.target,
          observation,
          items: ["one", "two"].map((application) => ({
            target: { repo: "owner/repo", application },
            deployed: [{ environment: "dev", observation }],
            observation
          }))
        });
      },
      inspect: async () => {
        throw new Error("Unmodeled inspection");
      }
    }
  });
  return {
    service,
    reads: () => reads,
    expire: () => {
      now = "2026-09-15T01:00:00Z";
    }
  };
}
describe("application discovery", () => {
  it("pages one stable observation without rereading or merging same names across scopes", async () => {
    const f = fixture();
    const first = await f.service.list(scope, { pageSize: 1 }, caller, control);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("Expected page");
    const second = await f.service.list(
      scope,
      {
        pageSize: 1,
        continuationToken: first.value.continuationToken
      },
      caller,
      control
    );
    expect(second).toMatchObject({
      status: "ok",
      value: { items: [{ target: { application: "two" } }] }
    });
    expect(f.reads()).toBe(1);
    expect(first.value.items[0]?.deployed?.[0]?.environment).toBe("dev");
  });
  it.each(["caller", "scope", "filter", "stale"] as const)(
    "rejects %s cursor mismatch",
    async (kind) => {
      const f = fixture();
      const first = await f.service.list(
        scope,
        { pageSize: 1 },
        caller,
        control
      );
      if (first.status !== "ok") throw new Error("Expected page");
      if (kind === "stale") f.expire();
      expect(
        await f.service.list(
          kind === "scope" ?
            { ...scope, target: { ...scope.target, environment: "prod" } }
          : scope,
          {
            pageSize: kind === "filter" ? 2 : 1,
            continuationToken: first.value.continuationToken
          },
          kind === "caller" ?
            { ...caller, sessionRef: "another-session" }
          : caller,
          control
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "PRECONDITION_FAILED" }
      });
      expect(f.reads()).toBe(1);
    }
  );
  it.each([0, 101, 1.5])(
    "rejects invalid page size %s without IO",
    async (pageSize) => {
      const f = fixture();
      expect(
        await f.service.list(scope, { pageSize }, caller, control)
      ).toMatchObject({ status: "failed" });
      expect(f.reads()).toBe(0);
    }
  );
  it("never turns forbidden or unavailable evidence into an empty successful page", async () => {
    for (const result of [
      portForbidden(),
      portUnavailable("RESULT_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "workflow"
      })
    ]) {
      const service = createApplicationDiscovery({
        ids: { next: () => "cursor" },
        clock: { now: () => observation.observedAt },
        read: { list: async () => result, inspect: async () => result }
      });
      expect(await service.list(scope, {}, caller, control)).toEqual(result);
    }
  });
});
