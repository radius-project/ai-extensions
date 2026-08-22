// Functional: comparing an application across two committed branches.
//
// The diff a UI renders is produced by three modules in sequence — the same
// converter runs on both branches, the visualization filter drops build-only
// nodes, and the diff algorithm pairs what remains. This suite drives that
// composition rather than each module alone, because the properties that matter
// (a stable node identity across branches, edge-level statuses, and no spurious
// "modified" from connection ordering) only exist once they are combined.

import { describe, expect, it } from "vitest";

import {
  applicationGraphToResources,
  computeGraphDiff,
  fetchBicepFromRepo,
  filterGraphVisualizationResources
} from "../../src/index.js";
import { createFakeGitHub } from "../support/fake-github.js";
import {
  API_ID,
  APP_BICEP,
  APP_BICEP_WITH_CACHE,
  BASE_BRANCH,
  CACHE_ID,
  DB_ID,
  HEAD_BRANCH,
  IMAGE_ID,
  REGISTRY_SECRET_ID,
  REPO,
  appGraphPayload,
  contentsPath
} from "../fixtures/storefront-app.js";

function branchResources(options: { withCache: boolean }): any[] {
  return applicationGraphToResources(
    appGraphPayload(options),
    ".radius/app.bicep",
    options.withCache ? APP_BICEP_WITH_CACHE : APP_BICEP
  );
}

function statusById(diff: any[]): Record<string, string> {
  return Object.fromEntries(diff.map((r) => [r.id, r.diffStatus]));
}

describe("branch diff journey", () => {
  it("fetches both branch models through one GitHub port", async () => {
    const gh = createFakeGitHub({
      files: {
        [contentsPath(REPO, ".radius/app.bicep", BASE_BRANCH)]: APP_BICEP,
        [contentsPath(REPO, ".radius/app.bicep", HEAD_BRANCH)]:
          APP_BICEP_WITH_CACHE
      }
    });

    const base = await fetchBicepFromRepo(gh, REPO, BASE_BRANCH);
    const head = await fetchBicepFromRepo(gh, REPO, HEAD_BRANCH);

    expect(base).toBe(APP_BICEP);
    expect(head).toBe(APP_BICEP_WITH_CACHE);
    expect(gh.reads).toEqual([
      contentsPath(REPO, ".radius/app.bicep", BASE_BRANCH),
      contentsPath(REPO, ".radius/app.bicep", HEAD_BRANCH)
    ]);
  });

  it("reports an added resource, its new edge, and its dependents", () => {
    const base = branchResources({ withCache: false });
    const head = branchResources({ withCache: true });

    const diff = computeGraphDiff(base, head);

    expect(statusById(diff)).toEqual({
      // The container's own hash changed because it gained a connection.
      [API_ID]: "modified",
      [DB_ID]: "unchanged",
      [IMAGE_ID]: "unchanged",
      [REGISTRY_SECRET_ID]: "unchanged",
      [CACHE_ID]: "added"
    });

    const container = diff.find((r) => r.id === API_ID);
    const edgeStatus = Object.fromEntries(
      container.connections.map((c: any) => [
        `${c.direction}:${c.id}`,
        c.diffStatus
      ])
    );
    expect(edgeStatus[`Outbound:${CACHE_ID}`]).toBe("added");
    expect(edgeStatus[`Outbound:${DB_ID}`]).toBe("unchanged");
  });

  it("reports a removed resource and marks every edge leaving it removed", () => {
    const base = branchResources({ withCache: true });
    const head = branchResources({ withCache: false });

    const diff = computeGraphDiff(base, head);

    expect(statusById(diff)[CACHE_ID]).toBe("removed");
    const container = diff.find((r) => r.id === API_ID);
    const removedEdge = container.connections.find(
      (c: any) => c.id === CACHE_ID
    );
    expect(removedEdge.diffStatus).toBe("removed");
    // The removed node is still emitted so the re-attached edge has a target.
    const cache = diff.find((r) => r.id === CACHE_ID);
    expect(cache.connections).toEqual([{ id: API_ID, direction: "Inbound" }]);
  });

  it("reports no change when both branches model the same application", () => {
    const diff = computeGraphDiff(
      branchResources({ withCache: true }),
      branchResources({ withCache: true })
    );

    expect(diff.every((r) => r.diffStatus === "unchanged")).toBe(true);
    for (const resource of diff) {
      for (const connection of resource.connections) {
        // Only rendered (Outbound) edges carry an edge-level status.
        if (connection.direction !== "Outbound") continue;
        expect(connection.diffStatus).toBe("unchanged");
      }
    }
  });

  it("is unaffected by the order rad emits connections in", () => {
    const shuffled = appGraphPayload({ withCache: true });
    shuffled.resources[0].connections.reverse();

    const diff = computeGraphDiff(
      branchResources({ withCache: true }),
      applicationGraphToResources(
        shuffled,
        ".radius/app.bicep",
        APP_BICEP_WITH_CACHE
      )
    );

    expect(diff.every((r) => r.diffStatus === "unchanged")).toBe(true);
  });

  it("diffs the filtered visualization without leaving dangling edges", () => {
    const base = filterGraphVisualizationResources(
      branchResources({ withCache: false })
    );
    const head = filterGraphVisualizationResources(
      branchResources({ withCache: true })
    );

    const diff = computeGraphDiff(base, head);

    expect(diff.map((r) => r.id)).toEqual([API_ID, DB_ID, CACHE_ID]);
    const rendered = new Set(diff.map((r) => r.id));
    for (const resource of diff) {
      for (const connection of resource.connections) {
        expect(rendered.has(connection.id)).toBe(true);
      }
    }
  });

  it("treats an empty base branch as an entirely added application", () => {
    const diff = computeGraphDiff([], branchResources({ withCache: true }));

    expect(diff.every((r) => r.diffStatus === "added")).toBe(true);
    expect(diff).toHaveLength(5);
  });
});
