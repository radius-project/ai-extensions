import { describe, expect, it, vi } from "vitest";
import {
  LIST_AWS_ROLES_ENDPOINT,
  awsRoleHelpText,
  initializeAwsDeployIdentity,
  parseAwsRoleCandidates,
  reposTrustedBy
} from "./aws-deploy-identity.js";
import { beginEntry } from "../lifecycle.js";
import type { AppPickerChoice, AppPickerOptions } from "./discovery.js";
import type { HttpResponse } from "../ports.js";
import {
  createFakeBrowser,
  createFakeElement,
  createFakeInput
} from "../../../test/support/browser/fakes.js";

const ROLE_ARN = "arn:aws:iam::123456789012:role/platform-deploy";

function json(body: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body
  };
}

function page(
  prompt: (
    options: AppPickerOptions
  ) => Promise<AppPickerChoice> = async () => ({
    appId: ROLE_ARN
  })
) {
  const browser = createFakeBrowser();
  const name = createFakeInput(
    "aws-role-name-input",
    "radius-deploy-octo-shop"
  );
  name.setAttribute("data-default-name", "radius-deploy-octo-shop");
  const arn = createFakeInput("aws-selected-role-arn", "");
  const help = createFakeElement("aws-role-help");
  const note = createFakeElement("aws-selected-role-note");
  const clear = createFakeElement("aws-clear-role-link");
  const use = createFakeElement("aws-use-existing-role-link");
  for (const element of [name, arn, help, note, clear, use]) {
    browser.document.add(element);
  }
  const scope = beginEntry(browser.context, "aws-identity-test");
  if (!scope) throw new Error("Expected an entry scope.");
  let environment = "dev";
  const promptRoleSelection = vi.fn(prompt);
  const handle = initializeAwsDeployIdentity(browser.context, scope, {
    repo: "octo/shop",
    defaultRoleName: "radius-deploy-octo-shop",
    environmentName: () => environment,
    promptRoleSelection
  });
  return {
    browser,
    handle,
    name,
    arn,
    help,
    note,
    clear,
    use,
    promptRoleSelection,
    setEnvironment(value: string) {
      environment = value;
    }
  };
}

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

describe("AWS deploy identity helpers", () => {
  it("states the trust, region, and cluster access in the help text", () => {
    expect(awsRoleHelpText("octo/shop", "dev", "us-west-2")).toBe(
      "Created in your AWS account, trusted over OIDC by repo:octo/shop for the dev environment, and granted PowerUserAccess limited to resources in us-west-2. Setup also grants the role cluster-admin access on the target EKS cluster."
    );
    expect(awsRoleHelpText("octo/shop", "", "")).toContain(
      "for the this environment"
    );
  });

  it("lists the repositories a role already trusts", () => {
    expect(
      reposTrustedBy([
        "repo:b/two:environment:dev",
        "repo:a/one:environment:dev",
        "repo:a/one:environment:prod",
        "not-a-subject"
      ])
    ).toEqual(["a/one", "b/two"]);
  });

  it("parses role candidates and skips ones without an ARN", () => {
    expect(
      parseAwsRoleCandidates({
        roles: [
          { arn: ROLE_ARN, trustedSubjects: ["repo:a/b:environment:x"] },
          { name: "no arn" }
        ]
      })
    ).toEqual([
      {
        arn: ROLE_ARN,
        name: ROLE_ARN,
        trustedSubjects: ["repo:a/b:environment:x"]
      }
    ]);
  });
});

