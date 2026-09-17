import { describe, expect, it, vi } from "vitest";
import Ajv from "ajv";
import {
  LIFECYCLE_API_VERSION,
  PAGE_SIZE_MAX,
  PAGE_SIZE_MIN,
  operationSchemas,
  lifecycleRequestSchema,
  lifecycleResponseSchema,
  type CanonicalGraph,
  type EnvironmentConfiguration,
  type OperationRecord,
  type RequiredAction,
  type ValidationReport,
  type LifecycleOperation,
  type LifecycleRequestFor,
  type LifecycleResponseFor
} from "@radius-project/core/lifecycle";
import { createLifecycleValidators } from "./validation.js";

it("compiles each contract only when used and reuses it within its owning context", () => {
  const compile = vi.spyOn(Ajv.prototype, "compile");
  try {
    const validators = createLifecycleValidators();
    const count = (schema: object) =>
      compile.mock.calls.filter(([value]) => value === schema).length;
    const selected = operationSchemas["capabilities.get"];
    expect(count(selected.request)).toBe(0);
    expect(count(selected.response)).toBe(0);
    for (let index = 0; index < 2; index++)
      expect(
        validators.validateRequest(request("capabilities.get")).valid
      ).toBe(true);
    expect(count(selected.request)).toBe(1);
    expect(count(selected.response)).toBe(0);
    for (let index = 0; index < 2; index++)
      expect(
        validators.validateResponse(response("capabilities.get")).valid
      ).toBe(true);
    expect(count(selected.response)).toBe(1);
    expect(count(lifecycleRequestSchema)).toBe(0);
    expect(count(lifecycleResponseSchema)).toBe(0);
  } finally {
    compile.mockRestore();
  }
});

const git = {
  kind: "git",
  ref: "feature/contracts",
  expectedCommit: "a".repeat(40)
} as const;
const workspace = {
  kind: "workspace",
  workspaceRef: "workspace-1",
  branch: "feature/contracts",
  expectedFingerprint: `sha256:${"b".repeat(64)}`
} as const;
const repo = { repo: "example/service" } as const;
const environment = { ...repo, environment: "test" } as const;
const application = { ...environment, application: "store" } as const;
const definition = {
  ...repo,
  definition: ".radius/app.bicep",
  source: git
} as const;
const observation = {
  quality: "current",
  observedAt: "2026-09-15T12:00:00Z",
  evidence: "source",
  completeness: "complete"
} as const;
const provenance = {
  repo: repo.repo,
  kind: "git",
  ref: git.ref,
  commit: git.expectedCommit,
  fingerprint: workspace.expectedFingerprint,
  resolvedAt: observation.observedAt
} as const;
const workspaceProvenance = {
  repo: repo.repo,
  kind: "workspace",
  workspaceRef: workspace.workspaceRef,
  branch: workspace.branch,
  fingerprint: workspace.expectedFingerprint,
  resolvedAt: observation.observedAt
} as const;
describe("read-only discovery evidence contracts", () => {
  const validators = createLifecycleValidators();
  it("accepts source-only authored inspection and still requires provenance and definition", () => {
    const value = {
      apiVersion: LIFECYCLE_API_VERSION,
      requestId: "read",
      operation: "application.inspect",
      result: {
        target: { ...repo, application: "store" },
        observation,
        authored: { provenance, definition: ".radius/app.bicep", observation }
      }
    };
    expect(validators.validateResponse(value).valid).toBe(true);
    for (const key of ["provenance", "definition", "observation"]) {
      const authored = Object.fromEntries(
        Object.entries(value.result.authored).filter(([name]) => name !== key)
      );
      expect(
        validators.validateResponse({
          ...value,
          result: { ...value.result, authored }
        }).valid
      ).toBe(false);
    }
  });
  it("requires explicit recipe unavailability for partial configuration without weakening creation", () => {
    const result = {
      target: environment,
      configuration: { provider: "azure" },
      protections: { requiredReviewers: false },
      limitations: ["Recipe evidence unavailable."],
      observation: { ...observation, completeness: "partial" },
      recipeObservation: {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "radius",
        limitation: "No read-only recipe evidence channel."
      }
    };
    const value = {
      apiVersion: LIFECYCLE_API_VERSION,
      requestId: "read",
      operation: "environment.inspect",
      result
    };
    expect(validators.validateResponse(value).valid).toBe(true);
    const { recipeObservation: _missing, ...missing } = result;
    expect(
      validators.validateResponse({
        ...value,
        result: {
          ...result,
          configuration: { provider: "azure", recipes: [] }
        }
      }).valid
    ).toBe(false);
    expect(
      validators.validateResponse({ ...value, result: missing }).valid
    ).toBe(false);
    expect(
      validators.validateRequest({
        apiVersion: LIFECYCLE_API_VERSION,
        requestId: "write",
        operation: "environment.create",
        target: environment,
        input: { configuration: { provider: "azure" } }
      }).valid
    ).toBe(false);
  });
});
const report = {
  status: "passed",
  checks: [
    {
      checkId: "compile",
      classification: "required",
      status: "passed",
      reason: "Compiled."
    }
  ],
  warnings: [],
  diagnostics: [],
  sourceFingerprint: workspace.expectedFingerprint
} satisfies ValidationReport;
const policy = { mode: "manual", maxAttempts: 5 } as const;
const configuration = {
  provider: "azure",
  settings: {
    subscriptionId: "subscription-1",
    resourceGroup: "test",
    location: "westus"
  },
  identityRef: "identity-1",
  recipes: []
} satisfies EnvironmentConfiguration;
const record = {
  operationId: "operation-1",
  operation: "deployment.start",
  target: application,
  source: provenance,
  state: "queued",
  observation,
  attempts: [],
  actions: []
} satisfies OperationRecord;
const graph = {
  resources: [
    {
      id: "store",
      name: "store",
      type: "Radius.Core/applications",
      diffHash: `sha256:${"c".repeat(64)}`,
      connections: [],
      outputResources: []
    }
  ]
} satisfies CanonicalGraph;
const userAction = {
  actionId: "action-1",
  operationId: "operation-1",
  target: application,
  source: provenance,
  status: "outstanding",
  kind: "user.decision",
  responder: "user",
  message: "Approve the selected scope",
  response: {
    kind: "user.decision",
    choices: ["approve", "deny"],
    permittedInput: ["approvalRef"]
  }
} satisfies RequiredAction;

