import { describe, expect, it } from "vitest";
import { explainOidcEnterpriseClaim, extractErrorLines } from "./deploy.mjs";

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
        // Explains the personal-account root cause and the empty actual value.
        expect(out.toLowerCase()).toContain("personal");
        expect(out).toContain("empty");
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

    it("returns '' for an unrelated error", () => {
        expect(explainOidcEnterpriseClaim("some unrelated error: forbidden")).toBe("");
    });

    it("falls back to a generic accepted label when only the AADSTS code is present", () => {
        const log = "Login failed: AADSTS7002381 was returned by the token endpoint.";
        const out = explainOidcEnterpriseClaim(log);
        expect(out).not.toBe("");
        expect(out).toContain("a value required by the target Azure tenant");
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
            "fatal: giving up",
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
