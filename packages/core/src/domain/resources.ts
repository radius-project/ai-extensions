export interface Resource<T = Record<string, unknown>> {
  id: string;
  type: string;
  name: string;
  tags?: Record<string, string>;
  systemData: Record<string, never>;
  properties: T;
}

export interface ResourceList<T = Record<string, unknown>> {
  value: Resource<T>[];
}

export interface ApplicationProperties {
  provisioningState: string;
  environment: string;
}

export interface Recipe {
  templateKind: string;
  templatePath: string;
}

export interface RecipeDefinition {
  kind: string;
  source: string;
  plainHttp?: boolean;
  parameters?: Record<string, unknown>;
}

export interface RecipePackProperties {
  provisioningState?: string;
  referencedBy?: string[];
  recipes: Record<string, RecipeDefinition>;
}

export interface EnvironmentProperties {
  provisioningState: string;
  recipes: Record<string, Record<string, Recipe>>;
  recipePacks?: string[];
  compute?: {
    namespace?: string;
    kubernetes?: { namespace?: string };
  };
  providers?: {
    azure?: {
      scope?: string;
      subscriptionId?: string;
      resourceGroup?: string;
    };
    aws?: {
      scope?: string;
      accountId?: string;
      region?: string;
    };
  };
}

export interface ResourceTypeProperties {
  namespace: string;
  type: string;
  apiVersion: string;
  apiVersions?: string[];
}

export interface ResourceType {
  Name: string;
  Description: string;
  ResourceProviderNamespace: string;
  APIVersions: Record<string, { Schema?: unknown }>;
  APIVersionList: string[];
}

const applications = [
  "Applications.Core/applications",
  "Radius.Core/applications"
];
const environments = [
  "Applications.Core/environments",
  "Radius.Core/environments"
];

export function isApplicationType(type?: string): boolean {
  return type !== undefined && applications.includes(type);
}

export function isEnvironmentType(type?: string): boolean {
  return type !== undefined && environments.includes(type);
}

/** Legacy-first order is stable, independent of the requested equivalent. */
export function getEquivalentTypes(type: string): string[] | undefined {
  if (isApplicationType(type)) return [...applications];
  if (isEnvironmentType(type)) return [...environments];
  return undefined;
}