const requests = {
  "application.delete": { target: application, input: { intent: "delete" } },
  "application.inspect": {
    target: { ...definition, application: "store" },
    input: {}
  },
  "application.list": { target: repo, input: { pageSize: 1 } },
  "capabilities.get": { target: repo, input: {} },
  "credentials.configure": {
    target: repo,
    input: {
      provider: "azure",
      intent: "authenticate",
      identityRef: "identity-1"
    }
  },
  "credentials.inspect": { target: repo, input: {} },
  "definition.author": {
    target: { ...definition, source: workspace },
    input: { intent: "Create a model", provider: "azure" }
  },
  "definition.validate": {
    target: definition,
    input: { policyVersion: "github-radius/validation/v1" }
  },
  "deployment.start": {
    target: { ...application, ...definition },
    input: { approvalRef: "approval-1", repairPolicy: policy }
  },
  "environment.configure": {
    target: environment,
    input: { patch: configuration }
  },
  "environment.create": {
    target: environment,
    input: { configuration, approvalRef: "approval-1" }
  },
  "environment.delete": { target: environment, input: { intent: "teardown" } },
  "environment.inspect": { target: environment, input: {} },
  "environment.list": { target: repo, input: { pageSize: 1 } },
  "graph.diff": {
    target: repo,
    input: {
      kind: "authored",
      base: { ...definition, repo: "upstream/service" },
      head: definition
    }
  },
  "graph.get": { target: definition, input: { kind: "authored" } },
  "operation.cancel": {
    target: application,
    input: { operationId: "operation-1" }
  },
  "operation.get": {
    target: application,
    input: { operationId: "operation-1" }
  },
  "operation.list": { target: repo, input: { pageSize: 1 } },
  "operation.repair": {
    target: application,
    input: {
      operationId: "operation-1",
      source: workspace,
      repairPolicy: policy,
      approvalRef: "approval-1"
    }
  },
  "operation.respond": {
    target: application,
    input: {
      operationId: "operation-1",
      actionId: "action-1",
      response: {
        kind: "user.decision",
        choice: "approve",
        approvalRef: "approval-1"
      }
    }
  }
} as const satisfies {
  [O in LifecycleOperation]: Pick<LifecycleRequestFor<O>, "target" | "input">;
};

const accepted = {
  operationId: "operation-1",
  target: application,
  state: "queued",
  observation
} as const;
const responses = {
  "application.delete": accepted,
  "application.inspect": {
    target: { ...repo, application: "store" },
    authored: {
      provenance,
      definition: definition.definition,
      graph,
      observation
    },
    observation
  },
  "application.list": { target: repo, items: [], observation },
  "capabilities.get": { target: repo, capabilities: [], limitations: [] },
  "credentials.configure": { ...accepted, target: repo },
  "credentials.inspect": {
    target: repo,
    prerequisites: [],
    actions: [],
    observation
  },
  "definition.author": {
    ...accepted,
    target: { ...definition, source: workspace },
    source: workspaceProvenance
  },
  "definition.validate": {
    target: definition,
    provenance,
    report,
    observation
  },
  "deployment.start": {
    ...accepted,
    target: { ...application, ...definition },
    source: provenance
  },
  "environment.configure": { ...accepted, target: environment },
  "environment.create": { ...accepted, target: environment },
  "environment.delete": { ...accepted, target: environment },
  "environment.inspect": {
    target: environment,
    configuration,
    protections: { requiredReviewers: true },
    limitations: [],
    observation
  },
  "environment.list": { target: repo, items: [], observation },
  "graph.diff": {
    status: "available",
    kind: "authored",
    base: provenance,
    head: provenance,
    baseTarget: definition,
    headTarget: definition,
    graph,
    observation
  },
  "graph.get": {
    kind: "authored",
    target: definition,
    provenance,
    graph,
    observation
  },
  "operation.cancel": {
    cancellation: { status: "requested", requestedAt: observation.observedAt },
    operation: record
  },
  "operation.get": record,
  "operation.list": { target: repo, items: [], observation },
  "operation.repair": { ...accepted, source: workspaceProvenance },
  "operation.respond": record
} as const satisfies {
  [O in LifecycleOperation]: LifecycleResponseFor<O>["result"];
};

function request(operation: LifecycleOperation) {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-1",
    operation,
    ...requests[operation]
  };
}

function response(operation: LifecycleOperation) {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-1",
    operation,
    result: responses[operation]
  };
}

const validators = createLifecycleValidators();

