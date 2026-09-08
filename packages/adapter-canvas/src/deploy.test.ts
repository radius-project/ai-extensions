import { describe, expect, it } from "vitest";
import {
  explainOidcEnterpriseClaim,
  explainNoSubscriptions,
  classifyDeployCloudAuthDrift,
  cloudCredentialsComplete,
  explainRepoAccessForEnvSetup,
  isRepoNotFoundError,
  extractErrorLines,
  extractGitHubActionsStepLog,
  fetchRunLog,
  findWorkflowRun,
  getRunDetail,
  isSelectedGhAuthorizationError,
  selectedCommandAuthorizationError,
  selectWorkflowRunId
} from "./deploy.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "./repository-access-guidance.js";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";

describe("selected-account workflow reads", () => {
  it.each([
    ["gh: Forbidden (HTTP 403)", 403],
    [
      "Resource protected by organization SAML enforcement. You must grant your OAuth token access.",
      403
    ]
  ])(
    "classifies direct selected-account command authorization failure %j",
    async (stderr, status) => {
      const executor = successfulSelectedGhExecutor({ login: "alice" });

      await expect(
        selectedCommandAuthorizationError(executor, "contoso/store", {
          code: 1,
          stdout: "",
          stderr
        })
      ).resolves.toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
    }
  );

  it("does not classify rate limiting as selected-account authorization failure", async () => {
    const executor = successfulSelectedGhExecutor({ login: "alice" });

    await expect(
      selectedCommandAuthorizationError(executor, "contoso/store", {
        code: 1,
        stdout: "",
        stderr: "gh: Too Many Requests (HTTP 429)"
      })
    ).resolves.toBeNull();
  });

  it.each([
    ["run discovery", 401, "gh: Unauthorized (HTTP 401)", "list"],
    ["run detail", 403, "gh: Forbidden (HTTP 403)", "detail"]
  ])(
    "surfaces %s HTTP %i instead of degrading to pending",
    async (_label, status, stderr, operation) => {
      const calls: string[][] = [];
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: async (args) => {
          calls.push(args);
          return { code: 1, stdout: "", stderr };
        }
      });

      const attempt =
        operation === "list" ?
          findWorkflowRun(
            "contoso/store",
            "verify.yml",
            Date.now(),
            null,
            executor
          )
        : getRunDetail("contoso/store", "41", executor);

      const error = await attempt.catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
      expect(isSelectedGhAuthorizationError(error)).toBe(true);
      expect(calls).toHaveLength(1);
    }
  );

  it("keeps transient selected-account run discovery pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
  });

  it.each([
    ["retry-after", "gh: Forbidden (HTTP 403)\nRetry-After: 60"],
    [
      "exhausted primary limit",
      "gh: API rate limit exceeded (HTTP 403)\nX-RateLimit-Remaining: 0"
    ],
    [
      "secondary limit",
      "gh: You have exceeded a secondary rate limit (HTTP 403)"
    ],
    [
      "reset guidance",
      "gh: rate limit reached (HTTP 403); retry when the limit resets"
    ],
    ["too many requests", "gh: Too Many Requests (HTTP 429)"]
  ])("keeps selected-account %s responses pollable", async (_label, stderr) => {
    let calls = 0;
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr };
      }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("terminalizes a masked private-repository 404 after the selected account loses repository access", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)"
        };
      }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 404
    });
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
    expect(calls[1]).toEqual([
      "api",
      "repos/contoso/store",
      "--jq",
      ".full_name"
    ]);
  });

  it("keeps a not-yet-visible run detail pending when the selected account still reads the repository", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return args[0] === "api" ?
            { code: 0, stdout: "contoso/store", stderr: "" }
          : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
    });

    await expect(
      getRunDetail("contoso/store", "41", executor)
    ).resolves.toBeNull();
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
  });

  it("keeps a masked run 404 pending when its repository probe is rate-limited", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) =>
        args[0] === "api" ?
          {
            code: 1,
            stdout: "",
            stderr:
              "gh: You have exceeded a secondary rate limit (HTTP 403)\nRetry-After: 60"
          }
        : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
  });

  it.each([
    ["run discovery", 401, "list"],
    ["run detail", 403, "detail"]
  ])(
    "surfaces rejected selected-account %s identity check HTTP %i",
    async (_label, status, operation) => {
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: () =>
          Promise.reject(
            new Error(
              `GitHub identity verification failed for @alice: gh: access rejected (HTTP ${status})`
            )
          )
      });

      const attempt =
        operation === "list" ?
          findWorkflowRun(
            "contoso/store",
            "verify.yml",
            Date.now(),
            null,
            executor
          )
        : getRunDetail("contoso/store", "41", executor);
      const error = await attempt.catch((reason: unknown) => reason);

      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
    }
  );

  it("leaves a rejected transient selected-account identity check pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: () =>
        Promise.reject(
          new Error(
            "GitHub identity verification failed for @alice: gh: Service Unavailable (HTTP 503)"
          )
        )
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).rejects.toThrow("HTTP 503");
  });

  it("keeps transient selected-account run detail pollable after its fallback", async () => {
    let calls = 0;
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => {
        calls += 1;
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Service Unavailable (HTTP 503)"
        };
      }
    });

    await expect(
      getRunDetail("contoso/store", "41", executor)
    ).resolves.toBeNull();
    expect(calls).toBe(2);
  });

  it("surfaces selected-account authorization failure while reading a failed run log", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Unauthorized (HTTP 401)"
      })
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 401
    });
  });

  it("does not read workflow log stdout as a GitHub authorization failure", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "curl failed against a service endpoint (HTTP 403)",
        stderr: "gh: could not retrieve the workflow log"
      })
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).resolves.toBeNull();
  });

  it("keeps transient selected-account run log failure pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).resolves.toBeNull();
  });

  it("terminalizes a selected-account log 404 when the repository probe also loses access", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)"
        };
      }
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 404
    });
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
  });

  it("keeps a missing selected-account log ordinary when the repository probe succeeds", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return args[0] === "api" ?
            { code: 0, stdout: "contoso/store", stderr: "" }
          : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      }
    });

    await expect(
      fetchRunLog("contoso/store", "41", executor)
    ).resolves.toBeNull();
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
  });

  it.each([
    ["returns the selected-account run log", "workflow log", "workflow log"],
    ["treats an empty selected-account run log as unavailable", "", null]
  ])("%s", async (_label, stdout, expected) => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({ code: 0, stdout, stderr: "" })
    });

    await expect(fetchRunLog("contoso/store", "41", executor)).resolves.toBe(
      expected
    );
  });
});

