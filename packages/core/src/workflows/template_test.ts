import { describe, expect, it } from "vitest";
import {
  assertNoUnresolvedPlaceholders,
  fillTemplate,
  findUnresolvedPlaceholders
} from "./template.js";

describe("fillTemplate", () => {
  it("replaces known UPPER_SNAKE tokens and leaves unknown ones untouched", () => {
    const out = fillTemplate("a={{ENV}} b={{REF}}", { ENV: "prod" });

    expect(out).toBe("a=prod b={{REF}}");
  });

  it("inserts values verbatim without applying $-replacement patterns", () => {
    const out = fillTemplate("v={{VAL}}", { VAL: "${{ secrets.X }} $var $&" });

    expect(out).toBe("v=${{ secrets.X }} $var $&");
  });

  it("does not treat GitHub ${{ ... }} expressions as tokens", () => {
    const input = "run: echo ${{ github.sha }}";

    expect(fillTemplate(input, {})).toBe(input);
  });

  it("leaves ${{ ... }} expressions untouched even without inner whitespace", () => {
    expect(fillTemplate("run: echo ${{github.sha}}", {})).toBe(
      "run: echo ${{github.sha}}"
    );
  });

  it("does not replace an UPPER_SNAKE token inside a ${{ ... }} expression", () => {
    expect(fillTemplate("v=${{ENV}}", { ENV: "prod" })).toBe("v=${{ENV}}");
  });
});

describe("findUnresolvedPlaceholders", () => {
  it("returns distinct leftover tokens in first-seen order", () => {
    expect(
      findUnresolvedPlaceholders("{{A}} {{B}} {{A}} ${{ github.sha }}")
    ).toEqual(["{{A}}", "{{B}}"]);
  });

  it("returns an empty array when nothing remains", () => {
    expect(findUnresolvedPlaceholders("nothing here ${{ ok }}")).toEqual([]);
  });

  it("ignores UPPER_SNAKE tokens embedded in ${{ ... }} expressions", () => {
    expect(findUnresolvedPlaceholders("a=${{ENV}} b=${{ REF }}")).toEqual([]);
  });

  it("still reports a bare token next to a ${{ ... }} expression", () => {
    expect(findUnresolvedPlaceholders("${{ github.sha }} {{ENV}}")).toEqual([
      "{{ENV}}"
    ]);
  });
});

describe("assertNoUnresolvedPlaceholders", () => {
  it("throws listing the leftover tokens and context", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders("x={{FOO}}", "test workflow")
    ).toThrow(/\{\{FOO\}\}.*test workflow/);
  });

  it("does not throw when all placeholders are resolved", () => {
    expect(() =>
      assertNoUnresolvedPlaceholders("run: ${{ github.sha }}", "ctx")
    ).not.toThrow();
  });
});