describe("initializeAwsDeployIdentity", () => {
  it("proposes the default role name and updates help for the profile and environment", () => {
    const view = page();
    view.handle.setProfile({ accountId: "123456789012", region: "us-west-2" });
    expect(view.help.textContent).toContain("for the dev environment");
    expect(view.help.textContent).toContain("in us-west-2");
    view.setEnvironment("prod");
    view.handle.refreshHelp();
    expect(view.help.textContent).toContain("for the prod environment");
    expect(view.handle.request()).toEqual({
      roleName: "radius-deploy-octo-shop",
      existingRoleArn: ""
    });
  });

  it("pins a picked role, disables the name, and can return to a per-repo role", async () => {
    const view = page();
    view.handle.setProfile({ accountId: "123456789012", region: "us-west-2" });
    view.browser.net.handle(
      `${LIST_AWS_ROLES_ENDPOINT}?accountId=123456789012`,
      () =>
        json({
          roles: [
            {
              arn: ROLE_ARN,
              name: "platform-deploy",
              trustedSubjects: ["repo:octo/api:environment:dev"]
            }
          ]
        })
    );
    view.use.dispatch("click");
    await flush();
    expect(view.promptRoleSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Use an existing role",
        lazyServes: false,
        allowCreateNew: false,
        candidates: [
          {
            appId: ROLE_ARN,
            displayName: "platform-deploy",
            servesRepos: ["octo/api"]
          }
        ]
      })
    );
    expect(view.name.value).toBe("platform-deploy");
    expect(view.name.disabled).toBe(true);
    expect(view.note.textContent).toBe(
      `Will use: platform-deploy (${ROLE_ARN}).`
    );
    expect(view.handle.request()).toEqual({
      roleName: "",
      existingRoleArn: ROLE_ARN
    });
    view.clear.dispatch("click");
    expect(view.name.disabled).toBe(false);
    expect(view.handle.request()).toEqual({
      roleName: "radius-deploy-octo-shop",
      existingRoleArn: ""
    });
  });

  it("unpins a role when the profile moves to another account", async () => {
    const view = page();
    view.handle.setProfile({ accountId: "123456789012", region: "us-west-2" });
    view.arn.value = ROLE_ARN;
    view.handle.setProfile({ accountId: "999988887777", region: "us-west-2" });
    expect(view.handle.request().existingRoleArn).toBe("");
    view.handle.setProfile(null);
    expect(view.help.textContent).toContain("the profile's region");
  });

  it.each([
    [
      "a server error",
      () => json({ error: "Failed to list IAM roles: denied" }),
      "Failed to list IAM roles: denied"
    ],
    [
      "no roles",
      () => json({ roles: [] }),
      "The signed-in identity cannot see any IAM roles."
    ],
    [
      "a network failure",
      () => {
        throw "offline";
      },
      "Could not list IAM roles: offline"
    ],
    [
      "a thrown error",
      () => {
        throw new Error("offline");
      },
      "Could not list IAM roles: offline"
    ]
  ])("reports %s next to the field", async (_label, handler, message) => {
    const view = page();
    view.browser.net.handle(`${LIST_AWS_ROLES_ENDPOINT}?accountId=`, handler);
    view.use.dispatch("click");
    await flush();
    expect(view.note.textContent).toBe(message);
    expect(view.use.textContent).toBe("use an existing role…");
    expect(view.promptRoleSelection).not.toHaveBeenCalled();
  });

  it("works with only its two inputs", () => {
    const browser = createFakeBrowser();
    browser.document.add(createFakeInput("aws-role-name-input", "r"));
    browser.document.add(createFakeInput("aws-selected-role-arn", ""));
    const scope = beginEntry(browser.context, "aws-identity-inputs");
    if (!scope) throw new Error("Expected an entry scope.");
    const handle = initializeAwsDeployIdentity(browser.context, scope, {
      repo: "octo/shop",
      defaultRoleName: "radius-deploy-octo-shop",
      environmentName: () => "dev",
      promptRoleSelection: async () => ({ createNew: true })
    });
    handle.setProfile({ accountId: "123456789012" });
    expect(handle.request()).toEqual({
      roleName: "radius-deploy-octo-shop",
      existingRoleArn: ""
    });
  });

  it("is inert when the name input exists without its ARN input", () => {
    const browser = createFakeBrowser();
    browser.document.add(createFakeInput("aws-role-name-input", "r"));
    const scope = beginEntry(browser.context, "aws-identity-half");
    if (!scope) throw new Error("Expected an entry scope.");
    const handle = initializeAwsDeployIdentity(browser.context, scope, {
      repo: "octo/shop",
      defaultRoleName: "radius-deploy-octo-shop",
      environmentName: () => "dev",
      promptRoleSelection: async () => ({ createNew: true })
    });
    expect(handle.request()).toEqual({ roleName: "", existingRoleArn: "" });
  });

  it("works without its optional page elements", () => {
    const browser = createFakeBrowser();
    const scope = beginEntry(browser.context, "aws-identity-bare");
    if (!scope) throw new Error("Expected an entry scope.");
    const handle = initializeAwsDeployIdentity(browser.context, scope, {
      repo: "octo/shop",
      defaultRoleName: "radius-deploy-octo-shop",
      environmentName: () => "dev",
      promptRoleSelection: async () => ({ createNew: true })
    });
    handle.setProfile({ accountId: "123456789012" });
    handle.refreshHelp();
    expect(handle.request()).toEqual({ roleName: "", existingRoleArn: "" });
  });

  it("uses the ARN as the name when the picker returns a role it did not list", async () => {
    const view = page(async () => ({
      appId: "arn:aws:iam::123456789012:role/x"
    }));
    view.browser.net.handle(`${LIST_AWS_ROLES_ENDPOINT}?accountId=`, () =>
      json({ roles: [{ arn: ROLE_ARN }] })
    );
    view.use.dispatch("click");
    await flush();
    expect(view.name.value).toBe("arn:aws:iam::123456789012:role/x");
  });

  it("ignores a picker answer that is not a role", async () => {
    const view = page(async () => ({ createNew: true }));
    view.browser.net.handle(`${LIST_AWS_ROLES_ENDPOINT}?accountId=`, () =>
      json({ roles: [{ arn: ROLE_ARN }] })
    );
    view.use.dispatch("click");
    await flush();
    expect(view.handle.request().existingRoleArn).toBe("");
  });

  it("leaves the field alone when the picker is cancelled", async () => {
    const view = page(async () => {
      throw new Error("cancelled");
    });
    view.browser.net.handle(`${LIST_AWS_ROLES_ENDPOINT}?accountId=`, () =>
      json({ roles: [{ arn: ROLE_ARN }] })
    );
    view.use.dispatch("click");
    await flush();
    expect(view.handle.request().existingRoleArn).toBe("");
    expect(view.name.disabled).toBe(false);
  });
});
