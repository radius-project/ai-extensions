import { describe, expect, it } from "vitest";
import {
  RADIUS_CANVAS_ID,
  RADIUS_CANVAS_DISPLAY_NAME,
  RADIUS_CANVAS_DESCRIPTION,
  RADIUS_CANVAS_PAGES,
  RESERVED_DECLARATION_NAMES,
  buildRadiusCanvasInputSchema,
  RADIUS_ACTION_DECLARATIONS,
  RADIUS_TOOL_DECLARATIONS,
  RADIUS_SESSION_START_CONTEXT
} from "./declarations.js";

// Declared schemas are typed as Record<string, unknown> (JSON Schema is
// dynamically shaped), so tests read nested fields through this narrow,
// test-only accessor rather than sprinkling `as any` at every call site.
function props(schema: Record<string, unknown>): any {
  return (schema as { properties: any }).properties;
}

// RU-01: canvas metadata, the 7-page enum, repo/base/head fields, and schema
// immutability.
describe("RU-01: canvas metadata + input schema", () => {
  it("declares the canvas id/displayName/description", () => {
    expect(RADIUS_CANVAS_ID).toBe("radius");
    expect(RADIUS_CANVAS_DISPLAY_NAME).toBe("Radius");
    expect(RADIUS_CANVAS_DESCRIPTION).toMatch(/application modeling/i);
  });

  it("enumerates exactly the 7 current canvas pages", () => {
    expect([...RADIUS_CANVAS_PAGES]).toEqual([
      "credentials",
      "graph",
      "planned",
      "graph-diff",
      "deployed",
      "environment",
      "deploying"
    ]);
  });

  it("builds an input schema with the page enum, default, and repo/branch/baseBranch/headBranch fields", () => {
    const schema = buildRadiusCanvasInputSchema("graph");
    expect(schema.properties.page.enum).toEqual([...RADIUS_CANVAS_PAGES]);
    expect(schema.properties.page.default).toBe("graph");
    expect(schema.properties.repo.type).toBe("string");
    // The canvas reads input.branch when opening a non-workspace repository, so
    // it must be advertised or callers cannot know the branch can be chosen.
    expect(schema.properties.branch.type).toBe("string");
    expect(schema.properties.baseBranch.type).toBe("string");
    expect(schema.properties.headBranch.type).toBe("string");
  });

  it("respects the supplied default page", () => {
    const schema = buildRadiusCanvasInputSchema("planned");
    expect(schema.properties.page.default).toBe("planned");
  });

  it("is deeply frozen so a consumer cannot mutate the canonical schema", () => {
    const schema = buildRadiusCanvasInputSchema("graph");
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.properties)).toBe(true);
    expect(Object.isFrozen(schema.properties.page)).toBe(true);
    expect(() => {
      (schema.properties.page as { default: string }).default = "environment";
    }).toThrow();
  });

  it("freezes RADIUS_ACTION_DECLARATIONS and RADIUS_TOOL_DECLARATIONS", () => {
    expect(Object.isFrozen(RADIUS_ACTION_DECLARATIONS)).toBe(true);
    expect(Object.isFrozen(RADIUS_ACTION_DECLARATIONS[0])).toBe(true);
    expect(Object.isFrozen(RADIUS_ACTION_DECLARATIONS[0].inputSchema)).toBe(
      true
    );
    expect(Object.isFrozen(RADIUS_TOOL_DECLARATIONS)).toBe(true);
    expect(Object.isFrozen(RADIUS_TOOL_DECLARATIONS[0])).toBe(true);
    expect(Object.isFrozen(RADIUS_TOOL_DECLARATIONS[0].parameters)).toBe(true);
  });
});

