import { vi } from "vitest";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import type { RadiusExtension } from "../../../src/runtime/create-radius-extension.js";
import {
  createFakeDependencies,
  createFakeSession,
  type FakeDependenciesOptions
} from "./fakes.js";

interface JsonSchema {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

interface CanvasContext {
  extensionId: string;
  canvasId: string;
  instanceId: string;
  input?: Record<string, unknown>;
}

type CanvasDeclaration = RadiusExtension["canvases"][number];
type CanvasAction = CanvasDeclaration["actions"][number];

export interface RadiusRegistrationSnapshot {
  canvas: {
    id: string;
    displayName: string;
    description: string;
    inputSchema: JsonSchema;
    actions: Array<{
      name: string;
      description: string;
      inputSchema: JsonSchema;
    }>;
  };
  tools: Array<{
    name: string;
    description: string;
    parameters: JsonSchema;
  }>;
  hooks: string[];
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertSchema(
  schema: JsonSchema,
  value: unknown,
  location: string
): void {
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${location} must be one of ${schema.enum.join(", ")}`);
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${location} must be an object`);
    }
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? []) {
      if (!(required in object)) {
        throw new Error(`${location}.${required} is required`);
      }
    }
    for (const [name, childSchema] of Object.entries(schema.properties ?? {})) {
      if (name in object) {
        assertSchema(childSchema, object[name], `${location}.${name}`);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
    if (schema.items) {
      value.forEach((item, index) =>
        assertSchema(schema.items!, item, `${location}[${index}]`)
      );
    }
  } else if (schema.type && typeof value !== schema.type) {
    throw new Error(`${location} must be a ${schema.type}`);
  }
}

function actionByName(
  declaration: CanvasDeclaration,
  actionName: string
): CanvasAction {
  const action = declaration.actions.find(
    (candidate) => candidate.name === actionName
  );
  if (!action) throw new Error(`Unknown Radius action: ${actionName}`);
  return action;
}

export async function createRuntimeSdkHarness(
  options: FakeDependenciesOptions = {}
) {
  const fake = createFakeDependencies(options);
  let canvasDeclaration: CanvasDeclaration | undefined;
  let extension: RadiusExtension | undefined;
  let lastInput: Record<string, Record<string, unknown> | undefined> = {};
  const routedOpens: CanvasContext[] = [];

  const host = {
    async open(
      instanceId: string,
      input?: Record<string, unknown>
    ): Promise<unknown> {
      if (!canvasDeclaration)
        throw new Error("Radius canvas is not registered");
      const validatedInput = input === undefined ? {} : input;
      assertSchema(
        canvasDeclaration.inputSchema,
        validatedInput,
        "canvas input"
      );
      lastInput[instanceId] = input;
      const context: CanvasContext = {
        extensionId: "plugin:radius",
        canvasId: canvasDeclaration.id,
        instanceId,
        input
      };
      routedOpens.push(context);
      return canvasDeclaration.open(context);
    },
    async invoke(
      instanceId: string,
      actionName: string,
      input?: Record<string, unknown>
    ): Promise<unknown> {
      if (!canvasDeclaration)
        throw new Error("Radius canvas is not registered");
      const action = actionByName(canvasDeclaration, actionName);
      const validatedInput = input === undefined ? {} : input;
      assertSchema(action.inputSchema, validatedInput, `${actionName} input`);
      return action.handler({
        extensionId: "plugin:radius",
        canvasId: canvasDeclaration.id,
        instanceId,
        input
      });
    },
    async rehydrate(instanceId: string): Promise<unknown> {
      return host.open(instanceId, lastInput[instanceId]);
    },
    async close(instanceId: string): Promise<void> {
      if (!canvasDeclaration)
        throw new Error("Radius canvas is not registered");
      await canvasDeclaration.onClose({
        extensionId: "plugin:radius",
        canvasId: canvasDeclaration.id,
        instanceId
      });
      delete lastInput[instanceId];
    }
  };

  const session = createFakeSession({
    rpc: {
      canvas: {
        open: vi.fn(async ({ instanceId, input }) =>
          host.open(instanceId, input)
        )
      }
    }
  });
  const createCanvas = vi.fn((declaration: CanvasDeclaration) => {
    canvasDeclaration = declaration;
    return declaration;
  });
  const joinSession = vi.fn(async () => session);

  extension = await bootstrapRadiusExtension(fake.deps, {
    createCanvas,
    joinSession
  });

  if (!canvasDeclaration) throw new Error("Bootstrap registered no canvas");

  const registration: RadiusRegistrationSnapshot = roundTrip({
    canvas: {
      id: canvasDeclaration.id,
      displayName: canvasDeclaration.displayName,
      description: canvasDeclaration.description,
      inputSchema: canvasDeclaration.inputSchema,
      actions: canvasDeclaration.actions.map(
        ({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema
        })
      )
    },
    tools: extension.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters
    })),
    hooks: Object.keys(extension.hooks).sort()
  });

  return {
    ...fake,
    extension,
    session,
    host,
    registration,
    createCanvas,
    joinSession,
    routedOpens
  };
}
