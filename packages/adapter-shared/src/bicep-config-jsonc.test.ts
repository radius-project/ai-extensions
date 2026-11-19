import { describe, expect, it } from "vitest";
import { readBicepConfigJsonc } from "./bicep-config-jsonc.js";

describe("Bicep JSONC reading", () => {
  it("preserves JSON property semantics in nested objects and arrays", () => {
    const json =
      '{"extensions":{"__proto__":{"radius":"not an alias"},"x":1,"x":2},"settings":[null,false,{"value":3}]}';
    const config = readBicepConfigJsonc(`/* Bicep settings */\n${json}`);
    expect(config).toStrictEqual(JSON.parse(json));
  });

  it.each(["", "{", "/* unterminated"])("rejects invalid config %j", (text) => {
    expect(() => readBicepConfigJsonc(text)).toThrow(SyntaxError);
  });
});
