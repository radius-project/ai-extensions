// Route-level tests for /api/deploy. The unit tests around
// resolveDeployRepairLoop cover the decision; these cover the wiring, and above
// all the guarantee that matters to a user: a refused redeploy costs no
// GitHub Actions run. That can only be shown by driving the route itself, so
// these bind the real request handler to an ephemeral port and make real
// requests.
//
// Every case here is a refusal, which the route answers before it touches gh or
// the network, so nothing needs to be stubbed. The one accepted deploy uses an
// empty repo, which the background monitor rejects immediately, so it never
// reaches the network either.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createLegacyRequestHandler,
  servers,
  setDeployRepairHandoff,
  DEPLOY_RUN_UNCONFIRMED_KIND
} from "./server.js";
import { DEPLOY_REPAIR_ATTEMPT_CAP } from "./runtime/hooks.js";
import { MIGRATED_ROUTE_KEYS } from "./server/route-table.js";
import type { CanvasState } from "./shared.js";

// The deploy dispatch is a `gh workflow run` issued through cliExec, and the
// route's own branch lookup goes through runCommand, both taken from this
// module. Replacing them records what the route actually ran, so "a refusal
// costs no Actions run" is checked at that boundary rather than inferred from
// which state the route did or did not touch.
//
// This covers the dispatch, not every possible route to GitHub: helpers kept
// through importOriginal (getDefaultBranch, fetchFileFromRepo, and the rest)
// call cliExec internally rather than through the module's exports, so their
// calls are not recorded here. That is enough for what these cases assert,
// because a refusal returns before the route reaches any of them.
const ghCli = vi.hoisted(() => ({
  cliExec: vi.fn(),
  runCommand: vi.fn()
}));

vi.mock("./gh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gh.js")>();
  return {
    ...actual,
    cliExec: ghCli.cliExec,
    runCommand: ghCli.runCommand
  };
});

const INSTANCE = "deploy-route-test";

let http: Server;
let baseUrl = "";

beforeEach(async () => {
  // A handoff would otherwise fire from the accepted deploy's monitor.
  setDeployRepairHandoff(() => Promise.resolve());
  ghCli.cliExec.mockReset();
  ghCli.runCommand.mockReset();
  ghCli.runCommand.mockResolvedValue("");
  ghCli.cliExec.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: null, stdout: string, stderr: string) => void
    ) => {
      cb?.(null, "", "");
      return { stdin: { end: () => {} } };
    }
  );
  const { handler } = createLegacyRequestHandler(INSTANCE, () => baseUrl);
  http = createServer(handler);
  await new Promise<void>((resolve) =>
    http.listen(0, "127.0.0.1", () => resolve())
  );
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  servers.delete(INSTANCE);
  setDeployRepairHandoff(null);
  // fetch keeps its sockets alive, and close() waits for open connections, so
  // teardown would otherwise stall until the keep-alive timeout expired.
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

function seed(state: Partial<CanvasState>): CanvasState {
  const full = state as CanvasState;
  servers.set(INSTANCE, {
    server: http,
    baseUrl,
    url: `${baseUrl}/?page=deployed`,
    page: "deployed",
    state: full
  });
  return full;
}

// A repair-loop redeploy as the tool builds it: the attempt snapshot is
// replayed, so a branch is always supplied and the route never has to resolve
// one (which would shell out to gh).
function repairPayload(attemptId: string) {
  return {
    attemptId,
    targetRepo: "acme/widgets",
    environment: "production",
    branch: "feat",
    provider: "azure",
    appFile: ".radius/app.bicep",
    agentInitiated: true
  };
}

function failedAttempt(extra: Partial<CanvasState> = {}): Partial<CanvasState> {
  return {
    deployStatus: "failed",
    deployAttempt: {
      id: "attempt-A",
      targetRepo: "acme/widgets",
      environment: "production",
      branch: "feat",
      provider: "azure",
      appFile: ".radius/app.bicep"
    },
    ...extra
  };
}

