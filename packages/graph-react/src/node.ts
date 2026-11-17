import { createElement as h, useContext } from "react";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import type { ReactElement } from "react";
import type { GraphNodeData } from "./build.js";
import { NodeInteractionContext, ResourceNodeCard } from "./node-card.js";

export {
  NodeInteractionContext,
  fitTypeLabel,
  portalLinkLabel
} from "./node-card.js";
export type { NodeInteraction } from "./node-card.js";

export type ResourceFlowNode = Node<GraphNodeData, "rad">;

export function ResourceNode({
  data
}: NodeProps<ResourceFlowNode>): ReactElement {
  const interaction = useContext(NodeInteractionContext);
  if (!interaction)
    throw new Error("ResourceNode must be rendered inside RadiusGraph.");
  return h(ResourceNodeCard, {
    data,
    interaction,
    targetHandle: h(Handle, {
      type: "target",
      position: Position.Top,
      isConnectable: false,
      className: "rad-handle"
    }),
    sourceHandle: h(Handle, {
      type: "source",
      position: Position.Bottom,
      isConnectable: false,
      className: "rad-handle"
    })
  });
}