// The exact rejection surfaced by GitHub Actions' "Azure Login (OIDC)" step when
// a personal-account repo hits a tenant that enforces the enterprise claim.
const MS_ERROR =
  "AADSTS7002381: Federated identity credentials issued by " +
  "'https://token.actions.githubusercontent.com/' for applications or managed " +
  "identities registered in this tenant must contain the enterprise claim with " +
  "value 'microsoft', 'github' or 'microsoftopensource' but actual value is ''.";

describe("explainOidcEnterpriseClaim", () => {
  it("explains the Microsoft-tenant rejection, parsing accepted + empty actual value", () => {
    const out = explainOidcEnterpriseClaim(MS_ERROR);
    expect(out).not.toBe("");
    // All three accepted values are surfaced dynamically (parsed, not hardcoded).
    expect(out).toContain("microsoft");
    expect(out).toContain("github");
    expect(out).toContain("microsoftopensource");
    // Frames it as the missing "enterprise" claim.
    expect(out.toLowerCase()).toContain("enterprise");
    expect(out).toContain("missing");
    // Explains the personal-account root cause and the empty actual value.
    expect(out.toLowerCase()).toContain("personal");
    expect(out).toContain("empty");
  });

  describe("extractGitHubActionsStepLog", () => {
    it("isolates the actual Azure Login step from advisory text that mentions AADSTS7002381", () => {
      const log = [
        "verify\tAzure Login (OIDC)\t2026-08-07T04:04:47Z ##[error]No subscriptions found.",
        'verify\tReport possible GitHub enterprise-claim mismatch\t2026-08-07T04:04:48Z echo "Check for AADSTS7002381"',
        'verify\tReport possible GitHub enterprise-claim mismatch\t2026-08-07T04:04:48Z echo "must contain the enterprise claim"'
      ].join("\n");
      const azureLogin = extractGitHubActionsStepLog(log, "Azure Login (OIDC)");
      expect(azureLogin).toContain("No subscriptions found");
      expect(azureLogin).not.toContain("AADSTS7002381");
      expect(explainOidcEnterpriseClaim(azureLogin)).toBe("");
    });

    it("returns an empty string when structured step prefixes are unavailable", () => {
      expect(
        extractGitHubActionsStepLog(
          "AADSTS7002381 was mentioned outside a structured step log",
          "Azure Login (OIDC)"
        )
      ).toBe("");
    });

    it("isolates Azure Login when gh labels every log row UNKNOWN STEP", () => {
      const log = [
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:46Z ##[group]Run azure/login@abc123",
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:47Z Running Azure CLI Login.",
        `verify\tUNKNOWN STEP\t2026-08-07T04:04:48Z ##[error]${MS_ERROR}`,
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:49Z ##[endgroup]",
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:50Z Logout succeeded.",
        'verify\tUNKNOWN STEP\t2026-08-07T04:04:51Z ##[group]Run echo "Check for AADSTS7002381"',
        "verify\tUNKNOWN STEP\t2026-08-07T04:04:52Z must contain the enterprise claim"
      ].join("\n");

      const azureLogin = extractGitHubActionsStepLog(log, "Azure Login (OIDC)");
      expect(azureLogin).toContain("AADSTS7002381");
      expect(azureLogin).toContain("Logout succeeded");
      expect(azureLogin).not.toContain('Run echo "Check for AADSTS7002381"');
      expect(explainOidcEnterpriseClaim(azureLogin)).toContain(
        "GitHub Enterprise"
      );
    });
  });

  it("is tenant-agnostic: surfaces a non-Microsoft tenant's accepted + actual values", () => {
    const log =
      "AADSTS7002381: ... must contain the enterprise claim with value " +
      "'contoso' or 'fabrikam' but actual value is 'personal-acct'.";
    const out = explainOidcEnterpriseClaim(log);
    expect(out).not.toBe("");
    expect(out).toContain("contoso");
    expect(out).toContain("fabrikam");
    expect(out).toContain("personal-acct");
    // Proves nothing is hardcoded to Microsoft's values.
    expect(out).not.toContain("microsoft");
  });

  it("distinguishes a present-but-untrusted claim value (not 'missing')", () => {
    const log =
      "AADSTS7002381: ... must contain the enterprise claim with value " +
      "'microsoft' or 'github' but actual value is 'fabrikam'.";
    const out = explainOidcEnterpriseClaim(log);
    expect(out).not.toBe("");
    // The claim IS present, just not trusted — must not say it's "missing".
    expect(out).toContain("not trusted");
    expect(out).toContain("fabrikam");
    expect(out).not.toContain("missing");
  });

  it("returns '' for an unrelated error", () => {
    expect(explainOidcEnterpriseClaim("some unrelated error: forbidden")).toBe(
      ""
    );
  });

  it("falls back to a generic accepted label and 'not reported' when only the AADSTS code is present", () => {
    const log =
      "Login failed: AADSTS7002381 was returned by the token endpoint.";
    const out = explainOidcEnterpriseClaim(log);
    expect(out).not.toBe("");
    expect(out).toContain("a value required by the target Azure tenant");
    // Actual value was not parseable — don't assert a definite empty/personal value.
    expect(out).toContain("not reported");
    expect(out).not.toContain("missing");
    expect(out).not.toContain("empty (this repository");
  });

  it("returns '' for empty / undefined input", () => {
    expect(explainOidcEnterpriseClaim("")).toBe("");
    expect(explainOidcEnterpriseClaim(undefined)).toBe("");
    expect(explainOidcEnterpriseClaim(null)).toBe("");
  });
});

