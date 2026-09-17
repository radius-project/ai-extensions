import { describe, expect, expectTypeOf, it } from "vitest";
import {
  lifecycleRequestSchema,
  lifecycleResponseSchema,
  operationSchemas,
  type LifecycleOperation,
  type LifecycleRequestFor,
  type LifecycleResponseFor
} from "./catalog.js";

describe("lifecycle operation catalog", () => {
  it("publishes exactly 21 paired request and response variants as JSON data", () => {
    expect(Object.keys(operationSchemas)).toEqual([
      "application.delete",
      "application.inspect",
      "application.list",
      "capabilities.get",
      "credentials.configure",
      "credentials.inspect",
      "definition.author",
      "definition.validate",
      "deployment.start",
      "environment.configure",
      "environment.create",
      "environment.delete",
      "environment.inspect",
      "environment.list",
      "graph.diff",
      "graph.get",
      "operation.cancel",
      "operation.get",
      "operation.list",
      "operation.repair",
      "operation.respond"
    ]);
    expect(lifecycleRequestSchema.oneOf).toHaveLength(21);
    expect(lifecycleResponseSchema.oneOf).toHaveLength(22);
    for (const schema of [lifecycleRequestSchema, lifecycleResponseSchema]) {
      expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    }
  });

  it("infers required targets, operation tags, and git-only deployment sources", () => {
    expectTypeOf<
      LifecycleRequestFor<"deployment.start">["target"]
    >().toEqualTypeOf<{
      repo: string;
      environment: string;
      application: string;
      definition: string;
      source: { kind: "git"; ref: string; expectedCommit: string };
    }>();
    expectTypeOf<
      LifecycleRequestFor<"deployment.start">["operation"]
    >().toEqualTypeOf<"deployment.start">();
    expectTypeOf<
      LifecycleResponseFor<"definition.validate">["result"]["report"]["status"]
    >().toEqualTypeOf<"passed" | "failed" | "incomplete">();
    expectTypeOf<
      keyof typeof operationSchemas
    >().toEqualTypeOf<LifecycleOperation>();
  });
});
