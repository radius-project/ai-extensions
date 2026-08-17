import { describe, it, expect } from "vitest";
import { credentialsPaneMarkup } from "./credentials-pane.js";

describe("credentialsPaneMarkup", () => {
  it("renders one visible section when the credentials sub-tab is active", () => {
    const html = credentialsPaneMarkup("credentials");
    expect(html).toContain('<section id="pane-credentials" style="">');
    expect(html.trimEnd().endsWith("</section>")).toBe(true);
  });

  it("hides the section for every other sub-tab", () => {
    for (const subtab of ["environments", "", "nonsense"]) {
      expect(credentialsPaneMarkup(subtab)).toContain(
        '<section id="pane-credentials" style="display:none;">'
      );
    }
  });

  it("shows the profile listing and its creation entry point", () => {
    const html = credentialsPaneMarkup("credentials");
    expect(html).toContain('id="cred-landing"');
    expect(html).toContain('id="cred-table-body"');
    expect(html).toContain('id="new-cred-btn"');
    expect(html).toContain('id="cred-success-banner"');
  });

  it("offers both provider forms with the save action disabled until verified", () => {
    const html = credentialsPaneMarkup("credentials");
    expect(html).toContain('id="cred-panel-azure"');
    expect(html).toContain('id="cred-panel-aws"');
    expect(html).toContain('id="btn-verify-azure"');
    expect(html).toContain('id="btn-verify-aws"');
    expect(html).toContain('id="save-cred-btn"');
    expect(html).toMatch(/id="save-cred-btn"[^>]*disabled/);
  });

  it("holds a slot for the GitHub Packages gate and the verification result", () => {
    const html = credentialsPaneMarkup("credentials");
    expect(html).toContain('id="cred-ghcr-section"');
    expect(html).toContain('id="cred-ghcr-command"');
    expect(html).toContain('id="cred-verify-status"');
    expect(html).toContain('id="cred-verify-hint"');
  });

  it("is markup only, with no interpolation beyond the sub-tab state", () => {
    expect(credentialsPaneMarkup("credentials")).not.toContain("${");
  });
});