// RU-02: action names/descriptions/required/enums/reserved exclusion.
describe("RU-02: action declarations", () => {
  it("declares exactly the retained 2 action names, in order", () => {
    expect(RADIUS_ACTION_DECLARATIONS.map((a) => a.name)).toEqual([
      "get_graph_resources",
      "update_source_refs"
    ]);
  });

  it("gives every action a non-empty, distinct description", () => {
    const descriptions = RADIUS_ACTION_DECLARATIONS.map((a) => a.description);
    expect(
      descriptions.every((d) => typeof d === "string" && d.length > 0)
    ).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("requires contextToken + refs on update_source_refs, with nested id/codeReference required", () => {
    const decl = RADIUS_ACTION_DECLARATIONS.find(
      (a) => a.name === "update_source_refs"
    )!;
    expect(decl.inputSchema.required).toEqual(["contextToken", "refs"]);
    expect(props(decl.inputSchema).refs.items.required).toEqual([
      "id",
      "codeReference"
    ]);
  });

  it("constrains get_graph_resources' view enum to graph/planned/diff", () => {
    const decl = RADIUS_ACTION_DECLARATIONS.find(
      (a) => a.name === "get_graph_resources"
    )!;
    expect(props(decl.inputSchema).view.enum).toEqual([
      "graph",
      "planned",
      "diff"
    ]);
  });

  it("never declares an action name that collides with a reserved/built-in name", () => {
    const reserved = new Set<string>(RESERVED_DECLARATION_NAMES);
    for (const action of RADIUS_ACTION_DECLARATIONS) {
      expect(reserved.has(action.name)).toBe(false);
    }
  });
});

// RU-03: tool names/schemas/descriptions/unique.
describe("RU-03: tool declarations", () => {
  it("declares exactly the retained 6 tool names, in order", () => {
    expect(RADIUS_TOOL_DECLARATIONS.map((t) => t.name)).toEqual([
      "radius_generate_app",
      "radius_generate_pr_diff_markdown",
      "radius_publish_custom_type_extension",
      "radius_publish_recipe",
      "radius_deploy",
      "radius_deploy_status"
    ]);
  });

  it("gives every tool a unique name", () => {
    const names = RADIUS_TOOL_DECLARATIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every tool a non-empty, distinct description", () => {
    const descriptions = RADIUS_TOOL_DECLARATIONS.map((t) => t.description);
    expect(
      descriptions.every((d) => typeof d === "string" && d.length > 0)
    ).toBe(true);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("gives every tool an object-typed parameters schema", () => {
    for (const tool of RADIUS_TOOL_DECLARATIONS) {
      expect(tool.parameters.type).toBe("object");
      expect(typeof tool.parameters.properties).toBe("object");
    }
  });

  it("requires repo/baseBranch/headBranch on radius_generate_pr_diff_markdown", () => {
    const decl = RADIUS_TOOL_DECLARATIONS.find(
      (t) => t.name === "radius_generate_pr_diff_markdown"
    )!;
    expect(decl.parameters.required).toEqual([
      "repo",
      "baseBranch",
      "headBranch"
    ]);
  });

  // The tool description is read at the call site, so it must carry the same
  // condition as the session-start rule: embed a diff that came back, and leave
  // the section out when one did not.
  it("makes embedding the pr-diff result conditional in its own description", () => {
    const decl = RADIUS_TOOL_DECLARATIONS.find(
      (t) => t.name === "radius_generate_pr_diff_markdown"
    )!;
    expect(decl.description).toMatch(/only when it returns a diff/);
    expect(decl.description).toMatch(
      /leave the graph diff section out of the PR body/
    );
  });

  it("requires file/target on radius_publish_recipe", () => {
    const decl = RADIUS_TOOL_DECLARATIONS.find(
      (t) => t.name === "radius_publish_recipe"
    )!;
    expect(decl.parameters.required).toEqual(["file", "target"]);
  });

  it("constrains provider enums to azure/aws where present", () => {
    for (const tool of RADIUS_TOOL_DECLARATIONS) {
      const provider = props(tool.parameters).provider as
        { enum?: string[] } | undefined;
      if (provider?.enum) {
        expect(provider.enum).toEqual(["azure", "aws"]);
      }
    }
  });

  it("never declares a tool name that collides with a reserved/built-in name", () => {
    const reserved = new Set<string>(RESERVED_DECLARATION_NAMES);
    for (const tool of RADIUS_TOOL_DECLARATIONS) {
      expect(reserved.has(tool.name)).toBe(false);
    }
  });

  it("never declares a tool name that collides with an action name", () => {
    const actionNames = new Set(RADIUS_ACTION_DECLARATIONS.map((a) => a.name));
    for (const tool of RADIUS_TOOL_DECLARATIONS) {
      expect(actionNames.has(tool.name)).toBe(false);
    }
  });
});

// RU-19: the session-start instruction the extension feeds back to the agent.
// The PR graph-diff rule is the part that writes into a durable artifact (a
// pull request description), so both of its outcomes are pinned here.
describe("RU-19: session-start PR graph-diff instruction", () => {
  const prDiffRule = RADIUS_SESSION_START_CONTEXT.slice(
    RADIUS_SESSION_START_CONTEXT.indexOf("Automatic PR Graph Diff"),
    RADIUS_SESSION_START_CONTEXT.indexOf(
      'When the user asks to "show me the app graph"'
    )
  );

  it("still asks for the diff first and puts a returned diagram at the top of the body", () => {
    expect(prDiffRule).toContain("radius_generate_pr_diff_markdown");
    expect(prDiffRule).toMatch(/TOP of the PR description/);
  });

  it("makes including the section conditional on the tool returning a diff", () => {
    expect(prDiffRule).toMatch(
      /If it returns a Mermaid application graph diff/
    );
    expect(prDiffRule).toMatch(/If it does NOT return a diff/);
  });

  it("names every way the diff can be unavailable so none falls through to the body", () => {
    for (const outcome of [
      /denied/,
      /no application to model/,
      /no committed \.radius\/app\.bicep/,
      /reported an error/
    ]) {
      expect(prDiffRule).toMatch(outcome);
    }
  });

  it("requires omitting the section rather than explaining its absence", () => {
    expect(prDiffRule).toMatch(
      /Leave the graph diff section out of the description entirely/
    );
    expect(prDiffRule).toMatch(
      /do not add a sentence explaining why it is missing/
    );
  });

  it("routes the unavailable reason to chat and skips the canvas page", () => {
    expect(prDiffRule).toMatch(/report the reason in the chat session/);
    expect(prDiffRule).toMatch(/do not open the graph-diff canvas page/);
  });

  // The rule suppresses one section, not a subject. A pull request that changes
  // Radius modeling must still be described normally, so the omission must never
  // widen into a ban on naming Radius, app.bicep, or Dockerfiles in the body.
  it("suppresses only the graph diff section, not Radius as a subject", () => {
    expect(prDiffRule).toMatch(/governs only the graph diff section/);
    expect(prDiffRule).toMatch(/describe the change itself/);
    expect(prDiffRule).not.toMatch(/do not mention Radius/);
  });

  it("keeps every instruction line flush-left so the agent reads one list", () => {
    for (const line of RADIUS_SESSION_START_CONTEXT.split("\n")) {
      expect(line).not.toMatch(/^\s{4,}\d\./);
    }
  });
});
