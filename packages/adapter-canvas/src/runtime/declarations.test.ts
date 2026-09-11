import { describe, expect, it } from "vitest";
import {
  RADIUS_CANVAS_ID,
  RADIUS_CANVAS_DISPLAY_NAME,
  RADIUS_CANVAS_DESCRIPTION,
  RADIUS_CANVAS_PAGES,
  RESERVED_DECLARATION_NAMES,
  buildRadiusCanvasInputSchema,
  RADIUS_ACTION_DECLARATIONS,
  RADIUS_SESSION_START_CONTEXT,
  RADIUS_TOOL_DECLARATIONS
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
  it("declares exactly the retained 7 tool names, in order", () => {
    expect(RADIUS_TOOL_DECLARATIONS.map((t) => t.name)).toEqual([
      "radius_generate_app",
      "radius_report_modeling_failure",
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

  it("documents both generate-app response shapes", () => {
    const declaration = RADIUS_TOOL_DECLARATIONS.find(
      (tool) => tool.name === "radius_generate_app"
    )!;

    expect(declaration.description).toContain("returns one JSON object");
    expect(declaration.description).toContain("optional ambiguity brief");
    expect(declaration.description).toContain("returns a Markdown refusal");
  });

  it("requires the complete fenced modeling-failure report", () => {
    const declaration = RADIUS_TOOL_DECLARATIONS.find(
      (tool) => tool.name === "radius_report_modeling_failure"
    )!;

    expect(declaration.parameters.required).toEqual([
      "instanceId",
      "repo",
      "branch",
      "attemptToken",
      "error"
    ]);
    expect(
      (
        declaration.parameters.properties as Record<
          string,
          { maxLength?: number }
        >
      ).error.maxLength
    ).toBe(4000);
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

  it("makes PR embedding conditional on a successful graph diff", () => {
    const decl = RADIUS_TOOL_DECLARATIONS.find(
      (tool) => tool.name === "radius_generate_pr_diff_markdown"
    )!;

    expect(decl.description).toContain("only when the result contains a diff");
    expect(decl.description).toContain(
      "create the PR without a graph diff section"
    );
    expect(decl.description).toContain("report the reason in chat");
  });

  it("requires file/target on radius_publish_recipe", () => {
    const decl = RADIUS_TOOL_DECLARATIONS.find(
      (t) => t.name === "radius_publish_recipe"
    )!;
    expect(decl.parameters.required).toEqual(["file", "target"]);
  });

  describe("RU-19: automatic PR graph diff guidance", () => {
    it("requires exact returned markdown only when a graph diff exists", () => {
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "If it returns a Mermaid application graph diff"
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "exact returned markdown at the TOP"
      );
    });

    it("keeps unavailable graph explanations out of the PR body", () => {
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "create the pull request without a graph diff section"
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "Do not add a sentence to the PR body"
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "Report the reason in chat"
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "describe the change itself normally"
      );
    });

    it("never requires publishing the current worktree for a graph diff", () => {
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "Do not commit or push the current worktree merely to compare it."
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "whichever side exactly matches the current workspace repo and branch"
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "report that the diff is unavailable rather than publishing the worktree"
      );
    });

    it("uses the existing Radius instance in every concrete open example", () => {
      expect(RADIUS_SESSION_START_CONTEXT).not.toContain(
        'open_canvas({ canvasId: "radius", instanceId: "radius-panel"'
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        'instanceId: "<radius-instance>"'
      );
      expect(RADIUS_SESSION_START_CONTEXT).toContain(
        "always use its actual instanceId"
      );
    });

    it("keeps numbered instructions flush-left", () => {
      for (const line of RADIUS_SESSION_START_CONTEXT.split("\n")) {
        expect(line).not.toMatch(/^\s{4,}\d\./);
      }
    });
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
