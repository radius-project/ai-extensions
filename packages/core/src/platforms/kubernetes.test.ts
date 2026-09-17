import { describe, expect, it } from "vitest";
import { isKubernetesNamespace } from "./kubernetes.js";

describe("isKubernetesNamespace", () => {
  it.each([
    ["one lowercase letter", "a"],
    ["one digit", "0"],
    ["lowercase letters, digits, and internal hyphens", "todo-app-3"],
    ["the 63-character limit", `a${"b".repeat(61)}c`]
  ])("accepts %s", (_label, namespace) => {
    expect(isKubernetesNamespace(namespace)).toBe(true);
  });

  it.each([
    ["an empty value", ""],
    ["uppercase letters", "Todo-app-3"],
    ["an underscore", "todo_app"],
    ["a space", "todo app"],
    ["a leading hyphen", "-todo"],
    ["a trailing hyphen", "todo-"],
    ["64 characters", `a${"b".repeat(62)}c`]
  ])("rejects %s", (_label, namespace) => {
    expect(isKubernetesNamespace(namespace)).toBe(false);
  });
});
