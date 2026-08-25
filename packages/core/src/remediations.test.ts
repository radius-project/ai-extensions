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
  "github-account-scopes": { login: "octocat", packages: "true" },
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
      "gh auth switch -h github.com -u octo-cat\n" +
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
    ["a login that is too long", "a".repeat(80)],
    ["a login starting with an underscore", "_octocat"],
    ["a login ending with an underscore", "octocat_"],
    ["a missing login", undefined],
    ["an empty login", ""]
  ])("refuses %s", (_label, login) => {
    expect(buildRemediation("github-packages-scope", { login })).toEqual({
      ok: false,
      reason:
        "Granting package access needs the GitHub account login Radius detected."
    });
  });

  it("accepts an Enterprise Managed User login", () => {
    const remediation = build("github-packages-scope", {
      login: "witsai_microsoft"
    });

    expect(remediation.params).toEqual({ login: "witsai_microsoft" });
    expect(remediation.argv).toContainEqual([
      "gh",
      "auth",
      "switch",
      "-h",
      "github.com",
      "-u",
      "witsai_microsoft"
    ]);
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

  it.each([
    [
      "workflow only",
      { login: "octocat", workflow: "true" },
      "gh auth switch -h github.com -u octocat\ngh auth refresh -h github.com -s workflow"
    ],
    [
      "packages only",
      { login: "octocat", packages: "true" },
      "gh auth switch -h github.com -u octocat\ngh auth refresh -h github.com -s read:packages -s write:packages"
    ],
    [
      "both scopes",
      { login: "octocat", workflow: "true", packages: "true" },
      "gh auth switch -h github.com -u octocat\ngh auth refresh -h github.com -s workflow -s read:packages -s write:packages"
    ]
  ])("builds the account scope grant for %s", (_label, params, expected) => {
    const remediation = build("github-account-scopes", params);

    expect(remediation.displayCommand).toBe(expected);
    expect(remediation.impact).toBe("high");
    expect(remediation.confirmBody).toContain("machine-wide");
    expect(remediation.followUp).toContain("Re-check");
  });

  it.each([
    ["github-packages-scope", { login: "octocat" }],
    ["github-account-scopes", { login: "octocat", packages: "true" }]
  ] as const)(
    "separates %s commands by line so Windows PowerShell can run them",
    (id, params) => {
      const remediation = build(id, params);

      // Windows PowerShell 5.1 cannot parse `&&`, and the displayed text is
      // what a user copies into their own shell.
      expect(remediation.displayCommand).not.toContain("&&");
      expect(remediation.displayCommand.split("\n")).toHaveLength(
        remediation.argv.length
      );
    }
  );

  it("switches the account before refreshing it, never as one shell string", () => {
    const remediation = build("github-account-scopes", {
      login: "octocat",
      packages: "true"
    });

    expect(remediation.argv).toEqual([
      ["gh", "auth", "switch", "-h", "github.com", "-u", "octocat"],
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

  it("derives scopes itself so a caller cannot inject one", () => {
    const remediation = build("github-account-scopes", {
      login: "octocat",
      packages: "true",
      scopes: "admin:org",
      workflow: "yes"
    });

    // `workflow: "yes"` is not the literal `true`, so the workflow scope is
    // not granted, and the stray `scopes` parameter is ignored entirely.
    expect(remediation.displayCommand).not.toContain("admin:org");
    expect(remediation.displayCommand).not.toContain("workflow");
    expect(remediation.params).toEqual({ login: "octocat", packages: "true" });
  });

  it("switches to an Enterprise Managed User login", () => {
    const remediation = build("github-account-scopes", {
      login: "witsai_microsoft",
      packages: "true"
    });

    expect(remediation.argv).toContainEqual([
      "gh",
      "auth",
      "switch",
      "-h",
      "github.com",
      "-u",
      "witsai_microsoft"
    ]);
  });

  it("refuses an unusable login", () => {
    expect(
      buildRemediation("github-account-scopes", {
        login: "octo cat",
        packages: "true"
      })
    ).toEqual({
      ok: false,
      reason:
        "Granting GitHub access needs the GitHub account login Radius detected."
    });
  });

  it("refuses when no scope is actually missing", () => {
    expect(
      buildRemediation("github-account-scopes", { login: "octocat" })
    ).toEqual({
      ok: false,
      reason: "Radius did not find a GitHub scope that needs granting."
    });
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

  describe("uncommitted generated files", () => {
    it("stages and commits the generated model before pushing", () => {
      const remediation = build("git-push-branch", {
        branch: "feature/login",
        paths: ".radius,app.bicep"
      });

      // Order is the contract: a push that runs before the commit publishes a
      // branch without the model the deploy reads, which is the whole bug.
      expect(remediation.argv).toEqual([
        ["git", "add", "--", ".radius", "app.bicep"],
        ["git", "commit", "-m", "Add Radius application model"],
        ["git", "push", "-u", "origin", "feature/login"]
      ]);
      expect(remediation.displayCommand).toBe(
        'git add -- .radius app.bicep\ngit commit -m "Add Radius application model"\ngit push -u origin feature/login'
      );
      expect(remediation.params).toEqual({
        branch: "feature/login",
        paths: ".radius,app.bicep"
      });
      expect(remediation.title).toBe(
        "Commit the Radius model and push the branch"
      );
      expect(remediation.confirmLabel).toBe("Commit and push");
      expect(remediation.confirmBody).toContain(".radius, app.bicep");
      expect(remediation.confirmBody).toContain(
        "Nothing else in your working tree is staged"
      );
    });

    it("accepts an array of paths", () => {
      const remediation = build("git-push-branch", {
        branch: "main",
        paths: [".radius"]
      });

      expect(remediation.argv[0]).toEqual(["git", "add", "--", ".radius"]);
    });

    it("normalizes paths to the allowlist order and drops duplicates", () => {
      const remediation = build("git-push-branch", {
        branch: "main",
        paths: "app.origin.json,.radius,.radius"
      });

      expect(remediation.argv[0]).toEqual([
        "git",
        "add",
        "--",
        ".radius",
        "app.origin.json"
      ]);
    });

    it.each([
      ["a traversal", "../../etc/passwd"],
      ["a glob", "*"],
      ["the worktree root", "."],
      ["an unrelated source path", "src/index.ts"],
      ["a near-miss prefix", ".radiusx"],
      ["an empty entry", ""]
    ])("drops %s rather than staging it", (_label, path) => {
      const remediation = build("git-push-branch", {
        branch: "main",
        paths: path
      });

      // A path outside the allowlist degrades to a plain push: staging fewer
      // generated files still pushes correctly, and nothing unallowlisted may
      // ever reach a `git add`.
      expect(remediation.argv).toEqual([
        ["git", "push", "-u", "origin", "main"]
      ]);
      expect(remediation.params.paths).toBe("");
    });

    it("keeps the allowlisted members of a partly invalid list", () => {
      const remediation = build("git-push-branch", {
        branch: "main",
        paths: "src/index.ts,.radius"
      });

      expect(remediation.argv[0]).toEqual(["git", "add", "--", ".radius"]);
    });

    it.each([
      ["a number", 7],
      ["null", null],
      ["an object", { radius: true }]
    ])("treats %s as no paths", (_label, paths) => {
      const remediation = build("git-push-branch", { branch: "main", paths });

      expect(remediation.argv).toHaveLength(1);
      expect(remediation.title).toBe("Push the branch to GitHub");
      expect(remediation.confirmLabel).toBe("Push branch");
    });

    it("still refuses a bad branch even when paths are valid", () => {
      expect(
        buildRemediation("git-push-branch", {
          branch: "--force",
          paths: ".radius"
        }).ok
      ).toBe(false);
    });

    it("exposes the staged paths on the view", () => {
      const view = remediationView("git-push-branch", {
        branch: "main",
        paths: ".radius"
      });

      expect(view.runnable).toBe(true);
      expect(view.params.paths).toBe(".radius");
      expect(view.command).toContain("git add -- .radius");
    });
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
        "Your task ends when the command finishes. Then tell the user: After the login finishes, return to the Radius canvas and click Verify Credentials again. Do not carry out that step yourself; it belongs to the user in the Radius canvas."
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
        "Your task ends when the command finishes. Then tell the user: After the install and login finish, return to the Radius canvas and click Verify Credentials again. Do not carry out that step yourself; it belongs to the user in the Radius canvas."
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

  it("presents a multi-command remediation as an ordered block", () => {
    const message = remediationSessionMessage(
      build("git-push-branch", {
        branch: "feature/login",
        paths: ".radius"
      })
    );

    expect(message.prompt).toContain(
      "Run these commands, in order, in this Copilot session:"
    );
    expect(message.prompt).toContain(
      'git add -- .radius\ngit commit -m "Add Radius application model"\ngit push -u origin feature/login'
    );
    // Without this the agent could reasonably stage the whole worktree, which
    // would publish unrelated work the user never confirmed.
    expect(message.prompt).toContain(
      "Stage only the paths named above; do not stage anything else in the working tree."
    );
    expect(message.prompt).toContain("are not committed");
    expect(message.displayPrompt).toBe(
      "Committing the generated Radius files and pushing feature/login to GitHub."
    );
  });

  it("keeps the staging instruction out of a remediation that stages nothing", () => {
    const message = remediationSessionMessage(
      build("github-account-scopes", { login: "octocat", packages: "true" })
    );

    // A multi-command remediation, but no `git add`, so there are no "paths
    // named above" for the instruction to refer to.
    expect(message.prompt).toContain(
      "Run these commands, in order, in this Copilot session:"
    );
    expect(message.prompt).not.toContain("Stage only the paths");
  });

  it("keeps a single-command remediation inline", () => {
    const message = remediationSessionMessage(
      build("git-push-branch", { branch: "feature/login" })
    );

    expect(message.prompt).toContain(
      "Run `git push -u origin feature/login` in this Copilot session."
    );
    expect(message.prompt).not.toContain("```console");
    expect(message.displayPrompt).toBe("Pushing feature/login to GitHub.");
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

  // The push remediation exists because the canvas could not deploy. Naming
  // deployment anywhere in the agent's prompt read as an instruction, and the
  // agent went and deployed instead of stopping at the push. Retrying the
  // deploy is the user's action in the canvas, which is what the callout says.
  it.each([
    ["with generated paths", { branch: "feature/login", paths: ".radius" }],
    ["with a bare push", { branch: "feature/login" }]
  ])("never asks the agent to deploy after a push %s", (_name, params) => {
    const message = remediationSessionMessage(build("git-push-branch", params));

    expect(message.displayPrompt).not.toMatch(/deploy/i);
    expect(message.prompt).toContain(
      "Your task ends when the command finishes."
    );
    expect(message.prompt).toContain(
      "Do not carry out that step yourself; it belongs to the user in the Radius canvas."
    );
  });

  // followUp is written in the user's second person and names a canvas UI step.
  // Appending it bare left the agent reading "return to the Radius canvas and
  // deploy again" as its own next action.
  it.each(REMEDIATION_IDS)(
    "relays the %s follow-up as the user's step, not the agent's",
    (id) => {
      const remediation = build(id, VALID_PARAMS[id]);
      const message = remediationSessionMessage(remediation);

      expect(message.prompt).toContain(
        `Then tell the user: ${remediation.followUp}`
      );
      expect(message.prompt).not.toMatch(
        new RegExp(`\\n\\n${escapeRegExp(remediation.followUp)}$`)
      );
    }
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
