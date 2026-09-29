import { describe, expect, it } from "vitest";
import { validJsonSyntax } from "./json-syntax.js";

describe("validJsonSyntax", () => {
  it.each([
    "{}",
    "[]",
    " \t\r\n {} \t\r\n",
    '{"key":[],"nested":{"x":[true,false,null,"text"]}}',
    '{"key":"backslash\\\\quote\\"slash\\/tab\\tunicode\\u0aAF"}',
    "[0,-10,12.34,1e2,2E+3,3e-4]",
    '"text"',
    "true",
    "false",
    "null"
  ])("recognizes valid JSON syntax: %s", (value) => {
    expect(validJsonSyntax(value, 0, value.length)).toBe(true);
    expect(() => JSON.parse(value)).not.toThrow();
  });

  it.each([
    "",
    " ",
    "x",
    "tr",
    "nul",
    '"unterminated',
    '"\\',
    '"invalid\nstring"',
    '"\\q"',
    '"\\u123"',
    '"\\uG000"',
    '"\\u0G00"',
    '"\\u00G0"',
    '"\\u000G"',
    "[,]",
    "[0,]",
    "[1 2]",
    "[true false]",
    "[1e+]",
    "[1.]",
    "[01]",
    "[-]",
    '{"a":}',
    '{"a":1,}',
    '{"a":1 "b":2}',
    '{"a" 1}',
    "{true}",
    '{"unterminated:0}',
    '{"x":"unterminated}',
    '{"x":true,false}',
    '{"x":1} trailing'
  ])("rejects malformed JSON syntax: %s", (value) => {
    expect(validJsonSyntax(value, 0, value.length)).toBe(false);
    expect(() => JSON.parse(value)).toThrow();
  });

  it("checks only the requested framed span", () => {
    const text = 'Rad output: {"resources":[{"name":"web[0]"}]} trailing';
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}") + 1;
    expect(validJsonSyntax(text, start, end)).toBe(true);
    expect(validJsonSyntax(text, start, text.length)).toBe(false);
  });
});
