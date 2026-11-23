import { describe, expect, it, vi } from "vitest";
import {
  inspectApplicationDefinition,
  inspectDeploymentListings,
  type ApplicationDefinitionRead
} from "./deployments.js";

describe("application definition inspection", () => {
  it("uses the chosen branch and prefers the managed definition", async () => {
    const read = vi.fn(async (): Promise<ApplicationDefinitionRead> => ({
      kind: "read",
      source:
        "resource app 'Applications.Core/applications@2023' = { name: 'store' }"
    }));
    await expect(
      inspectApplicationDefinition("octo/repo", "feature/read", read)
    ).resolves.toEqual({
      kind: "defined",
      name: "store",
      path: ".radius/app.bicep",
      branch: "feature/read"
    });
    expect(read.mock.calls).toEqual([[".radius/app.bicep", "feature/read"]]);
  });

  it.each([
    { kind: "missing" },
    { kind: "read", source: "param location string" },
    { kind: "unavailable" }
  ] satisfies ApplicationDefinitionRead[])(
    "uses the root name without confirming it if the preferred read is unavailable ($kind)",
    async (preferred) => {
      const read = async (path: string): Promise<ApplicationDefinitionRead> =>
        path === "app.bicep" ?
          {
            kind: "read",
            source:
              "resource app 'Applications.Core/applications@2023' = { name: 'root-app' }"
          }
        : preferred;
      await expect(
        inspectApplicationDefinition("octo/repo", "", read)
      ).resolves.toEqual(
        preferred.kind === "unavailable" ?
          { kind: "unconfirmed", fallbackName: "root-app", unavailable: true }
        : {
            kind: "defined",
            name: "root-app",
            path: "app.bicep",
            branch: "main"
          }
      );
    }
  );

  it.each([
    ["missing", "octo/repo", "repo", false],
    ["unavailable", "octo/", "octo/", true]
  ] as const)(
    "does not confirm a name when the read is %s",
    async (kind, repo, fallbackName, unavailable) => {
      await expect(
        inspectApplicationDefinition(repo, "", async () => ({ kind }))
      ).resolves.toEqual({ kind: "unconfirmed", fallbackName, unavailable });
    }
  );
});

it("keeps per-environment deployment results separate across duplicate names and failures", async () => {
  const failure = new Error("could not read prod");
  const inspect = vi.fn(async (environment: string) => {
    if (environment === "prod") throw failure;
    return { deployment: null, incomplete: true };
  });
  await expect(
    inspectDeploymentListings(async () => ["dev", "prod", "dev"], inspect)
  ).resolves.toEqual([
    {
      environment: "dev",
      result: {
        status: "fulfilled",
        value: { deployment: null, incomplete: true }
      }
    },
    { environment: "prod", result: { status: "rejected", reason: failure } }
  ]);
  expect(inspect.mock.calls).toEqual([["dev"], ["prod"]]);
  await expect(
    inspectDeploymentListings(async () => {
      throw failure;
    }, inspect)
  ).rejects.toThrow(failure);
});
