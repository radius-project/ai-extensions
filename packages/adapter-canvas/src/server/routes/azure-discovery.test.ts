import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createAzureDiscoveryRoutes,
  handleAzureAppServesRepos,
  handleListAzureAppRegistrations,
  type AzureCommandResult,
  type AzureDiscoveryDependencies
} from "./azure-discovery.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  contentType: string | undefined;
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    contentType: undefined,
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
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

function request(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    url,
    method: "GET",
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
// widening of the dependency surface fails loudly.
function dependencies(
  overrides: Partial<AzureDiscoveryDependencies> = {}
): AzureDiscoveryDependencies {
  return {
    runAz: () => {
      throw new Error("runAz not stubbed");
    },
    isUuid: () => {
      throw new Error("isUuid not stubbed");
    },
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
  deps: AzureDiscoveryDependencies
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(url),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handler(context, deps);
  return recording;
}

describe("azure-discovery read routes (SU-06)", () => {
  it("declares exactly the two routes it owns", () => {
    expect(Object.keys(createAzureDiscoveryRoutes(dependencies()))).toEqual([
      "GET /api/list-azure-app-registrations",
      "GET /api/azure-app-serves-repos"
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
          dependencies({ isUuid: (value) => value === APP_ID })
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
          isUuid: (value) => value === APP_ID,
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
          isUuid: () => true,
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
          isUuid: () => true,
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
          dependencies({ runAz: az.runAz, isUuid: () => true })
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
            isUuid: () => true,
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
          dependencies({ runAz: az.runAz, isUuid: () => true })
        )
      ).rejects.toThrow();
    });
  });
});
