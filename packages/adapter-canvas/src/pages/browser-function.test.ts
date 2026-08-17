import { describe, it, expect } from "vitest";
import { serializeBrowserFunction } from "./browser-function.js";

describe("serializeBrowserFunction", () => {
  it("keeps stable browser helper names when the bundled function name is mangled", () => {
    function Fi(data: unknown): unknown {
      return data;
    }
    expect(serializeBrowserFunction("discoverStatusText", Fi)).toMatch(
      /^var discoverStatusText = function Fi\(data\)/
    );
    expect(() => serializeBrowserFunction("bad-name", Fi)).toThrow(
      'Invalid browser function name "bad-name".'
    );
  });

  it("rejects a name that is not a valid browser identifier", () => {
    const noop = () => {};
    for (const name of ["", "bad name", "bad-name", "1bad", "a.b", "a()"]) {
      expect(() => serializeBrowserFunction(name, noop)).toThrow(
        `Invalid browser function name "${name}".`
      );
    }
  });

  it("accepts the identifier characters a browser accepts", () => {
    const noop = () => {};
    for (const name of ["$", "_", "a1", "$radius_2"]) {
      expect(serializeBrowserFunction(name, noop)).toContain(`var ${name} = `);
    }
  });

  it("emits one assignment statement carrying the function source", () => {
    function add(a: number, b: number): number {
      return a + b;
    }
    const serialized = serializeBrowserFunction("radiusAdd", add);
    expect(serialized.startsWith("var radiusAdd = ")).toBe(true);
    expect(serialized.endsWith(";")).toBe(true);
    expect(serialized).toContain(add.toString());
  });

  it("produces source a browser can evaluate to the same behaviour", () => {
    const double = (value: number): number => value * 2;
    const evaluate = new Function(
      `${serializeBrowserFunction("radiusDouble", double)} return radiusDouble;`
    );
    expect((evaluate() as typeof double)(21)).toBe(42);
  });
});