describe("explainNoSubscriptions", () => {
  // The exact failure azure/login prints when the identity has no visible
  // subscription (issue #219).
  const NO_SUBS_LOG =
    "Running Azure CLI Login.\n" +
    "Error: No subscriptions found for ***.\n" +
    "Error: Login failed with Error: The process '/usr/bin/az' failed with exit code 1.";

  it("explains the no-subscriptions Azure Login failure and points at a role assignment", () => {
    const out = explainNoSubscriptions(NO_SUBS_LOG);
    expect(out).not.toBe("");
    expect(out.toLowerCase()).toContain("no subscriptions");
    // Actionable: name the role and the subscription scope.
    expect(out).toContain("Contributor");
    expect(out.toLowerCase()).toContain("role");
    expect(out.toLowerCase()).toContain("subscription");
  });

  it("returns '' for an unrelated error", () => {
    expect(explainNoSubscriptions("some unrelated error: forbidden")).toBe("");
  });

  it("returns '' for empty / undefined / null input", () => {
    expect(explainNoSubscriptions("")).toBe("");
    expect(explainNoSubscriptions(undefined)).toBe("");
    expect(explainNoSubscriptions(null)).toBe("");
  });
});

describe("cloudCredentialsComplete", () => {
  // Regression for #219: the create-environment handler must NOT dispatch the
  // verify-credentials workflow when the identifying cloud credentials are
  // absent, because the run would only fail at the cloud-login step.
  it("requires clientId, tenantId, and subscriptionId for Azure", () => {
    expect(
      cloudCredentialsComplete("azure", {
        clientId: "c",
        tenantId: "t",
        subscriptionId: "s"
      })
    ).toBe(true);
    expect(
      cloudCredentialsComplete("azure", { clientId: "c", tenantId: "t" })
    ).toBe(false);
    expect(
      cloudCredentialsComplete("azure", {
        clientId: "c",
        tenantId: "t",
        subscriptionId: ""
      })
    ).toBe(false);
    expect(cloudCredentialsComplete("azure", {})).toBe(false);
  });

  it("ignores a role ARN when the provider is Azure", () => {
    expect(
      cloudCredentialsComplete("azure", { roleArn: "arn:aws:iam::x" })
    ).toBe(false);
  });

  it("requires the role ARN for AWS (and ignores Azure fields)", () => {
    expect(
      cloudCredentialsComplete("aws", { roleArn: "arn:aws:iam::123:role/r" })
    ).toBe(true);
    expect(cloudCredentialsComplete("aws", { roleArn: "" })).toBe(false);
    expect(cloudCredentialsComplete("aws", {})).toBe(false);
    expect(
      cloudCredentialsComplete("aws", {
        clientId: "c",
        tenantId: "t",
        subscriptionId: "s"
      })
    ).toBe(false);
  });
});