async function postDeploy(body: unknown): Promise<{
  status: number;
  json: Record<string, unknown>;
}> {
  const res = await fetch(`${baseUrl}/api/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// The guarantee this file exists for: a refused redeploy never reaches the
// dispatch, so it cannot have started a workflow run. Asserted at that
// boundary itself, so reordering the route's state writes cannot make a
// refusal quietly start costing an Actions run.
function expectNoGitHubCliUse(): void {
  expect(ghCli.cliExec).not.toHaveBeenCalled();
  expect(ghCli.runCommand).not.toHaveBeenCalled();
}

describe("/api/deploy repair-loop refusals", () => {
  it("still runs through the handler these cases bind to", () => {
    // These bind the legacy handler directly, which is where /api/deploy is
    // served from today. If it is ever migrated onto the route table, that
    // stops being the path production takes and these cases would pass while
    // testing nothing, so the assumption fails loudly here instead.
    expect(MIGRATED_ROUTE_KEYS).not.toContain("POST /api/deploy");
  });

  it("refuses a redeploy past the cap without touching state or dispatching", async () => {
    const state = seed(
      failedAttempt({ deployRepairAttempts: DEPLOY_REPAIR_ATTEMPT_CAP })
    );
    const { status, json } = await postDeploy(repairPayload("attempt-A"));

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/already used its/);
    // The refusal has to be inert: no counter movement, no new attempt, and no
    // transition out of failed — a dispatched run would have set in_progress.
    expectNoGitHubCliUse();
    expect(state.deployRepairAttempts).toBe(DEPLOY_REPAIR_ATTEMPT_CAP);
    expect(state.deployAttempt?.id).toBe("attempt-A");
    expect(state.deployStatus).toBe("failed");
    expect(state.deployLogs).toBeUndefined();
  });

  it("refuses a redeploy while the attempt is still running", async () => {
    const state = seed(
      failedAttempt({ deployStatus: "in_progress", deployRepairAttempts: 1 })
    );
    const { status, json } = await postDeploy(repairPayload("attempt-A"));

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/still running/);
    expectNoGitHubCliUse();
    expect(state.deployRepairAttempts).toBe(1);
  });

  it("refuses a redeploy on an attempt that already succeeded", async () => {
    const state = seed(
      failedAttempt({ deployStatus: "complete", deployRepairAttempts: 2 })
    );
    const { status, json } = await postDeploy(repairPayload("attempt-A"));

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/without an attemptId/);
    expectNoGitHubCliUse();
    expect(state.deployRepairAttempts).toBe(2);
  });

  it("refuses a redeploy when the run's outcome was never confirmed", async () => {
    const state = seed(
      failedAttempt({
        deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND,
        deployRunUrl: "https://github.com/acme/widgets/actions/runs/7",
        deployRepairAttempts: 1
      })
    );
    const { status, json } = await postDeploy(repairPayload("attempt-A"));

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/may still be in flight/);
    expectNoGitHubCliUse();
    expect(state.deployRepairAttempts).toBe(1);
  });

  it("refuses a stale attempt without clobbering the current one", async () => {
    // The canvas moved on to attempt-B; a repair still addressing attempt-A
    // must not redirect that newer deploy at its own target.
    const state = seed({
      deployStatus: "failed",
      deployRepairAttempts: 0,
      deployAttempt: {
        id: "attempt-B",
        targetRepo: "acme/other",
        environment: "staging",
        branch: "main",
        provider: "azure",
        appFile: ".radius/app.bicep"
      }
    });
    const { status, json } = await postDeploy(repairPayload("attempt-A"));

    expect(status).toBe(409);
    expect(String(json.error)).toMatch(/no longer the current attempt/);
    expectNoGitHubCliUse();
    expect(state.deployAttempt?.id).toBe("attempt-B");
    expect(state.deployAttempt?.targetRepo).toBe("acme/other");
    expect(state.deployRepairAttempts).toBe(0);
  });

  it("routes its GitHub CLI calls through the replaced module", async () => {
    // Without this, the assertions above could pass because nothing observes
    // the route rather than because the route stayed away from the CLI. An
    // accepted deploy that omits a branch has to resolve the repo's default
    // one, which is a gh call and must therefore be recorded here.
    seed(failedAttempt({ deployRepairAttempts: 0 }));
    const { status } = await postDeploy({
      targetRepo: "",
      environment: "production",
      provider: "azure",
      appFile: ".radius/app.bicep"
    });

    expect(status).toBe(200);
    expect(ghCli.runCommand).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["repo", "view"])
    );
  });

  it("accepts an unbound deploy, opening a new attempt and resetting the count", async () => {
    // What the browser Deploy button sends: no attemptId. It must start a fresh
    // loop rather than continue the agent's, so a human clicking Deploy never
    // spends repair budget. An empty repo keeps the monitor off the network.
    const state = seed(failedAttempt({ deployRepairAttempts: 4 }));
    const { status } = await postDeploy({
      targetRepo: "",
      environment: "production",
      branch: "feat",
      provider: "azure",
      appFile: ".radius/app.bicep"
    });

    expect(status).toBe(200);
    // The counter reset is the signal that this opened a new loop rather than
    // continuing the agent's. deployRepairing is deliberately not asserted:
    // the deploy is eligible to hand its own failure off, and that handoff
    // flips the flag from the background monitor, so its value here is a race.
    expect(state.deployRepairAttempts).toBe(0);
    expect(state.deployAttempt?.id).not.toBe("attempt-A");
  });
});
