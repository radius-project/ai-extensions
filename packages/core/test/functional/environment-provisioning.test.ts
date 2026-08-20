// Functional: provisioning a deploy environment for a repository.
//
// Setting up an environment is one journey across four modules — pick the
// compute platform, derive the OIDC federated-credential identity GitHub will
// actually present, generate the committed workflow set from the upstream
// templates, and derive the GHCR repository that holds the control-plane state.
// The value of testing them together is that the identity, the environment name,
// and the pinned action ref have to agree across all four outputs; a unit test
// of any single module cannot see a disagreement.

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  buildEnvironmentSuffix,
  buildFederatedCredentialName,
  buildOidcSubject,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AWS_FILE,
  DELETE_AZURE_FILE,
  DELETE_RADIUS_REF,
  DEPLOY_AWS_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE,
  generateDeleteWorkflow,
  generateDeployWorkflow,
  generateVerifyWorkflow,
  getPlatform,
  listPlatforms,
  RADIUS_REF,
  stateRegistryForEnvironment,
  verifyTemplateFile
} from "../../src/index.js";
import {
  DELETE_DISPATCHER_TEMPLATE,
  DELETE_PROVIDER_TEMPLATE,
  DEPLOY_DISPATCHER_TEMPLATE,
  DEPLOY_PROVIDER_TEMPLATE,
  VERIFY_TEMPLATE
} from "../fixtures/workflow-templates.js";
import { REPO } from "../fixtures/storefront-app.js";

const ENV_NAME = "production";

const deployTemplates = {
  [DEPLOY_DISPATCHER_FILE]: DEPLOY_DISPATCHER_TEMPLATE,
  [DEPLOY_AZURE_FILE]: DEPLOY_PROVIDER_TEMPLATE("Azure"),
  [DEPLOY_AWS_FILE]: DEPLOY_PROVIDER_TEMPLATE("AWS")
};

const deleteTemplates = {
  [DELETE_APP_DISPATCHER_FILE]: DELETE_DISPATCHER_TEMPLATE,
  [DELETE_AZURE_FILE]: DELETE_PROVIDER_TEMPLATE("Azure"),
  [DELETE_AWS_FILE]: DELETE_PROVIDER_TEMPLATE("AWS")
};

function pinnedRefs(yamlText: string): string[] {
  return [...yamlText.matchAll(/radius-project\/radius\/[^@\s]+@(\S+)/g)].map(
    (match) => match[1]
  );
}

