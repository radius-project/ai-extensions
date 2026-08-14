import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { isUuid } from "../../azure-oidc.js";
import { createRequestContext } from "../request-context.js";
import {
  createAzureDiscoveryRoutes,
  handleAzureAppServesRepos,
  handleDiscover,
  handleListAzureAppRegistrations,
  type AzureCommandResult,
  type AzureDiscoveryDependencies
} from "./azure-discovery.js";
import type { DiscoveryItem, DiscoveryResult } from "../services/discovery.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  contentType: string | undefined;
  headers: Array<[string, string]>;
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    contentType: undefined,
    headers: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      recording.headers.push([name, value]);
      if (name === "Content-Type") recording.contentType = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(url: string, body?: string): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [body]), {
    url,
    method: body === undefined ? "GET" : "POST",
    headers: {}
  }) as unknown as IncomingMessage;
}

// Exact argv vectors these two routes are allowed to issue. The fake keys on the
// full joined command line and throws on anything else, so a dropped
// `--show-mine`, a changed `--query` projection, or one route issuing the
// other's invocation fails loudly instead of matching a looser key.
const ARGV = {
  list:
    "az ad app list --show-mine --query " +
    "[].{appId:appId,displayName:displayName,createdDateTime:createdDateTime} -o json",
  fic: (appId: string) =>
    `az ad app federated-credential list --id ${appId} --query [].subject -o json`
};

interface AzScript {
  [commandLine: string]: Partial<AzureCommandResult> | { throws: unknown };
}

function azFake(script: AzScript) {
  const calls: string[] = [];
  const runAz: AzureDiscoveryDependencies["runAz"] = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    const scripted = script[line];
    if (!scripted) throw new Error(`unscripted az call: ${line}`);
    if ("throws" in scripted) return Promise.reject(scripted.throws);
    return Promise.resolve({
      code: scripted.code ?? 0,
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? ""
    });
  };
  return { calls, runAz };
}

// Fakes throw on anything the route is not supposed to reach, so an accidental
// widening of the dependency surface fails loudly. `isUuid` is the exception:
// it is the real pure `azure-oidc` predicate, injected exactly as the
// composition root injects it, because a double for a pure function controls
// nothing and could only diverge from production.
function dependencies(
  overrides: Partial<AzureDiscoveryDependencies> = {}
): AzureDiscoveryDependencies {
  return {
    runAz: () => {
      throw new Error("runAz not stubbed");
    },
    runCli: () => {
      throw new Error("runCli not stubbed");
    },
    isUuid,
    parseServedReposFromSubjects: () => {
      throw new Error("parseServedReposFromSubjects not stubbed");
    },
    ...overrides
  };
}

type Handler = (
  context: ReturnType<typeof createRequestContext>,
  deps: AzureDiscoveryDependencies
) => Promise<void>;

async function run(
  url: string,
  handler: Handler,
  deps: AzureDiscoveryDependencies,
  body?: string
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(url, body),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handler(context, deps);
  return recording;
}

