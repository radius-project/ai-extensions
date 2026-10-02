import type { RadiusGraphProps } from "@radius-project/graph-react";
import type { GraphMount } from "../../../src/browser/graph/surface.js";

export function createRecordingMount() {
  const roots: Array<{
    host: unknown;
    props: RadiusGraphProps;
    updates: RadiusGraphProps[];
    unmounts: number;
  }> = [];
  const mount: GraphMount = (host, props) => {
    const root = {
      host,
      props,
      updates: [] as RadiusGraphProps[],
      unmounts: 0
    };
    roots.push(root);
    return {
      update(next) {
        root.updates.push(next);
        return true;
      },
      unmount() {
        root.unmounts++;
      }
    };
  };
  return { mount, roots };
}