describe("classifyDeployCloudAuthDrift", () => {
  // Exception 5.2: a redeploy whose cloud login/credentials step fails before
  // `rad deploy` touches a resource is credential drift, not a resource failure.
  it("classifies an Azure login-step failure before any resource was touched", () => {
    const out = classifyDeployCloudAuthDrift({
      provider: "azure",
      resourcesTouched: false,
      failedStepNames: ["Azure Login (OIDC)"]
    });
    expect(out).toContain("Cloud authentication or authorization failed");
    expect(out).toContain("Azure");
    expect(out).toContain("federated credential or role assignment");
    expect(out).toContain("Re-verify the environment's credentials");
    // Prior verification is unknown here, so the message must not assert it.
    expect(out).toContain("If this environment authenticated before");
    expect(out).not.toContain("verified earlier");
  });

  it("classifies an AWS configure-credentials / assume-role failure", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "aws",
        resourcesTouched: false,
        failedStepNames: ["Configure AWS Credentials"]
      })
    ).toContain("AWS");
    const assume = classifyDeployCloudAuthDrift({
      provider: "aws",
      resourcesTouched: false,
      failedStepNames: ["Assume role"]
    });
    expect(assume).toContain("IAM role's trust policy or permissions");
  });

  it("uses a provider-agnostic label for an unknown provider", () => {
    // An unknown provider cannot be tied to a provider-specific login step, so
    // its failure is no longer force-classified as drift.
    const out = classifyDeployCloudAuthDrift({
      provider: "gcp",
      resourcesTouched: false,
      failedStepNames: ["OIDC login"]
    });
    expect(out).toBe("");
  });

  it("returns '' once a resource was touched (that is a 5.1 resource failure)", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: true,
        failedStepNames: ["Azure Login (OIDC)"]
      })
    ).toBe("");
  });

  it("returns '' when no failed step looks like a cloud auth step", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "aws",
        resourcesTouched: false,
        failedStepNames: ["Run rad commands", undefined]
      })
    ).toBe("");
  });

  it("returns '' when there are no failed steps at all", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: []
      })
    ).toBe("");
  });

  it("returns '' when a mutation step failed even though login is also listed", () => {
    // A failed mutation step (e.g. registering credentials with Radius) means
    // state was already being changed, so this is not clean pre-mutation drift.
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: [
          "Azure Login (OIDC)",
          "Register cloud credentials with Radius"
        ]
      })
    ).toBe("");
  });

  it("does not misread a mutation step that mentions credentials as a login failure", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: ["Refresh external deployment target credentials"]
      })
    ).toBe("");
  });

  it("returns '' when the environment never verified (bypassed), even at the login step", () => {
    expect(
      classifyDeployCloudAuthDrift({
        provider: "azure",
        resourcesTouched: false,
        failedStepNames: ["Azure Login (OIDC)"],
        environmentPreviouslyVerified: false
      })
    ).toBe("");
  });

  it("classifies drift when the environment previously verified and login failed", () => {
    const out = classifyDeployCloudAuthDrift({
      provider: "aws",
      resourcesTouched: false,
      failedStepNames: ["Configure AWS Credentials (OIDC)"],
      environmentPreviouslyVerified: true
    });
    expect(out).toContain("Cloud authentication or authorization failed");
    // Prior success is proven, so the message may assert it.
    expect(out).toContain("This environment verified earlier");
  });
});

