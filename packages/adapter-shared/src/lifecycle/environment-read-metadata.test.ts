import { expect, it } from "vitest";
import {
  portForbidden,
  portSuccess,
  portUnavailable
} from "@radius-project/core/lifecycle";
import {
  createEnvironmentReadAdapter,
  type EnvironmentReadMetadata
} from "./environment-read.js";

const scope = {
  operation: "environment.inspect" as const,
  principalRef: "reader",
  authorizationRef: "authorization",
  target: { repo: "owner/repo", environment: "dev" }
};
const control = {
  requestId: "read",
  cancellation: { aborted: false, onAbort: () => () => {} }
};

it.each([undefined, 17, "17"])(
  "projects optional compatibility ID %s only from successful configuration evidence",
  async (id) => {
    const observations: EnvironmentReadMetadata[] = [];
    const read = createEnvironmentReadAdapter({
      clock: { now: () => "2026-09-15T00:00:00Z" },
      classifyProvider: () => "",
      get: async (path) =>
        portSuccess(
          path.includes("/variables") ?
            { variables: [{ name: "RADIUS_MANAGED", value: "true" }] }
          : {
              name: "dev",
              protection_rules: [],
              ...(id === undefined ? {} : { id })
            }
        ),
      registrations: async () =>
        portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "radius"
        }),
      metadata: {
        observe: (target, metadata) => {
          expect(target).toEqual(scope.target);
          observations.push(metadata);
        }
      }
    });
    expect(await read.inspect(scope, control)).toMatchObject({ status: "ok" });
    expect(observations).toEqual([
      {
        id: id === undefined ? "" : String(id),
        variables: { RADIUS_MANAGED: "true" }
      }
    ]);
  }
);

it("never publishes compatibility metadata for a failed configuration read", async () => {
  let observed = false;
  const deps = {
    clock: { now: () => "2026-09-15T00:00:00Z" },
    classifyProvider: () => "" as const,
    get: async () => portForbidden(),
    registrations: async (): Promise<never> => {
      throw new Error("No registration read");
    },
    metadata: {
      observe: () => {
        observed = true;
      }
    }
  };
  expect(
    await createEnvironmentReadAdapter(deps).inspect(scope, control)
  ).toMatchObject({ status: "forbidden" });
  expect(observed).toBe(false);
  expect(() =>
    Reflect.apply(createEnvironmentReadAdapter, undefined, [
      { ...deps, metadata: {} }
    ])
  ).toThrow("require");
});
