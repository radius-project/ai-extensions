import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isNode, parseDocument } from "yaml";
import {
  DEPLOY_AWS_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE,
  generateDeployWorkflow
} from "@radius-project/core";
import {
  DEPLOY_PROGRESS_SCHEMA_VERSION,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_STATUS_FILES,
  parseDeployProgressArtifact
} from "../../../src/deploy-artifacts.js";
import {
  RADIUS_ACTION_DECLARATIONS,
  RADIUS_CANVAS_PAGES,
  RADIUS_TOOL_DECLARATIONS,
  RADIUS_LIFECYCLE_TOOL_DECLARATION,
  buildRadiusCanvasInputSchema
} from "../../../src/runtime/declarations.js";
import {
  SERVER_ROUTE_DECLARATIONS,
  createServerRouteTable,
  matchRoute,
  routeKey,
  type RouteHandlerRegistry
} from "../../../src/server/route-table.js";
import {
  ACTION_BASELINE,
  CANVAS_BASELINE,
  LEGACY_PROGRESS_BASELINE,
  LEGACY_RESULT_BASELINE,
  ROUTE_BASELINE,
  WORKFLOW_BASELINE
} from "../../fixtures/lifecycle/compatibility-baseline.js";
import { AUTHORING_TOOL_CONTRACTS } from "../../fixtures/lifecycle/authoring-tool-compatibility.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { createTestRouteTable } from "../../support/server/route-table.js";