describe("azure-discovery routes (SU-08)", () => {
  it("declares exactly the three routes it owns", () => {
    expect(Object.keys(createAzureDiscoveryRoutes(dependencies()))).toEqual([
      "GET /api/list-azure-app-registrations",
      "GET /api/azure-app-serves-repos",
      "POST /api/discover"
    ]);
  });

  describe("GET /api/list-azure-app-registrations", () => {
    it("projects only the three picker fields and drops entries without an appId", async () => {
      const az = azFake({
        [ARGV.list]: {
          stdout: JSON.stringify([
            {
              appId: "a1",
              displayName: "App One",
              createdDateTime: "2024-01-01",
              extra: "dropped"
            },
            { displayName: "no app id" },
            null,
            "not an object",
            ["nested", "array"],
            { appId: "", displayName: "empty app id" },
            { appId: "a2" }
          ])
        }
      });
      const recording = await run(
        "/api/list-azure-app-registrations",
        handleListAzureAppRegistrations,
        dependencies({ runAz: az.runAz })
      );

      expect(az.calls).toEqual([ARGV.list]);
      expect(recording.status).toBe(200);
      expect(recording.contentType).toBe("application/json");
      // `displayName` and `createdDateTime` are absent rather than null when the
      // CLI omits them, because JSON.stringify drops undefined properties.
      expect(recording.body).toBe(
        '{"apps":[{"appId":"a1","displayName":"App One","createdDateTime":"2024-01-01"},{"appId":"a2"}]}'
      );
    });

    it("reports a non-zero az exit as 400 and echoes stderr twice", async () => {
      const az = azFake({
        [ARGV.list]: { code: 1, stderr: "az: not logged in" }
      });
      const recording = await run(
        "/api/list-azure-app-registrations",
        handleListAzureAppRegistrations,
        dependencies({ runAz: az.runAz })
      );

      expect(recording.status).toBe(400);
      expect(recording.contentType).toBe("application/json");
      // stderr reaches the caller both interpolated into the message and raw in
      // `azError`; the picker renders the first and diagnoses on the second.
      expect(JSON.parse(recording.body)).toEqual({
        error: "Failed to list App Registrations: az: not logged in",
        code: "app-list-failed",
        azError: "az: not logged in"
      });
    });

    // Verbatim transcription of the deleted legacy POST /api/discover arm. The
    // differential cases below drive this independent implementation and the
    // migrated HTTP adapter with identical scripts, then compare every observable
    // boundary: status, ordered headers, serialized payload, argv, and timeouts.
    function legacyDiscoveryItems(value: unknown): DiscoveryItem[] {
      if (!Array.isArray(value)) return [];
      return value.map((item) => {
        const fields =
          item !== null && typeof item === "object" && !Array.isArray(item) ?
            Object.fromEntries(Object.entries(item))
          : {};
        return {
          id: typeof fields.id === "string" ? fields.id : "",
          name: typeof fields.name === "string" ? fields.name : "",
          resourceGroup:
            typeof fields.resourceGroup === "string" ? fields.resourceGroup : ""
        };
      });
    }

    function legacyErrorMessage(error: unknown): string {
      return error instanceof Error ? error.message : String(error);
    }

    async function legacyDiscover(
      incoming: IncomingMessage,
      response: ServerResponse<IncomingMessage>,
      runCli: AzureDiscoveryDependencies["runCli"]
    ): Promise<void> {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      try {
        const data = JSON.parse(body) as {
          subscriptionId?: string;
          provider?: string;
        };
        const result: DiscoveryResult = {
          clusters: [],
          resourceGroups: [],
          namespaces: [],
          vpcs: [],
          subnets: []
        };

        if (
          data.subscriptionId &&
          !isUuid(String(data.subscriptionId).trim())
        ) {
          response.setHeader("Content-Type", "application/json");
          response.writeHead(200);
          response.end(
            JSON.stringify({
              error: `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
              clusters: [],
              resourceGroups: [],
              namespaces: ["default"],
              vpcs: [],
              subnets: []
            })
          );
          return;
        }

        if (data.provider === "azure") {
          if (data.subscriptionId) {
            try {
              await runCli(
                "az",
                ["account", "set", "--subscription", data.subscriptionId],
                { timeout: 10000 }
              );
            } catch {}
          }
          const subArgs =
            data.subscriptionId ? ["--subscription", data.subscriptionId] : [];
          try {
            const aksJson = await runCli(
              "az",
              [
                "aks",
                "list",
                "--query",
                "[].{id:name, name:name, resourceGroup:resourceGroup}",
                "-o",
                "json",
                ...subArgs
              ],
              { timeout: 30000 }
            );
            result.clusters = legacyDiscoveryItems(JSON.parse(aksJson));
          } catch (error) {
            result.clusters = [];
            result.errors = result.errors || {};
            result.errors.clusters = legacyErrorMessage(error).slice(0, 800);
          }
          try {
            const groupsJson = await runCli(
              "az",
              [
                "group",
                "list",
                "--query",
                "[].{id:name, name:name}",
                "-o",
                "json",
                ...subArgs
              ],
              { timeout: 30000 }
            );
            result.resourceGroups = legacyDiscoveryItems(
              JSON.parse(groupsJson)
            );
          } catch (error) {
            result.resourceGroups = [];
            result.errors = result.errors || {};
            result.errors.resourceGroups = legacyErrorMessage(error).slice(
              0,
              800
            );
          }
          if (result.clusters.length > 0) {
            try {
              const resourceGroup =
                result.resourceGroups.length > 0 ?
                  result.resourceGroups[0].id
                : "";
              const clusterName = result.clusters[0].id;
              if (resourceGroup && clusterName) {
                await runCli(
                  "az",
                  [
                    "aks",
                    "get-credentials",
                    "--name",
                    clusterName,
                    "--resource-group",
                    resourceGroup,
                    "--overwrite-existing"
                  ],
                  { timeout: 20000 }
                );
                const namespacesJson = await runCli(
                  "kubectl",
                  [
                    "get",
                    "namespaces",
                    "-o",
                    "jsonpath={.items[*].metadata.name}"
                  ],
                  { timeout: 10000 }
                );
                result.namespaces = namespacesJson
                  .replace(/"/g, "")
                  .split(" ")
                  .filter(Boolean);
              } else {
                result.namespaces = ["default", "kube-system", "radius-system"];
              }
            } catch {
              result.namespaces = ["default", "kube-system", "radius-system"];
            }
          } else {
            result.namespaces = ["default", "kube-system", "radius-system"];
          }
        } else {
          try {
            const clustersJson = await runCli(
              "aws",
              [
                "eks",
                "list-clusters",
                "--query",
                "clusters",
                "--output",
                "json"
              ],
              { timeout: 15000 }
            );
            const clusterNames: unknown = JSON.parse(clustersJson);
            result.clusters =
              Array.isArray(clusterNames) ?
                clusterNames
                  .filter((name): name is string => typeof name === "string")
                  .map((name) => ({ id: name, name }))
              : [];
          } catch (error) {
            result.clusters = [];
            result.errors = result.errors || {};
            result.errors.clusters = legacyErrorMessage(error).slice(0, 800);
          }
          try {
            const vpcsJson = await runCli(
              "aws",
              [
                "ec2",
                "describe-vpcs",
                "--query",
                "Vpcs[].{id:VpcId, name:VpcId}",
                "--output",
                "json"
              ],
              { timeout: 15000 }
            );
            result.vpcs = legacyDiscoveryItems(JSON.parse(vpcsJson));
          } catch (error) {
            result.vpcs = [];
            result.errors = result.errors || {};
            result.errors.vpcs = legacyErrorMessage(error).slice(0, 800);
          }
          try {
            const subnetsJson = await runCli(
              "aws",
              [
                "ec2",
                "describe-subnets",
                "--query",
                "Subnets[].{id:SubnetId, name:SubnetId}",
                "--output",
                "json"
              ],
              { timeout: 15000 }
            );
            result.subnets = legacyDiscoveryItems(JSON.parse(subnetsJson));
          } catch (error) {
            result.subnets = [];
            result.errors = result.errors || {};
            result.errors.subnets = legacyErrorMessage(error).slice(0, 800);
          }
          result.namespaces = ["default", "kube-system", "radius-system"];
        }

        response.setHeader("Content-Type", "application/json");
        response.writeHead(200);
        response.end(JSON.stringify(result));
      } catch (error) {
        response.setHeader("Content-Type", "application/json");
        response.writeHead(200);
        response.end(
          JSON.stringify({
            error: legacyErrorMessage(error),
            clusters: [],
            resourceGroups: [],
            namespaces: ["default"],
            vpcs: [],
            subnets: []
          })
        );
      }
    }

    interface DifferentialCall {
      line: string;
      timeout: number;
    }

    type DifferentialScript = ReadonlyMap<string, string | { throws: unknown }>;

    function differentialCli(script: DifferentialScript): {
      calls: DifferentialCall[];
      runCli: AzureDiscoveryDependencies["runCli"];
    } {
      const calls: DifferentialCall[] = [];
      return {
        calls,
        runCli(command, args, options) {
          const line = [command, ...args].join(" ");
          calls.push({ line, timeout: options.timeout });
          const result = script.get(line);
          if (result === undefined) {
            throw new Error(`unscripted differential CLI call: ${line}`);
          }
          return typeof result === "string" ?
              Promise.resolve(result)
            : Promise.reject(result.throws);
        }
      };
    }

    async function differentialDiscover(
      body: string,
      script: DifferentialScript
    ): Promise<{
      legacy: { recording: Recording; calls: DifferentialCall[] };
      migrated: { recording: Recording; calls: DifferentialCall[] };
    }> {
      const legacyCli = differentialCli(script);
      const legacy = recorder();
      await legacyDiscover(
        request("/api/discover", body),
        legacy.response,
        legacyCli.runCli
      );

      const migratedCli = differentialCli(script);
      const migrated = await run(
        "/api/discover",
        handleDiscover,
        dependencies({ runCli: migratedCli.runCli }),
        body
      );
      return {
        legacy: { recording: legacy.recording, calls: legacyCli.calls },
        migrated: { recording: migrated, calls: migratedCli.calls }
      };
    }

    describe("POST /api/discover legacy/migrated differential contract", () => {
      const aks =
        "az aks list --query [].{id:name, name:name, resourceGroup:resourceGroup} -o json";
      const groups = "az group list --query [].{id:name, name:name} -o json";
      const credentials =
        "az aks get-credentials --name aks-1 --resource-group rg-1 --overwrite-existing";
      const namespaces =
        "kubectl get namespaces -o jsonpath={.items[*].metadata.name}";
      const eks = "aws eks list-clusters --query clusters --output json";
      const vpcs =
        "aws ec2 describe-vpcs --query Vpcs[].{id:VpcId, name:VpcId} --output json";
      const subnets =
        "aws ec2 describe-subnets --query Subnets[].{id:SubnetId, name:SubnetId} --output json";

      it.each([
        {
          label: "Azure success",
          body: JSON.stringify({ provider: "azure" }),
          script: new Map([
            [
              aks,
              JSON.stringify([
                { id: "aks-1", name: "aks-1", resourceGroup: "rg-1" }
              ])
            ],
            [groups, JSON.stringify([{ id: "rg-1", name: "rg-1" }])],
            [credentials, ""],
            [namespaces, '"default" "radius-system"']
          ]),
          calls: [
            { line: aks, timeout: 30000 },
            { line: groups, timeout: 30000 },
            { line: credentials, timeout: 20000 },
            { line: namespaces, timeout: 10000 }
          ]
        },
        {
          label: "AWS success",
          body: JSON.stringify({ provider: "aws" }),
          script: new Map([
            [eks, '["eks-1"]'],
            [vpcs, JSON.stringify([{ id: "vpc-1", name: "vpc-1" }])],
            [subnets, JSON.stringify([{ id: "subnet-1", name: "subnet-1" }])]
          ]),
          calls: [
            { line: eks, timeout: 15000 },
            { line: vpcs, timeout: 15000 },
            { line: subnets, timeout: 15000 }
          ]
        },
        {
          label: "malformed input",
          body: "not json",
          script: new Map<string, string>(),
          calls: []
        },
        {
          label: "partial AWS failure",
          body: JSON.stringify({ provider: "aws" }),
          script: new Map<string, string | { throws: unknown }>([
            [eks, '["eks-1"]'],
            [vpcs, { throws: new Error("vpcs denied") }],
            [subnets, "[]"]
          ]),
          calls: [
            { line: eks, timeout: 15000 },
            { line: vpcs, timeout: 15000 },
            { line: subnets, timeout: 15000 }
          ]
        }
      ])(
        "matches status, headers, payload, argv, and timeouts for $label",
        async ({ body, script, calls }) => {
          const { legacy, migrated } = await differentialDiscover(body, script);

          expect(migrated.recording).toEqual(legacy.recording);
          expect(legacy.calls).toEqual(calls);
          expect(migrated.calls).toEqual(calls);
        }
      );
    });

    it("treats a string exit code as a failure", async () => {
      // The runner reports a spawn errno as a string, and `!== 0` is strict, so
      // "ENOENT" is a failure. Pinned because the success path is the one that
      // would silently swallow it.
      const az = azFake({
        [ARGV.list]: { code: "ENOENT", stdout: "[]", stderr: "az missing" }
      });
      const recording = await run(
        "/api/list-azure-app-registrations",
        handleListAzureAppRegistrations,
        dependencies({ runAz: az.runAz })
      );

      expect(recording.status).toBe(400);
      expect((JSON.parse(recording.body) as { code: string }).code).toBe(
        "app-list-failed"
      );
    });

    it("reports unparsable and non-array output alike as app-list-parse", async () => {
      for (const stdout of ["not json", '{"apps":[]}', '"a string"', "null"]) {
        const az = azFake({ [ARGV.list]: { stdout } });
        const recording = await run(
          "/api/list-azure-app-registrations",
          handleListAzureAppRegistrations,
          dependencies({ runAz: az.runAz })
        );

        expect(recording.status, stdout).toBe(400);
        expect(JSON.parse(recording.body), stdout).toEqual({
          error: "The App Registration list returned an unexpected result.",
          code: "app-list-parse"
        });
      }
    });

    it("answers an empty list when az returns an empty array", async () => {
      const az = azFake({ [ARGV.list]: { stdout: "[]" } });
      const recording = await run(
        "/api/list-azure-app-registrations",
        handleListAzureAppRegistrations,
        dependencies({ runAz: az.runAz })
      );

      expect(recording.status).toBe(200);
      expect(recording.body).toBe('{"apps":[]}');
    });

    it("turns a rejecting runner into a 400 carrying the failure text", async () => {
      const az = azFake({
        [ARGV.list]: { throws: new Error("spawn ENOENT") }
      });
      const recording = await run(
        "/api/list-azure-app-registrations",
        handleListAzureAppRegistrations,
        dependencies({ runAz: az.runAz })
      );

      expect(recording.status).toBe(400);
      // The failure text is deliberately serialized into the response body, so
      // it is caller-visible content rather than incidental exception prose.
      expect(JSON.parse(recording.body)).toEqual({
        error: "spawn ENOENT",
        code: "app-list-failed"
      });
    });

    it("coerces a non-Error rejection into the same 400 body", async () => {
      const az = azFake({ [ARGV.list]: { throws: "az exploded" } });
      const recording = await run(
        "/api/list-azure-app-registrations",
        handleListAzureAppRegistrations,
        dependencies({ runAz: az.runAz })
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body)).toEqual({
        error: "az exploded",
        code: "app-list-failed"
      });
    });
  });

  describe("GET /api/azure-app-serves-repos", () => {
    const APP_ID = "11111111-2222-3333-4444-555555555555";

    it("rejects a missing or malformed appId without spawning az", async () => {
      for (const url of [
        "/api/azure-app-serves-repos",
        "/api/azure-app-serves-repos?appId=",
        "/api/azure-app-serves-repos?appId=not-a-uuid"
      ]) {
        const recording = await run(
          url,
          handleAzureAppServesRepos,
          // `runAz` stays unstubbed: reaching it at all throws.
          dependencies()
        );

        expect(recording.status, url).toBe(400);
        expect(recording.contentType, url).toBe("application/json");
        expect(JSON.parse(recording.body), url).toEqual({
          error: "A valid appId is required.",
          code: "app-serves-bad-id"
        });
      }
    });

    it("returns the parsed repo labels for a valid appId", async () => {
      const az = azFake({
        [ARGV.fic(APP_ID)]: {
          stdout: JSON.stringify(["repo:octo/app:ref:refs/heads/main"])
        }
      });
      const subjects: unknown[] = [];
      const recording = await run(
        `/api/azure-app-serves-repos?appId=${APP_ID}`,
        handleAzureAppServesRepos,
        dependencies({
          runAz: az.runAz,
          parseServedReposFromSubjects: (value) => {
            subjects.push(value);
            return ["octo/app"];
          }
        })
      );

      expect(az.calls).toEqual([ARGV.fic(APP_ID)]);
      // The raw `az` stdout is parsed once here and handed to the helper as a
      // value, so the helper never sees the JSON text.
      expect(subjects).toEqual([["repo:octo/app:ref:refs/heads/main"]]);
      expect(recording.status).toBe(200);
      expect(recording.contentType).toBe("application/json");
      expect(recording.body).toBe('{"servesRepos":["octo/app"]}');
    });

    it("keeps an empty result as an empty array rather than collapsing it to null", async () => {
      const az = azFake({ [ARGV.fic(APP_ID)]: { stdout: "[]" } });
      const recording = await run(
        `/api/azure-app-serves-repos?appId=${APP_ID}`,
        handleAzureAppServesRepos,
        dependencies({
          runAz: az.runAz,
          parseServedReposFromSubjects: () => []
        })
      );

      // `[] || null` keeps the array: "this app serves no repos" is a different
      // answer from "the label could not be computed", and the picker renders
      // them differently.
      expect(recording.status).toBe(200);
      expect(recording.body).toBe('{"servesRepos":[]}');
    });

    it("falls back to null when the parser yields no list at all", async () => {
      const az = azFake({ [ARGV.fic(APP_ID)]: { stdout: "[]" } });
      const recording = await run(
        `/api/azure-app-serves-repos?appId=${APP_ID}`,
        handleAzureAppServesRepos,
        dependencies({
          runAz: az.runAz,
          // The production helper always returns an array, so this drives the
          // defensive `|| null` arm the legacy route carried. The cast is the
          // point: only a parser outside its declared contract reaches it.
          parseServedReposFromSubjects: () => undefined as unknown as string[]
        })
      );

      expect(recording.status).toBe(200);
      expect(recording.body).toBe('{"servesRepos":null}');
    });

    it("degrades a failed az call to a null label without parsing stdout", async () => {
      for (const code of [1, "ENOENT"] as const) {
        const az = azFake({
          [ARGV.fic(APP_ID)]: {
            code,
            stdout: '["repo:octo/app:ref:refs/heads/main"]',
            stderr: "az: forbidden"
          }
        });
        const recording = await run(
          `/api/azure-app-serves-repos?appId=${APP_ID}`,
          handleAzureAppServesRepos,
          // `parseServedReposFromSubjects` stays unstubbed: a non-zero exit must
          // short-circuit before it, even though stdout would have parsed.
          dependencies({ runAz: az.runAz })
        );

        expect(recording.status, String(code)).toBe(200);
        expect(recording.body, String(code)).toBe('{"servesRepos":null}');
      }
    });

    it("degrades unparsable stdout and a throwing parser to a null label", async () => {
      for (const [stdout, parse] of [
        ["not json", () => ["octo/app"]],
        [
          '["ok"]',
          (): string[] => {
            throw new Error("bad subjects");
          }
        ]
      ] as const) {
        const az = azFake({ [ARGV.fic(APP_ID)]: { stdout } });
        const recording = await run(
          `/api/azure-app-serves-repos?appId=${APP_ID}`,
          handleAzureAppServesRepos,
          dependencies({
            runAz: az.runAz,
            parseServedReposFromSubjects: parse
          })
        );

        expect(recording.status, stdout).toBe(200);
        expect(recording.body, stdout).toBe('{"servesRepos":null}');
      }
    });

    it("propagates a rejecting runner instead of answering 400", async () => {
      const az = azFake({
        [ARGV.fic(APP_ID)]: { throws: new Error("spawn ENOENT") }
      });

      // Unlike the list route, this one has no surrounding try/catch, so the
      // request fails rather than degrading to an error response.
      await expect(
        run(
          `/api/azure-app-serves-repos?appId=${APP_ID}`,
          handleAzureAppServesRepos,
          dependencies({ runAz: az.runAz })
        )
      ).rejects.toThrow();
    });
  });

  describe("POST /api/discover", () => {
    const SUB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const NS_TRIPLE = ["default", "kube-system", "radius-system"];
    // The shape every failing arm answers with. Pinned once so each refusal
    // below asserts the whole body rather than only its `error` field.
    const REFUSAL = {
      clusters: [],
      resourceGroups: [],
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    };

    // Exact argv vectors, keyed on the joined command line exactly as the `az`
    // fake above is. `sub` appends the `--subscription` pair the azure arm adds
    // only when a subscription was supplied.
    const CLI = {
      accountSet: (id: string) => `az account set --subscription ${id}`,
      aks: (sub = "") =>
        "az aks list --query [].{id:name, name:name, resourceGroup:resourceGroup} -o json" +
        sub,
      groups: (sub = "") =>
        "az group list --query [].{id:name, name:name} -o json" + sub,
      credentials: (cluster: string, rg: string) =>
        `az aks get-credentials --name ${cluster} --resource-group ${rg} --overwrite-existing`,
      namespaces:
        "kubectl get namespaces -o jsonpath={.items[*].metadata.name}",
      eks: "aws eks list-clusters --query clusters --output json",
      vpcs: "aws ec2 describe-vpcs --query Vpcs[].{id:VpcId, name:VpcId} --output json",
      subnets:
        "aws ec2 describe-subnets --query Subnets[].{id:SubnetId, name:SubnetId} --output json"
    };
    const sub = (id: string) => ` --subscription ${id}`;

    interface CliCall {
      line: string;
      timeout: number;
    }

    // Same discipline as `azFake`: the runner is scripted on the full command
    // line and throws on anything unscripted, so a dropped `--subscription`, a
    // changed `--query` projection, or a call the arm should have skipped fails
    // loudly instead of matching a looser key.
    function cliFake(script: Record<string, string | { throws: unknown }>) {
      const calls: CliCall[] = [];
      const runCli: AzureDiscoveryDependencies["runCli"] = (
        command,
        args,
        options
      ) => {
        const line = [command, ...args].join(" ");
        calls.push({ line, timeout: options.timeout });
        const scripted = script[line];
        if (scripted === undefined) {
          throw new Error(`unscripted cli call: ${line}`);
        }
        if (typeof scripted !== "string") {
          return Promise.reject(scripted.throws);
        }
        return Promise.resolve(scripted);
      };
      return { calls, runCli };
    }

    function discover(
      body: string,
      overrides: Partial<AzureDiscoveryDependencies> = {}
    ): Promise<Recording> {
      return run(
        "/api/discover",
        handleDiscover,
        dependencies(overrides),
        body
      );
    }

    it("answers 200 with the refusal shape when the body is not JSON", async () => {
      // `runCli` stays unstubbed: the parse failure must land before any spawn.
      const recording = await discover("not json");

      expect(recording.status).toBe(200);
      expect(recording.contentType).toBe("application/json");
      const parsed = JSON.parse(recording.body) as { error: string };
      expect(parsed.error.length).toBeGreaterThan(0);
      expect(parsed).toMatchObject(REFUSAL);
    });

    it("answers the same refusal for an empty body and for a null body", async () => {
      // An empty body fails in `JSON.parse`; `null` parses cleanly and then
      // throws out of the `data.subscriptionId` read. Both are the same answer.
      for (const body of ["", "null"]) {
        const recording = await discover(body);

        expect(recording.status, body).toBe(200);
        const parsed = JSON.parse(recording.body) as { error: string };
        expect(parsed.error.length, body).toBeGreaterThan(0);
        expect(parsed, body).toMatchObject(REFUSAL);
      }
    });

    it("lets a scalar body fall through to the aws arm instead of refusing", async () => {
      // Only `null` and `undefined` throw on a property read: reading
      // `.subscriptionId` off a number or a string boxes the primitive and
      // yields `undefined`, so the request proceeds as a provider-less
      // discovery. Pinned because it looks like it should share the `null`
      // refusal and does not.
      for (const body of ["42", '"a string"']) {
        const cli = cliFake({
          [CLI.eks]: "[]",
          [CLI.vpcs]: "[]",
          [CLI.subnets]: "[]"
        });
        const recording = await discover(body, { runCli: cli.runCli });

        expect(recording.status, body).toBe(200);
        expect(JSON.parse(recording.body), body).toEqual({
          clusters: [],
          resourceGroups: [],
          namespaces: NS_TRIPLE,
          vpcs: [],
          subnets: []
        });
      }
    });

    it("refuses a non-GUID subscriptionId before it reaches the az argv", async () => {
      for (const bad of ["x&calc", "not-a-guid", "  ", "sub with space"]) {
        // `runCli` stays unstubbed: reaching a spawn at all throws, which is
        // the point of the guard.
        const recording = await discover(
          JSON.stringify({ provider: "azure", subscriptionId: bad })
        );

        expect(recording.status, bad).toBe(200);
        expect(recording.contentType, bad).toBe("application/json");
        expect(JSON.parse(recording.body), bad).toEqual({
          error: `Invalid subscriptionId "${bad}" (expected a GUID).`,
          ...REFUSAL
        });
      }
    });

    it("accepts a padded GUID but forwards the untrimmed value to az", async () => {
      // The guard trims before validating and the argv does not, so the raw
      // value is what reaches the CLI. Pinned because collapsing the two would
      // look like a harmless cleanup.
      const padded = ` ${SUB} `;
      const cli = cliFake({
        [CLI.accountSet(padded)]: "",
        [CLI.aks(sub(padded))]: "[]",
        [CLI.groups(sub(padded))]: "[]"
      });
      const recording = await discover(
        JSON.stringify({ provider: "azure", subscriptionId: padded }),
        { runCli: cli.runCli }
      );

      expect(recording.status).toBe(200);
      expect(cli.calls.map((call) => call.line)).toEqual([
        CLI.accountSet(padded),
        CLI.aks(sub(padded)),
        CLI.groups(sub(padded))
      ]);
      expect(JSON.parse(recording.body)).toEqual({
        clusters: [],
        resourceGroups: [],
        namespaces: NS_TRIPLE,
        vpcs: [],
        subnets: []
      });
    });

    it("omits the subscription arguments entirely when none is supplied", async () => {
      // An empty subscriptionId is falsy, so the guard allows it and both the
      // `account set` call and the `--subscription` pair are skipped: the CLI
      // runs in its ambient context.
      for (const body of [
        { provider: "azure" },
        { provider: "azure", subscriptionId: "" }
      ]) {
        const cli = cliFake({ [CLI.aks()]: "[]", [CLI.groups()]: "[]" });
        const recording = await discover(JSON.stringify(body), {
          runCli: cli.runCli
        });

        expect(recording.status).toBe(200);
        expect(cli.calls.map((call) => call.line)).toEqual([
          CLI.aks(),
          CLI.groups()
        ]);
      }
    });

    it("swallows an account-set failure and still queries with an explicit subscription", async () => {
      const cli = cliFake({
        [CLI.accountSet(SUB)]: { throws: new Error("no such subscription") },
        [CLI.aks(sub(SUB))]: "[]",
        [CLI.groups(sub(SUB))]: "[]"
      });
      const recording = await discover(
        JSON.stringify({ provider: "azure", subscriptionId: SUB }),
        { runCli: cli.runCli }
      );

      expect(recording.status).toBe(200);
      // The failure is deliberately not surfaced: it produces no `errors` entry
      // and does not stop the enumeration.
      expect(JSON.parse(recording.body)).toEqual({
        clusters: [],
        resourceGroups: [],
        namespaces: NS_TRIPLE,
        vpcs: [],
        subnets: []
      });
    });

    it("projects clusters and resource groups and reads namespaces from the cluster", async () => {
      const cli = cliFake({
        [CLI.aks()]: JSON.stringify([
          { id: "aks-1", name: "aks-1", resourceGroup: "rg-1" },
          { id: 7, name: null },
          null,
          7,
          []
        ]),
        [CLI.groups()]: JSON.stringify([{ id: "rg-1", name: "rg-1" }]),
        [CLI.credentials("aks-1", "rg-1")]: "",
        [CLI.namespaces]: '"default" "radius-system"  '
      });
      const recording = await discover(JSON.stringify({ provider: "azure" }), {
        runCli: cli.runCli
      });

      expect(recording.status).toBe(200);
      expect(recording.contentType).toBe("application/json");
      // Non-string projection fields collapse to "" rather than being dropped,
      // and the kubectl jsonpath output is de-quoted, split, and compacted.
      expect(JSON.parse(recording.body)).toEqual({
        clusters: [
          { id: "aks-1", name: "aks-1", resourceGroup: "rg-1" },
          { id: "", name: "", resourceGroup: "" },
          { id: "", name: "", resourceGroup: "" },
          { id: "", name: "", resourceGroup: "" },
          { id: "", name: "", resourceGroup: "" }
        ],
        resourceGroups: [{ id: "rg-1", name: "rg-1", resourceGroup: "" }],
        namespaces: ["default", "radius-system"],
        vpcs: [],
        subnets: []
      });
      // The per-call timeouts are part of the contract with the runner.
      expect(cli.calls).toEqual([
        { line: CLI.aks(), timeout: 30000 },
        { line: CLI.groups(), timeout: 30000 },
        { line: CLI.credentials("aks-1", "rg-1"), timeout: 20000 },
        { line: CLI.namespaces, timeout: 10000 }
      ]);
    });

    it("records a per-facet error for each failing azure query without failing the request", async () => {
      const cli = cliFake({
        [CLI.aks()]: { throws: new Error("aks denied") },
        [CLI.groups()]: { throws: "groups exploded" }
      });
      const recording = await discover(JSON.stringify({ provider: "azure" }), {
        runCli: cli.runCli
      });

      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body)).toEqual({
        clusters: [],
        resourceGroups: [],
        // No cluster to reach, so the namespace list falls back rather than
        // being left empty.
        namespaces: NS_TRIPLE,
        vpcs: [],
        subnets: [],
        errors: { clusters: "aks denied", resourceGroups: "groups exploded" }
      });
    });

    it("truncates a long failure message to 800 characters", async () => {
      const cli = cliFake({
        [CLI.aks()]: { throws: new Error("x".repeat(1000)) },
        [CLI.groups()]: "[]"
      });
      const recording = await discover(JSON.stringify({ provider: "azure" }), {
        runCli: cli.runCli
      });

      const parsed = JSON.parse(recording.body) as {
        errors: { clusters: string };
      };
      expect(parsed.errors.clusters).toBe("x".repeat(800));
    });

    it("falls back to the default namespaces when the cluster row carries no name", async () => {
      // A cluster exists but its id is empty, so `get-credentials` is skipped
      // entirely. `runCli` is scripted for only the two list calls, so
      // attempting the credentials call would throw.
      const cli = cliFake({
        [CLI.aks()]: JSON.stringify([{ name: "unnamed" }]),
        [CLI.groups()]: JSON.stringify([{ id: "rg-1", name: "rg-1" }])
      });
      const recording = await discover(JSON.stringify({ provider: "azure" }), {
        runCli: cli.runCli
      });

      expect(recording.status).toBe(200);
      expect(cli.calls.map((call) => call.line)).toEqual([
        CLI.aks(),
        CLI.groups()
      ]);
      expect(
        (JSON.parse(recording.body) as { namespaces: string[] }).namespaces
      ).toEqual(NS_TRIPLE);
    });

    it("falls back to the default namespaces when no resource group was discovered", async () => {
      const cli = cliFake({
        [CLI.aks()]: JSON.stringify([{ id: "aks-1", name: "aks-1" }]),
        [CLI.groups()]: "[]"
      });
      const recording = await discover(JSON.stringify({ provider: "azure" }), {
        runCli: cli.runCli
      });

      expect(cli.calls.map((call) => call.line)).toEqual([
        CLI.aks(),
        CLI.groups()
      ]);
      expect(
        (JSON.parse(recording.body) as { namespaces: string[] }).namespaces
      ).toEqual(NS_TRIPLE);
    });

    it("falls back to the default namespaces when kubectl or get-credentials fails", async () => {
      for (const failing of [
        CLI.credentials("aks-1", "rg-1"),
        CLI.namespaces
      ]) {
        const cli = cliFake({
          [CLI.aks()]: JSON.stringify([
            { id: "aks-1", name: "aks-1", resourceGroup: "rg-1" }
          ]),
          [CLI.groups()]: JSON.stringify([{ id: "rg-1", name: "rg-1" }]),
          [CLI.credentials("aks-1", "rg-1")]: "",
          [CLI.namespaces]: "ns-a",
          [failing]: { throws: new Error("kube down") }
        });
        const recording = await discover(
          JSON.stringify({ provider: "azure" }),
          {
            runCli: cli.runCli
          }
        );

        expect(recording.status, failing).toBe(200);
        const parsed = JSON.parse(recording.body) as {
          namespaces: string[];
          errors?: unknown;
        };
        // The namespace failure is absorbed by the fallback and never becomes
        // an `errors` entry, unlike the two list queries above.
        expect(parsed.namespaces, failing).toEqual(NS_TRIPLE);
        expect(parsed.errors, failing).toBeUndefined();
      }
    });

    it("treats unparsable az output as an empty facet rather than an error", async () => {
      // `JSON.parse` throws inside the same try as the spawn, so bad stdout
      // takes the identical arm a failed spawn does -- but the message is the
      // parse failure, not a CLI failure.
      const cli = cliFake({ [CLI.aks()]: "not json", [CLI.groups()]: "null" });
      const recording = await discover(JSON.stringify({ provider: "azure" }), {
        runCli: cli.runCli
      });

      const parsed = JSON.parse(recording.body) as {
        clusters: unknown[];
        resourceGroups: unknown[];
        errors: Record<string, string>;
      };
      expect(parsed.clusters).toEqual([]);
      // A non-array parses fine and projects to an empty list with no error.
      expect(parsed.resourceGroups).toEqual([]);
      expect(Object.keys(parsed.errors)).toEqual(["clusters"]);
    });

    it("takes the aws arm for every provider other than azure", async () => {
      for (const provider of [undefined, "aws", "AZURE", ""]) {
        const cli = cliFake({
          [CLI.eks]: '["eks-1", 7, null]',
          [CLI.vpcs]: JSON.stringify([{ id: "vpc-1", name: "vpc-1" }]),
          [CLI.subnets]: JSON.stringify([{ id: "sn-1", name: "sn-1" }])
        });
        const recording = await discover(JSON.stringify({ provider }), {
          runCli: cli.runCli
        });

        expect(recording.status, String(provider)).toBe(200);
        // EKS returns bare cluster names, so non-strings are filtered out
        // rather than projected through `discoveryItems`.
        expect(JSON.parse(recording.body), String(provider)).toEqual({
          clusters: [{ id: "eks-1", name: "eks-1" }],
          resourceGroups: [],
          namespaces: NS_TRIPLE,
          vpcs: [{ id: "vpc-1", name: "vpc-1", resourceGroup: "" }],
          subnets: [{ id: "sn-1", name: "sn-1", resourceGroup: "" }]
        });
        expect(cli.calls, String(provider)).toEqual([
          { line: CLI.eks, timeout: 15000 },
          { line: CLI.vpcs, timeout: 15000 },
          { line: CLI.subnets, timeout: 15000 }
        ]);
      }
    });

    it("still refuses a bad subscriptionId on the aws arm", async () => {
      // The guard runs before the provider split, so it applies even where no
      // subscription is ever used.
      const recording = await discover(
        JSON.stringify({ provider: "aws", subscriptionId: "x&calc" })
      );

      expect(JSON.parse(recording.body)).toEqual({
        error: 'Invalid subscriptionId "x&calc" (expected a GUID).',
        ...REFUSAL
      });
    });

    it("records a per-facet error for each failing aws query", async () => {
      const cli = cliFake({
        [CLI.eks]: { throws: new Error("eks denied") },
        [CLI.vpcs]: { throws: new Error("vpcs denied") },
        [CLI.subnets]: { throws: new Error("subnets denied") }
      });
      const recording = await discover(JSON.stringify({ provider: "aws" }), {
        runCli: cli.runCli
      });

      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body)).toEqual({
        clusters: [],
        resourceGroups: [],
        namespaces: NS_TRIPLE,
        vpcs: [],
        subnets: [],
        errors: {
          clusters: "eks denied",
          vpcs: "vpcs denied",
          subnets: "subnets denied"
        }
      });
    });

    it("creates the errors bag on whichever facet fails first", async () => {
      // `result.errors = result.errors || {}` has two arms per facet, and a
      // suite where the first query always fails only ever exercises the
      // creating arm on clusters. These two cases fail a *later* facet with the
      // earlier ones succeeding, so each facet is pinned as able to create the
      // bag on its own.
      const azure = cliFake({
        [CLI.aks()]: "[]",
        [CLI.groups()]: { throws: new Error("groups denied") }
      });
      const azureRecording = await discover(
        JSON.stringify({ provider: "azure" }),
        { runCli: azure.runCli }
      );
      expect(
        (JSON.parse(azureRecording.body) as { errors: unknown }).errors
      ).toEqual({ resourceGroups: "groups denied" });

      const aws = cliFake({
        [CLI.eks]: "[]",
        [CLI.vpcs]: "[]",
        [CLI.subnets]: { throws: new Error("subnets denied") }
      });
      const awsRecording = await discover(JSON.stringify({ provider: "aws" }), {
        runCli: aws.runCli
      });
      expect(
        (JSON.parse(awsRecording.body) as { errors: unknown }).errors
      ).toEqual({ subnets: "subnets denied" });
    });

    it("keeps a non-array eks payload as an empty cluster list with no error", async () => {
      const cli = cliFake({
        [CLI.eks]: '{"clusters":[]}',
        [CLI.vpcs]: "[]",
        [CLI.subnets]: "[]"
      });
      const recording = await discover(JSON.stringify({ provider: "aws" }), {
        runCli: cli.runCli
      });

      expect(JSON.parse(recording.body)).toEqual({
        clusters: [],
        resourceGroups: [],
        namespaces: NS_TRIPLE,
        vpcs: [],
        subnets: []
      });
    });
  });
});
