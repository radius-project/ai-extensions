import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createGraphsPlanningWritesRoutes,
  handleDiffBranches,
  handleLoadGraph,
  handlePlanGraph,
  type GraphsPlanningWritesDependencies
} from "./graphs-planning-writes.js";
import type {
  GraphPlanningWorkflows,
  GraphWorkflowOutcome,
  GraphWorkflowRequest
} from "./graph-workflows.js";

// The workflow behaviour these routes drive is covered in
// `graph-workflows.test.ts`. What is left here is exactly what the route layer
// owns: reading the body, forwarding the instance, and turning an outcome into
// bytes — including the `Content-Type` asymmetry a `bare` outcome encodes.

interface Recording {
  headers: Record<string, string>;
  headerOrder: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(body: string): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url: "/api/load-graph",
    method: "POST",
    headers: {}
  }) as unknown as IncomingMessage;
}

interface WorkflowCall {
  workflow: keyof GraphPlanningWorkflows;
  request: GraphWorkflowRequest;
}

// A scripted double: it records what the adapter forwarded and returns the
// outcome the scenario wants serialized. It throws for any workflow the
// scenario did not script, so a route wired to the wrong workflow fails loudly
// rather than quietly answering another route's outcome.
function start(
  outcomes: Partial<Record<keyof GraphPlanningWorkflows, GraphWorkflowOutcome>>
) {
  const calls: WorkflowCall[] = [];
  function workflow(name: keyof GraphPlanningWorkflows) {
    return (workflowRequest: GraphWorkflowRequest) => {
      calls.push({ workflow: name, request: workflowRequest });
      const outcome = outcomes[name];
      if (!outcome) throw new Error(`unscripted workflow: ${name}`);
      return Promise.resolve(outcome);
    };
  }
  const dependencies: GraphsPlanningWritesDependencies = {
    workflows: {
      loadGraph: workflow("loadGraph"),
      planGraph: workflow("planGraph"),
      diffBranches: workflow("diffBranches")
    }
  };
  return { calls, dependencies };
}

async function invoke(
  handler: (
    context: ReturnType<typeof createRequestContext>,
    dependencies: GraphsPlanningWritesDependencies
  ) => Promise<void>,
  dependencies: GraphsPlanningWritesDependencies,
  body: string
): Promise<Recording> {
  const { recording, response } = recorder();
  await handler(
    createRequestContext(request(body), response, "panel-a", new Map()),
    dependencies
  );
  return recording;
}

describe("graphs-planning write routes", () => {
  describe("outcome serialization", () => {
    it("sets Content-Type before the status for a json outcome", async () => {
      const { dependencies } = start({
        loadGraph: {
          kind: "json",
          status: 200,
          payload: { reload: true, resources: [] }
        }
      });

      const recording = await invoke(handleLoadGraph, dependencies, "{}");

      expect(recording.status).toBe(200);
      expect(recording.headerOrder).toEqual(["Content-Type"]);
      expect(recording.headers["Content-Type"]).toBe("application/json");
      expect(recording.body).toBe('{"reload":true,"resources":[]}');
    });

    it("writes a bare outcome with no Content-Type at all", async () => {
      const { dependencies } = start({
        loadGraph: { kind: "bare", status: 409, payload: { stale: true } }
      });

      const recording = await invoke(handleLoadGraph, dependencies, "{}");

      expect(recording.status).toBe(409);
      // The legacy branch wrote this one without ever calling `setHeader`, and
      // a client can observe the difference.
      expect(recording.headerOrder).toEqual([]);
      expect(recording.headers["Content-Type"]).toBeUndefined();
      expect(recording.body).toBe('{"stale":true}');
    });

    it("preserves the status of a bare 503 and still serializes its payload", async () => {
      const { dependencies } = start({
        diffBranches: {
          kind: "bare",
          status: 503,
          payload: { error: "Canvas server state is unavailable." }
        }
      });

      const recording = await invoke(handleDiffBranches, dependencies, "{}");

      expect(recording.status).toBe(503);
      expect(recording.headerOrder).toEqual([]);
      expect(recording.body).toBe(
        '{"error":"Canvas server state is unavailable."}'
      );
    });
  });

  describe("workflow invocation", () => {
    it.each([
      ["loadGraph" as const, handleLoadGraph],
      ["planGraph" as const, handlePlanGraph],
      ["diffBranches" as const, handleDiffBranches]
    ])(
      "routes %s to its own workflow with the raw body and instance",
      async (name, handler) => {
        const { calls, dependencies } = start({
          [name]: { kind: "json", status: 200, payload: { ok: true } }
        });

        await invoke(handler, dependencies, '{"repo":"octo/app"}');

        expect(calls).toEqual([
          {
            workflow: name,
            request: { instanceId: "panel-a", body: '{"repo":"octo/app"}' }
          }
        ]);
      }
    );

    it("forwards an unparseable body verbatim rather than rejecting it", async () => {
      // Parsing belongs to the workflow, because only a *parse* failure answers
      // 400. The adapter must not pre-validate and must not swallow the body.
      const { calls, dependencies } = start({
        loadGraph: { kind: "json", status: 400, payload: { error: "bad" } }
      });

      const recording = await invoke(
        handleLoadGraph,
        dependencies,
        "{not json"
      );

      expect(calls[0]?.request.body).toBe("{not json");
      expect(recording.status).toBe(400);
    });

    it("forwards an empty body as an empty string", async () => {
      const { calls, dependencies } = start({
        planGraph: { kind: "json", status: 400, payload: { error: "bad" } }
      });

      await invoke(handlePlanGraph, dependencies, "");

      expect(calls[0]?.request.body).toBe("");
    });
  });

  describe("route registry", () => {
    it("registers exactly the three write routes", () => {
      const { dependencies } = start({});

      expect(
        Object.keys(createGraphsPlanningWritesRoutes(dependencies)).sort()
      ).toEqual([
        "POST /api/diff-branches",
        "POST /api/load-graph",
        "POST /api/plan-graph"
      ]);
    });

    it.each([
      ["POST /api/load-graph", "loadGraph" as const],
      ["POST /api/plan-graph", "planGraph" as const],
      ["POST /api/diff-branches", "diffBranches" as const]
    ])("dispatches %s to the %s workflow", async (key, name) => {
      const { calls, dependencies } = start({
        [name]: { kind: "json", status: 200, payload: { dispatched: name } }
      });
      const routes = createGraphsPlanningWritesRoutes(dependencies);
      const { recording, response } = recorder();

      await routes[key]?.(
        createRequestContext(request("{}"), response, "panel-a", new Map())
      );

      expect(calls.map((call) => call.workflow)).toEqual([name]);
      expect(JSON.parse(recording.body)).toEqual({ dispatched: name });
    });
  });
});
