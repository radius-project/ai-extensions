import { describe, expect, it } from "vitest";
import {
  isCallable,
  isRecord,
  readArray,
  readBoolean,
  readNumber,
  readRecord,
  readString,
  readStringArray
} from "./json.js";

describe("browser JSON narrowing", () => {
  it("recognizes records and callables without accepting arrays or primitives", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("value")).toBe(false);
    expect(isCallable(() => undefined)).toBe(true);
    expect(isCallable({})).toBe(false);
  });

  it.each([
    [{ name: "web" }, "web"],
    [{ name: 5 }, ""],
    [{}, ""],
    [null, ""]
  ])("reads a string only from a record", (value, expected) => {
    expect(readString(value, "name")).toBe(expected);
  });

  it("reads strict booleans and finite numbers", () => {
    expect(readBoolean({ ok: true }, "ok")).toBe(true);
    expect(readBoolean({ ok: "true" }, "ok")).toBe(false);
    expect(readBoolean(null, "ok")).toBe(false);
    expect(readNumber({ count: 3 }, "count")).toBe(3);
    expect(readNumber({ count: Number.NaN }, "count")).toBeNull();
    expect(readNumber({ count: "3" }, "count")).toBeNull();
    expect(readNumber(null, "count")).toBeNull();
  });

  it("reads arrays, string arrays, and nested records without casts", () => {
    expect(readArray({ values: [1, 2] }, "values")).toEqual([1, 2]);
    expect(readArray({ values: "no" }, "values")).toEqual([]);
    expect(readArray(null, "values")).toEqual([]);
    expect(readStringArray({ values: ["a", 2, "b"] }, "values")).toEqual([
      "a",
      "b"
    ]);
    expect(readRecord({ value: { id: 1 } }, "value")).toEqual({ id: 1 });
    expect(readRecord({ value: [] }, "value")).toBeNull();
    expect(readRecord(null, "value")).toBeNull();
  });
});