describe("extractErrorLines", () => {
  it("returns trailing error-ish lines only", () => {
    const log = [
      "starting up",
      "everything is fine",
      "Error: something exploded",
      "cleanup done",
      "fatal: giving up"
    ].join("\n");
    const out = extractErrorLines(log, 8);
    expect(out).toContain("Error: something exploded");
    expect(out).toContain("fatal: giving up");
    expect(out).not.toContain("everything is fine");
  });

  it("returns [] for empty input", () => {
    expect(extractErrorLines("")).toEqual([]);
    expect(extractErrorLines(undefined)).toEqual([]);
  });
});
describe("explainRepoAccessForEnvSetup", () => {
  it("read failure with a known login → switch-account guidance", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: true,
      permissions: null
    });
    expect(out).not.toBe("");
    expect(out).toContain("ryanwaite");
    expect(out).toContain("azure-cto/app");
    expect(out).toContain("gh auth switch");
    expect(out).toContain(FORK_REPOSITORY_SETUP_GUIDANCE);
  });

  it("uses the bundled GitHub CLI path in switch-account guidance", () => {
    const out = explainRepoAccessForEnvSetup(
      {
        repo: "azure-cto/app",
        login: "ryanwaite",
        readFailed: true,
        permissions: null
      },
      {
        kind: "absolute",
        shell: "powershell",
        executablePath: "C:\\Copilot Tools\\gh.exe",
        installationNote: "Install GitHub CLI system-wide."
      }
    );

    expect(out).toContain(
      "& 'C:\\Copilot Tools\\gh.exe' auth switch --user <account>"
    );
    expect(out).toContain("Install GitHub CLI system-wide.");
  });

  it("read failure with unknown login → 'the active gh account'", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "",
      readFailed: true,
      permissions: null
    });
    expect(out).toContain("the active gh account");
  });

  it("admin access → '' (no error)", () => {
    expect(
      explainRepoAccessForEnvSetup({
        repo: "azure-cto/app",
        login: "ryanwaite",
        readFailed: false,
        permissions: { admin: true }
      })
    ).toBe("");
  });

  it("maintain-only → Admin-needed message naming the Maintain role, no switch guidance", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite_microsoft",
      readFailed: false,
      permissions: { admin: false, maintain: true, push: true }
    });
    expect(out).toContain("Admin");
    expect(out).toContain("Maintain");
    expect(out).toContain("grant");
    expect(out).not.toContain("gh auth switch");
    expect(out).toContain(FORK_REPOSITORY_SETUP_GUIDANCE);
  });

  it("push-only → role label Write", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: false,
      permissions: { admin: false, maintain: false, push: true }
    });
    expect(out).toContain("Write");
  });

  it("pull-only → role label Read", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: false,
      permissions: { admin: false, pull: true }
    });
    expect(out).toContain("Read");
  });

  it("null permissions with read OK (odd edge) → non-empty, role undetermined, no throw", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "ryanwaite",
      readFailed: false,
      permissions: null
    });
    expect(out).not.toBe("");
    expect(out).not.toContain("no direct");
    expect(out).toContain("does not have Admin");
    expect(out).toContain("could not be determined");
  });

  it("admin missing with empty login → addresses 'you'", () => {
    const out = explainRepoAccessForEnvSetup({
      repo: "azure-cto/app",
      login: "",
      readFailed: false,
      permissions: { admin: false, pull: true }
    });
    expect(out).toContain("you");
  });
});

