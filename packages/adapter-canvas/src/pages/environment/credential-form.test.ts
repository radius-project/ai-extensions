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
    const html = credentialFormMarkup();
    expect(unlabelledTextInputIds(html)).toEqual([]);
    expect(unlabelledSelectIds(html)).toEqual([]);
  });

  it("renders a single relocatable card", () => {
    const html = credentialFormMarkup().trim();
    expect(html.startsWith('<div class="rad-card" id="cred-form-card">')).toBe(
      true
    );
    expect(html.endsWith("</div>")).toBe(true);
  });

  it("names the fields the credential client script addresses by id", () => {
    const html = credentialFormMarkup();
    for (const id of [
      "cred-form-title",
      "cred-name-input",
      "cred-provider-select",
      "az-tenant-id",
      "az-sub-id",
      "aws-account-id",
      "aws-region",
      "aws-role-arn"
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("keeps AWS implementation markup while hiding and disabling its provider option", () => {
    const html = credentialFormMarkup();
    expect(html).toContain(
      '<option value="aws" disabled hidden>AWS (coming soon)</option>'
    );
    expect(html).toContain('<div id="cred-panel-azure" class="rad-section">');
    expect(html).toContain(
      '<div id="cred-panel-aws" class="rad-section" style="display:none;">'
    );
    expect(html).toContain('id="btn-verify-azure"');
    expect(html).toContain('id="btn-verify-aws"');
  });

  it("holds the GitHub Packages gate and the verification result", () => {
    const html = credentialFormMarkup();
    expect(html).toContain('id="cred-ghcr-section"');
    expect(html).toContain('id="cred-ghcr-command-row"');
    expect(html).toContain('id="cred-verify-action"');
    expect(html).toContain('id="cred-ghcr-retry"');
    expect(html).toContain('id="cred-verify-status"');
    expect(html).toContain('id="cred-verify-hint"');
  });

  it("keeps saving disabled until the client enables it", () => {
    expect(credentialFormMarkup()).toMatch(/id="save-cred-btn"[^>]*disabled/);
  });

  it("declares every element id exactly once so the node can be relocated", () => {
    const ids = [...credentialFormMarkup().matchAll(/id="([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is markup only, with no interpolation", () => {
    expect(credentialFormMarkup()).not.toContain("${");
  });
});
