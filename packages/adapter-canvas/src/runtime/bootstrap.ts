import {
  createRadiusExtension,
  type RadiusExtension
} from "./create-radius-extension.js";
import type { RadiusExtensionDependencies } from "./dependencies.js";
import type { SessionPort } from "./session.js";

type RadiusCanvasDeclaration = RadiusExtension["canvases"][number];
type RadiusToolDeclarations = RadiusExtension["tools"];
type RadiusHooks = RadiusExtension["hooks"];

export interface RadiusSessionDeclaration<Canvas> {
  canvases: Canvas[];
  tools: RadiusToolDeclarations;
  hooks: RadiusHooks;
}

export interface RadiusSdk<Canvas> {
  createCanvas(declaration: RadiusCanvasDeclaration): Canvas;
  joinSession(
    declaration: RadiusSessionDeclaration<Canvas>
  ): Promise<SessionPort>;
}

export async function bootstrapRadiusExtension<Canvas>(
  dependencies: RadiusExtensionDependencies,
  sdk: RadiusSdk<Canvas>
): Promise<RadiusExtension> {
  const extension = createRadiusExtension(dependencies);
  const declaration = {
    canvases: extension.canvases.map((canvas) => sdk.createCanvas(canvas)),
    tools: extension.tools,
    hooks: extension.hooks
  };
  const session = await sdk.joinSession(declaration);
  extension.attachSession(session);
  return extension;
}
