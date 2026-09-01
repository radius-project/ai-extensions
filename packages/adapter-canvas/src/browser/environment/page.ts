import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { queryValue } from "../query.js";
import { readString } from "../json.js";
import {
  parseGhCommandPresentation,
  type GhCommandPresentation
} from "../../gh-command-display.js";
import { readPageState } from "../pages/state.js";
import { ENVIRONMENT_PAGE_STATE_ID } from "../../pages/browser-state-ids.js";
import {
  initializeCredentialsPane,
  isCredentialsPaneController
} from "./credentials.js";
import { initializeDiscoveryPanel } from "./discovery.js";
import { createEnvironmentConfirmDialog } from "./confirm-dialog.js";
import {
  initializeEnvironmentPane,
  isEnvironmentPaneController,
  type EnvironmentPaneController
} from "./environments.js";
import {
  initializeEnvironmentOperations,
  type EnvironmentOperationsController,
  type OperationRecord
} from "./operations.js";
import {
  initializeCredentialProfilesPanel,
  type CredentialProfile,
  type GithubReadiness
} from "./profiles.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { AbortHandle, BrowserContext, DomInputElement } from "../ports.js";

export const ENVIRONMENT_PAGE_ENTRY_KEY = "environment-page";
export const CREATE_ENVIRONMENT_OPERATION_PATH = "/api/operations";
export { ENVIRONMENT_PAGE_STATE_ID };

interface EnvironmentPageState {
  readonly repo: string;
  readonly branch: string;
  readonly activeSubtab: "credentials" | "environments";
  readonly mutationNonce: string;
  readonly ghCommandPresentation: GhCommandPresentation;
}

export interface EnvironmentPageOptions {
  readonly selectableProviders?: readonly ("azure" | "aws")[];
}

function parsePageState(context: BrowserContext): EnvironmentPageState {
  const state = readPageState(context, ENVIRONMENT_PAGE_STATE_ID);
  return {
    repo: readString(state, "repo"),
    branch: readString(state, "branch"),
    mutationNonce: readString(state, "mutationNonce"),
    ghCommandPresentation: parseGhCommandPresentation(
      state.ghCommandPresentation
    ),
    activeSubtab:
      readString(state, "activeSubtab") === "credentials" ? "credentials" : (
        "environments"
      )
  };
}

function input(context: BrowserContext, id: string): DomInputElement | null {
  return context.dom.inputById(id);
}

function optimisticOperation(
  kind: string,
  environment: string,
  provider: string,
  now: number,
  summary: string
): OperationRecord {
  return {
    operationId: "pending",
    kind,
    environment,
    provider,
    state: "running",
    terminalState: null,
    summary,
    currentStage: "",
    stages: [],
    steps: [],
    failure: null,
    cleanup: {
      state: "",
      rollbackBeforeCommit: undefined,
      retry: { startsCleanly: false, guidance: "" },
      warnings: [],
      created: [],
      retainedArtifacts: [],
      reused: [],
      cleaned: [],
      manualActionRequired: []
    },
    actions: [],
    guidance: [],
    headline: null,
    activeCommandKind: "",
    nextTransition: null,
    verification: null,
    inputRequired: null,
    startedAt: new Date(now).toISOString(),
    endedAt: null,
    terminal: null
  };
}