const asciiLineEndings = ["\n", "\r", "\r\n"] as const;
const allLineEndings = [...asciiLineEndings, "\u2028", "\u2029"] as const;
const lineEndingBoundaries = [
  {
    name: "repository",
    base: repo.repo,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.list"),
      target: { repo: value }
    })
  },
  {
    name: "request handle",
    base: "request-1",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.list"),
      requestId: value
    })
  },
  {
    name: "operation handle",
    base: "operation-1",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("operation.get"),
      input: { operationId: value }
    })
  },
  {
    name: "action handle",
    base: "action-1",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("operation.respond"),
      input: { ...requests["operation.respond"].input, actionId: value }
    })
  },
  {
    name: "scoped staged-output reference",
    base: "staging-1/app.bicep",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("operation.respond"),
      input: {
        ...requests["operation.respond"].input,
        response: {
          kind: "agent.outcome",
          status: "completed",
          stagedOutputRefs: [value]
        }
      }
    })
  },
  {
    name: "environment name",
    base: environment.environment,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.inspect"),
      target: { ...environment, environment: value }
    })
  },
  {
    name: "application name",
    base: application.application,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("application.delete"),
      target: { ...application, application: value }
    })
  },
  {
    name: "definition path",
    base: definition.definition,
    endings: asciiLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("definition.validate"),
      target: { ...definition, definition: value }
    })
  },
  {
    name: "workspace handle",
    base: workspace.workspaceRef,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("definition.author"),
      target: { ...definition, source: { ...workspace, workspaceRef: value } }
    })
  },
  {
    name: "workspace fingerprint",
    base: workspace.expectedFingerprint,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("definition.author"),
      target: {
        ...definition,
        source: { ...workspace, expectedFingerprint: value }
      }
    })
  },
  {
    name: "workspace branch",
    base: workspace.branch,
    endings: asciiLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("definition.author"),
      target: { ...definition, source: { ...workspace, branch: value } }
    })
  },
  {
    name: "Git ref",
    base: git.ref,
    endings: asciiLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("definition.validate"),
      target: { ...definition, source: { ...git, ref: value } }
    })
  },
  {
    name: "Git expected commit",
    base: git.expectedCommit,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("deployment.start"),
      target: {
        ...application,
        ...definition,
        source: { ...git, expectedCommit: value }
      }
    })
  },
  {
    name: "approval handle",
    base: "approval-1",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("deployment.start"),
      input: { ...requests["deployment.start"].input, approvalRef: value }
    })
  },
  {
    name: "identity handle",
    base: configuration.identityRef,
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.create"),
      input: {
        ...requests["environment.create"].input,
        configuration: { ...configuration, identityRef: value }
      }
    })
  },
  {
    name: "AWS account ID",
    base: "123456789012",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.create"),
      input: {
        configuration: {
          provider: "aws",
          identityRef: "identity-1",
          recipes: [],
          settings: {
            accountId: value,
            region: "us-west-2",
            roleName: "role-1"
          }
        }
      }
    })
  },
  {
    name: "recipe resource type",
    base: "Radius.Resources/postgreSQL",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.configure"),
      input: {
        patch: {
          provider: "azure",
          recipes: [
            {
              resourceType: value,
              kind: "bicep",
              source: "br:ghcr.io/example/postgresql:1.0"
            }
          ]
        }
      }
    })
  },
  {
    name: "OCI recipe reference",
    base: "br:ghcr.io/example/postgresql:1.0",
    endings: allLineEndings,
    validate: validators.validateRequest,
    message: (value: string) => ({
      ...request("environment.configure"),
      input: {
        patch: {
          provider: "azure",
          recipes: [
            {
              resourceType: "Radius.Resources/postgreSQL",
              kind: "bicep",
              source: value
            }
          ]
        }
      }
    })
  },
  {
    name: "resolved provenance repository",
    base: provenance.repo,
    endings: allLineEndings,
    validate: validators.validateResponse,
    message: (value: string) => ({
      ...response("definition.validate"),
      result: {
        ...responses["definition.validate"],
        provenance: { ...provenance, repo: value }
      }
    })
  },
  {
    name: "resolved commit",
    base: provenance.commit,
    endings: allLineEndings,
    validate: validators.validateResponse,
    message: (value: string) => ({
      ...response("definition.validate"),
      result: {
        ...responses["definition.validate"],
        provenance: { ...provenance, commit: value }
      }
    })
  },
  {
    name: "resolved ref",
    base: provenance.ref,
    endings: asciiLineEndings,
    validate: validators.validateResponse,
    message: (value: string) => ({
      ...response("definition.validate"),
      result: {
        ...responses["definition.validate"],
        provenance: { ...provenance, ref: value }
      }
    })
  },
  {
    name: "resolved fingerprint",
    base: provenance.fingerprint,
    endings: allLineEndings,
    validate: validators.validateResponse,
    message: (value: string) => ({
      ...response("definition.validate"),
      result: {
        ...responses["definition.validate"],
        provenance: { ...provenance, fingerprint: value }
      }
    })
  },
  {
    name: "observation timestamp",
    base: observation.observedAt,
    endings: allLineEndings,
    validate: validators.validateResponse,
    message: (value: string) => ({
      ...response("environment.list"),
      result: {
        ...responses["environment.list"],
        observation: { ...observation, observedAt: value }
      }
    })
  },
  {
    name: "canonical graph hash",
    base: graph.resources[0].diffHash,
    endings: allLineEndings,
    validate: validators.validateResponse,
    message: (value: string) => ({
      ...response("graph.get"),
      result: {
        ...responses["graph.get"],
        graph: { resources: [{ ...graph.resources[0], diffHash: value }] }
      }
    })
  }
];

