import { describe, expect, it } from "vitest";
import {
  RADIUS_BRAND_MARK,
  radiusBrandMarkSvg,
  type RadiusBrandMarkOptions
} from "./brand.js";

describe("RADIUS_BRAND_MARK", () => {
  it("publishes the dial geometry an icon registry needs", () => {
    expect(RADIUS_BRAND_MARK.width).toBe(128);
    expect(RADIUS_BRAND_MARK.height).toBe(128);
    expect(RADIUS_BRAND_MARK.body.startsWith("<svg")).toBe(false);
    expect(RADIUS_BRAND_MARK.body).toContain(
      '<circle cx="64" cy="64" r="64" fill="var(--rad-brand, #da4c2a)"/>'
    );
    expect(RADIUS_BRAND_MARK.body).toContain(
      '<line x1="64" y1="64" x2="34" y2="28" stroke="#fff" stroke-width="7" stroke-linecap="round"/>'
    );
  });

  it("themes its fills through the graph brand tokens with a palette fallback", () => {
    const fills = RADIUS_BRAND_MARK.body.match(/fill="var\([^"]+\)"/g);
    expect(fills).toEqual([
      'fill="var(--rad-brand, #da4c2a)"',
      'fill="var(--rad-brand-dark, #bb311e)"'
    ]);
  });
});

describe("radiusBrandMarkSvg", () => {
  it("renders a decorative 28px mark by default", () => {
    expect(radiusBrandMarkSvg()).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="28" height="28" aria-hidden="true">${RADIUS_BRAND_MARK.body}</svg>`
    );
  });

  it("treats an empty options object as the default mark", () => {
    expect(radiusBrandMarkSvg({})).toBe(radiusBrandMarkSvg());
  });

  it.each([1, 16, 26, 64, 512])("renders the mark at %ipx", (size) => {
    const svg = radiusBrandMarkSvg({ size });
    expect(svg).toContain(`width="${size}" height="${size}"`);
    expect(svg).toContain('viewBox="0 0 128 128"');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1" onload="alert(1)'])(
    "rejects size %s before it reaches the markup",
    (size) => {
      expect(() => radiusBrandMarkSvg({ size: size as number })).toThrow(
        RangeError
      );
    }
  );

  it("names the mark for assistive technology when it carries meaning", () => {
    const svg = radiusBrandMarkSvg({ title: "Radius" });
    expect(svg).toContain('role="img" aria-label="Radius"');
    expect(svg).not.toContain("aria-hidden");
  });

  it("escapes a title so it cannot break out of the attribute", () => {
    const svg = radiusBrandMarkSvg({
      title: 'Radius "app" <b>&</b>'
    });
    expect(svg).toContain(
      'aria-label="Radius &quot;app&quot; &lt;b&gt;&amp;&lt;/b&gt;"'
    );
    expect(svg).not.toContain("<b>");
  });

  it("hides an explicitly undefined title rather than naming it", () => {
    const options: RadiusBrandMarkOptions = { title: undefined };
    expect(radiusBrandMarkSvg(options)).toContain('aria-hidden="true"');
  });

  it("renders an empty title as an empty accessible name", () => {
    const svg = radiusBrandMarkSvg({ title: "" });
    expect(svg).toContain('role="img" aria-label=""');
    expect(svg).not.toContain("aria-hidden");
  });

  it("wraps the shared body in exactly one self-contained element", () => {
    const svg = radiusBrandMarkSvg({ size: 26 });
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    expect(svg.match(/<\/svg>/g)).toHaveLength(1);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.slice(svg.indexOf(">") + 1, -"</svg>".length)).toBe(
      RADIUS_BRAND_MARK.body
    );
  });
});
