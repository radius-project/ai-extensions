import { describe, it, expect } from "vitest";
import {
  REMEDIATION_IDS,
  buildRemediation,
  isRemediationId,
  remediationSessionMessage,
  remediationView
} from "./remediations.js";
import type { Remediation, RemediationId } from "./remediations.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const SUBSCRIPTION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function build(id: string, params: unknown = {}): Remediation {
  const result = buildRemediation(id, params);
  if (!result.ok) throw new Error(`expected ${id} to build: ${result.reason}`);
  return result.remediation;
}

// Parameters that let every id build, so a case can be driven by id alone.
const VALID_PARAMS: Readonly<Record<RemediationId, Record<string, string>>> = {
  "azure-cli-install": { tenantId: TENANT },
  "azure-cli-login": { tenantId: TENANT },
  "azure-subscription-set": { subscriptionId: SUBSCRIPTION },
  "aws-cli-login": {},
  "github-cli-login": {},
  "github-packages-scope": { login: "octocat" },
  "github-workflow-scope": {},
  "git-push-branch": { branch: "feature/add-run-command" }
};

describe("isRemediationId", () => {
  it.each(REMEDIATION_IDS)("accepts the %s id", (id) => {
    expect(isRemediationId(id)).toBe(true);
  });

  it.each([
    ["an unknown name", "rm-rf"],
    ["an empty string", ""],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an object", { id: "azure-cli-login" }]
  ])("rejects %s", (_label, value) => {
    expect(isRemediationId(value)).toBe(false);
  });
});

