import { describe, expect, it } from "vitest";
import { confirmDialogMarkup } from "./confirm-dialog.js";

describe("confirmDialogMarkup", () => {
  const html = confirmDialogMarkup();

  it("starts hidden so it never covers the page on load", () => {
    expect(html).toContain('id="env-confirm-modal"');
    expect(html).toContain("display:none");
  });

  it("exposes every slot the client script addresses", () => {
    for (const id of [
      "env-confirm-title",
      "env-confirm-message",
      "env-confirm-usage",
      "env-confirm-usage-label",
      "env-confirm-usage-list",
      "env-confirm-cancel",
      "env-confirm-ok"
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it("names itself to assistive technology as a modal dialog", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="env-confirm-title"');
  });

  it("keeps the usage list hidden until a caller fills it", () => {
    const usage = html.slice(html.indexOf('id="env-confirm-usage"'));
    expect(usage.slice(0, usage.indexOf(">"))).toContain("display:none");
  });

  it("leaves the confirm button unlabelled for the caller to name", () => {
    expect(html).toContain(
      '<button id="env-confirm-ok" type="button" class="rad-btn rad-btn--danger-outline" style="margin:0;"></button>'
    );
  });

  it("renders no interpolated content", () => {
    expect(html).not.toContain("${");
  });

  it("declares each id exactly once", () => {
    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
