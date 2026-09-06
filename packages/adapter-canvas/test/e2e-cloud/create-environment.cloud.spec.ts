// Stage one of the cloud journey: creating an environment for real.
//
// Everything below runs against a real Azure subscription and a real GitHub
// repository. Nothing is faked, which is the point — the fake-CLI suite already
// proves the page's behaviour, and what it cannot prove is that the commands the
// product actually issues are accepted by Azure and GitHub.
//
// Two rules govern the file:
//
// 1. **It never runs unless it can prove something.** Without `RADIUS_CLOUD_E2E`
//    it skips by default. After explicit opt-in, missing fixture provisioning or
//    credentials fail preflight so a broken cloud job cannot pass without
//    executing assertions.
// 2. **It contains no logic.** Every decision — the skip gate, the expected
//    federated-credential subjects, which workflow publication path was taken,
//    whether the GitHub Environment names the right identity — lives in
//    `support/create-environment-journey.ts` behind unit tests, because a rule
//    written here could only ever be checked by a nightly run against real
//    infrastructure.
//
// Stage one only: create. Deploy and delete are later stages and are not
// started here, so this file never destroys anything the product made — the
// fixture's own reclamation does that, after the assertions.
import { expect, test, type Page } from "@playwright/test";
import { CanvasHarness } from "../e2e/support/canvas-harness.js";
import {
  createNodeCloudFixturePorts,
  expectSuccess,
  type CloudCommandPort,
  type CloudFixturePorts
} from "./support/cloud-command-port.js";
import {
  createCloudFixture,
  type CloudFixture
} from "./support/cloud-fixture.js";
import {
  classifyWorkflowPublication,
  cloudCanvasState,
  describeWorkflowPublication,
  evaluateCreateEnvironmentGate,
  expectedFederatedCredentialSubjects,
  findEnvironmentIdentityProblems,
  parseJsonPayload,
  readAzureAccount,
  readEnvironmentVariables,
  readOidcSubjectCustomization,
  readOperationHttpResponse,
  readOperationId,
  readOperationSnapshot,
  readRepositoryIdentity,
  readServicePrincipalObjectId,
  readWorkflowDirectory,
  runCleanupSteps,
  selectFallbackBranches,
  selectFallbackPullRequests,
  workflowFallbackBranchPrefix
} from "./support/create-environment-journey.js";
import {
  describeUnprovisionedFixtureRepository,
  isFixtureRepositoryProvisioned,
  resolveFixtureLocation
} from "./support/fixture-repository.js";

const PROFILE_NAME = "cloud-e2e";
const WORKFLOW_DIRECTORY = ".github/workflows";
const KUBERNETES_NAMESPACE = "default";
const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID?.trim() ?? "";
const githubToken = process.env.GH_TOKEN?.trim() ?? "";

// Creating an environment provisions an Entra application, a service principal,
// two federated credentials, a role assignment, a GitHub Environment and its
// workflows. Twenty minutes is generous rather than optimistic: a timeout here
// reports as a product failure, so it must never be the first thing to give.
const OPERATION_TIMEOUT_MS = 20 * 60 * 1000;

const gate = evaluateCreateEnvironmentGate({
  cloudE2eFlag: process.env.RADIUS_CLOUD_E2E,
  fixtureProvisioned: isFixtureRepositoryProvisioned(),
  unprovisionedReason: describeUnprovisionedFixtureRepository(),
  subscriptionId,
  githubToken
});
const skipReason =
  !gate.enabled && gate.disposition === "skip" ? gate.reason : "";

const ports: CloudFixturePorts = createNodeCloudFixturePorts();

async function runGh(
  commands: CloudCommandPort,
  args: readonly string[],
  context: string
): Promise<unknown> {
  return parseJsonPayload(
    expectSuccess(await commands.runGh(args), context).stdout,
    context
  );
}

async function runAz(
  commands: CloudCommandPort,
  args: readonly string[],
  context: string
): Promise<unknown> {
  return parseJsonPayload(
    expectSuccess(await commands.runAz(args), context).stdout,
    context
  );
}

/**
 * Creates a credential profile the way a person would.
 *
 * Cloud mode deliberately leaves the credential store empty, so the profile the
 * wizard later selects has to come from the real form and a real
 * `/api/verify-azure-login` round trip against the signed-in Azure CLI. Seeding
 * it directly would skip the first thing a cloud run should catch: a product
 * change that stops the verification path working against a real tenant.
 */