export function initializeEnvironmentPage(
  context: BrowserContext,
  options: EnvironmentPageOptions = {}
): BrowserTeardown {
  const newEnvironment = context.dom.byId("new-env-btn");
  const cancelEnvironment = context.dom.byId("cancel-env-btn");
  const createProfile = context.dom.byId("env-create-profile-link");
  const newCredential = context.dom.byId("new-cred-btn");
  const createButton = input(context, "deploy-btn");
  const environmentInput = input(context, "env-name-input");
  const targetRepoInput = input(context, "target-repo");
  const branchInput = input(context, "deploy-branch-select");
  const clientIdInput = input(context, "az-client-id");
  const appNameInput = input(context, "az-app-name-input");
  const appIdInput = input(context, "az-selected-app-id");
  const formStatus = context.dom.byId("deploy-status");
  if (
    !context.dom.byId(ENVIRONMENT_PAGE_STATE_ID) ||
    !context.dom.byId("pane-environments") ||
    !context.dom.byId("pane-credentials") ||
    !newEnvironment ||
    !cancelEnvironment ||
    !createProfile ||
    !newCredential ||
    !createButton ||
    !environmentInput ||
    !targetRepoInput ||
    !branchInput ||
    !clientIdInput ||
    !appNameInput ||
    !appIdInput ||
    !formStatus
  ) {
    return NOOP_TEARDOWN;
  }
  // Parsed before the binding is claimed: a throw here would otherwise leave
  // the entry key claimed forever and escape the compiled entry's IIFE.
  const state = parsePageState(context);
  const scope = beginEntry(context, ENVIRONMENT_PAGE_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const discovery = initializeDiscoveryPanel(context);
  let selectedProfile: CredentialProfile | null = null;
  let githubReadiness: GithubReadiness | null = null;
  let creating = false;
  let createAbort: AbortHandle | null = null;
  const refreshCreateEligibility = (): void => {
    createButton.disabled =
      creating || !selectedProfile || githubReadiness?.ready !== true;
  };

  if (!discovery) {
    scope.teardown();
    return NOOP_TEARDOWN;
  }
  const confirmDialog = createEnvironmentConfirmDialog(context);

  const profiles = initializeCredentialProfilesPanel(context, {
    repo: state.repo,
    selectableProviders: options.selectableProviders ?? ["azure"],
    mutationNonce: state.mutationNonce,
    ghCommandPresentation: state.ghCommandPresentation,
    environmentName: () => environmentInput.value,
    onReadinessChange(readiness) {
      githubReadiness = readiness;
      refreshCreateEligibility();
    },
    onProfileChange(profile) {
      selectedProfile = profile;
      refreshCreateEligibility();
      const summary = context.dom.byId("env-profile-summary");
      if (summary) {
        summary.textContent =
          profile ?
            `${profile.name} (${profile.provider === "aws" ? "AWS" : "Azure"})`
          : "No credential profile selected";
      }
      const detail = context.dom.byId("env-profile-detail");
      const status = context.dom.byId("env-profile-status");
      if (detail) {
        detail.innerHTML = profile ? (status?.innerHTML ?? "") : "";
        detail.style.display = profile ? "" : "none";
      }
      const next = context.dom.inputById("env-step1-next");
      if (next) next.disabled = !profile;
      const hint = context.dom.byId("env-step1-hint");
      if (hint) hint.style.display = profile ? "none" : "";
    },
    discoverResources(provider, subscriptionId, tenantId) {
      void discovery.discoverResources(provider, subscriptionId, tenantId);
    }
  });
  if (!profiles) {
    confirmDialog?.teardown();
    discovery.teardown();
    scope.teardown();
    return NOOP_TEARDOWN;
  }
  scope.on(environmentInput, "input", profiles.invalidateReadiness);

  // Credential actions call into the environment controller only after user
  // interaction, so construct credentials first and close over the controller
  // assigned immediately afterward. This makes the construction ordering
  // explicit without installing a silent nullable fallback.
  let environments: EnvironmentPaneController;
  let operations: EnvironmentOperationsController;

  // Terminal behavior for a delete operation, shared by the start path
  // (startDeleteProgress) and the rejoin path (resumeProgress), so the user
  // sees the same acknowledgement whether they stay on the panel or return to
  // it while the delete is still running.
  const handleDeleteTerminal = (op: OperationRecord): void => {
    environments.loadEnvironmentTable();
    const succeeded =
      op.terminalState === "succeeded" ||
      op.terminalState === "succeeded_with_warnings";
    // Azure environments own a Microsoft Entra app registration that Radius
    // never deletes automatically (it may be shared). Tell the user it was left
    // behind so they can remove it in Azure if they want to.
    if (!succeeded || op.provider !== "azure" || !confirmDialog) return;
    const withWarnings = op.terminalState === "succeeded_with_warnings";
    const outcome =
      withWarnings ?
        `The environment "${op.environment}" was deleted, but some cleanup steps reported warnings — check the progress panel for details.`
      : `The environment "${op.environment}" was deleted.`;
    confirmDialog.show({
      title:
        withWarnings ?
          "Environment deleted with warnings"
        : "Environment deleted",
      message: `${outcome}\n\nIts Microsoft Entra app registration was not deleted — Radius never removes app registrations automatically because they can be shared by other environments or services. If you no longer need it, delete it in the `,
      messageLink: {
        label: "Azure portal",
        href: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
        suffix: "."
      },
      confirmLabel: "Done",
      confirmVariant: "primary",
      hideCancel: true
      // "Done" only acknowledges this notice. It must NOT dismiss the progress
      // panel — the panel carries its own dismiss button ("OK" for a clean
      // delete, "Exit" for a warning outcome), and that button is the single
      // action that persists the dismissal server-side. Dismissing from here as
      // well would tear the panel down behind the user's back the moment they
      // acknowledge the Entra-app notice.
    });
  };
  const credentials = initializeCredentialsPane(
    context,
    {
      repo: state.repo,
      mutationNonce: state.mutationNonce,
      ghCommandPresentation: state.ghCommandPresentation,
      decisions: context.dialogs,
      ...(confirmDialog ? { confirmDialog } : {})
    },
    {
      selectEnvironmentsSubtab() {
        environments.switchSubtab("environments");
      },
      openEnvironmentForm(preset) {
        environments.showEnvironmentForm(preset);
      },
      credentialCreated(name) {
        void profiles.loadProfiles(name).then(() => {
          environments.showWizardStep(2);
          environmentInput.focus();
        });
      }
    }
  );
  if (!isCredentialsPaneController(credentials)) {
    confirmDialog?.teardown();
    profiles.teardown();
    discovery.teardown();
    scope.teardown();
    return NOOP_TEARDOWN;
  }

  const initializedEnvironments = initializeEnvironmentPane(
    context,
    {
      repo: state.repo,
      decisions: context.dialogs,
      ...(confirmDialog ? { confirmDialog } : {})
    },
    {
      loadCredentialTable() {
        credentials.loadCredentialTable();
      },
      loadProfiles(preselectName) {
        return profiles.loadProfiles(preselectName);
      },
      loadGitHubIdentity(fresh) {
        void profiles.loadGithubIdentity(fresh);
      },
      clearSharedAppPin() {
        discovery.clearSharedAppPin();
      },
      setPendingInfraSelection(config, provider) {
        discovery.setPendingInfraSelection(config, provider);
      },
      currentInfraSelection(provider) {
        return discovery.currentInfraSelection(provider);
      },
      canSubmit() {
        return (
          !creating &&
          selectedProfile !== null &&
          githubReadiness?.ready === true
        );
      },
      startDeleteProgress(environment, provider) {
        environments.hideTerminalBanners();
        operations.stopProgress();
        operations.renderProgress(
          optimisticOperation(
            "delete",
            environment,
            provider,
            context.clock.now(),
            `Deleting ${environment}…`
          )
        );
        operations.focusPanel();
        operations.trackProgress(environment, provider, handleDeleteTerminal);
      }
    }
  );

  if (!isEnvironmentPaneController(initializedEnvironments)) {
    confirmDialog?.teardown();
    credentials.teardown();
    profiles.teardown();
    discovery.teardown();
    scope.teardown();
    return NOOP_TEARDOWN;
  }
  environments = initializedEnvironments;

  const restoreCreateButton = (): void => {
    creating = false;
    environments.resetSubmitButton();
  };

  const initializedOperations = initializeEnvironmentOperations(context, {
    repo: state.repo,
    mutationNonce: state.mutationNonce,
    ghCommandPresentation: state.ghCommandPresentation,
    deps: {
      showSuccessBanner: environments.showSuccess,
      showActionRequired: environments.showActionRequired,
      showSetupWarnings: environments.showWarnings,
      showError: environments.showError,
      reloadEnvironmentsTable: environments.loadEnvironmentTable,
      // The page owns the `creating` latch. Every terminal path, including one
      // reached after Stop, Retry, Rollback, or Exit, must release it before the
      // user can start another setup without reloading the page.
      resetSubmitButton: restoreCreateButton,
      onDeleteTerminal: handleDeleteTerminal,
      promptServiceManagementReference:
        discovery.promptServiceManagementReference,
      promptAppSelection: discovery.promptAppSelection
    }
  });

  if (!initializedOperations) {
    confirmDialog?.teardown();
    credentials.teardown();
    environments.teardown();
    profiles.teardown();
    discovery.teardown();
    scope.teardown();
    return NOOP_TEARDOWN;
  }
  operations = initializedOperations;

  const showFormError = (message: string): void => {
    formStatus.className = "status error";
    formStatus.textContent = message;
    formStatus.style.display = "block";
  };

  const failCreate = (message: string): void => {
    restoreCreateButton();
    operations.hideProgress();
    environments.showError(message);
  };

  const createEnvironment = (): void => {
    if (creating) return;
    if (!selectedProfile) {
      showFormError("Please select a credential profile.");
      return;
    }
    if (
      githubReadiness?.ready !== true ||
      githubReadiness.selectionHandle === ""
    ) {
      showFormError(
        "Re-check the selected GitHub account before creating the environment."
      );
      return;
    }
    const environment = environmentInput.value.trim();
    if (environment === "") {
      showFormError("Please enter an environment name.");
      return;
    }
    const targetRepo = targetRepoInput.value.trim();
    if (targetRepo === "" || targetRepo !== state.repo) {
      showFormError(
        "The repository context changed. Reopen the environment page and try again."
      );
      return;
    }
    const provider = selectedProfile.provider === "aws" ? "aws" : "azure";
    const tenantId = (selectedProfile.tenantId ?? "").trim();
    const subscriptionId = (selectedProfile.subscriptionId ?? "").trim();
    const accountId = (selectedProfile.accountId ?? "").trim();
    const region = (selectedProfile.region ?? "").trim();
    const infrastructure = discovery.currentInfraSelection(provider);
    const cluster = (infrastructure.cluster ?? "").trim();
    const namespace = (infrastructure.namespace ?? "").trim() || "default";
    const resourceGroup = (infrastructure.resourceGroup ?? "").trim();
    if (provider === "azure" && resourceGroup === "") {
      showFormError("Please specify a resource group.");
      return;
    }
    if (cluster === "") {
      showFormError(
        provider === "azure" ?
          "Please specify an AKS cluster."
        : "Please specify an EKS cluster."
      );
      return;
    }
    if (provider === "azure" && (subscriptionId === "" || tenantId === "")) {
      showFormError(
        "The selected profile needs both a tenant ID and subscription ID. Delete the profile and create it again with those values before creating the environment."
      );
      return;
    }
    if (provider === "aws" && (accountId === "" || region === "")) {
      showFormError(
        "The selected profile needs both an account ID and region. Delete the profile and create it again with those values before creating the environment."
      );
      return;
    }

    const branch = branchInput.value || state.branch;
    const body: Record<string, unknown> = {
      repo: targetRepo,
      environment,
      provider,
      cluster,
      namespace,
      profileName: selectedProfile.name,
      origin: "environment",
      resumeTarget: { page: "planned", repo: targetRepo, branch: state.branch },
      resumeBranch: state.branch,
      resumeReason: "View planned graph",
      branch
    };
    body.selectionHandle = githubReadiness.selectionHandle;
    if (provider === "azure") {
      body.clientId = clientIdInput.value.trim();
      body.tenantId = tenantId;
      body.subscriptionId = subscriptionId;
      body.resourceGroup = resourceGroup;
      body.clusterResourceGroup =
        discovery.findAzureClusterResourceGroup(cluster);
      body.appName = appNameInput.value.trim();
      body.appId = appIdInput.value;
    } else {
      body.roleArn = selectedProfile.roleArn ?? "";
      body.region = region;
      body.accountId = accountId;
      body.vpcId = (infrastructure.vpcId ?? "").trim();
      body.subnetIds = (infrastructure.subnetIds ?? "").trim();
    }

    creating = true;
    createButton.disabled = true;
    createButton.textContent =
      environmentInput.disabled ?
        "Saving environment…"
      : "Creating environment…";
    formStatus.style.display = "none";
    environments.showEnvironmentLanding();
    environments.hideTerminalBanners();
    operations.stopProgress();
    operations.renderProgress(
      optimisticOperation(
        "create",
        environment,
        provider,
        context.clock.now(),
        `${environmentInput.disabled ? "Updating" : "Creating"} ${environment}…`
      )
    );
    operations.focusPanel();

    createAbort = context.net.createAbort();
    void context.net
      .fetch(CREATE_ENVIRONMENT_OPERATION_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Radius-Mutation-Nonce": state.mutationNonce
        },
        body: JSON.stringify(body),
        ...(createAbort ? { signal: createAbort.signal } : {})
      })
      .then(async (response) => {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new Error("Radius returned an invalid environment response.");
        }
        if (!response.ok || readString(payload, "error") !== "") {
          if (!scope.active) return null;
          const rendered = await operations.syncFailureOperation(payload);
          if (!rendered) {
            throw new Error(
              readString(payload, "error") ||
                "Could not start environment setup."
            );
          }
          return null;
        }
        if (readString(payload, "operationId") === "") {
          throw new Error("Radius did not return an environment operation.");
        }
        return payload;
      })
      .then(
        (payload) => {
          if (!scope.active) return;
          createAbort = null;
          if (payload === null) {
            restoreCreateButton();
            return;
          }
          operations.trackProgress(environment, provider, (operation) => {
            restoreCreateButton();
            operations.applyTerminal(operation);
          });
        },
        (error: unknown) => {
          if (!scope.active) return;
          createAbort = null;
          failCreate(
            error instanceof Error ?
              error.message
            : "Could not start environment setup. Please try again."
          );
        }
      );
  };

  scope.on(newEnvironment, "click", () =>
    environments.showEnvironmentForm({ name: "" })
  );
  scope.on(cancelEnvironment, "click", environments.showEnvironmentLanding);
  scope.on(createProfile, "click", (event) => {
    event.preventDefault();
    environments.showWizardStep(1);
    credentials.startWizardCreation();
  });
  scope.on(createButton, "click", createEnvironment);

  if (state.activeSubtab === "credentials") {
    credentials.loadCredentialTable();
  } else {
    environments.loadEnvironmentTable();
  }
  if (queryValue(context.nav.search, "new") === "1") {
    environments.showEnvironmentForm({
      name: queryValue(context.nav.search, "name"),
      profile: queryValue(context.nav.search, "profile")
    });
  }
  operations.resumeProgress();

  return () => {
    createAbort?.abort();
    createAbort = null;
    operations.teardown();
    profiles.teardown();
    credentials.teardown();
    confirmDialog?.teardown();
    environments.teardown();
    discovery.teardown();
    scope.teardown();
  };
}
