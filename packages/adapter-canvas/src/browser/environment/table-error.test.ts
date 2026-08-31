import { describe, expect, it } from "vitest";
import { ServerResponseError } from "../http.js";
import { tableErrorRowMarkup } from "./table-error.js";

describe("tableErrorRowMarkup", () => {
  it("escapes a trusted server-response error", () => {
    expect(
      tableErrorRowMarkup(
        new ServerResponseError("<strong>denied</strong>"),
        5,
        "Could not load."
      )
    ).toBe(
      '<tr><td colspan="5" style="color:var(--rad-text-tertiary);">&lt;strong&gt;denied&lt;/strong&gt;</td></tr>'
    );
  });

  it("uses the escaped fallback for an arbitrary rejection", () => {
    expect(
      tableErrorRowMarkup(new Error("secret"), 4, "Couldn\u2019t load.")
    ).toBe(
      '<tr><td colspan="4" style="color:var(--rad-text-tertiary);">Couldn\u2019t load.</td></tr>'
    );
  });
});
