import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  portAbsent,
  portFailure,
  portForbidden,
  portSuccess,
  type EnvironmentInspection,
  type LifecycleRequestFor,
  type RequestControl
} from "@radius-project/core/lifecycle";
import {
  createEnvironmentConfigurationAdapter,
  type EnvironmentWorkflowPreview,
  type QualifiedWorkflowAssets
} from "@radius-project/adapter-shared";
import { createLifecycleBinding } from "../../src/runtime/create-lifecycle-binding.js";
import type { KnownLifecycleOperation } from "../../src/runtime/lifecycle-routing.js";
import { createCanvasLifecycleCredentials } from "../../src/runtime/lifecycle-credentials.js";
import { createEnvironmentProviderWriter } from "../../src/server/services/lifecycle-environment-provider.js";
import { createEnvironmentWorkflowPublisher } from "../../src/server/services/lifecycle-environment-publishing.js";
import { authorizeFixture, createLifecycleFixture } from "./lifecycle.js";

export async function createEnvironmentFixture(
  provider: "azure" | "aws" = "azure",
  repo = "owner/repo"
) {
  const state = {
    authenticated: true,
    trusted: true,
    exists: false,
    failure: "",
    uncertain: "",
    variables: new Map<string, string>(),
    files: new Map<string, string>(),
    recipes: [] as { resourceType: string; kind: string; source: string }[],
    calls: [] as string[],
    legacyOperations: [] as KnownLifecycleOperation[],
    provider,
    protections: {
      requiredReviewers: true,
      waitTimerMinutes: 5,
      branchPolicy: "protected"
    }
  };
  const foundation = createLifecycleFixture({
    overrides: {
      identity: {
        authorize: async (request) =>
          state.trusted ?
            portSuccess(authorizeFixture(request))
          : portForbidden()
      }
    }
  });
  const target = { repo, environment: "dev" };
  const subscriptionId = "33333333-3333-3333-3333-333333333333";
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const hostBinding = () => ({
    bindingRef: "fixture-binding",
    sessionRef: foundation.caller.sessionRef
  });
  const observation = () => ({
    quality: "current" as const,
    completeness: "complete" as const,
    evidence: "radius" as const,
    observedAt: foundation.ports.clock.now()
  });
  const credentials = createCanvasLifecycleCredentials({
    authority: foundation.ports.identity,
    hostBinding,
    clock: foundation.ports.clock,
    runCommand: async (command, args) => {
      state.calls.push([command, ...args].join(" "));
      if (!state.authenticated)
        throw new Error(
          command === "az" ?
            "Please run az login"
          : "Unable to locate credentials"
        );
      if (command === "az" && args.join(" ") === "account show -o json")
        return JSON.stringify({
          id: subscriptionId,
          tenantId,
          user: { name: "fixture-user", type: "user" }
        });
      if (
        command === "aws" &&
        args.join(" ") === "sts get-caller-identity --output json"
      )
        return JSON.stringify({
          Account: "000011112222",
          Arn: "arn:aws:iam::000011112222:user/fixture-user"
        });
      throw new Error("Unexpected cloud command; setup must not deploy.");
    },
    configure: async () => {
      state.calls.push("authenticate");
      state.authenticated = true;
      return portSuccess(undefined);
    }
  });
  const control: RequestControl = {
    requestId: "fixture-request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const identity = await credentials.inspect(
    {
      authorizationRef: "fixture-authorization",
      principalRef: foundation.caller.principalRef,
      operation: "credentials.inspect",
      target
    },
    { provider },
    control
  );
  const identityRef =
    identity.status === "ok" ?
      identity.value.prerequisites[0]?.identityRef
    : undefined;
  if (!identityRef)
    throw new Error("Fixture provider identity was not observed");
  const configuration: LifecycleRequestFor<"environment.create">["input"]["configuration"] =

      provider === "azure" ?
        {
          provider,
          identityRef,
          settings: {
            subscriptionId,
            resourceGroup: "fixture-group",
            location: "westus"
          },
          recipes: []
        }
      : {
          provider,
          identityRef,
          settings: {
            accountId: "000011112222",
            region: "us-east-1",
            roleName: "fixture-role"
          },
          recipes: []
        };
  const producerRef = "a".repeat(40);
  const templates = resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    ".github",
    "extension"
  );
  const template = (file: string) =>
    readFileSync(resolve(templates, file), "utf8")
      .replaceAll("{{RADIUS_REF}}", producerRef)
      .replaceAll("{{ENV}}", "dev")
      .replaceAll("{{APP_FILE}}", ".radius/app.bicep")
      .replaceAll("{{LIFECYCLE_APPLICATION}}", "app");
  const files = Object.fromEntries(
    [
      "run-rad-commands.yml",
      "run-rad-commands-azure.yml",
      "run-rad-commands-aws.yml"
    ].map((file) => [file, template(file)])
  );
  const producerFiles = Object.fromEntries(
    [
      "lifecycle-evidence/action.yml",
      "lifecycle-evidence/evidence.sh",
      "run-rad-commands/action.yml",
      "restore-state/action.yml",
      "teardown/action.yml",
      "publish-lifecycle-result/action.yml",
      "deploy-progress/progress.sh"
    ].map((file) => [
      file,
      readFileSync(resolve(templates, "actions", file), "utf8")
    ])
  );
  const assets: QualifiedWorkflowAssets = {
    workflow: ".github/workflows/run-rad-commands.yml",
    executionVersion: 1,
    producerRef,
    selectedFiles: files,
    reviewedFiles: files,
    producerFiles,
    reviewedProducerFiles: producerFiles
  };
  async function inspect() {
    if (!state.exists) return portAbsent(observation());
    const get = (name: string) => state.variables.get(name) ?? "";
    const result: EnvironmentInspection = {
      target,
      protections: { ...state.protections },
      limitations: [],
      observation: observation(),
      recipeObservation: observation(),
      configuration:
        provider === "azure" ?
          {
            provider,
            identityRef: get("RADIUS_IDENTITY_REF"),
            settings: {
              subscriptionId: get("AZURE_SUBSCRIPTION_ID"),
              resourceGroup: get("AZURE_RESOURCE_GROUP"),
              location: get("AZURE_LOCATION")
            },
            recipes: [...state.recipes]
          }
        : {
            provider,
            identityRef: get("RADIUS_IDENTITY_REF"),
            settings: {
              accountId: get("AWS_ACCOUNT_ID"),
              region: get("AWS_REGION"),
              roleName: get("AWS_ROLE_ARN").split("/").at(-1)
            },
            recipes: [...state.recipes]
          }
    };
    return portSuccess(result);
  }
  const authorize = async () =>
    state.trusted ? portSuccess(undefined) : portForbidden();
  const write = createEnvironmentProviderWriter({
    authorize,
    resolve: async () =>
      portSuccess(
        provider === "azure" ?
          {
            provider,
            identityRef,
            clientId: "22222222-2222-2222-2222-222222222222",
            tenantId,
            subscriptionId,
            observation: observation()
          }
        : {
            provider,
            identityRef,
            roleArn: "arn:aws:iam::000011112222:role/fixture-role",
            accountId: "000011112222",
            observation: observation()
          }
      ),
    ensure: async () => {
      state.calls.push("github.ensure");
      state.exists = true;
      return portSuccess(undefined);
    },
    setVariable: async (_scope, name, value) => {
      state.calls.push(`variable:${name}`);
      if (state.failure === "environment")
        return portFailure("PRECONDITION_FAILED");
      state.variables.set(name, value);
      return portSuccess(undefined);
    }
  });
  const publish = createEnvironmentWorkflowPublisher({
    resolve: async (scope) =>
      portSuccess({
        target: {
          operation: {
            operationId: scope.operationId ?? "",
            repo: target.repo,
            environment: target.environment,
            provider
          },
          targetRepo: target.repo,
          envName: target.environment,
          provider,
          defaultBranch: "main"
        },
        ports: {
          generateVerifyWorkflow: async () =>
            template(`verify-${provider}.yml`),
          generateDeployWorkflow: async () => files,
          generateDeleteWorkflow: async () => ({}),
          commitWorkflowFileSmart: async (path, content) => {
            state.calls.push(`commit:${path}`);
            if (state.uncertain === "workflows")
              throw new Error("Controlled lost publication response");
            if (state.failure === "workflows")
              return { ok: false, changed: false, viaPr: false };
            state.files.set(
              path,
              Buffer.from(content, "base64").toString("utf8")
            );
            return {
              ok: true,
              changed: true,
              viaPr: false,
              commitSha: "b".repeat(40),
              blobSha: "c".repeat(40),
              contentSha256: "d".repeat(64),
              previousBlobKnown: true,
              previousBlobSha: null
            };
          },
          recordCommittedWorkflowFile: () => {
            state.calls.push("record-publication");
          },
          deleteLegacyDeployWorkflow: async () => {
            state.calls.push("remove-obsolete-workflow");
            return true;
          },
          pullRequestBranch: () => null,
          errorMessage: () => "Controlled publication failure.",
          pushStep: () => {},
          gate: async () => state.trusted
        }
      }),
    readPublished: async (_scope, preview) =>
      portSuccess({
        ...preview,
        assets: {
          ...assets,
          selectedFiles: Object.fromEntries(
            Object.keys(files).map((file) => [
              file,
              state.files.get(`.github/workflows/${file}`) ?? ""
            ])
          )
        },
        commit: "b".repeat(40),
        observation: observation()
      })
  });
  const execution = createEnvironmentConfigurationAdapter({
    clock: foundation.ports.clock,
    authorize,
    inspect,
    write,
    publish,
    prepare: async (_scope, plan) => {
      const intent: EnvironmentWorkflowPreview["intent"] =
        plan.change.operation === "environment.create" ?
          { operation: "environment.create", target, change: plan.change }
        : { operation: "environment.configure", target, change: plan.change };
      return portSuccess({ intent, assets });
    },
    registerRecipes: async (_scope, intent) => {
      state.calls.push("recipes");
      if (state.failure === "recipes")
        return portFailure("RECIPE_PACK_REQUIRED");
      const recipes =
        intent.change.operation === "environment.create" ?
          intent.change.configuration.recipes
        : (intent.change.patch.recipes ?? state.recipes);
      state.recipes = recipes.map((recipe) => ({ ...recipe }));
      return portSuccess({
        target,
        provider,
        recipes: [...state.recipes],
        observation: observation()
      });
    }
  });
  const binding = createLifecycleBinding({
    authority: foundation.ports.identity,
    clock: foundation.ports.clock,
    ids: foundation.ports.ids,
    hostBinding,
    resolveWorkspaceSource: async () => {
      throw new Error("Setup must not resolve or mutate application source");
    },
    knownLegacyOperations: () => state.legacyOperations,
    credentials,
    environmentConfiguration: {
      providers: [provider],
      environment: { inspect, configure: execution.configure }
    }
  });
  return {
    binding,
    state,
    target,
    configuration,
    identityRef,
    start: () =>
      binding.execute({
        operation: "environment.create",
        target,
        input: { configuration }
      }),
    close: async () => {
      await binding.close();
      await foundation.binding.close();
    }
  };
}