describe("T001 pre-lifecycle compatibility baseline", () => {
  it("pins all current declarative inputs and the real SDK registration", async () => {
    expect(RADIUS_CANVAS_PAGES).toEqual(
      CANVAS_BASELINE.inputSchema.properties.page.enum
    );
    expect(buildRadiusCanvasInputSchema("graph")).toEqual(
      CANVAS_BASELINE.inputSchema
    );
    expect(RADIUS_ACTION_DECLARATIONS).toEqual(ACTION_BASELINE);
    expect(
      RADIUS_TOOL_DECLARATIONS.filter(
        (tool) => tool.name !== "radius_lifecycle"
      )
    ).toEqual(AUTHORING_TOOL_CONTRACTS);
    expect(
      RADIUS_TOOL_DECLARATIONS.filter(
        (tool) => tool.name === "radius_lifecycle"
      )
    ).toEqual([RADIUS_LIFECYCLE_TOOL_DECLARATION]);

    const harness = await createRuntimeSdkHarness();
    try {
      expect(harness.registration.canvas).toEqual({
        ...CANVAS_BASELINE,
        actions: ACTION_BASELINE
      });
      expect(
        harness.registration.tools.filter(
          (tool) => tool.name !== "radius_lifecycle"
        )
      ).toEqual(AUTHORING_TOOL_CONTRACTS);
      expect(
        harness.registration.tools.filter(
          (tool) => tool.name === "radius_lifecycle"
        )
      ).toEqual([RADIUS_LIFECYCLE_TOOL_DECLARATION]);
      expect(harness.getOrCreateServer).not.toHaveBeenCalled();
    } finally {
      await harness.extension.shutdown("test");
    }
  });

  it("pins every ordered route, owner, matcher, body and mutation policy", () => {
    expect(SERVER_ROUTE_DECLARATIONS).toEqual(ROUTE_BASELINE);
    const routes = createTestRouteTable();
    expect(
      routes.map(
        ({ method, path, match, bodyPolicy, mutationPolicy, owner }) => ({
          method,
          path,
          match,
          bodyPolicy,
          mutationPolicy,
          owner
        })
      )
    ).toEqual(ROUTE_BASELINE);
    expect(new Set(ROUTE_BASELINE.map(routeKey)).size).toBe(
      ROUTE_BASELINE.length
    );

    for (const declaration of ROUTE_BASELINE) {
      const pathname = declaration.path
        .replace(":operationId", "op-example")
        .replace(":code", "verify")
        .replace(":retryKind", "failed");
      const matched = matchRoute(
        routes,
        declaration.method === "ANY" ? "PATCH" : declaration.method,
        pathname
      );
      expect(matched, routeKey(declaration)).toMatchObject(declaration);
    }
  });

  it("preserves route matching precedence, method and segment boundaries", () => {
    const routes = createTestRouteTable();
    expect(matchRoute(routes, undefined, "/api/ping")?.path).toBe("/api/ping");
    expect(matchRoute(routes, "GET", "/api/ping/")).toBeUndefined();
    expect(
      matchRoute(routes, "GET", "/api/operations/op-example/diagnostics")?.path
    ).toBe("/api/operations/:operationId/diagnostics");
    expect(matchRoute(routes, "GET", "/api/operations/op-example")?.path).toBe(
      "/api/operations/"
    );
    expect(
      matchRoute(routes, "POST", "/api/operations/op-example")
    ).toBeUndefined();
    expect(matchRoute(routes, "POST", "/api/operations//stop")).toBeUndefined();
    expect(
      matchRoute(routes, "POST", "/api/operations/op-example/stop/extra")
    ).toBeUndefined();
    expect(matchRoute(routes, "POST", "/api/oidc")).toBeUndefined();
    expect(matchRoute(routes, "GET", "/api/not-declared")).toBeUndefined();
  });

  it("fails construction for missing or undeclared baseline handlers", () => {
    const handlers: RouteHandlerRegistry = Object.fromEntries(
      ROUTE_BASELINE.map((route) => [
        routeKey(route),
        () => {
          throw new Error(`Unexpected handler execution: ${routeKey(route)}`);
        }
      ])
    );
    expect(() => createServerRouteTable(handlers)).not.toThrow();
    const { "ANY /api/ping": ping, ...withoutPing } = handlers;
    expect(() => createServerRouteTable(withoutPing)).toThrow(
      "Missing handler for server route: ANY /api/ping"
    );
    expect(() =>
      createServerRouteTable({ ...handlers, "POST /api/not-declared": ping })
    ).toThrow(
      "Handler registered for undeclared server route: POST /api/not-declared"
    );
  });

  it("retains legacy workflow inputs and provider forwarding without an execution version", () => {
    expect(DEPLOY_DISPATCHER_FILE).toBe(WORKFLOW_BASELINE.dispatcher);
    expect([DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE]).toEqual(
      WORKFLOW_BASELINE.providers
    );
    const templates = Object.fromEntries(
      [WORKFLOW_BASELINE.dispatcher, ...WORKFLOW_BASELINE.providers].map(
        (file) => [
          file,
          readFileSync(
            new URL(
              `../../../../../.github/extension/${file}`,
              import.meta.url
            ),
            "utf8"
          )
        ]
      )
    );
    const source = parseDocument(templates[WORKFLOW_BASELINE.dispatcher]);
    expect(source.errors).toEqual([]);
    const dispatchInputs = source.getIn(["on", "workflow_dispatch", "inputs"]);
    expect(
      isNode(dispatchInputs) ? dispatchInputs.toJSON() : dispatchInputs
    ).toMatchObject(WORKFLOW_BASELINE.dispatchInputs);
    const lifecycleInputs = [
      "lifecycle_version",
      "lifecycle_operation",
      "operation_id",
      "attempt_id",
      "expected_commit"
    ];
    for (const name of lifecycleInputs) {
      expect(
        source.getIn(["on", "workflow_dispatch", "inputs", name, "required"])
      ).toBe(false);
      expect(
        source.getIn(["on", "workflow_dispatch", "inputs", name, "default"])
      ).toBe("");
    }

    const generated = generateDeployWorkflow(
      "dev",
      ".radius/app.bicep",
      templates
    );
    const dispatcher = parseDocument(generated[WORKFLOW_BASELINE.dispatcher]);
    for (const [provider, file] of [
      ["azure", WORKFLOW_BASELINE.providers[0]],
      ["aws", WORKFLOW_BASELINE.providers[1]]
    ]) {
      expect(dispatcher.getIn(["jobs", provider, "uses"])).toBe(
        `./.github/workflows/${file}`
      );
      const forwarded = dispatcher.getIn(["jobs", provider, "with"]);
      expect(isNode(forwarded) ? forwarded.toJSON() : forwarded).toEqual({
        environment: "${{ inputs.environment || 'dev' }}",
        image: "${{ inputs.image }}",
        rad_commands: "${{ inputs.rad_commands }}",
        ...Object.fromEntries(
          lifecycleInputs.map((name) => [name, `\${{ inputs.${name} }}`])
        )
      });
      const workflow = parseDocument(generated[file]);
      expect(workflow.errors).toEqual([]);
      const callInputs = workflow.getIn(["on", "workflow_call", "inputs"]);
      expect(
        isNode(callInputs) ? callInputs.toJSON() : callInputs
      ).toMatchObject({
        environment: {
          description: "GitHub Environment name",
          type: "string",
          required: true
        },
        image: { ...WORKFLOW_BASELINE.dispatchInputs.image, type: "string" },
        rad_commands: {
          ...WORKFLOW_BASELINE.dispatchInputs.rad_commands,
          type: "string"
        }
      });
      for (const name of lifecycleInputs) {
        expect(
          workflow.getIn(["on", "workflow_call", "inputs", name, "required"])
        ).toBe(false);
        expect(
          workflow.getIn(["on", "workflow_call", "inputs", name, "default"])
        ).toBe("");
      }
      const concurrency = workflow.get("concurrency");
      expect(isNode(concurrency) ? concurrency.toJSON() : concurrency).toEqual(
        WORKFLOW_BASELINE.concurrency
      );
    }
  });

  it("retains the command-result artifact publication declaration", () => {
    const action = parseDocument(
      readFileSync(
        new URL(
          "../../../../../.github/extension/actions/run-rad-commands/action.yml",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(action.errors).toEqual([]);
    const steps = action.getIn(["runs", "steps"]);
    expect(isNode(steps) ? steps.toJSON() : steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Upload command result",
          with: expect.objectContaining({
            name: LEGACY_RESULT_BASELINE.command.artifact
          })
        })
      ])
    );
  });

  it("reads legacy numeric progress versions without inferring lifecycle identity", () => {
    expect(DEPLOY_PROGRESS_SCHEMA_VERSION).toBe(
      LEGACY_RESULT_BASELINE.progress.schemaVersion
    );
    expect(DEPLOY_STATUS_FILES.progress).toBe(
      LEGACY_RESULT_BASELINE.progress.file
    );
    expect(DEPLOY_STATUS_ARTIFACT_PREFIX).toBe(
      LEGACY_RESULT_BASELINE.progress.artifactPrefix
    );
    const result = parseDeployProgressArtifact(
      JSON.stringify(LEGACY_PROGRESS_BASELINE)
    );
    expect(result).toEqual(LEGACY_PROGRESS_BASELINE);
    expect(result).not.toHaveProperty("operationId");
    expect(result).not.toHaveProperty("attemptId");
    expect(result).not.toHaveProperty("executionSchemaVersion");
  });

  it.each([undefined, "1", LEGACY_RESULT_BASELINE.command.schemaVersion, 2])(
    "rejects progress version %s rather than treating artifact versions as interchangeable",
    (schemaVersion) => {
      expect(
        parseDeployProgressArtifact(
          JSON.stringify({ ...LEGACY_PROGRESS_BASELINE, schemaVersion })
        )
      ).toBeNull();
    }
  );
});