async function createCredentialProfile(
  page: Page,
  baseUrl: string,
  account: { tenantId: string; subscriptionId: string }
): Promise<void> {
  await page.goto(`${baseUrl}/?page=credentials`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "New Credential Profile" }).click();
  await page.getByLabel("Profile Name").fill(PROFILE_NAME);
  await page.getByLabel("Tenant ID").fill(account.tenantId);
  await page.getByLabel("Subscription ID").fill(account.subscriptionId);
  await page.getByRole("button", { name: "Verify Credentials" }).click();

  // The verified line is the product's own report that the real CLI answered.
  await expect(page.locator("#cred-verify-status")).toBeVisible({
    timeout: 120_000
  });
  const save = page.locator("#save-cred-btn:not([disabled])");
  await expect(save).toBeVisible({ timeout: 120_000 });
  await save.click();
  await expect(page.locator("#cred-landing")).toBeVisible();
}

test.describe("Radius Canvas creates an environment against real cloud", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!gate.enabled && gate.disposition === "skip", skipReason);

  let fixture: CloudFixture | undefined;
  let productOperationStarted = false;

  test.beforeAll(async () => {
    if (!gate.enabled) throw new Error(gate.reason);
    fixture = await createCloudFixture({
      subscriptionId,
      // CI publishes the region; locally it is absent and the fixture's own
      // default applies. Validated in the helper rather than here, so this file
      // keeps containing no logic a nightly run would be the first to check.
      location: resolveFixtureLocation(
        process.env.AIEXT_CLOUD_E2E_AZURE_LOCATION
      ),
      githubRunId: process.env.GITHUB_RUN_ID,
      ports
    });
    // Turns every assertion below from an observation into a proof: none of the
    // artifacts asserted on existed before the product ran.
    await fixture.assertCleanSlate();
  });

  test.afterAll(async () => {
    const current = fixture;
    fixture = undefined;
    if (!current) return;
    await runCleanupSteps([
      {
        label: "reclaim product-created artifacts",
        run: async () => {
          if (!productOperationStarted) return;
          const reclaimed = await current.reclaimLeakedProductArtifacts();
          if (reclaimed.length > 0)
            console.info(
              `Cleaned up this stage-one run's product-created artifacts: ${reclaimed.join(", ")}.`
            );
        }
      },
      { label: "dispose cloud fixture", run: () => current.dispose() }
    ]);
  });

  test("creates the Azure identity, the GitHub Environment, and the workflows", async ({
    page
  }, testInfo) => {
    testInfo.setTimeout(OPERATION_TIMEOUT_MS + 10 * 60 * 1000);
    const cloud = fixture;
    if (!cloud) throw new Error("The cloud fixture was not created.");

    const account = readAzureAccount(
      await runAz(
        ports.commands,
        ["account", "show", "-o", "json"],
        "az account show"
      )
    );
    expect(account.subscriptionId).toBe(cloud.subscriptionId);

    const harness = await CanvasHarness.create({
      page,
      title: "cloud-create-environment",
      mode: "cloud",
      workspacePath: cloud.workspacePath,
      initialPage: "credentials"
    });

    let primaryError: unknown;
    try {
      await harness.seedState(
        cloudCanvasState({
          repository: cloud.repository,
          branch: cloud.defaultBranch,
          workspacePath: cloud.workspacePath
        })
      );
      await createCredentialProfile(page, harness.baseUrl, account);

      await page.goto(`${harness.baseUrl}/?page=environment`);
      await page.waitForLoadState("domcontentloaded");
      await page.locator("#new-env-btn").click();
      await expect(page.locator("#env-form")).toBeVisible();
      await page.locator("#env-profile-button").click();
      await page
        .locator("#env-profile-menu")
        .getByRole("option", { name: new RegExp(PROFILE_NAME) })
        .click();
      await page.locator("#env-step1-next").click();
      await expect(page.locator("#env-step-details")).toBeVisible();

      await page.getByLabel("Environment name").fill(cloud.environmentName);
      // Selecting by value rather than typing a custom name is deliberate: the
      // option only exists if the product's own `az group list` and `az aks
      // list` discovery found the group and cluster the fixture created.
      await page
        .getByLabel("Resource Group", { exact: true })
        .selectOption(cloud.resourceGroup);
      await page
        .getByLabel("Cluster", { exact: true })
        .selectOption(cloud.clusterName);
      await page
        .locator("#azure-namespace-select")
        .selectOption(KUBERNETES_NAMESPACE);

      const operationResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/operations" &&
          response.request().method() === "POST"
      );
      const createEnvironment = page.locator("#deploy-btn:not([disabled])");
      await expect(createEnvironment).toHaveText("Create Environment");
      await createEnvironment.click();
      const createResponse = await operationResponse;
      const operationId = readOperationId(
        readOperationHttpResponse({
          ok: createResponse.ok(),
          status: createResponse.status(),
          statusText: createResponse.statusText(),
          body: await createResponse.text()
        })
      );
      expect(operationId).toMatch(/^op_/);
      productOperationStarted = true;

      const snapshot = async (): Promise<
        ReturnType<typeof readOperationSnapshot>
      > =>
        readOperationSnapshot(
          readOperationHttpResponse(
            await page.evaluate(async (id) => {
              const response = await fetch(`/api/operations/${id}`);
              return {
                ok: response.ok,
                status: response.status,
                statusText: response.statusText,
                body: await response.text()
              };
            }, operationId)
          )
        );

      await expect
        .poll(async () => (await snapshot()).terminal, {
          timeout: OPERATION_TIMEOUT_MS,
          intervals: [5_000]
        })
        .toBe(true);
      const finished = await snapshot();
      expect(
        finished.state,
        `The create-environment operation ended ${finished.state}: ${finished.error || "no error was reported."}`
      ).toBe("succeeded");

      const app = await cloud.assertAppRegistrationExists();

      const identity = readRepositoryIdentity(
        await runGh(
          ports.commands,
          ["api", `repos/${cloud.repository}`],
          `gh api repos/${cloud.repository}`
        )
      );
      const customization = readOidcSubjectCustomization(
        await runGh(
          ports.commands,
          ["api", `repos/${cloud.repository}/actions/oidc/customization/sub`],
          "gh api the repository's OIDC subject customization"
        )
      );
      const subjects = expectedFederatedCredentialSubjects({
        fullName: cloud.repository,
        ownerId: identity.ownerId,
        repoId: identity.repoId,
        environmentName: cloud.environmentName,
        customization
      });
      expect(
        subjects.supported,
        subjects.supported ? "" : subjects.reason
      ).toBe(true);
      if (subjects.supported)
        for (const subject of subjects.required)
          await cloud.assertFederatedCredentialExists(subject);

      const principalId = readServicePrincipalObjectId(
        await runAz(
          ports.commands,
          ["ad", "sp", "show", "--id", app.appId, "-o", "json"],
          `az ad sp show --id ${app.appId}`
        )
      );
      await cloud.assertRoleAssignmentExists(principalId);

      await cloud.assertGitHubEnvironmentExists();
      const variables = readEnvironmentVariables(
        await runGh(
          ports.commands,
          [
            "api",
            `repos/${cloud.repository}/environments/${cloud.environmentName}/variables`
          ],
          "gh api the environment's variables"
        )
      );
      expect(
        findEnvironmentIdentityProblems({
          variables,
          createdAppId: app.appId,
          bootstrapClientId: process.env.AZURE_CLIENT_ID,
          expected: {
            tenantId: account.tenantId,
            subscriptionId: cloud.subscriptionId,
            resourceGroup: cloud.resourceGroup,
            cluster: cloud.clusterName,
            location: cloud.location,
            namespace: KUBERNETES_NAMESPACE
          }
        })
      ).toEqual([]);

      const publication = classifyWorkflowPublication({
        defaultBranchPaths: readWorkflowDirectory(
          await ports.commands.runGh([
            "api",
            `repos/${cloud.repository}/contents/${WORKFLOW_DIRECTORY}?ref=${cloud.defaultBranch}`
          ]),
          "gh api the default branch's workflow directory"
        ),
        fallbackBranches: selectFallbackBranches(
          await runGh(
            ports.commands,
            [
              "api",
              `repos/${cloud.repository}/git/matching-refs/heads/${workflowFallbackBranchPrefix(cloud.environmentName)}`
            ],
            "gh api this environment's workflow fallback branches"
          ),
          cloud.environmentName
        ),
        openPullRequests: selectFallbackPullRequests(
          await runGh(
            ports.commands,
            [
              "api",
              "--paginate",
              "--slurp",
              `repos/${cloud.repository}/pulls?state=open&per_page=100`
            ],
            "gh api the repository's open pull requests"
          ),
          cloud.environmentName
        )
      });
      expect(
        publication.outcome,
        describeWorkflowPublication(publication, {
          repository: cloud.repository,
          defaultBranch: cloud.defaultBranch
        })
      ).toBe("committed");
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await runCleanupSteps(
        [{ label: "clean up Canvas harness", run: () => harness.cleanup() }],
        primaryError
      );
    }
  });
});
