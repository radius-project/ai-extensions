import { expect, it } from "vitest";
import { extractAppName } from "./bicep.js";
it.each(["comment", "multiline", "expression", "multiple"] as const)(
  "does not infer a declaration identity from %s syntax",
  (kind) => {
    const app =
      "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'app'\n}";
    const source =
      kind === "comment" ? `/*\n${app}\n*/`
      : kind === "multiline" ? `var text = '''\n${app}\n'''`
      : kind === "expression" ? app.replace("'app'", "'app' + suffix")
      : `${app}\n${app.replace("'app'", "dynamicName")}`;
    expect(extractAppName(source, { strict: true })).toBe("");
  }
);
it("requires one static application declaration for discovery instead of guessing another resource name", () => {
  const app =
    "resource app 'Radius.Core/applications@2025-08-01-preview' = {\n name: 'app'\n}";
  expect(extractAppName(app, { strict: true })).toBe("app");
  expect(
    extractAppName(
      "resource db 'Radius.Data/databases@2025-01-01' = { name: 'db' }",
      { strict: true }
    )
  ).toBe("");
  expect(extractAppName(`${app}\n${app}`, { strict: true })).toBe("");
  expect(
    extractAppName(app.replace("'app'", "application"), { strict: true })
  ).toBe("");
  expect(extractAppName("{ name: 'legacy' }")).toBe("legacy");
});
