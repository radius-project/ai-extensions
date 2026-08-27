// Session-scoped ownership of the one Radius canvas panel.
//
// The host may restore an existing panel after the extension process restarts,
// so the first provider open is authoritative even when its instance ID predates
// the current canonical default. Later opens must target that same instance.

export interface RadiusCanvasInstanceRegistry {
  claim(instanceId: string): string;
  current(): string | undefined;
  release(instanceId: string): void;
}

export function createRadiusCanvasInstanceRegistry(): RadiusCanvasInstanceRegistry {
  let activeInstanceId: string | undefined;
  return {
    claim(instanceId) {
      activeInstanceId ??= instanceId;
      return activeInstanceId;
    },
    current() {
      return activeInstanceId;
    },
    release(instanceId) {
      if (activeInstanceId === instanceId) activeInstanceId = undefined;
    }
  };
}
