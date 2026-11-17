import { describe, expect, it } from "vitest";
import {
  commandsMatchWorkflowApplication,
  literalWorkflowApplication,
  parseWorkflowApplicationTitle
} from "./workflow-application-identity.js";

const model =
  "resource app 'Radius.Core/applications@2023-10-01' = {\n name: 'my-app'\n properties: {}\n}";

describe("workflow application evidence", () => {
  it.each([
    [model, "my-app"],
    [`// name: 'other'\n${model}`, "my-app"],
    [`// ignored\r${model}\n// end`, "my-app"],
    [`/* resource fake 'Radius.Core/applications@1' = {} */${model}`, "my-app"],
    [`var text = 'escaped\\' quote'\n${model}`, "my-app"],
    [`metadata note = '''\na multiline description\n'''\n${model}`, null],
    [
      `metadata example = '''
it's an example
resource sample 'Radius.Core/applications@1' = {
 name: 'sample'
}
'''
${model}
metadata tail = '''
it's a tail
'''
`,
      null
    ],
    [`${model}\nidentifier`, "my-app"],
    [`${model}\n'not closed`, null],
    [`${model}\n'escaped\\`, null],
    [`${model}\n/* not closed`, null],
    [`${model}\n${"/*".repeat(10000)}`, null],
    [`${model}\n'${"\\'".repeat(10000)}`, null],
    [
      `resource other 'Radius.Resources/widgets@1' = { name: 'other' }\n${model}`,
      "my-app"
    ],
    [model.replace("'my-app'", "appName"), null],
    [model.replace("'my-app'", "'${appName}'"), null],
    [model.replace("'my-app'", "'my-app' + suffix"), null],
    [model.replace(" = {", " = if (ready) {"), null],
    [model + "\n" + model, null],
    ["name: 'not-an-app'", null],
    [model + "\nmodule another 'other.bicep' = {}", null],
    [model.replace(" name:", " nested: { name: 'nested' }\n name:"), "my-app"],
    [model.replace(" properties:", " name: 'duplicate'\n properties:"), null],
    [model.slice(0, -1), null],
    [model.replace("my-app", "a".repeat(63)), "a".repeat(63)],
    [model.replace("my-app", "a".repeat(64)), null]
  ])(
    "resolves only the admitted literal application %#",
    (source, expected) => {
      expect(literalWorkflowApplication(source)).toBe(expected);
    }
  );

  it.each([
    ["", true],
    ['["deploy app.bicep --environment dev"]', true],
    [
      '["deploy app.bicep --environment dev --parameters image=tag","app graph --application my-app --include-icons"]',
      true
    ],
    ['["deploy app.bicep --environment dev","app graph my-app -o json"]', true],
    ['["deploy other.bicep --environment dev"]', false],
    ['["deploy app.bicep --environment other"]', false],
    ['["deploy app.bicep --environment dev --application other"]', false],
    ['["deploy app.bicep --environment dev --parameters"]', false],
    ['["deploy app.bicep --environment dev","app graph other -o json"]', false],
    [
      '["deploy app.bicep --environment dev","deploy other.bicep --environment dev"]',
      false
    ],
    ["deploy app.bicep --environment dev", false],
    ["[]", false],
    ["null", false],
    ["[1]", false],
    ['["deploy app.bicep --environment dev","a","b"]', false]
  ])(
    "validates a declared single-target command sequence %#",
    (commands, expected) => {
      expect(
        commandsMatchWorkflowApplication(commands, "app.bicep", "dev", "my-app")
      ).toBe(expected);
    }
  );

  it.each(["deploy", "delete"] as const)(
    "parses the strict %s suffix without splitting environment names",
    (kind) => {
      const prefix = `Radius - ${kind === "deploy" ? "Deploy" : "Delete"} dev west`;
      expect(
        parseWorkflowApplicationTitle(
          `${prefix} [radius:v1 app=my-app] dep-123`,
          "dev west",
          kind
        )
      ).toEqual({ application: "my-app", correlationId: "dep-123" });
      expect(
        parseWorkflowApplicationTitle(
          `${prefix} [radius:v1 app=unknown] dep-123`,
          "dev west",
          kind
        )
      ).toEqual({ application: null, correlationId: "dep-123" });
      for (const title of [
        `${prefix} [radius:v2 app=my-app] dep-123`,
        `${prefix} [radius:v1 app=my-app] dep-123 extra`,
        `${prefix} [radius:v1 app=my-app]`,
        `${prefix} [radius:v1 app=my-app] dep-${"x".repeat(65)}`,
        `${prefix} [radius:v1 app=my app] dep-123`,
        "x".repeat(257),
        "unrelated"
      ])
        expect(
          parseWorkflowApplicationTitle(title, "dev west", kind)
        ).toBeNull();
      expect(
        parseWorkflowApplicationTitle(
          `${prefix} [radius:v1 app=my-app] dep-123`,
          "other",
          kind
        )
      ).toBeNull();
    }
  );
});
