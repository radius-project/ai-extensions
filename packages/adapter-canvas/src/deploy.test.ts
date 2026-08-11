import { describe, expect, it } from "vitest";
import {
  explainOidcEnterpriseClaim,
  explainRepoAccessForEnvSetup,
  isRepoNotFoundError,
  extractErrorLines,
  extractGitHubActionsStepLog
} from "./deploy.js";

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
