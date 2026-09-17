import { portSuccess } from "@radius-project/core/lifecycle";
import type { LegacyDiscoveryReader } from "../../src/server/services/discovery-reader.js";
import type { EnvironmentsDependencies } from "../../src/server/routes/environments-types.js";
import { classifyProvider } from "../../src/provider-classification.js";

/** Scripted route-level evidence; command-boundary conformance uses the real reader instead. */
export function createLegacyDiscoveryFake(
  options: {
    application?(repo: string, branch: string): Promise<string>;
    cli?: EnvironmentsDependencies["cliExec"];
  } = {}
): LegacyDiscoveryReader {
  const observation = {
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "configuration" as const
  };
  return {
    open: async (repo) => {
      const run = (args: string[]) =>
        new Promise<{ ok: boolean; stdout: string }>((resolve, reject) => {
          if (!options.cli)
            throw new Error("Unmodeled legacy discovery command");
          options.cli(
            "gh",
            args,
            { timeout: 12000 },
            (error, stdout, stderr) => {
              if (error) reject(new Error(stderr || error.message));
              else resolve({ ok: true, stdout: (stdout || "").trim() });
            }
          );
        });
      return portSuccess({
        cacheKey: "fixture-reader",
        applications: async (branch) => {
          if (!options.application)
            throw new Error("Unmodeled application evidence");
          return portSuccess({
            target: { repo },
            items: [
              {
                target: {
                  repo,
                  application: await options.application(repo, branch)
                },
                observation
              }
            ],
            observation
          });
        },
        environments: async () => {
          const names = await run([
            "api",
            "--paginate",
            `/repos/${repo}/environments?per_page=100`
          ]);
          const entries = await Promise.all(
            names.stdout
              .split("\n")
              .filter(Boolean)
              .map(async (line) => {
                const tab = line.indexOf("\t");
                const name = tab < 0 ? line : line.slice(tab + 1);
                const vars = await run([
                  "api",
                  `/repos/${repo}/environments/${encodeURIComponent(name)}/variables?per_page=100`
                ]);
                const variables = Object.fromEntries(
                  vars.stdout
                    .split("\n")
                    .filter(Boolean)
                    .map((row) => {
                      const split = row.indexOf("\t");
                      return split < 0 ?
                          [row, ""]
                        : [row.slice(0, split), row.slice(split + 1)];
                    })
                );
                const provider = classifyProvider(variables);
                return {
                  inspection: {
                    target: { repo, environment: name },
                    ...(provider ? { configuration: { provider } } : {}),
                    protections: { requiredReviewers: false },
                    observation,
                    recipeObservation: {
                      ...observation,
                      completeness: "unavailable" as const
                    },
                    limitations: []
                  },
                  metadata: { id: tab < 0 ? "" : line.slice(0, tab), variables }
                };
              })
          );
          return portSuccess({ entries });
        },
        run: async (args) => {
          try {
            return await run(args);
          } catch {
            return { ok: false, stdout: "" };
          }
        },
        close: async () => {}
      });
    }
  };
}
