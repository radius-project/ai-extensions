import { describe, it, expect } from "vitest";
import {
  unlabelledSelectIds,
  unlabelledTextInputIds
} from "../../../test/support/pages/labelled-controls.js";
import { credentialFormMarkup } from "./credential-form.js";

describe("credentialFormMarkup", () => {
  // Extracting this form out of the credentials pane dropped every
  // <label for=...>, which left the whole credential form unnamed to assistive
  // technology. Assert the empty set so the next relocation cannot repeat it.
  it("gives every control in the credential form a programmatic name", () => {
    const html = credentialFormMarkup(false);
    expect(unlabelledTextInputIds(html)).toEqual([]);
    expect(unlabelledSelectIds(html)).toEqual([]);
  });

  it("renders a single relocatable card", () => {
    const html = credentialFormMarkup(false).trim();
    expect(html.startsWith('<div class="rad-card" id="cred-form-card">')).toBe(
      true
    );
    expect(html.endsWith("</div>")).toBe(true);
  });

  it("names the fields the credential client script addresses by id", () => {
    const html = credentialFormMarkup(false);
    for (const id of [
      "cred-form-title",
      "cred-name-input",
      "cred-provider-select",
      "az-tenant-id",
      "az-sub-id",
      "aws-account-id",
      "aws-region"
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("leaves the deploy role out of the AWS profile", () => {
    const html = credentialFormMarkup(false);
    expect(html).not.toContain('id="aws-role-arn"');
    expect(html).not.toContain("Role ARN");
    expect(html).toContain(
      "The profile carries no deploy identity; that is set up when you create an environment."
    );
  });

  it("keeps AWS coming soon while the AWS switch is off", () => {
    const html = credentialFormMarkup(false);
    expect(html).toContain(
      '<option value="aws" disabled>AWS (coming soon)</option>'
    );
    expect(html).not.toContain('<option value="aws">AWS</option>');
  });

  it("offers AWS as an enabled provider alongside Azure with the AWS switch on", () => {
    const html = credentialFormMarkup(true);
    expect(html).toContain('<option value="aws">AWS</option>');
    expect(html).not.toContain("coming soon");
    expect(html).toContain('<div id="cred-panel-azure" class="rad-section">');
    expect(html).toContain(
      '<div id="cred-panel-aws" class="rad-section" style="display:none;">'
    );
    expect(html).toContain('id="btn-verify-azure"');
    expect(html).toContain('id="btn-verify-aws"');
  });

  it("holds the GitHub Packages gate and the verification result", () => {
    const html = credentialFormMarkup(false);
    expect(html).toContain('id="cred-ghcr-section"');
    expect(html).toContain('id="cred-ghcr-command-row"');
    expect(html).toContain('id="cred-verify-action"');
    expect(html).toContain('id="cred-ghcr-retry"');
    expect(html).toContain('id="cred-verify-status"');
    expect(html).toContain('id="cred-verify-hint"');
  });

  it("keeps saving disabled until the client enables it", () => {
    expect(credentialFormMarkup(false)).toMatch(
      /id="save-cred-btn"[^>]*disabled/
    );
  });

  it("declares every element id exactly once so the node can be relocated", () => {
    const ids = [...credentialFormMarkup(false).matchAll(/id="([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is markup only, with no interpolation", () => {
    expect(credentialFormMarkup(false)).not.toContain("${");
  });
});