describe("isRepoNotFoundError", () => {
  it("is true for gh's Not Found (HTTP 404) text", () => {
    expect(isRepoNotFoundError("gh: Not Found (HTTP 404)")).toBe(true);
  });
  it("is true for a bare HTTP 404", () => {
    expect(isRepoNotFoundError("request failed: HTTP 404")).toBe(true);
  });
  it("is true for a lowercase 'not found' phrase", () => {
    expect(isRepoNotFoundError("the repository was not found")).toBe(true);
  });
  it("is false for HTTP 403", () => {
    expect(isRepoNotFoundError("gh: Forbidden (HTTP 403)")).toBe(false);
  });
  it("is false for a timeout / transient error", () => {
    expect(isRepoNotFoundError("dial tcp: i/o timeout")).toBe(false);
  });
  it("is false for empty / undefined / null", () => {
    expect(isRepoNotFoundError("")).toBe(false);
    expect(isRepoNotFoundError(undefined)).toBe(false);
    expect(isRepoNotFoundError(null)).toBe(false);
  });
});

describe("selectWorkflowRunId", () => {
  const at = (iso: string) => Date.parse(iso);
  const since = at("2026-08-20T10:00:00Z");

  it("returns null for a non-array payload", () => {
    expect(selectWorkflowRunId(null, since)).toBeNull();
    expect(selectWorkflowRunId({}, since)).toBeNull();
  });

  it("picks the newest run created within the skew window", () => {
    const runs = [
      { databaseId: 3, createdAt: "2026-08-20T10:00:05Z" },
      { databaseId: 2, createdAt: "2026-08-20T09:59:59Z" }
    ];
    expect(selectWorkflowRunId(runs, since)).toBe(3);
  });

  it("ignores stale runs created before the ~60s cutoff", () => {
    const runs = [{ databaseId: 9, createdAt: "2026-08-20T09:58:00Z" }];
    expect(selectWorkflowRunId(runs, since)).toBeNull();
  });

  it("tolerates ~60s of clock skew before dispatch", () => {
    const runs = [{ databaseId: 7, createdAt: "2026-08-20T09:59:10Z" }];
    expect(selectWorkflowRunId(runs, since)).toBe(7);
  });

  it("matches only the run whose display title carries the correlation id", () => {
    const runs = [
      {
        databaseId: 5,
        createdAt: "2026-08-20T10:00:06Z",
        displayTitle: "Radius - Delete Environment prod other-id"
      },
      {
        databaseId: 4,
        createdAt: "2026-08-20T10:00:04Z",
        displayTitle: "Radius - Delete Environment prod del-abc-123"
      }
    ];
    expect(selectWorkflowRunId(runs, since, "del-abc-123")).toBe(4);
  });

  it("returns null when no run carries the requested correlation id", () => {
    const runs = [
      {
        databaseId: 5,
        createdAt: "2026-08-20T10:00:06Z",
        displayTitle: "Radius - Delete Environment prod other-id"
      }
    ];
    expect(selectWorkflowRunId(runs, since, "del-missing")).toBeNull();
  });

  it("skips entries missing a databaseId", () => {
    const runs = [
      { createdAt: "2026-08-20T10:00:06Z" },
      { databaseId: 8, createdAt: "2026-08-20T10:00:05Z" }
    ];
    expect(selectWorkflowRunId(runs, since)).toBe(8);
  });
});
