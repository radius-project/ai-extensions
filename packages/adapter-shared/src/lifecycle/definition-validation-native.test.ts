import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createValidationPolicy,
  portSuccess,
  type RequestControl,
  type SourceSelection
} from "@radius-project/core/lifecycle";
import { RadProcessError, spawnRad } from "../rad.js";
import { createDefinitionValidationAdapter } from "./definition-validation.js";
import {
  createSourceReadAdapter,
  nodeSourceFileSystem,
  type SourceReadAdapter
} from "./source-access.js";

const directory = dirname(fileURLToPath(import.meta.url));
const archiveFile = resolve(
  directory,
  "../../test/fixtures/lifecycle-registry-inputs/custom-types.tgz.base64"
);
const scriptPath = resolve(
  directory,
  "../../../../extensions/radius/skills/radius-app-bicep/scripts/validate-bicep.mjs"
);
const ownedTools = process.env.RADIUS_NATIVE_GRAPH_TEST_TOOLS;
const applicationType = "Radius.Core/applications@2025-08-01-preview";
const commit = "a".repeat(40);
const selection: SourceSelection = {
  repo: "example/native-validation",
  definition: "app.bicep",
  source: { kind: "git", ref: "fixture-branch", expectedCommit: commit }
};
const control: RequestControl = {
  requestId: "native-validation",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const owned: { root: string; source?: SourceReadAdapter }[] = [];
const scenarios = [
  {
    name: "an empty definition",
    schema: false,
    outcome: "passed",
    empty: true
  },
  { name: "application-only schema evidence", schema: true, outcome: "passed" },
  { name: "missing schema evidence", schema: false, outcome: "incomplete" },
  {
    name: "a native linter warning",
    schema: true,
    outcome: "failed",
    warning: true
  },
  {
    name: "a native property type mismatch",
    schema: true,
    outcome: "failed",
    typeError: true
  }
] as const;

async function capture(options: {
  schema: boolean;
  warning?: boolean;
  typeError?: boolean;
  configuration?: boolean;
  empty?: boolean;
}) {
  const root = resolve(".artifacts", `nv-${randomUUID().slice(0, 8)}`);
  const ownership: (typeof owned)[number] = { root };
  owned.push(ownership);
  await mkdir(join(root, "snapshots"), { recursive: true });
  await mkdir(join(root, "validation"));
  const encoded = await readFile(archiveFile, "utf8");
  const archive = Buffer.from(encoded, "base64");
  expect(createHash("sha256").update(archive).digest("hex")).toBe(
    "2456583fbd7dc7e006107e34c496cee7f912d2d2b4e9b11e2efa5cce9b1fb175"
  );
  // Reuse the exact published archive under a standalone name: custom-types.tgz
  // denotes a modeling artifact set with a required Recipe companion.
  const data = new Map<string, Uint8Array>(
    options.empty ? [] : [["radius-types.tgz", archive]]
  );
  const text = new TextEncoder();
  data.set(
    "app.bicep",
    text.encode(
      options.empty ?
        "// empty native definition\n"
      : "extension './radius-types.tgz' as radius\n" +
          (options.warning ? "var unusedFixture = 'unused'\n" : "") +
          `resource application '${applicationType}' = {\n` +
          "  name: 'native-validation'\n" +
          "  properties: {\n" +
          `    environment: ${options.typeError ? "42" : "'fixture-environment'"}\n` +
          "  }\n}\n" +
          // This authored data output includes the schema in the captured closure.
          // Neither the capture adapter nor the validator rewrites the source.
          (options.schema ?
            "output schemaEvidence object = loadJsonContent('./resolved-types.json')\n"
          : "")
    )
  );
  if (options.schema)
    data.set(
      "resolved-types.json",
      text.encode(
        JSON.stringify({
          contractVersion: 1,
          types: { [applicationType]: { environment: false } }
        })
      )
    );
  if (options.configuration) data.set("bicepconfig.json", text.encode("{}"));
  const source = createSourceReadAdapter({
    storageRoot: join(root, "snapshots"),
    files: nodeSourceFileSystem,
    clock: { now: () => "2026-09-16T12:00:00Z" },
    ids: { next: () => randomUUID() },
    limits: {
      maxFiles: 10,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 3_000_000
    },
    authority: {
      resolve: async () =>
        portSuccess({
          kind: "git",
          repo: selection.repo,
          accessRef: "fixture-access"
        })
    },
    git: {
      resolveCommit: async () => portSuccess(commit),
      materializeCommit: async (_location, _commit, destination) => {
        for (const [name, bytes] of data)
          await writeFile(join(destination, name), bytes);
        return portSuccess(undefined);
      },
      readCommit: async () => portSuccess(commit),
      workspaceState: async () => {
        throw new Error("Unexpected workspace access");
      }
    }
  });
  ownership.source = source;
  const captured = await source.capture(
    {
      operation: "definition.validate",
      target: selection,
      authorizationRef: "fixture-authorization",
      principalRef: "fixture-principal"
    },
    selection,
    control
  );
  expect(captured).toMatchObject({
    status: "ok",
    value: {
      status: "captured",
      snapshot: { manifest: { completeness: "complete" } }
    }
  });
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error("Expected captured native validation inputs");
  const { snapshot } = captured.value;
  expect(
    snapshot.manifest.inputs
      .filter((input) => input.existed)
      .map((input) => input.path)
      .sort()
  ).toEqual([...data.keys()].sort());
  const runProcess = vi.fn<typeof spawnRad>(spawnRad);
  function validator(native: boolean) {
    if (native)
      expect(ownedTools).toBe(
        resolve(".artifacts", "t038-registry-native", "tools")
      );
    const executable = (name: string) => {
      if (!native) return process.execPath;
      if (!ownedTools) throw new Error("Missing explicitly owned native tools");
      return join(
        ownedTools,
        `${name}${process.platform === "win32" ? ".exe" : ""}`
      );
    };
    return createDefinitionValidationAdapter({
      source,
      files: nodeSourceFileSystem,
      storageRoot: join(root, "validation"),
      ids: { next: () => "native" },
      acquireBinaries: async () =>
        portSuccess({
          radPath: executable("rad"),
          bicepPath: executable("bicep")
        }),
      trustedPath: [],
      ...(process.env.SystemRoot ? { systemRoot: process.env.SystemRoot } : {}),
      timeoutMs: 10_000,
      nodePath: process.execPath,
      scriptPath,
      runProcess
    });
  }
  async function verifyUnchanged() {
    for (const [name, bytes] of data)
      expect(await source.readBytes(snapshot, name, control)).toMatchObject({
        status: "ok",
        value: { bytes: new Uint8Array(bytes) }
      });
    expect(await readFile(archiveFile, "utf8")).toBe(encoded);
    expect(await readdir(join(root, "validation"))).toEqual([]);
    expect(await source.releaseSnapshot(snapshot)).toMatchObject({
      status: "ok"
    });
    await source.close();
    expect(await readdir(join(root, "snapshots"))).toEqual([]);
  }
  return {
    validator,
    runProcess,
    verifyUnchanged,
    request: {
      snapshot,
      sourceFingerprint: snapshot.manifest.fingerprint,
      policy: createValidationPolicy("validation")
    }
  };
}

afterEach(async () => {
  for (const { source, root } of owned.splice(0)) {
    try {
      await source?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("native definition validation qualification", () => {
  it.each(scenarios)(
    "captures $name without claiming native evidence",
    async (scenario) => {
      const fixture = await capture(scenario);
      await fixture.verifyUnchanged();
      expect(fixture.runProcess).not.toHaveBeenCalled();
    }
  );

  it.runIf(process.platform === "win32")(
    "refuses captured configuration without an isolated Windows cache before spawning",
    async () => {
      const fixture = await capture({ schema: true, configuration: true });
      expect(
        await fixture.validator(false).validate(fixture.request, control)
      ).toMatchObject({
        status: "ok",
        value: { status: "incomplete" }
      });
      expect(fixture.runProcess).not.toHaveBeenCalled();
      await fixture.verifyUnchanged();
    }
  );

  it.runIf(ownedTools !== undefined).each(scenarios)(
    "validates $name through owned native Bicep and the machine executable",
    async (scenario) => {
      const fixture = await capture(scenario);
      const result = await fixture
        .validator(true)
        .validate(fixture.request, control);
      expect(fixture.runProcess).toHaveBeenCalledTimes(2);
      const [compilerCall, validatorCall] = fixture.runProcess.mock.calls;
      expect(compilerCall[1].slice(2)).toEqual([
        "--diagnostics-format",
        "sarif",
        "--stdout"
      ]);
      expect(validatorCall[1].slice(0, 2)).toEqual([
        scriptPath,
        "--validate-json"
      ]);
      for (const [, , options] of fixture.runProcess.mock.calls) {
        expect(options?.inheritEnv).toBe(false);
        for (const name of [
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "AWS_PROFILE",
          "NODE_OPTIONS"
        ])
          expect(options?.env?.[name]).toBeUndefined();
      }
      const compiled = await fixture.runProcess.mock.results[0].value.catch(
        (error: unknown) => {
          if (error instanceof RadProcessError) return error;
          throw error;
        }
      );
      console.log(
        JSON.stringify({
          nativeDefinitionQualification: scenario.name,
          compiler: { stdout: compiled.stdout, stderr: compiled.stderr },
          report: result
        })
      );
      const diagnostics = JSON.parse(compiled.stderr);
      expect(diagnostics).toMatchObject({ runs: expect.any(Array) });
      if ("typeError" in scenario) {
        // Bicep emits BCP036 without a level and exits zero for this extension.
        // Required validation must reject it rather than trust the exit status.
        expect(compiled).not.toBeInstanceOf(RadProcessError);
        expect(diagnostics.runs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              results: expect.arrayContaining([
                expect.objectContaining({ ruleId: "BCP036" })
              ])
            })
          ])
        );
      } else {
        expect(compiled).not.toBeInstanceOf(RadProcessError);
        expect(JSON.parse(compiled.stdout)).toMatchObject(
          "empty" in scenario ?
            {
              resources: {}
            }
          : {
              resources: {
                application: {
                  type: applicationType,
                  properties: {
                    name: "native-validation",
                    properties: { environment: "fixture-environment" }
                  }
                }
              }
            }
        );
        if ("warning" in scenario)
          expect(diagnostics.runs).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                results: expect.arrayContaining([
                  expect.objectContaining({ ruleId: "no-unused-vars" })
                ])
              })
            ])
          );
      }
      expect(result).toMatchObject({
        status: "ok",
        value: {
          status: scenario.outcome,
          sourceFingerprint: fixture.request.sourceFingerprint
        }
      });
      if (result.status !== "ok")
        throw new Error("Expected native validation report");
      const required = result.value.checks.filter(
        (check) => check.classification === "required"
      );
      expect(required).toHaveLength(7);
      if (scenario.outcome === "passed")
        expect(required.every((check) => check.status === "passed")).toBe(true);
      else if (scenario.outcome === "incomplete")
        expect(
          required
            .filter((check) => check.status === "unavailable")
            .map((check) => check.checkId)
        ).toEqual(["type-compatibility", "secret-safety"]);
      else
        expect(required).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              checkId: "bicep-compile",
              status: "failed"
            }),
            expect.objectContaining({
              checkId: "type-compatibility",
              status: "failed"
            })
          ])
        );
      await fixture.verifyUnchanged();
    },
    15_000
  );
});
