import { describe, expect, it } from "vitest";
import { remediationReference } from "./remediation-reference.js";

describe("remediationReference", () => {
  it("retains a non-empty id and string parameters", () => {
    expect(
      remediationReference({
        id: "github-account-scopes",
        params: { login: "octocat", packages: "true", ignored: 7 }
      })
    ).toEqual({
      id: "github-account-scopes",
      params: { login: "octocat", packages: "true" }
    });
  });

  it.each([
    null,
    "github-account-scopes",
    [],
    {},
    { id: "", params: {} },
    { id: 7, params: {} }
  ])("rejects an invalid remediation reference %#", (value) => {
    expect(remediationReference(value)).toBeNull();
  });

  it.each([undefined, null, 7, "login", ["octocat"]])(
    "normalizes invalid params to an empty record when params=%j",
    (params) => {
      expect(
        remediationReference({ id: "github-account-scopes", params })
      ).toEqual({
        id: "github-account-scopes",
        params: {}
      });
    }
  );
});