describe("buildRemediation", () => {
  it.each(REMEDIATION_IDS)("builds %s from valid parameters", (id) => {
    const remediation = build(id, VALID_PARAMS[id]);

    expect(remediation.id).toBe(id);
    expect(remediation.displayCommand).not.toBe("");
    expect(remediation.argv.length).toBeGreaterThan(0);
    expect(remediation.confirmTitle).not.toBe("");
    expect(remediation.confirmBody).not.toBe("");
    expect(remediation.confirmLabel).not.toBe("");
    expect(remediation.followUp).not.toBe("");
  });

  it.each(REMEDIATION_IDS)(
    "models %s as argv arrays with no shell metacharacters",
    (id) => {
      const remediation = build(id, VALID_PARAMS[id]);

      for (const argv of remediation.argv) {
        expect(argv.length).toBeGreaterThan(0);
        for (const arg of argv) {
          expect(arg).not.toMatch(/[&|;<>$`\n]/);
        }
      }
    }
  );

  it("refuses an unknown id", () => {
    expect(buildRemediation("sudo-rm", {})).toEqual({
      ok: false,
      reason: "Radius does not offer to run this command."
    });
  });

  it("refuses a non-string id", () => {
    expect(buildRemediation(42, {})).toEqual({
      ok: false,
      reason: "Radius does not offer to run this command."
    });
  });

  it.each([
    ["a missing params object", undefined],
    ["a null params object", null],
    ["a non-object params value", "tenantId=1"]
  ])("treats %s as empty parameters", (_label, params) => {
    const remediation = build("azure-cli-login", params);

    expect(remediation.displayCommand).toBe("az login --use-device-code");
    expect(remediation.params).toEqual({});
  });
});

describe("azure remediations", () => {
  it("includes a GUID tenant in the login command", () => {
    const remediation = build("azure-cli-login", { tenantId: TENANT });

    expect(remediation.displayCommand).toBe(
      `az login --use-device-code --tenant ${TENANT}`
    );
    expect(remediation.argv).toEqual([
      ["az", "login", "--use-device-code", "--tenant", TENANT]
    ]);
    expect(remediation.params).toEqual({ tenantId: TENANT });
  });

  it.each([
    ["a non-GUID tenant", "contoso.onmicrosoft.com"],
    ["an injection attempt", "$(whoami)"],
    ["an empty tenant", ""],
    ["a numeric tenant", 12345]
  ])("drops %s rather than passing it to az", (_label, tenantId) => {
    const remediation = build("azure-cli-login", { tenantId });

    expect(remediation.displayCommand).toBe("az login --use-device-code");
    expect(remediation.argv).toEqual([["az", "login", "--use-device-code"]]);
    expect(remediation.params).toEqual({});
  });

  it("trims surrounding whitespace from a GUID tenant", () => {
    const remediation = build("azure-cli-login", { tenantId: `  ${TENANT}  ` });

    expect(remediation.params).toEqual({ tenantId: TENANT });
  });

  it("keeps the install variant on the same login command", () => {
    const remediation = build("azure-cli-install", { tenantId: TENANT });

    expect(remediation.displayCommand).toBe(
      `az login --use-device-code --tenant ${TENANT}`
    );
    expect(remediation.confirmTitle).toBe("Install Azure CLI?");
    expect(remediation.impact).toBe("low");
  });

  it("builds the install variant without a tenant", () => {
    const remediation = build("azure-cli-install", {});

    expect(remediation.displayCommand).toBe("az login --use-device-code");
    expect(remediation.params).toEqual({});
  });

  it("builds a subscription selection from a GUID", () => {
    const remediation = build("azure-subscription-set", {
      subscriptionId: SUBSCRIPTION
    });

    expect(remediation.displayCommand).toBe(
      `az account set --subscription ${SUBSCRIPTION}`
    );
    expect(remediation.argv).toEqual([
      ["az", "account", "set", "--subscription", SUBSCRIPTION]
    ]);
  });

  it.each([
    ["a non-GUID subscription", "my-subscription"],
    ["a missing subscription", undefined]
  ])("refuses %s", (_label, subscriptionId) => {
    expect(
      buildRemediation("azure-subscription-set", { subscriptionId })
    ).toEqual({
      ok: false,
      reason:
        "Selecting an Azure subscription needs a subscription id in GUID form."
    });
  });
});

describe("github remediations", () => {
  it("builds both package-scope commands for a valid login", () => {
    const remediation = build("github-packages-scope", { login: "octo-cat" });

    expect(remediation.displayCommand).toBe(
      "gh auth switch -h github.com -u octo-cat && " +
        "gh auth refresh -h github.com -s read:packages -s write:packages"
    );
    expect(remediation.argv).toEqual([
      ["gh", "auth", "switch", "-h", "github.com", "-u", "octo-cat"],
      [
        "gh",
        "auth",
        "refresh",
        "-h",
        "github.com",
        "-s",
        "read:packages",
        "-s",
        "write:packages"
      ]
    ]);
  });

  it("warns that switching changes the active account machine-wide", () => {
    const remediation = build("github-packages-scope", { login: "octocat" });

    expect(remediation.impact).toBe("high");
    expect(remediation.confirmBody).toContain("machine-wide");
  });

  it.each([
    ["a login with a slash", "octo/cat"],
    ["a login with a space", "octo cat"],
    ["a login starting with a hyphen", "-octocat"],
    ["a login ending with a hyphen", "octocat-"],
    ["a login that is too long", "a".repeat(40)],
    ["a missing login", undefined],
    ["an empty login", ""]
  ])("refuses %s", (_label, login) => {
    expect(buildRemediation("github-packages-scope", { login })).toEqual({
      ok: false,
      reason:
        "Granting package access needs the GitHub account login Radius detected."
    });
  });

  it("accepts a single-character login", () => {
    const remediation = build("github-packages-scope", { login: "a" });

    expect(remediation.params).toEqual({ login: "a" });
  });

  it("builds the workflow scope refresh", () => {
    const remediation = build("github-workflow-scope", {});

    expect(remediation.displayCommand).toBe(
      "gh auth refresh -h github.com -s workflow"
    );
    expect(remediation.impact).toBe("high");
  });

  it("treats gh auth login as machine-wide", () => {
    const remediation = build("github-cli-login", {});

    expect(remediation.displayCommand).toBe("gh auth login");
    expect(remediation.impact).toBe("high");
    expect(remediation.confirmBody).toContain("machine-wide");
  });
});

describe("aws remediation", () => {
  it("offers SSO login and mentions the static-credential alternative", () => {
    const remediation = build("aws-cli-login", {});

    expect(remediation.displayCommand).toBe("aws sso login");
    expect(remediation.argv).toEqual([["aws", "sso", "login"]]);
    expect(remediation.confirmBody).toContain("aws configure");
    expect(remediation.impact).toBe("low");
  });
});

describe("git push remediation", () => {
  it("builds a tracking push for a valid branch", () => {
    const remediation = build("git-push-branch", { branch: "feature/login" });

    expect(remediation.displayCommand).toBe("git push -u origin feature/login");
    expect(remediation.argv).toEqual([
      ["git", "push", "-u", "origin", "feature/login"]
    ]);
    expect(remediation.cwd).toBe("workspace");
    expect(remediation.impact).toBe("high");
  });

  it("states that the push writes to the remote", () => {
    const remediation = build("git-push-branch", { branch: "main" });

    expect(remediation.confirmBody).toContain("remote repository");
  });

  it.each([
    ["a branch starting with a hyphen", "--force"],
    ["a branch with a space", "my branch"],
    ["a branch with a traversal", "feature/../main"],
    ["a lock ref", "feature/login.lock"],
    ["a branch with a semicolon", "main;rm -rf /"],
    ["a branch with a newline", "main\nrm -rf /"],
    ["an over-long branch", `b${"x".repeat(200)}`],
    ["a missing branch", undefined],
    ["an empty branch", ""]
  ])("refuses %s", (_label, branch) => {
    expect(buildRemediation("git-push-branch", { branch })).toEqual({
      ok: false,
      reason:
        "Radius could not read a branch name it can safely push, so it will not run git push for you."
    });
  });
});

describe("remediationView", () => {
  it.each(REMEDIATION_IDS)("projects %s as a runnable view", (id) => {
    const view = remediationView(id, VALID_PARAMS[id]);
    const remediation = build(id, VALID_PARAMS[id]);

    expect(view).toEqual({
      id,
      params: remediation.params,
      title: remediation.title,
      command: remediation.displayCommand,
      cwd: remediation.cwd,
      impact: remediation.impact,
      runnable: true,
      unsupportedReason: "",
      confirmTitle: remediation.confirmTitle,
      confirmBody: remediation.confirmBody,
      confirmLabel: remediation.confirmLabel,
      followUp: remediation.followUp
    });
  });

  it("never carries prompt text to a client", () => {
    const view = remediationView("azure-cli-login", { tenantId: TENANT });

    expect(Object.keys(view).sort()).toEqual(
      [
        "command",
        "confirmBody",
        "confirmLabel",
        "confirmTitle",
        "cwd",
        "followUp",
        "id",
        "impact",
        "params",
        "runnable",
        "title",
        "unsupportedReason"
      ].sort()
    );
  });

  it("offers a disabled view with a reason when a parameter is unusable", () => {
    const view = remediationView("git-push-branch", { branch: "--force" });

    expect(view.runnable).toBe(false);
    expect(view.command).toBe("");
    expect(view.unsupportedReason).toContain("will not run git push");
    expect(view.confirmLabel).toBe("");
  });

  it("keeps an unknown id out of the view payload it echoes", () => {
    const view = remediationView("sudo-rm", {});

    expect(view.runnable).toBe(false);
    expect(view.id).toBe("sudo-rm");
    expect(view.params).toEqual({});
    expect(view.unsupportedReason).toBe(
      "Radius does not offer to run this command."
    );
  });

  it("reports an empty id for a non-string request", () => {
    expect(remediationView(null, {}).id).toBe("");
  });
});

describe("remediationSessionMessage", () => {
  it.each(REMEDIATION_IDS)("pairs a prompt and a stand-in for %s", (id) => {
    const message = remediationSessionMessage(build(id, VALID_PARAMS[id]));

    expect(message.prompt).not.toBe("");
    expect(message.displayPrompt).not.toBe("");
    expect(message.displayPrompt).not.toContain("\n");
  });

  it.each(REMEDIATION_IDS)("names the %s command in its prompt", (id) => {
    const remediation = build(id, VALID_PARAMS[id]);
    const message = remediationSessionMessage(remediation);

    expect(message.prompt).toContain(remediation.displayCommand);
    expect(message.prompt).toContain(remediation.followUp);
  });

  it("reproduces the original Azure CLI login prompt exactly", () => {
    const message = remediationSessionMessage(
      build("azure-cli-login", { tenantId: TENANT })
    );

    expect(message.prompt).toBe(
      [
        "The Radius canvas needs an active Azure CLI session before it can verify these credentials.",
        [
          `Run \`az login --use-device-code --tenant ${TENANT}\` in this Copilot session.`,
          "For that command, remove COPILOT_AGENT_SESSION_ID from the az process environment so Azure CLI does not inject it into the authentication request.",
          "Use the shell-appropriate way to unset the variable only for the login invocation, and show me the device code and sign-in URL."
        ].join(" "),
        "After the login finishes, return to the Radius canvas and click Verify Credentials again."
      ].join("\n\n")
    );
    expect(message.displayPrompt).toBe(
      "Signing in to Azure CLI so the Radius canvas can verify these Azure credentials."
    );
  });

  it("reproduces the original Azure CLI install prompt exactly", () => {
    const message = remediationSessionMessage(build("azure-cli-install", {}));

    expect(message.prompt).toBe(
      [
        "Azure CLI is not installed in this environment, so the Radius canvas can't verify Azure credentials yet.",
        [
          "Please install Azure CLI, then Run `az login --use-device-code` in this Copilot session.",
          "For that command, remove COPILOT_AGENT_SESSION_ID from the az process environment so Azure CLI does not inject it into the authentication request.",
          "Use the shell-appropriate way to unset the variable only for the login invocation, and show me the device code and sign-in URL."
        ].join(" "),
        "After the install and login finish, return to the Radius canvas and click Verify Credentials again."
      ].join("\n\n")
    );
    expect(message.displayPrompt).toBe(
      "Installing Azure CLI and signing in so the Radius canvas can verify these Azure credentials."
    );
  });

  it("tells the agent where to run a workspace command", () => {
    const message = remediationSessionMessage(
      build("git-push-branch", { branch: "feature/login" })
    );

    expect(message.prompt).toContain(
      "Run it from the repository worktree for this session."
    );
    expect(message.displayPrompt).toContain("feature/login");
  });

  it("omits the worktree line for machine-level commands", () => {
    const message = remediationSessionMessage(
      build("github-workflow-scope", {})
    );

    expect(message.prompt).not.toContain("worktree");
  });

  it("names the account whose packages access is being granted", () => {
    const message = remediationSessionMessage(
      build("github-packages-scope", { login: "octocat" })
    );

    expect(message.prompt).toContain("@octocat");
    expect(message.displayPrompt).toBe(
      "Granting the GitHub CLI account permission to publish packages for Radius."
    );
  });

  it.each([
    ["aws-cli-login", "AWS CLI"],
    ["github-cli-login", "GitHub CLI"],
    ["azure-subscription-set", "Azure subscription"]
  ])("describes %s in its stand-in", (id, expected) => {
    const message = remediationSessionMessage(
      build(id, VALID_PARAMS[id as RemediationId])
    );

    expect(message.displayPrompt).toContain(expected);
  });
});
