import { expect, it } from "vitest";
import {
  LIFECYCLE_API_VERSION,
  type LifecycleRequestFor
} from "@radius-project/core/lifecycle";
import {
  createLifecycleFixture,
  authorizeFixture
} from "../../test/support/lifecycle.js";
import {
  createLifecycleGraphRegistrations,
  graphCapabilities
} from "./lifecycle-graphs.js";

it("advertises only read operations with explicit source, registration, and deployed-evidence limitations", () => {
  expect(graphCapabilities.map((capability) => capability.operation)).toEqual([
    "graph.get",
    "graph.diff"
  ]);
  for (const capability of graphCapabilities) {
    expect(capability.contexts).toEqual(["workspace", "git", "environment"]);
    expect(capability.requiresAgent).toBe(false);
    expect(capability.limitations.join(" ")).toContain(
      "actual selected-environment recipe registrations"
    );
    expect(capability.limitations.join(" ")).toContain(
      "authored graphs are never substituted"
    );
  }
});

it("registers real graph handlers and rejects late requests after close without touching strict source ports", async () => {
  const fixture = createLifecycleFixture();
  const graphs = createLifecycleGraphRegistrations(fixture.ports);
  const request: LifecycleRequestFor<"graph.get"> = {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-test",
    operation: "graph.get",
    target: {
      repo: "owner/repo",
      definition: ".radius/app.bicep",
      source: { kind: "git", ref: "main", expectedCommit: "a".repeat(40) }
    },
    input: { kind: "authored" }
  };
  const handler = graphs.registrations.find(
    (registration) => registration.operation === "graph.get"
  );
  if (!handler) throw new Error("Missing graph registration");
  graphs.close();
  const response = await handler.execute(request, {
    caller: fixture.caller,
    scope: authorizeFixture({
      caller: fixture.caller,
      operation: request.operation,
      target: request.target
    }),
    control: {
      requestId: request.requestId,
      cancellation: { aborted: false, onAbort: () => () => {} }
    }
  });

  expect(response).toMatchObject({
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: request.requestId,
    error: { code: "PRECONDITION_FAILED" }
  });
  await fixture.binding.close();
});

it("maps a closed diff read to a lifecycle failure without invoking source or compiler ports", async () => {
  const fixture = createLifecycleFixture();
  const graphs = createLifecycleGraphRegistrations(fixture.ports);
  const target = {
    repo: "owner/repo",
    definition: ".radius/app.bicep",
    source: {
      kind: "git" as const,
      ref: "main",
      expectedCommit: "a".repeat(40)
    }
  };
  const request: LifecycleRequestFor<"graph.diff"> = {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-diff",
    operation: "graph.diff",
    target: { repo: target.repo },
    input: { kind: "authored", base: target, head: target }
  };
  const handler = graphs.registrations.find(
    (item) => item.operation === "graph.diff"
  );
  if (!handler) throw new Error("Missing diff registration");
  graphs.close();
  expect(
    await handler.execute(request, {
      caller: fixture.caller,
      scope: authorizeFixture({
        caller: fixture.caller,
        operation: request.operation,
        target: request.target
      }),
      control: {
        requestId: request.requestId,
        cancellation: { aborted: false, onAbort: () => () => {} }
      }
    })
  ).toMatchObject({
    requestId: "request-diff",
    error: { code: "PRECONDITION_FAILED" }
  });
  await fixture.binding.close();
});
