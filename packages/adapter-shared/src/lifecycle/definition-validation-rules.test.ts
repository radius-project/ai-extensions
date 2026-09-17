import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateCompiledDefinition,
  validateCompiledDefinitionFiles,
  type CompiledValidationInput
} from "../../../../extensions/radius/skills/radius-app-bicep/scripts/validate-bicep.mjs";

const roots: string[] = [];
const type = "Radius.Messaging/rabbitMQ@2025-08-01";
const source = { codeReference: "src/main.ts" };
const applicationType = "Radius.Core/applications@2025-08-01-preview";
const application = {
  type: applicationType,
  properties: {
    name: "validation-app",
    location: "global",
    properties: { environment: "validation" }
  }
};
const applicationSchema = JSON.stringify({
  contractVersion: 1,
  types: { [applicationType]: { environment: false } }
});

async function input(template: unknown, schema?: string) {
  const root = resolve(".artifacts", `validation-rules-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  if (schema !== undefined)
    await writeFile(join(root, "resolved-types.json"), schema);
  const options: CompiledValidationInput = {
    app: join(root, "app.bicep"),
    templateText: JSON.stringify(template),
    diagnosticsText: '{"runs":[{"results":[]}]}',
    compilerStatus: "passed"
  };
  return { root, options };
}

function statuses(options: CompiledValidationInput) {
  return Object.fromEntries(
    validateCompiledDefinition(options).checks.map((check) => [
      check.checkId,
      check.status
    ])
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("existing validation rules in machine mode", () => {
  it.each([
    { resources: { application } },
    {
      resources: {
        module: {
          type: "Microsoft.Resources/deployments",
          properties: { template: { resources: { application } } }
        }
      }
    }
  ])(
    "validates nonempty application-only definitions with captured schema evidence",
    async (template) => {
      const { options } = await input(template, applicationSchema);
      expect(Object.values(statuses(options))).toEqual(Array(6).fill("passed"));
    }
  );

  it("does not substitute inapplicability for required application schema evidence", async () => {
    const { options } = await input({ resources: { application } });
    expect(statuses(options)).toEqual({
      "bicep-compile": "passed",
      "type-compatibility": "unavailable",
      "secret-safety": "unavailable",
      "runtime-contract": "passed",
      "reference-consistency": "passed",
      "recipe-constraints": "passed"
    });
  });

  it("does not exempt a workload alongside an application, even with all sensitivity maps captured", async () => {
    const { options } = await input(
      {
        resources: {
          application,
          service: { type, properties: { properties: source } }
        }
      },
      JSON.stringify({
        contractVersion: 1,
        types: {
          [applicationType]: { environment: false },
          [type]: { codeReference: false }
        }
      })
    );
    expect(statuses(options)).toEqual({
      "bicep-compile": "passed",
      "type-compatibility": "passed",
      "secret-safety": "passed",
      "runtime-contract": "unavailable",
      "reference-consistency": "unavailable",
      "recipe-constraints": "unavailable"
    });
  });

  it("does not exempt independently supplied Recipe evidence for an application-only model", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { root, options } = await input(
      { resources: { application } },
      applicationSchema
    );
    const file = join(root, "custom-recipe-pack.bicep");
    await writeFile(file, "not a Recipe pack");
    expect(
      statuses({ ...options, recipeFiles: [file] })["recipe-constraints"]
    ).toBe("unavailable");
    expect(
      statuses({ ...options, provider: "azure", recipeFiles: [file] })[
        "recipe-constraints"
      ]
    ).toBe("failed");
  });

  it.each([
    { type: "Microsoft.Resources/deployments", properties: {} },
    { properties: {} },
    { type: "Unknown.Provider/resource@2025-08-01", properties: {} }
  ])(
    "cannot prove inapplicability from an application alongside unresolved evidence: %j",
    async (unresolved) => {
      const { options } = await input(
        { resources: { application, unresolved } },
        applicationSchema
      );
      expect(statuses(options)).toMatchObject({
        "type-compatibility": "unavailable",
        "secret-safety": "unavailable",
        "runtime-contract": "unavailable",
        "reference-consistency": "unavailable",
        "recipe-constraints": "unavailable"
      });
    }
  );

  it("reads only supplied compiler artifacts and never requires a repair run", async () => {
    const { root, options } = await input({ resources: [] });
    const template = join(root, "compiled.json");
    const diagnostics = join(root, "diagnostics.json");
    await writeFile(template, options.templateText);
    await writeFile(diagnostics, options.diagnosticsText);
    expect(
      validateCompiledDefinitionFiles([
        options.app,
        template,
        diagnostics,
        "passed"
      ]).checks
    ).toEqual(validateCompiledDefinition(options).checks);
    expect(
      validateCompiledDefinitionFiles([
        options.app,
        template,
        diagnostics,
        "passed",
        "unspecified"
      ]).version
    ).toBe(1);
    expect(
      validateCompiledDefinitionFiles([
        options.app,
        template,
        diagnostics,
        "failed",
        "aws"
      ]).checks[0].status
    ).toBe("failed");
  });

  it.each(
    [
      [],
      ["relative", "relative", "relative", "passed"],
      ["absolute", "absolute", "absolute", "unknown"],
      ["absolute", "absolute", "absolute", "passed", "unsupported"],
      ["absolute", "absolute", "absolute", "passed", "azure", "relative"]
    ].map((args) => ({ args }))
  )(
    "rejects incomplete or unsafe machine arguments %# before reading files",
    async ({ args }) => {
      const { root } = await input({});
      expect(() =>
        validateCompiledDefinitionFiles(
          args.map((value) =>
            value === "absolute" ? join(root, "missing") : value
          )
        )
      ).toThrow("explicit owned artifact paths");
    }
  );

  it("surfaces missing compiler artifacts as executable failures, not empty evidence", async () => {
    const { root, options } = await input({});
    expect(() =>
      validateCompiledDefinitionFiles([
        options.app,
        join(root, "missing"),
        join(root, "missing-sarif"),
        "passed",
        "azure"
      ])
    ).toThrow();
  });

  it("keeps an unreadable declared Recipe incomplete rather than invalid or passed", async () => {
    const { root, options } = await input({ resources: {} });
    expect(
      statuses({
        ...options,
        provider: "azure",
        recipeFiles: [join(root, "missing-recipe.bicep")]
      })["recipe-constraints"]
    ).toBe("unavailable");
  });
  it.each([{}, []])(
    "accepts the compiler's resource-map and resource-array shapes",
    async (resources) => {
      const { options } = await input({ resources });
      expect(Object.values(statuses(options))).toEqual(Array(6).fill("passed"));
    }
  );

  it.each(["{", "null", "[]", "42", "{}", '{"resources":null}'])(
    "rejects malformed compiled evidence %s",
    async (templateText) => {
      const { options } = await input({});
      expect(Object.values(statuses({ ...options, templateText }))).toEqual(
        Array(6).fill("unavailable")
      );
    }
  );

  it("retains compilation failure when no template can be emitted", async () => {
    const { options } = await input(null);
    expect(statuses({ ...options, compilerStatus: "failed" })).toMatchObject({
      "bicep-compile": "failed",
      "type-compatibility": "unavailable"
    });
  });

  it.each([
    ["{", "unavailable"],
    ['{"runs":[]}', "unavailable"],
    ['{"runs":[{"results":[{"level":"note"},{"level":"none"}]}]}', "passed"],
    ['{"runs":[{"results":[{"level":"warning"}]}]}', "failed"],
    ['{"runs":[{"results":[{}]}]}', "failed"]
  ])(
    "preserves compiler diagnostic severity for %s",
    async (diagnosticsText, status) => {
      const { options } = await input({ resources: {} });
      expect(statuses({ ...options, diagnosticsText })["bicep-compile"]).toBe(
        status
      );
    }
  );

  it.each([undefined, "{", '{"contractVersion":2,"types":{}}'])(
    "discloses absent or unusable resolved schemas %#",
    async (schema) => {
      const { options } = await input(
        {
          resources: { service: { type, properties: { properties: source } } }
        },
        schema
      );
      expect(statuses(options)).toMatchObject({
        "bicep-compile": "passed",
        "type-compatibility": "unavailable",
        "secret-safety": "unavailable",
        "runtime-contract": "unavailable",
        "reference-consistency": "unavailable",
        "recipe-constraints": "unavailable"
      });
    }
  );

  it.each([
    [{ password: true }, "passed"],
    [{ password: false }, "failed"],
    [{}, "unavailable"]
  ])(
    "uses actual schema sensitivity rather than treating a credential as a resource ID: %j",
    async (properties, expected) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { options } = await input(
        {
          parameters: { credential: { type: "securestring" } },
          resources: {
            service: {
              type,
              properties: {
                properties: {
                  ...source,
                  password: "[parameters('credential')]"
                }
              }
            }
          }
        },
        JSON.stringify({ contractVersion: 1, types: { [type]: properties } })
      );
      expect(statuses(options)["secret-safety"]).toBe(expected);
    }
  );

  it("runs known secret rules despite unavailable schema evidence for another type", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { options } = await input(
      {
        parameters: { credential: { type: "securestring" } },
        resources: {
          unsafe: {
            type,
            properties: {
              properties: { ...source, password: "[parameters('credential')]" }
            }
          },
          unknown: {
            type: "Radius.Data/unknown@2025-08-01",
            properties: {
              properties: { ...source, password: "[parameters('credential')]" }
            }
          }
        }
      },
      JSON.stringify({
        contractVersion: 1,
        types: { [type]: { password: false } }
      })
    );
    expect(statuses(options)).toMatchObject({
      "type-compatibility": "unavailable",
      "secret-safety": "failed"
    });
  });

  it("propagates missing nested schema evidence without falsely failing a credential", async () => {
    const { options } = await input(
      {
        resources: {
          module: {
            type: "Microsoft.Resources/deployments",
            properties: {
              template: {
                parameters: { credential: { type: "securestring" } },
                resources: {
                  service: {
                    type,
                    properties: {
                      properties: {
                        ...source,
                        password: "[parameters('credential')]"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '{"contractVersion":1,"types":{}}'
    );
    expect(statuses(options)).toMatchObject({
      "type-compatibility": "unavailable",
      "secret-safety": "unavailable"
    });
  });

  it.each([
    { type: "Microsoft.Resources/deployments", properties: {} },
    { type: "Microsoft.Resources/deployments", properties: { template: {} } },
    { properties: {} }
  ])(
    "does not assume unknown or unresolved nested resource contracts passed: %j",
    async (resource) => {
      const { options } = await input({ resources: { unresolved: resource } });
      expect(statuses(options)).toMatchObject({
        "type-compatibility": "unavailable",
        "runtime-contract": "unavailable"
      });
    }
  );

  it("keeps runtime expansion, source references, and image build warnings required", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { options } = await input({
      resources: {
        api: {
          type: "Radius.Compute/containers@2025-08-01",
          properties: {
            properties: {
              codeReference: "Dockerfile",
              containers: { api: { env: { SELF: { value: "$(SELF)" } } } }
            }
          }
        },
        image: {
          type: "Radius.Compute/containerImages@2025-08-01",
          properties: {
            properties: {
              codeReference: "Dockerfile",
              build: {
                source: "git::https://github.com/example/app.git?ref=abcdefa"
              }
            }
          }
        }
      }
    });
    expect(statuses(options)).toMatchObject({
      "runtime-contract": "failed",
      "reference-consistency": "failed"
    });
  });

  it("reports an invalid source reference even without an image build warning", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { options } = await input({
      resources: { service: { type, properties: { properties: {} } } }
    });
    expect(statuses(options)["reference-consistency"]).toBe("failed");
  });

  it.each([
    ["azure", "not a Recipe pack", "failed"],
    ["aws", "not an Azure Recipe pack", "unavailable"],
    [
      "azure",
      "resource pack 'Radius.Core/recipePacks@2025-08-01' = {\n  recipes: {\n    'Radius.Messaging/rabbitMQ': {\n    }\n  }\n}",
      "unavailable"
    ]
  ])(
    "runs the existing applicable Recipe structure validator without inventing mapping evidence: %s",
    async (provider, content, expected) => {
      const { root, options } = await input({
        resources: { service: { type, properties: { properties: source } } }
      });
      const file = join(root, "custom-recipe-pack.bicep");
      await writeFile(file, content);
      expect(
        statuses({ ...options, provider, recipeFiles: [file] })[
          "recipe-constraints"
        ]
      ).toBe(expected);
    }
  );
});