describe("strict context-owned lifecycle validation", () => {
  it.each(lineEndingBoundaries)(
    "requires the actual end of $name without trimming input",
    ({ base, endings, validate, message }) => {
      const valid = message(base);
      expect(validate(valid)).toEqual({ valid: true, value: valid });
      for (const ending of endings) {
        const value = message(`${base}${ending}`);
        const before = structuredClone(value);
        expect(validate(value)).toMatchObject({
          valid: false,
          error: { code: "INVALID_REQUEST" }
        });
        expect(value).toEqual(before);
      }
    }
  );

  it.each(["\u2028", "\u2029"])(
    "preserves Unicode separator %j where the existing path/ref grammar permits it",
    (separator) => {
      for (const boundary of lineEndingBoundaries.filter(
        (entry) => entry.endings === asciiLineEndings
      )) {
        const value = boundary.message(`${boundary.base}${separator}`);
        expect(boundary.validate(value)).toEqual({ valid: true, value });
      }
    }
  );
  it.each(Object.keys(operationSchemas) as LifecycleOperation[])(
    "validates the %s request and response without altering either",
    (operation) => {
      for (const [value, validate] of [
        [request(operation), validators.validateRequest],
        [response(operation), validators.validateResponse]
      ] as const) {
        const before = structuredClone(value);
        expect(validate(value)).toEqual({ valid: true, value });
        expect(value).toEqual(before);
      }
    }
  );

  it.each([null, [], true, 1, "request", {}, { apiVersion: 1 }])(
    "rejects malformed envelopes: %j",
    (value) => {
      expect(validators.validateRequest(value)).toMatchObject({
        valid: false,
        error: { code: "INVALID_REQUEST" }
      });
      expect(validators.validateResponse(value)).toMatchObject({
        valid: false,
        error: { code: "INVALID_REQUEST" }
      });
    }
  );

  it("distinguishes unsupported versions from malformed or unknown operations", () => {
    for (const validate of [
      validators.validateRequest,
      validators.validateResponse
    ]) {
      expect(
        validate({
          ...request("environment.list"),
          apiVersion: "github-radius/v2"
        })
      ).toMatchObject({ valid: false, error: { code: "VERSION_UNSUPPORTED" } });
      expect(
        validate({
          ...request("environment.list"),
          operation: "environment.destroy"
        })
      ).toMatchObject({ valid: false, error: { code: "INVALID_REQUEST" } });
    }
  });

  it.each(["principal", "approved", "credentials", "token", "path", "command"])(
    "rejects claimed %s authority at each request boundary",
    (field) => {
      for (const operation of Object.keys(
        operationSchemas
      ) as LifecycleOperation[]) {
        const value = request(operation);
        for (const malformed of [
          { ...value, [field]: "untrusted" },
          { ...value, target: { ...value.target, [field]: "untrusted" } },
          { ...value, input: { ...value.input, [field]: "untrusted" } }
        ])
          expect(validators.validateRequest(malformed).valid).toBe(false);
      }
    }
  );

  it.each(Object.keys(operationSchemas) as LifecycleOperation[])(
    "rejects missing envelope fields and wrong results for %s",
    (operation) => {
      for (const key of [
        "apiVersion",
        "requestId",
        "operation",
        "target",
        "input"
      ]) {
        const value: Record<string, unknown> = { ...request(operation) };
        delete value[key];
        expect(validators.validateRequest(value).valid).toBe(false);
      }
      expect(
        validators.validateResponse({ ...response(operation), result: {} })
          .valid
      ).toBe(false);
      expect(
        validators.validateResponse({
          ...response(operation),
          result: { ...responses[operation], approved: true }
        }).valid
      ).toBe(false);
    }
  );

  it.each([
    ["application.delete", ["repo", "environment", "application"], ["intent"]],
    [
      "application.inspect",
      ["repo", "application", "source", "definition"],
      []
    ],
    ["application.list", ["repo"], []],
    ["capabilities.get", ["repo"], []],
    ["credentials.configure", ["repo"], ["provider", "intent"]],
    ["credentials.inspect", ["repo"], []],
    [
      "definition.author",
      ["repo", "source", "definition"],
      ["intent", "provider"]
    ],
    [
      "definition.validate",
      ["repo", "source", "definition"],
      ["policyVersion"]
    ],
    [
      "deployment.start",
      ["repo", "environment", "application", "source", "definition"],
      ["repairPolicy"]
    ],
    ["environment.configure", ["repo", "environment"], ["patch"]],
    ["environment.create", ["repo", "environment"], ["configuration"]],
    ["environment.delete", ["repo", "environment"], ["intent"]],
    ["environment.inspect", ["repo", "environment"], []],
    ["environment.list", ["repo"], []],
    ["graph.diff", ["repo"], ["kind", "base", "head"]],
    ["graph.get", ["repo", "source", "definition"], ["kind"]],
    ["operation.cancel", ["repo"], ["operationId"]],
    ["operation.get", ["repo"], ["operationId"]],
    ["operation.list", ["repo"], []],
    ["operation.repair", ["repo"], ["operationId", "source", "repairPolicy"]],
    ["operation.respond", ["repo"], ["operationId", "actionId", "response"]]
  ] as const)(
    "requires the operation-specific fields for %s",
    (operation, targetKeys, inputKeys) => {
      const value = request(operation);
      for (const [field, keys] of [
        ["target", targetKeys],
        ["input", inputKeys]
      ] as const) {
        for (const key of keys) {
          const nested: Record<string, unknown> = { ...value[field] };
          delete nested[key];
          expect(
            validators.validateRequest({ ...value, [field]: nested }).valid
          ).toBe(false);
        }
      }
    }
  );

  it("supports authored inspection alone, deployed alone, or both, but never neither or partial authored selection", () => {
    const value = request("application.inspect");
    for (const target of [
      { ...definition, application: "store" },
      application,
      { ...application, ...definition }
    ])
      expect(validators.validateRequest({ ...value, target }).valid).toBe(true);
    for (const target of [
      { ...repo, application: "store" },
      { ...application, source: git },
      { ...application, definition: definition.definition },
      { ...definition },
      { ...repo, application: "store", source: git }
    ])
      expect(validators.validateRequest({ ...value, target }).valid).toBe(
        false
      );
  });

  it("requires published exact-commit git sources for deployment and workspaces for authoring", () => {
    const value = request("deployment.start");
    expect(
      validators.validateRequest({
        ...value,
        target: { ...value.target, source: workspace }
      }).valid
    ).toBe(false);
    expect(
      validators.validateRequest({
        ...request("definition.author"),
        target: definition
      }).valid
    ).toBe(false);
    for (const source of [
      { kind: "git", ref: "main" },
      { ...git, expectedCommit: "abcd123" },
      { ...git, expectedCommit: "g".repeat(40) },
      { ...git, workspaceRef: "workspace-1" },
      { ...git, ref: "C:\\outside" },
      { ...git, ref: "/outside" },
      { ...git, ref: "--upload-pack=command" },
      { ...git, ref: "main~1" },
      { ...workspace, expectedFingerprint: "changed" },
      { kind: "file", path: "C:\\outside\\app.bicep" }
    ])
      expect(
        validators.validateRequest({
          ...request("definition.validate"),
          target: { ...definition, source }
        }).valid
      ).toBe(false);
    expect(
      validators.validateRequest({
        ...value,
        target: {
          ...value.target,
          source: { ...git, expectedCommit: "B".repeat(64) }
        }
      }).valid
    ).toBe(true);
    for (const operation of [
      "definition.author",
      "deployment.start",
      "operation.repair"
    ] as const) {
      const reply = response(operation);
      const result: Record<string, unknown> = { ...responses[operation] };
      delete result.source;
      expect(validators.validateResponse({ ...reply, result }).valid).toBe(
        false
      );
    }
    expect(
      validators.validateResponse({
        ...response("deployment.start"),
        result: {
          ...responses["deployment.start"],
          source: workspaceProvenance
        }
      }).valid
    ).toBe(false);
  });

  it.each([
    "/app.bicep",
    "../app.bicep",
    ".radius/../app.bicep",
    "C:\\app.bicep",
    "C:/app.bicep",
    "\\\\host\\share\\app.bicep",
    ".radius\\app.bicep",
    "%2e%2e/app.bicep",
    ".radius/%252e%252e/app.bicep",
    "./app.bicep",
    "app.bicep/",
    "a//app.bicep",
    "app.bicep\u0000",
    ".. /app.bicep",
    "app.bicep.",
    "app.bicep ",
    "*.bicep"
  ])("rejects unsafe definition path %j", (path) => {
    expect(
      validators.validateRequest({
        ...request("definition.validate"),
        target: { ...definition, definition: path }
      }).valid
    ).toBe(false);
  });

  it("keeps diff source selections independent while checking the head repository identity", () => {
    const value = request("graph.diff");
    const input = requests["graph.diff"].input;
    expect(
      validators.validateRequest({
        ...value,
        input: {
          ...input,
          base: { ...input.base, source: workspace },
          head: { ...input.head, repo: "EXAMPLE/Service" }
        }
      }).valid
    ).toBe(true);
    expect(
      validators.validateRequest({
        ...value,
        input: { ...input, head: { ...input.head, repo: "other/service" } }
      }).valid
    ).toBe(false);
    expect(
      validators.validateRequest({
        ...value,
        input: { ...input, base: { source: git } }
      }).valid
    ).toBe(false);
    expect(
      validators.validateRequest({
        ...value,
        input: { ...input, kind: "planned" }
      }).valid
    ).toBe(false);
    expect(
      validators.validateRequest({
        ...value,
        input: {
          ...input,
          kind: "planned",
          base: { ...input.base, environment: "base" },
          head: { ...input.head, environment: "head" }
        }
      }).valid
    ).toBe(true);
    const deployed = {
      kind: "deployed",
      base: { ...input.base, environment: "base", application: "base-app" },
      head: { ...input.head, environment: "head", application: "head-app" }
    };
    expect(
      validators.validateRequest({ ...value, input: deployed }).valid
    ).toBe(true);
    expect(
      validators.validateRequest({
        ...value,
        input: { ...deployed, head: { ...input.head, application: "head-app" } }
      }).valid
    ).toBe(false);
  });

  it("requires environment-scoped planned/deployed graphs and supports authored workspaces", () => {
    const value = request("graph.get");
    expect(
      validators.validateRequest({
        ...value,
        target: { ...definition, source: workspace }
      }).valid
    ).toBe(true);
    expect(
      validators.validateRequest({ ...value, input: { kind: "planned" } }).valid
    ).toBe(false);
    expect(
      validators.validateRequest({
        ...value,
        target: { ...definition, environment: "test" },
        input: { kind: "planned" }
      }).valid
    ).toBe(true);
    expect(
      validators.validateRequest({
        ...value,
        target: application,
        input: { kind: "deployed" }
      }).valid
    ).toBe(true);
    expect(
      validators.validateRequest({
        ...value,
        target: { ...repo, application: "store" },
        input: { kind: "deployed" }
      }).valid
    ).toBe(false);
  });

  it.each(["application.list", "environment.list", "operation.list"] as const)(
    "enforces documented integer pagination bounds for %s",
    (operation) => {
      expect(PAGE_SIZE_MIN).toBe(1);
      expect(PAGE_SIZE_MAX).toBe(100);
      for (const pageSize of [PAGE_SIZE_MIN, PAGE_SIZE_MAX])
        expect(
          validators.validateRequest({
            ...request(operation),
            input: { pageSize, continuationToken: "cursor-1" }
          }).valid
        ).toBe(true);
      for (const pageSize of [0, PAGE_SIZE_MAX + 1, 1.5, "1"])
        expect(
          validators.validateRequest({
            ...request(operation),
            input: { pageSize }
          }).valid
        ).toBe(false);
      expect(
        validators.validateRequest({ ...request(operation), input: {} }).valid
      ).toBe(true);
      expect(
        validators.validateRequest({
          ...request(operation),
          input: { continuationToken: "" }
        }).valid
      ).toBe(false);
    }
  );

  it("validates response action discriminators and opaque staged references, not claimed authority", () => {
    const value = request("operation.respond");
    const input = requests["operation.respond"].input;
    for (const answer of [
      { kind: "user.decision", choice: "deny" },
      {
        kind: "agent.outcome",
        status: "completed",
        stagedOutputRefs: ["staging-1/app.bicep"]
      },
      {
        kind: "agent.outcome",
        status: "failed",
        diagnostics: [{ message: "Compilation failed", truncated: false }]
      },
      { kind: "agent.outcome", status: "cancelled", diagnostics: [] }
    ])
      expect(
        validators.validateRequest({
          ...value,
          input: { ...input, response: answer }
        }).valid
      ).toBe(true);
    for (const answer of [
      { kind: "agent.outcome", status: "completed" },
      { kind: "agent.outcome", status: "completed", stagedOutputRefs: [] },
      {
        kind: "agent.outcome",
        status: "completed",
        stagedOutputRefs: ["../output"]
      },
      { kind: "agent.outcome", status: "failed" },
      { kind: "user.authenticate", completed: true },
      { kind: "user.decision", choice: "approve", approved: true },
      { kind: "user.decision", choice: "approve", principal: "admin" },
      {
        kind: "agent.outcome",
        status: "completed",
        stagedOutputRefs: ["staging-1/app.bicep"],
        approvalRef: "approval-1"
      }
    ])
      expect(
        validators.validateRequest({
          ...value,
          input: { ...input, response: answer }
        }).valid
      ).toBe(false);
  });

  it("validates normative validation statuses, separate warnings, checks and errors", () => {
    const value = response("definition.validate");
    const result = responses["definition.validate"];
    for (const [status, checkStatus] of [
      ["passed", "passed"],
      ["failed", "failed"],
      ["incomplete", "unavailable"],
      ["incomplete", "skipped"]
    ]) {
      expect(
        validators.validateResponse({
          ...value,
          result: {
            ...result,
            report: {
              ...report,
              status,
              checks: [{ ...report.checks[0], status: checkStatus }]
            }
          }
        }).valid
      ).toBe(true);
    }
    for (const status of ["failed", "unavailable", "skipped"]) {
      expect(
        validators.validateResponse({
          ...value,
          result: {
            ...result,
            report: {
              ...report,
              checks: [
                ...report.checks,
                {
                  checkId: "description",
                  classification: "advisory",
                  status,
                  reason: "Optional enrichment unavailable"
                }
              ],
              warnings: ["Optional enrichment unavailable"]
            }
          }
        }).valid
      ).toBe(true);
    }
    for (const malformed of [
      { ...report, status: "success" },
      { ...report, checks: [] },
      { ...report, checks: [{ ...report.checks[0], status: "incomplete" }] },
      { ...report, checks: [{ checkId: "compile", status: "passed" }] },
      {
        status: "passed",
        warnings: [],
        diagnostics: [],
        sourceFingerprint: workspace.expectedFingerprint
      },
      {
        status: "passed",
        checks: report.checks,
        diagnostics: [],
        sourceFingerprint: workspace.expectedFingerprint
      }
    ])
      expect(
        validators.validateResponse({
          ...value,
          result: { ...result, report: malformed }
        }).valid
      ).toBe(false);
    const error = {
      apiVersion: LIFECYCLE_API_VERSION,
      requestId: "request-1",
      error: {
        code: "SOURCE_CHANGED",
        message: "Source changed",
        retryable: false,
        operationId: "operation-1",
        details: [],
        nextAction: "Refresh source"
      }
    };
    expect(validators.validateResponse(error)).toEqual({
      valid: true,
      value: error
    });
    expect(
      validators.validateResponse({
        ...error,
        error: { ...error.error, code: "UNKNOWN" }
      }).valid
    ).toBe(false);
    expect(
      validators.validateResponse({
        ...error,
        error: { code: "FORBIDDEN", message: "Denied" }
      }).valid
    ).toBe(false);
  });

  it("does not coerce, inject defaults, strip unknown fields or share mutable errors between contexts", () => {
    const first = createLifecycleValidators();
    const second = createLifecycleValidators();
    const value = Object.freeze({
      ...request("environment.list"),
      input: Object.freeze({})
    });
    expect(first.validateRequest(value)).toEqual({ valid: true, value });
    expect(value.input).toEqual({});
    const malformed = { ...value, input: { pageSize: "10", approved: true } };
    const before = structuredClone(malformed);
    const failure = first.validateRequest(malformed);
    const failureBefore = structuredClone(failure);
    second.validateRequest(null);
    first.validateRequest(value);
    expect(failure).toEqual(failureBefore);
    expect(malformed).toEqual(before);
  });

  it("rejects non-JSON values rather than validating their lossy serialized shape", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inherited = Object.create({ pageSize: 1 });
    const getter = Object.defineProperty({}, "pageSize", {
      enumerable: true,
      get() {
        throw new Error("Untrusted accessors must not execute");
      }
    });
    for (const input of [
      { pageSize: undefined },
      { pageSize: NaN },
      { pageSize: Infinity },
      { pageSize: 1n },
      { pageSize: () => 1 },
      { pageSize: Symbol("size") },
      cyclic,
      inherited,
      getter,
      new Date(),
      { [Symbol("authority")]: true },
      Object.defineProperty({}, "pageSize", { value: 1, enumerable: false })
    ]) {
      expect(
        validators.validateRequest({ ...request("environment.list"), input })
          .valid
      ).toBe(false);
    }
    expect(validators.validateRequest(undefined).valid).toBe(false);
    const array = [1];
    array.length = 2;
    expect(
      validators.validateRequest({
        ...request("environment.list"),
        input: array
      }).valid
    ).toBe(false);
    const decorated = Object.assign([], { hidden: "not serialized" });
    expect(
      validators.validateRequest({
        ...request("environment.list"),
        input: decorated
      }).valid
    ).toBe(false);
    let deep: unknown = {};
    for (let index = 0; index < 101; index++) deep = { nested: deep };
    expect(validators.validateRequest(deep).valid).toBe(false);
    const nullPrototype: object = Object.create(null);
    expect(
      validators.validateRequest({
        ...request("environment.list"),
        input: nullPrototype
      }).valid
    ).toBe(true);
  });

  it("rejects remote schema instructions as data and never loads schemas from requests", () => {
    expect(
      validators.validateRequest({
        ...request("environment.configure"),
        input: { $ref: "https://schemas.invalid/authority.json" }
      }).valid
    ).toBe(false);
    expect(
      validators.validateResponse({
        ...response("operation.get"),
        result: { ...record, $schema: "https://schemas.invalid/authority.json" }
      }).valid
    ).toBe(false);
  });

  it("keeps provider configuration and patches closed and does not reset omitted settings", () => {
    const value = request("environment.configure");
    const aws = {
      provider: "aws",
      identityRef: "identity-1",
      recipes: [],
      settings: {
        accountId: "123456789012",
        region: "us-west-2",
        roleName: "test"
      }
    };
    expect(
      validators.validateRequest({
        ...request("environment.create"),
        input: { configuration: aws, approvalRef: "approval-1" }
      }).valid
    ).toBe(true);
    for (const patch of [
      { provider: "azure", identityRef: "identity-2" },
      { provider: "azure", recipes: [] },
      { provider: "aws", settings: { region: "us-east-1" } }
    ]) {
      const before = structuredClone(patch);
      expect(
        validators.validateRequest({ ...value, input: { patch } }).valid
      ).toBe(true);
      expect(patch).toEqual(before);
    }
    for (const patch of [
      {},
      { provider: "azure" },
      { provider: "azure", settings: {} },
      { ...configuration, settings: { region: "us-east-1" } },
      { ...aws, settings: { accountId: "123" } },
      {
        ...configuration,
        settings: { ...configuration.settings, token: "untrusted" }
      },
      { ...configuration, deploy: true },
      { ...configuration, provider: "kubernetes" },
      {
        ...configuration,
        recipes: [
          {
            resourceType: "Radius.Resources/postgreSQL",
            kind: "bicep",
            source: "C:\\outside\\recipe.bicep"
          }
        ]
      },
      {
        ...configuration,
        recipes: [
          {
            resourceType: "Radius.Resources/postgreSQL",
            kind: "bicep",
            source: "https://identity:untrusted@registry.invalid/recipe"
          }
        ]
      }
    ])
      expect(
        validators.validateRequest({ ...value, input: { patch } }).valid
      ).toBe(false);
    expect(
      validators.validateRequest({
        ...value,
        input: {
          patch: {
            provider: "azure",
            recipes: [
              {
                resourceType: "Radius.Resources/postgreSQL",
                kind: "bicep",
                source: "br:ghcr.io/example/recipes/postgresql:1.0.0"
              }
            ]
          }
        }
      }).valid
    ).toBe(true);
  });

  it("requires explicit finite repair policy within the existing five-attempt ceiling", () => {
    const value = request("deployment.start");
    for (const maxAttempts of [0, 1, 5]) {
      expect(
        validators.validateRequest({
          ...value,
          input: {
            ...value.input,
            repairPolicy: { mode: "automatic", maxAttempts }
          }
        }).valid
      ).toBe(true);
    }
    for (const repairPolicy of [
      { mode: "manual" },
      { maxAttempts: 1 },
      { mode: "unbounded", maxAttempts: 1 },
      { mode: "manual", maxAttempts: -1 },
      { mode: "automatic", maxAttempts: 6 },
      { mode: "manual", maxAttempts: 0.5 }
    ]) {
      expect(
        validators.validateRequest({
          ...value,
          input: { ...value.input, repairPolicy }
        }).valid
      ).toBe(false);
    }
  });

  it("allows requests to reach approval previews without treating missing approval handles as authority", () => {
    for (const operation of [
      "deployment.start",
      "environment.create",
      "operation.repair"
    ] as const) {
      const value = request(operation);
      const input: Record<string, unknown> = { ...requests[operation].input };
      delete input.approvalRef;
      expect(validators.validateRequest({ ...value, input }).valid).toBe(true);
      expect(
        validators.validateRequest({
          ...value,
          input: { ...input, approved: true }
        }).valid
      ).toBe(false);
    }
  });

  it("validates all action declarations and requires an action for blocked acceptance", () => {
    const value = response("application.delete");
    expect(
      validators.validateResponse({
        ...value,
        result: { ...accepted, state: "action_required" }
      }).valid
    ).toBe(false);
    expect(
      validators.validateResponse({
        ...value,
        result: {
          ...accepted,
          state: "action_required",
          requiredAction: userAction
        }
      }).valid
    ).toBe(true);
    for (const kind of [
      "user.decision",
      "user.authenticate",
      "agent.author_definition",
      "agent.repair_definition"
    ]) {
      const action =
        kind.startsWith("agent.") ?
          {
            ...userAction,
            kind,
            responder: "agent",
            response: { kind: "agent.outcome" }
          }
        : { ...userAction, kind };
      expect(
        validators.validateResponse({
          ...response("operation.get"),
          result: { ...record, state: "action_required", actions: [action] }
        }).valid
      ).toBe(true);
      expect(
        validators.validateResponse({
          ...response("operation.get"),
          result: { ...record, actions: [{ ...action, responder: "service" }] }
        }).valid
      ).toBe(false);
    }
    for (const action of [
      { ...userAction, kind: "unknown" },
      { ...userAction, response: { kind: "agent.outcome" } },
      { ...userAction, response: { ...userAction.response, choices: [] } },
      { ...userAction, source: { ...provenance, commit: "short" } },
      { ...userAction, approved: true }
    ])
      expect(
        validators.validateResponse({
          ...value,
          result: { ...accepted, requiredAction: action }
        }).valid
      ).toBe(false);
  });

  it("validates operation states separately from observation quality and execution attempts", () => {
    const value = response("operation.get");
    const attempt = {
      attemptId: "attempt-1",
      operationId: "operation-1",
      expectedCommit: git.expectedCommit,
      provider: "azure",
      observation,
      run: {
        repo: repo.repo,
        workflow: ".github/workflows/deploy.yml",
        runId: "run-1",
        runAttempt: 1,
        commit: git.expectedCommit,
        conclusion: "failure"
      },
      phases: [
        {
          phase: "command",
          status: "failed",
          reason: "Compilation failed",
          exitCode: 1
        }
      ]
    };
    for (const state of [
      "queued",
      "running",
      "action_required",
      "succeeded",
      "failed",
      "cancelled"
    ]) {
      for (const quality of ["current", "stale", "unknown"]) {
        expect(
          validators.validateResponse({
            ...value,
            result: {
              ...record,
              state,
              actions: state === "action_required" ? [userAction] : [],
              observation: { ...observation, quality },
              attempts: [attempt],
              cancellationRequestedAt: observation.observedAt
            }
          }).valid
        ).toBe(true);
      }
    }
    for (const result of [
      { ...record, state: "success" },
      { ...record, observation: { ...observation, quality: "failed" } },
      {
        ...record,
        attempts: [{ ...attempt, run: { ...attempt.run, runAttempt: 0 } }]
      },
      {
        ...record,
        attempts: [
          { ...attempt, phases: [{ phase: "restore", status: "skipped" }] }
        ]
      },
      { ...record, operation: "unknown" },
      { ...record, result: { kind: "unknown" } }
    ])
      expect(validators.validateResponse({ ...value, result }).valid).toBe(
        false
      );
  });

  it("carries typed proposals and partial deletion outcomes rather than untyped result bags", () => {
    const value = response("operation.get");
    const proposal = {
      operationId: "operation-1",
      actionId: "action-1",
      stagingRef: "staging-1",
      outputs: [
        {
          path: ".radius/app.bicep",
          kind: "definition",
          contentHash: workspace.expectedFingerprint,
          existed: true
        }
      ],
      originalFingerprint: workspace.expectedFingerprint,
      validation: report,
      promotion: "refused"
    };
    const plan = {
      planRef: "plan-1",
      target: environment,
      phases: [
        {
          phase: "identity",
          treatment: "retain",
          ownership: "shared",
          provenance: "Environment registration",
          requiredPermission: "identity.delete",
          status: "blocked",
          reason: "Shared identity retained"
        }
      ],
      recovery: ["Review completed phases before retrying"]
    };
    for (const result of [
      { kind: "definition", proposal },
      { kind: "deletion", plan },
      {
        kind: "execution",
        phases: [
          { phase: "state-save", status: "failed", reason: "Save failed" }
        ]
      }
    ])
      expect(
        validators.validateResponse({ ...value, result: { ...record, result } })
          .valid
      ).toBe(true);
    expect(
      validators.validateResponse({
        ...value,
        result: {
          ...record,
          result: {
            kind: "definition",
            proposal: { ...proposal, stagingRef: "C:\\outside" }
          }
        }
      }).valid
    ).toBe(false);
    expect(
      validators.validateResponse({
        ...value,
        result: {
          ...record,
          result: {
            kind: "deletion",
            plan: { ...plan, phases: [{ ...plan.phases[0], approved: true }] }
          }
        }
      }).valid
    ).toBe(false);
  });

  it("validates graph meanings, canonical hashes and connection discriminators without computing a graph", () => {
    const value = response("graph.get");
    const richGraph = {
      resources: [
        {
          ...graph.resources[0],
          diffStatus: "modified",
          connections: [
            { id: "database", direction: "Outbound", diffStatus: "added" }
          ],
          outputResources: [
            {
              name: "database",
              type: "Microsoft.DBforPostgreSQL/flexibleServers",
              displayType: "PostgreSQL",
              provider: "azure",
              apiVersion: "2024-08-01"
            }
          ]
        }
      ]
    };
    expect(
      validators.validateResponse({
        ...value,
        result: { ...responses["graph.get"], graph: richGraph }
      }).valid
    ).toBe(true);
    expect(
      validators.validateResponse({
        ...value,
        result: {
          ...responses["graph.get"],
          kind: "planned",
          target: { ...definition, environment: "test" },
          enrichment: {
            recipes: [
              {
                resourceType: "Radius.Resources/postgreSQL",
                kind: "bicep",
                source: "br:registry.invalid/recipe:v1"
              }
            ],
            observation
          }
        }
      }).valid
    ).toBe(true);
    expect(
      validators.validateResponse({
        ...value,
        result: { kind: "deployed", target: application, graph, observation }
      }).valid
    ).toBe(true);
    for (const resource of [
      { ...graph.resources[0], diffHash: "invalid" },
      {
        ...graph.resources[0],
        connections: [{ id: "database", direction: "Sideways" }]
      },
      { ...graph.resources[0], diffStatus: "unknown" },
      { ...graph.resources[0], x: 10, y: 10 }
    ])
      expect(
        validators.validateResponse({
          ...value,
          result: {
            ...responses["graph.get"],
            graph: { resources: [resource] }
          }
        }).valid
      ).toBe(false);
    const unavailable = {
      status: "unavailable",
      source: "base",
      reason: "DEFINITION_NOT_FOUND",
      message: "No base definition",
      observation
    };
    expect(
      validators.validateResponse({
        ...response("graph.diff"),
        result: unavailable
      }).valid
    ).toBe(true);
    expect(
      validators.validateResponse({
        ...response("graph.diff"),
        result: { ...unavailable, source: "unknown" }
      }).valid
    ).toBe(false);
  });

  it("accepts bounded non-authoritative response metadata but rejects undeclared authoritative fields", () => {
    const value = response("capabilities.get");
    expect(
      validators.validateResponse({
        ...value,
        metadata: { futureHint: "Read-only metadata" }
      }).valid
    ).toBe(true);
    expect(
      validators.validateResponse({ ...value, metadata: { approved: true } })
        .valid
    ).toBe(false);
    expect(
      validators.validateResponse({ ...value, approved: true }).valid
    ).toBe(false);
    expect(
      validators.validateResponse({
        ...value,
        result: {
          ...responses["capabilities.get"],
          capabilities: [
            {
              operation: "unknown",
              apiVersion: LIFECYCLE_API_VERSION,
              contexts: ["session"],
              providers: [],
              requiresAgent: false,
              limitations: []
            }
          ]
        }
      }).valid
    ).toBe(false);
  });

  it("represents authored and deployed discovery independently and bounds result pages", () => {
    const authored = responses["application.inspect"].authored;
    const deployed = [
      { environment: "test", graph, operationId: "operation-1", observation }
    ];
    for (const evidence of [
      { authored },
      { deployed },
      { authored, deployed }
    ]) {
      expect(
        validators.validateResponse({
          ...response("application.inspect"),
          result: {
            target: { ...repo, application: "store" },
            observation,
            ...evidence
          }
        }).valid
      ).toBe(true);
    }
    for (const items of [
      [],
      Array.from({ length: PAGE_SIZE_MAX }, () => record)
    ]) {
      expect(
        validators.validateResponse({
          ...response("operation.list"),
          result: {
            target: repo,
            items,
            observation,
            continuationToken: "cursor-1"
          }
        }).valid
      ).toBe(true);
    }
    expect(
      validators.validateResponse({
        ...response("operation.list"),
        result: {
          target: repo,
          items: Array.from({ length: PAGE_SIZE_MAX + 1 }, () => record),
          observation
        }
      }).valid
    ).toBe(false);
    const unknown = {
      quality: "unknown",
      evidence: "session",
      completeness: "unavailable",
      limitation: "Only current-session operations are available"
    };
    expect(
      validators.validateResponse({
        ...response("operation.list"),
        result: { target: repo, items: [], observation: unknown }
      }).valid
    ).toBe(true);
    expect(
      validators.validateResponse({
        ...response("application.inspect"),
        result: {
          ...responses["application.inspect"],
          deployed: [{ graph, observation }]
        }
      }).valid
    ).toBe(false);
  });
});
