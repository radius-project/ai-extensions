import type { ManagedModelStaging } from "../../../../extensions/radius/skills/radius-app-bicep/scripts/app-model-staging.mjs";

export interface AuthoringTarget {
  repo: string;
  branch: string;
  workspace: string;
  sourceRevision: string;
}

interface AuthoringRequest {
  token: string;
  target: AuthoringTarget;
  staging: ManagedModelStaging;
  current(): boolean;
  inFlight: number;
  finalizing: boolean;
}

function sameTarget(left: AuthoringTarget, right: AuthoringTarget): boolean {
  return (
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.workspace === right.workspace &&
    left.sourceRevision === right.sourceRevision
  );
}

export function createModelAuthoringOwner(ports: {
  staging(workspace: string): ManagedModelStaging;
  resolveTarget(): Promise<AuthoringTarget | null>;
  validate(staging: ManagedModelStaging): Promise<void>;
}) {
  const requests = new Map<string, AuthoringRequest>();
  let closed = false;

  function cancel(request: AuthoringRequest) {
    requests.delete(request.token);
    request.staging.cancel();
  }

  function assertCurrent(request: AuthoringRequest) {
    if (
      closed ||
      requests.get(request.token) !== request ||
      !request.current()
    ) {
      throw new Error("The Radius authoring request is no longer current.");
    }
  }

  async function assertCurrentTarget(request: AuthoringRequest) {
    assertCurrent(request);
    const target = await ports.resolveTarget();
    assertCurrent(request);
    if (!target || !sameTarget(request.target, target)) {
      cancel(request);
      throw new Error("The authoring source or worktree changed.");
    }
  }

  function requestFor(token: string) {
    const request = requests.get(token);
    if (!request)
      throw new Error("Unknown or expired Radius authoring request.");
    return request;
  }

  return {
    begin(token: string, target: AuthoringTarget, current: () => boolean) {
      if (closed || !token || !target.sourceRevision || !current()) {
        throw new Error("Cannot establish a current Radius authoring source.");
      }
      if (requests.has(token)) throw new Error("Duplicate authoring request.");
      const staging = ports.staging(target.workspace);
      for (const request of requests.values()) {
        if (request.target.workspace === target.workspace) cancel(request);
      }
      requests.set(token, {
        token,
        target: { ...target },
        staging,
        current,
        inFlight: 0,
        finalizing: false
      });
      return staging.stagingDir;
    },
    cancel(token: string) {
      const request = requests.get(token);
      if (request) cancel(request);
    },
    close() {
      closed = true;
      for (const request of requests.values()) cancel(request);
    },
    async publish<T>(
      token: string,
      start: (stagingDir: string) => Promise<T>
    ): Promise<T> {
      const request = requestFor(token);
      await assertCurrentTarget(request);
      assertCurrent(request);
      if (request.finalizing)
        throw new Error("The Radius authoring request is already finalizing.");
      request.inFlight++;
      try {
        // No await between the current check and starting the publisher. The
        // caller prepares credentials and takes any registry queue slot first.
        return await start(request.staging.stagingDir);
      } finally {
        request.inFlight--;
      }
    },
    async finish(token: string) {
      const request = requestFor(token);
      assertCurrent(request);
      if (request.finalizing || request.inFlight > 0) {
        throw new Error(
          "The Radius authoring request already has work running."
        );
      }
      request.finalizing = true;
      try {
        await assertCurrentTarget(request);
        await ports.validate(request.staging);
        await assertCurrentTarget(request);
        assertCurrent(request);
        return request.staging.promote();
      } finally {
        if (requests.get(token) === request) cancel(request);
      }
    }
  };
}