describe("environment provisioning journey", () => {
  it("produces a consistent identity, workflow set, and state registry", () => {
    const platform = getPlatform("azure");
    expect(platform?.supports).toEqual({ oidc: true, portalUrl: true });

    const suffix = buildEnvironmentSuffix(ENV_NAME);
    const subject = buildOidcSubject({
      repoFullName: REPO,
      suffix,
      subjectConfig: { useDefault: true }
    });
    const credentialName = buildFederatedCredentialName({
      repoFullName: REPO,
      envName: ENV_NAME
    });

    expect(subject).toBe(`repo:${REPO}:environment:${ENV_NAME}`);
    expect(credentialName).toBe("github-acme-storefront-production");

    const verify = generateVerifyWorkflow(
      ENV_NAME,
      platform!,
      VERIFY_TEMPLATE("Azure")
    );
    const deploy = generateDeployWorkflow(
      ENV_NAME,
      ".radius/app.bicep",
      deployTemplates
    );
    const remove = generateDeleteWorkflow(ENV_NAME, deleteTemplates);

    // Every generated file is valid YAML with the environment threaded through.
    const generated = {
      "verify-azure.yml": verify,
      ...deploy,
      ...remove
    };
    for (const [file, body] of Object.entries(generated)) {
      expect(() => parseYaml(body), file).not.toThrow();
      expect(body, file).not.toMatch(/(?<!\$)\{\{[A-Z_]+\}\}/);
    }

    // The manual OIDC script the platform emits targets the same subject the
    // credential builder derived, so a user following it lands on a credential
    // the deploy workflow can actually use.
    const oidc = platform!.generateOidc({
      repoFullName: REPO,
      environment: ENV_NAME,
      tenantId: "tenant-1",
      subscriptionId: "sub-1",
      clientId: "client-1"
    });
    expect(oidc.output).toContain(`"subject": "${subject}"`);

    // Composite actions in every generated workflow are pinned to the ref the
    // templates themselves were fetched at.
    expect(pinnedRefs(verify)).toEqual([RADIUS_REF]);
    expect(pinnedRefs(deploy[DEPLOY_AZURE_FILE])).toEqual([RADIUS_REF]);
    expect(pinnedRefs(remove[DELETE_AZURE_FILE])).toEqual([DELETE_RADIUS_REF]);

    const registry = stateRegistryForEnvironment(REPO, ENV_NAME);
    expect(registry).toMatch(
      /^ghcr\.io\/acme\/storefront-radius-state-production-[0-9a-f]{12}$/
    );
  });

  it("commits both provider workflows regardless of the chosen platform", () => {
    const deploy = generateDeployWorkflow(
      ENV_NAME,
      ".radius/app.bicep",
      deployTemplates
    );
    const remove = generateDeleteWorkflow(ENV_NAME, deleteTemplates);

    expect(Object.keys(deploy)).toEqual([
      DEPLOY_DISPATCHER_FILE,
      DEPLOY_AZURE_FILE,
      DEPLOY_AWS_FILE
    ]);
    expect(Object.keys(remove)).toEqual([
      DELETE_APP_DISPATCHER_FILE,
      DELETE_AZURE_FILE,
      DELETE_AWS_FILE
    ]);

    // The dispatcher's reusable-workflow references must resolve to files the
    // same generation produced, or the run fails only once it is dispatched.
    const dispatcher = parseYaml(deploy[DEPLOY_DISPATCHER_FILE]);
    const referenced = Object.values<any>(dispatcher.jobs)
      .map((job) => job.uses)
      .filter(Boolean)
      .map((uses: string) => uses.replace("./.github/workflows/", ""));
    expect(referenced).toEqual([DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE]);
    for (const file of referenced) {
      expect(deploy[file]).toBeDefined();
    }
  });

  it("threads the application file and architecture defaults into the deploy set", () => {
    const deploy = generateDeployWorkflow(
      ENV_NAME,
      ".radius/app.bicep",
      deployTemplates
    );

    const dispatcher = parseYaml(deploy[DEPLOY_DISPATCHER_FILE]);
    expect(dispatcher.jobs.azure.with.app_file).toBe(".radius/app.bicep");

    const azure = parseYaml(deploy[DEPLOY_AZURE_FILE]);
    const build = azure.jobs.deploy.steps.find(
      (step: any) => step.name === "Build images"
    );
    expect(build.env.ARCH_MODE).toBe(
      "${{ vars.RADIUS_BUILD_ARCH_MODE || 'detect' }}"
    );
    expect(build.env.PLATFORMS).toBe(
      "${{ vars.RADIUS_BUILD_PLATFORMS || 'linux/amd64,linux/arm64' }}"
    );
  });

  it("lets a caller override the architecture defaults without touching templates", () => {
    const deploy = generateDeployWorkflow(
      ENV_NAME,
      ".radius/app.bicep",
      deployTemplates,
      { templateVars: { TARGET_CLUSTER_ARCH_MODE: "arm64" } }
    );

    const azure = parseYaml(deploy[DEPLOY_AZURE_FILE]);
    const build = azure.jobs.deploy.steps.find(
      (step: any) => step.name === "Build images"
    );
    expect(build.env.ARCH_MODE).toBe("arm64");
  });

  it("refuses to generate a workflow set when an upstream template is missing", () => {
    const partial = {
      [DEPLOY_DISPATCHER_FILE]: DEPLOY_DISPATCHER_TEMPLATE,
      [DEPLOY_AZURE_FILE]: DEPLOY_PROVIDER_TEMPLATE("Azure")
    };

    expect(() =>
      generateDeployWorkflow(ENV_NAME, ".radius/app.bicep", partial)
    ).toThrow(/Missing deploy template "run-rad-commands-aws\.yml"/);
    expect(() => generateDeleteWorkflow(ENV_NAME, {})).toThrow(
      /Missing delete template "delete-application\.yml"/
    );
    expect(() =>
      generateVerifyWorkflow(ENV_NAME, getPlatform("aws")!, "")
    ).toThrow(/Missing verify template for platform "aws"/);
  });

  it("refuses to generate a workflow that still carries an unfilled placeholder", () => {
    expect(() =>
      generateDeployWorkflow(ENV_NAME, ".radius/app.bicep", {
        ...deployTemplates,
        [DEPLOY_AZURE_FILE]: `${DEPLOY_PROVIDER_TEMPLATE("Azure")}\n# {{STATE_ARCHIVE}}\n`
      })
    ).toThrow(/Unresolved template placeholder\(s\) \{\{STATE_ARCHIVE\}\}/);
  });

  it("provisions every registered platform with its own verify template", () => {
    const platforms = listPlatforms();

    expect(platforms.map((p) => p.id).sort()).toEqual(["aws", "azure"]);
    for (const platform of platforms) {
      const file = verifyTemplateFile(platform);
      expect(file, platform.id).toBe(`verify-${platform.id}.yml`);
      const workflow = generateVerifyWorkflow(
        ENV_NAME,
        platform,
        VERIFY_TEMPLATE(platform.displayName)
      );
      expect(parseYaml(workflow).jobs.verify.environment).toBe(
        "${{ inputs.environment }}"
      );
      expect(workflow).toContain(`default: "${ENV_NAME}"`);
    }
  });

  it("gives each environment and each repository its own state registry", () => {
    const production = stateRegistryForEnvironment(REPO, "production");
    const staging = stateRegistryForEnvironment(REPO, "staging");
    const otherRepo = stateRegistryForEnvironment("acme/other", "production");

    expect(new Set([production, staging, otherRepo]).size).toBe(3);
    expect(stateRegistryForEnvironment(REPO, "production")).toBe(production);
  });

  it("fails closed when the repository or environment cannot identify state", () => {
    expect(() => stateRegistryForEnvironment("storefront", ENV_NAME)).toThrow(
      /expected owner\/repo/
    );
    expect(() => stateRegistryForEnvironment(REPO, "  ")).toThrow(
      /Environment name is required/
    );
    expect(() => stateRegistryForEnvironment("acme/---", ENV_NAME)).toThrow(
      /must contain an ASCII letter or number/
    );
  });

  it("refuses to guess an OIDC subject an organization policy has customized", () => {
    expect(() =>
      buildOidcSubject({
        repoFullName: REPO,
        suffix: buildEnvironmentSuffix(ENV_NAME),
        subjectConfig: {
          useDefault: false,
          includeClaimKeys: ["repository", "job_workflow_ref"]
        }
      })
    ).toThrow(/"job_workflow_ref"/);
  });

  it("derives distinct credential names for the mutable and immutable subjects", () => {
    const mutable = buildFederatedCredentialName({
      repoFullName: REPO,
      envName: ENV_NAME,
      variant: "mutable"
    });
    const immutable = buildFederatedCredentialName({
      repoFullName: REPO,
      envName: ENV_NAME,
      variant: "immutable"
    });

    expect(mutable).not.toBe(immutable);
    expect(
      buildOidcSubject({
        repoFullName: REPO,
        ownerId: 42,
        repoId: 7,
        suffix: buildEnvironmentSuffix(ENV_NAME),
        subjectConfig: { useDefault: true, useImmutableSubject: true }
      })
    ).toBe(`repo:acme@42/storefront@7:environment:${ENV_NAME}`);
  });

  it("escapes an environment name the way GitHub mints it in the subject", () => {
    const suffix = buildEnvironmentSuffix("prod:eu");

    expect(suffix).toBe("environment:prod%3Aeu");
    expect(
      buildOidcSubject({
        repoFullName: REPO,
        suffix,
        subjectConfig: { useDefault: true }
      })
    ).toBe("repo:acme/storefront:environment:prod%3Aeu");
  });
});
