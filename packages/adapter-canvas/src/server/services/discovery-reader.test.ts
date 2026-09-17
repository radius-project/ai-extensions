import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { createLegacyDiscoveryReader } from "./discovery-reader.js";

it.each([
  "ok",
  "variables-forbidden",
  "variables-network",
  "variables-malformed",
  "repo-forbidden"
] as const)(
  "uses canonical environment inspection and preserves %s metadata failures",
  async (kind) => {
    const root = await mkdtemp(resolve(".test-discovery-legacy-"));
    let sequence = 0;
    const calls: string[][] = [];
    const reader = createLegacyDiscoveryReader({
      storageRoot: join(root, "snapshots"),
      clock: { now: () => "2026-09-15T00:00:00Z" },
      ids: { next: () => `id-${++sequence}` },
      identity: async () => ({ actingLogin: "reader" }),
      workspace: async () => ({
        repo: "owner/repo",
        workspacePath: root,
        branch: "feature"
      }),
      git: async () => {
        throw new Error("Environment reads must not run Git");
      },
      executor: async (login) => ({
        login,
        run: async (args) => {
          calls.push(args);
          const path = args.find((arg) => arg.startsWith("/repos/"));
          if (path === "/repos/owner/repo")
            return {
              code: kind === "repo-forbidden" ? 403 : 0,
              stderr: kind === "repo-forbidden" ? "HTTP 403" : "",
              stdout: JSON.stringify({ full_name: "owner/repo" })
            };
          if (path?.includes("/variables")) {
            if (kind === "variables-forbidden" || kind === "variables-network")
              return {
                code: 1,
                stderr:
                  kind === "variables-forbidden" ? "HTTP 403" : (
                    "Connection failed"
                  ),
                stdout: ""
              };
            return {
              code: 0,
              stderr: "",
              stdout:
                kind === "variables-malformed" ? "not-json" : (
                  JSON.stringify({
                    variables: [
                      { name: "RADIUS_MANAGED", value: "true" },
                      { name: "AZURE_CLIENT_ID", value: "client" }
                    ]
                  })
                )
            };
          }
          if (path?.includes("/environments?"))
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({ environments: [{ name: "dev", id: 1 }] })
            };
          if (path?.endsWith("/environments/dev"))
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                name: "dev",
                id: 1,
                protection_rules: []
              })
            };
          throw new Error(`Unmodeled command: ${args.join(" ")}`);
        }
      })
    });
    try {
      const opened = await reader.open("owner/repo", "panel");
      if (kind === "repo-forbidden") {
        expect(opened).toMatchObject({ status: "forbidden" });
        return;
      }
      if (opened.status !== "ok") throw new Error("Expected authorized reader");
      try {
        const result = await opened.value.environments();
        if (kind === "ok")
          expect(result).toMatchObject({
            status: "ok",
            value: {
              entries: [
                {
                  inspection: {
                    configuration: { provider: "azure" },
                    recipeObservation: { completeness: "unavailable" }
                  },
                  metadata: { id: "1", variables: { RADIUS_MANAGED: "true" } }
                }
              ]
            }
          });
        else
          expect(result).toMatchObject({
            status: "ok",
            value: {
              entries: [],
              error: {
                code:
                  kind === "variables-forbidden" ? "FORBIDDEN"
                  : kind === "variables-malformed" ? "EVIDENCE_MISMATCH"
                  : "RESULT_UNAVAILABLE"
              }
            }
          });
        expect(calls.every((args) => args.includes("GET"))).toBe(true);
      } finally {
        await opened.value.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
