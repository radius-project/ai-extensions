import { expect, it } from "vitest";
import { portSuccess, portForbidden } from "@radius-project/core/lifecycle";
import { createDeployedApplicationRead } from "./deployed-application-read.js";
const scope = {
  operation: "application.list" as const,
  principalRef: "reader",
  authorizationRef: "auth",
  target: { repo: "owner/repo", environment: "dev" }
};
const control = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
it.each(
  [
    [],
    [
      {
        environment: "dev",
        payload: { application: "app" },
        updated_at: "2026-09-15T00:00:00Z"
      }
    ],
    [
      { environment: "dev", payload: { application: "app" } },
      {
        environment: "dev",
        payload: { application: "app" },
        updated_at: "invalid"
      }
    ]
  ].map((rows) => ({ rows }))
)(
  "retains scoped historical evidence without manufacturing current Radius state",
  async ({ rows }) => {
    const read = createDeployedApplicationRead({
      clock: { now: () => "2026-09-15T00:00:00Z" },
      get: async () => portSuccess(rows)
    });
    const result = await read(scope, control);
    expect(result).toMatchObject({
      status: "ok",
      value: { observation: { completeness: "complete" } }
    });
    if (result.status !== "ok") throw new Error("Expected observations");
    expect(result.value.items).toHaveLength(rows.length ? 1 : 0);
    const timestamp =
      rows[0] && "updated_at" in rows[0] ? rows[0].updated_at : undefined;
    for (const item of result.value.items) {
      expect(item.observation).toMatchObject({
        quality: timestamp ? "stale" : "unknown",
        completeness: "partial"
      });
      expect(item.observation.observedAt).toBe(timestamp);
    }
  }
);
it("rejects missing scopes, cancellation, denied reads and malformed or mismatched observations", async () => {
  for (const value of [
    null,
    [null],
    [{ environment: "dev", payload: { application: "has spaces" } }],
    [{ environment: "dev", payload: { application: "a".repeat(129) } }],
    [{ environment: "other", payload: {} }],
    [{ environment: "dev", payload: { application: "" } }]
  ]) {
    const read = createDeployedApplicationRead({
      clock: { now: () => "" },
      get: async () => portSuccess(value)
    });
    expect((await read(scope, control)).status).not.toBe("ok");
  }
  const denied = createDeployedApplicationRead({
    clock: { now: () => "" },
    get: async () => portForbidden()
  });
  expect(await denied(scope, control)).toMatchObject({ status: "forbidden" });
  expect(
    await denied({ ...scope, target: { repo: "owner/repo" } }, control)
  ).toMatchObject({ status: "failed" });
  expect(
    await denied(scope, {
      ...control,
      cancellation: { ...control.cancellation, aborted: true }
    })
  ).toMatchObject({ status: "cancelled" });
  const bounded = createDeployedApplicationRead({
    clock: { now: () => "2026-09-15T00:00:00Z" },
    get: async () =>
      portSuccess(
        Array.from({ length: 100 }, (_, index) => ({
          environment: "dev",
          payload: { application: `app-${index}` },
          updated_at: "invalid"
        }))
      )
  });
  expect(await bounded(scope, control)).toMatchObject({
    status: "ok",
    value: { observation: { completeness: "partial" } }
  });
});
it("does not treat a loosely parsed non-timestamp as dated deployment evidence", async () => {
  const read = createDeployedApplicationRead({
    clock: { now: () => "2026-09-15T00:00:00Z" },
    get: async () =>
      portSuccess([
        {
          environment: "dev",
          payload: { application: "app" },
          updated_at: "123"
        }
      ])
  });
  const result = await read(scope, control);
  expect(result).toMatchObject({
    status: "ok",
    value: { items: [{ observation: { quality: "unknown" } }] }
  });
  if (result.status !== "ok")
    throw new Error("Expected bounded historical evidence");
  expect(result.value.items[0].observation.observedAt).toBeUndefined();
});
