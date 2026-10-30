// Canvas adapter: browser behavior for the AWS deploy identity field in the
// environment wizard. Radius proposes `radius-deploy-<owner>-<repo>`, the help
// text states what the role will get, and `use an existing role…` pins a role
// a platform team already owns.

import { isRecord, readArray, readString, readStringArray } from "../json.js";
import type { EntryScope } from "../lifecycle.js";
import type { BrowserContext, DomElement } from "../ports.js";
import type { AppPickerChoice, AppPickerOptions } from "./discovery.js";

export const LIST_AWS_ROLES_ENDPOINT = "/api/list-aws-roles";

export interface AwsRoleCandidate {
  readonly arn: string;
  readonly name: string;
  readonly trustedSubjects: readonly string[];
}

export interface AwsDeployIdentityRequest {
  readonly roleName: string;
  readonly existingRoleArn: string;
}

export function awsRoleHelpText(
  repo: string,
  environment: string,
  region: string
): string {
  const env = environment || "this";
  return `Created in your AWS account, trusted over OIDC by repo:${repo} for the ${env} environment, and granted PowerUserAccess limited to resources in ${region || "the profile's region"}. Setup also grants the role cluster-admin access on the target EKS cluster.`;
}

/** The repositories a role's GitHub subjects already name. */
export function reposTrustedBy(subjects: readonly string[]): string[] {
  const repos = new Set<string>();
  for (const subject of subjects) {
    const match = /^repo:([^:]+):/.exec(subject);
    if (match) repos.add(match[1]);
  }
  return [...repos].sort();
}

export function parseAwsRoleCandidates(payload: unknown): AwsRoleCandidate[] {
  return readArray(payload, "roles")
    .filter(isRecord)
    .flatMap((role) => {
      const arn = readString(role, "arn");
      if (arn === "") return [];
      return [
        {
          arn,
          name: readString(role, "name") || arn,
          trustedSubjects: readStringArray(role, "trustedSubjects")
        }
      ];
    });
}

export interface AwsDeployIdentityDeps {
  readonly repo: string;
  readonly defaultRoleName: string;
  environmentName(): string;
  promptRoleSelection(options: AppPickerOptions): Promise<AppPickerChoice>;
}

export interface AwsDeployIdentityHandle {
  setProfile(profile: { accountId?: string; region?: string } | null): void;
  refreshHelp(): void;
  request(): AwsDeployIdentityRequest;
}

export function initializeAwsDeployIdentity(
  context: BrowserContext,
  scope: EntryScope,
  deps: AwsDeployIdentityDeps
): AwsDeployIdentityHandle {
  let accountId = "";
  let region = "";
  // Bumped by every role lookup and every account change, so a lookup that
  // finishes after either never opens the picker or pins a role.
  let generation = 0;
  const nameInput = context.dom.inputById("aws-role-name-input");
  const arnInput = context.dom.inputById("aws-selected-role-arn");
  const note = context.dom.byId("aws-selected-role-note");
  const clearLink = context.dom.byId("aws-clear-role-link");
  const useLink = context.dom.byId("aws-use-existing-role-link");
  // Without its two inputs the field does not exist on this page, and there is
  // nothing to propose or pin.
  if (!nameInput || !arnInput) {
    return {
      setProfile() {},
      refreshHelp() {},
      request: () => ({ roleName: "", existingRoleArn: "" })
    };
  }

  const showNote = (text: string, error: boolean): void => {
    if (!note) return;
    note.style.display = text === "" ? "none" : "block";
    note.style.color =
      error ? "var(--rad-danger,#cf222e)" : "var(--rad-info,#0969da)";
    note.textContent = text;
  };

  const pin = (arn: string, name: string): void => {
    arnInput.value = arn;
    nameInput.value = name;
    nameInput.disabled = true;
    if (clearLink) clearLink.style.display = "inline";
  };

  const clearPin = (): void => {
    arnInput.value = "";
    nameInput.disabled = false;
    nameInput.value = deps.defaultRoleName;
    if (clearLink) clearLink.style.display = "none";
    showNote("", false);
  };

  const refreshHelp = (): void => {
    const help = context.dom.byId("aws-role-help");
    if (help) {
      help.textContent = awsRoleHelpText(
        deps.repo,
        deps.environmentName().trim(),
        region
      );
    }
  };

  const useExistingRole = async (useLink: DomElement): Promise<void> => {
    const mine = ++generation;
    const lookupAccount = accountId;
    const stale = (): boolean => !scope.active || mine !== generation;
    useLink.textContent = "Loading roles…";
    let candidates: AwsRoleCandidate[];
    try {
      const response = await context.net.fetch(
        `${LIST_AWS_ROLES_ENDPOINT}?accountId=${encodeURIComponent(lookupAccount)}`
      );
      const payload = await response.json();
      if (!scope.active) return;
      useLink.textContent = "use an existing role…";
      if (stale()) return;
      const error = readString(payload, "error");
      if (error !== "") {
        showNote(error, true);
        return;
      }
      candidates = parseAwsRoleCandidates(payload);
    } catch (error) {
      if (!scope.active) return;
      useLink.textContent = "use an existing role…";
      if (stale()) return;
      showNote(
        `Could not list IAM roles: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
      return;
    }
    if (candidates.length === 0) {
      showNote("The signed-in identity cannot see any IAM roles.", true);
      return;
    }
    let choice: AppPickerChoice;
    try {
      choice = await deps.promptRoleSelection({
        title: "Use an existing role",
        intro: `Select an IAM role in account ${lookupAccount}. Radius adds this repository's trust, this environment's permissions, and cluster access to it, and never deletes it.`,
        caution:
          "Sharing one role across repositories means every trusted repository can use its AWS permissions. Only do this for repos that belong to the same product.",
        candidates: candidates.map((candidate) => ({
          appId: candidate.arn,
          displayName: candidate.name,
          servesRepos: reposTrustedBy(candidate.trustedSubjects)
        })),
        defaultAppId: "",
        allowCreateNew: false,
        lazyServes: false
      });
    } catch {
      return;
    }
    if (stale() || !("appId" in choice)) return;
    const picked = candidates.find(
      (candidate) => candidate.arn === choice.appId
    );
    pin(choice.appId, picked?.name ?? choice.appId);
    showNote(
      `Will use: ${picked?.name ?? choice.appId} (${choice.appId}).`,
      false
    );
  };

  if (useLink) {
    scope.on(useLink, "click", (event) => {
      event.preventDefault();
      void useExistingRole(useLink);
    });
  }
  if (clearLink) {
    scope.on(clearLink, "click", (event) => {
      event.preventDefault();
      clearPin();
    });
  }

  return {
    setProfile(profile) {
      const nextAccount = profile?.accountId ?? "";
      // A pinned role belongs to one account; a different profile unpins it
      // and abandons any lookup still running for the old account.
      if (nextAccount !== accountId) {
        generation += 1;
        clearPin();
      }
      accountId = nextAccount;
      region = profile?.region ?? "";
      refreshHelp();
    },
    refreshHelp,
    request() {
      const existingRoleArn = arnInput.value.trim();
      return {
        roleName: existingRoleArn === "" ? nameInput.value.trim() : "",
        existingRoleArn
      };
    }
  };
}
