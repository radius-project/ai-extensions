export const ENVIRONMENT_CONTROL_ACTIONS = [
  "continue",
  "verify",
  "retry-setup",
  "retry-cleanup",
  "stop",
  "cancel-workflow",
  "rollback",
  "exit",
  "abandon",
  "bypass-verification"
] as const;

export type EnvironmentControlAction =
  (typeof ENVIRONMENT_CONTROL_ACTIONS)[number] | "resume";

type Schema = {
  type?: "object" | "string" | "boolean";
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  minLength?: number;
  const?: string | boolean;
  enum?: readonly string[];
  oneOf?: Schema[];
  anyOf?: Schema[];
};

const text: Schema = { type: "string", minLength: 1 };
const object = (
  properties: Record<string, Schema>,
  required: string[]
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});
const common = {
  repo: text,
  environment: text,
  branch: text,
  namespace: text,
  profileName: text
};
const target = { operationId: text, repo: text, environment: text };
const azure: Record<string, Schema> = {
  tenantId: text,
  subscriptionId: text,
  resourceGroup: text,
  cluster: text,
  clusterResourceGroup: text,
  clientId: text,
  appId: text,
  appName: text,
  createNew: { type: "boolean" },
  serviceManagementReference: text
};
const aws: Record<string, Schema> = {
  roleArn: text,
  accountId: text,
  region: text,
  cluster: text,
  vpcId: text,
  subnetIds: text
};

export const ENVIRONMENT_SETUP_SCHEMA = object(
  {
    ...common,
    provider: { type: "string", enum: ["azure", "aws"] },
    ...azure,
    ...aws
  },
  ["repo", "environment", "provider"]
);

export const ENVIRONMENT_SETUP_ARGUMENT_SCHEMA: Schema = {
  oneOf: [
    object(
      {
        ...common,
        provider: { const: "azure" },
        ...azure
      },
      [
        "repo",
        "environment",
        "provider",
        "tenantId",
        "subscriptionId",
        "resourceGroup",
        "cluster"
      ]
    ),
    object(
      {
        ...common,
        provider: { const: "aws" },
        ...aws
      },
      [
        "repo",
        "environment",
        "provider",
        "roleArn",
        "accountId",
        "region",
        "cluster"
      ]
    )
  ]
};

export const ENVIRONMENT_STATUS_SCHEMA = object(target, Object.keys(target));
const answerAlternatives: Schema[] = [
  object(
    {
      code: { const: "service-management-reference-required" },
      serviceManagementReference: text
    },
    ["code", "serviceManagementReference"]
  ),
  object(
    {
      code: { const: "app-selection-required" },
      createNew: { const: true }
    },
    ["code", "createNew"]
  ),
  object(
    {
      code: { const: "app-selection-required" },
      createNew: { const: false },
      appId: text
    },
    ["code", "createNew", "appId"]
  )
];
const resume = {
  interactionId: text,
  provider: { type: "string", enum: ["azure"] } satisfies Schema,
  checkpoint: text,
  answer: { oneOf: answerAlternatives } satisfies Schema
};
export const ENVIRONMENT_CONTROL_SCHEMA = object(
  {
    ...target,
    action: {
      type: "string",
      enum: [...ENVIRONMENT_CONTROL_ACTIONS, "resume"]
    },
    ...resume,
    answer: { anyOf: answerAlternatives }
  },
  [...Object.keys(target), "action"]
);
export const ENVIRONMENT_CONTROL_ARGUMENT_SCHEMA: Schema = {
  oneOf: [
    object({ ...target, action: { enum: ENVIRONMENT_CONTROL_ACTIONS } }, [
      ...Object.keys(target),
      "action"
    ]),
    object(
      {
        ...target,
        action: { const: "resume" },
        ...resume
      },
      [
        ...Object.keys(target),
        "action",
        "interactionId",
        "provider",
        "checkpoint",
        "answer"
      ]
    )
  ]
};

export function environmentRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined;
}

// Provider-compatible wire schemas are flat; handlers enforce the stricter conditional contract.
function matches(value: unknown, schema: Schema): boolean {
  if (schema.oneOf)
    return schema.oneOf.filter((choice) => matches(value, choice)).length === 1;
  if (schema.const !== undefined) return value === schema.const;
  if (schema.enum)
    return typeof value === "string" && schema.enum.includes(value);
  if (schema.type === "string")
    return (
      typeof value === "string" &&
      value.trim().length >= (schema.minLength ?? 0)
    );
  if (schema.type === "boolean") return typeof value === "boolean";
  const record = environmentRecord(value);
  if (!record || !schema.properties || !schema.required) return false;
  const properties = schema.properties;
  return (
    schema.required.every((key) => Object.hasOwn(record, key)) &&
    Object.entries(record).every(
      ([key, field]) =>
        Object.hasOwn(properties, key) && matches(field, properties[key])
    )
  );
}

export function readEnvironmentArguments(
  input: unknown,
  schema: Schema
): Record<string, unknown> {
  const record = environmentRecord(input);
  if (!record || !matches(record, schema)) {
    throw new Error(
      "Arguments must match the environment tool's closed schema; all required identifiers must be nonempty."
    );
  }
  return structuredClone(record);
}

export function environmentString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const ENVIRONMENT_TOOL_DECLARATIONS = [
  {
    name: "radius_setup_environment",
    description:
      "Configure and verify an Azure or AWS environment without opening Canvas. Setup never deploys. Specify repo, environment and provider. Azure requires tenantId, subscriptionId, resourceGroup and cluster; AWS requires roleArn, accountId, region and cluster. Do not mix provider-specific fields. Omit branch only for the session repository's current worktree branch. Account selection and sensitive consent use trusted host interaction, never tool arguments. Poll the returned operationId with radius_environment_status.",
    parameters: ENVIRONMENT_SETUP_SCHEMA
  },
  {
    name: "radius_environment_status",
    description:
      "Read a specified setup operation and bounded verification evidence without opening Canvas. operationId, repo and environment must match the saved operation and its account. Status never dispatches workflows, deploys, repairs or authorizes cleanup. Unknown or unavailable evidence is not success or permission to retry.",
    parameters: ENVIRONMENT_STATUS_SCHEMA
  },
  {
    name: "radius_environment_control",
    description:
      "Apply an eligible command to an exact saved setup operation. Only resume accepts and requires interactionId, provider (azure), checkpoint and a typed answer; use the current supported setup-input prompt, never an informational requirement ID. Sensitive commands require trusted host confirmation. Stop is cooperative, not remote cancellation. Rollback only removes proven-owned setup artifacts; this is not an environment-deletion tool.",
    parameters: ENVIRONMENT_CONTROL_SCHEMA
  }
];
