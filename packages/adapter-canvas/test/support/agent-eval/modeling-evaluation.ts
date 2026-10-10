import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRadiusAppBicepSkill } from "../../../src/skill.js";
import { appBicepHandoffPrompt } from "../../../src/runtime/hooks.js";
import {
  modelingEnvironment,
  modelingEvidence,
  type ModelingCase
} from "./modeling-cases.js";

interface Decision {
  status: "ready" | "blocked";
  blocker: "none" | "registration" | "recipe_behavior";
  reason: string;
}

export interface ModelingGuidance {
  skill: string;
  runtimeContract: string;
}

export function createModelingEvaluation(
  testCase: ModelingCase,
  repoRoot: string,
  workspace: string,
  guidance: ModelingGuidance
) {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let decision: Decision | undefined;
  const generate = createRadiusAppBicepSkill({
    moduleDir: join(repoRoot, "packages", "adapter-canvas", "src"),
    homeDir: workspace,
    pathExists: existsSync,
    generatorVersion: () => "headless-policy-poc",
    nodeExecutable: () => ({ executable: process.execPath, rejected: [] })
  });
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown> = {},
    required: string[] = []
  ) => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false
    }
  });
  const tools = [
    tool(
      "radius_generate_app",
      "Get the production Radius skill handoff, shipped guidance and controlled source fixture."
    ),
    tool(
      "resolve_modeling_evidence",
      "Get the controlled schema and Recipe evidence. Replaces external schema/Recipe fetching for this evaluation."
    ),
    tool(
      "submit_modeling_decision",
      "Record whether authoring may begin under the supplied skill. Does not generate or validate Bicep.",
      {
        status: { type: "string", enum: ["ready", "blocked"] },
        blocker: {
          type: "string",
          enum: ["none", "registration", "recipe_behavior"]
        },
        reason: { type: "string", minLength: 1 }
      },
      ["status", "blocker", "reason"]
    )
  ];

  function call(name: string, args: unknown): unknown {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Tool arguments must be an object.");
    }
    if (decision) throw new Error("This evaluation already has a decision.");
    const values = Object.entries(args);
    if (name === "radius_generate_app") {
      if (values.length)
        throw new Error("The handoff tool takes no arguments.");
      calls.push({ name, arguments: args });
      return {
        handoff: JSON.parse(generate(workspace)),
        skillText: guidance.skill,
        runtimeContract: guidance.runtimeContract,
        source: {
          dockerfile: 'FROM scratch\nCOPY app /app\nENTRYPOINT ["/app"]\n',
          runtime:
            "Runnable container application with a Redis backing service. It reads REDIS_URL, which must bind to the Redis Recipe's generated properties.url. It uses an existing public image and needs no image-build resources.",
          sourceCompatibility: "verified",
          schemaPaths: "verified",
          credentialShape: "no credentials required",
          omittedInputs: "none",
          selectedRecipeBehaviorRequired: true,
          generatedValueRequired:
            "Redis properties.url must reach REDIS_URL; do not omit this backing service or its binding.",
          checker:
            "Downstream validation is outside this pre-authoring evaluation; no checker run is claimed."
        },
        environment: modelingEnvironment(testCase)
      };
    }
    if (!calls.some((entry) => entry.name === "radius_generate_app")) {
      throw new Error("Read the skill handoff before resolving or deciding.");
    }
    if (name === "resolve_modeling_evidence") {
      if (values.length)
        throw new Error("The evidence tool takes no arguments.");
      calls.push({ name, arguments: args });
      return modelingEvidence(testCase);
    }
    if (name !== "submit_modeling_decision") {
      throw new Error(`Unknown evaluation tool: ${name}`);
    }
    if (!calls.some((entry) => entry.name === "resolve_modeling_evidence")) {
      throw new Error("Resolve Recipe evidence before deciding.");
    }
    const { status, blocker, reason } = args as Record<string, unknown>;
    if (
      values.length !== 3 ||
      (status !== "ready" && status !== "blocked") ||
      (blocker !== "none" &&
        blocker !== "registration" &&
        blocker !== "recipe_behavior") ||
      typeof reason !== "string" ||
      !reason.trim() ||
      (status === "ready") !== (blocker === "none")
    ) {
      throw new Error("Invalid or inconsistent modeling decision.");
    }
    decision = { status, blocker, reason };
    calls.push({ name, arguments: args });
    return { recorded: true };
  }

  return {
    tools,
    calls,
    call,
    prompt: [
      "Evaluate only the pre-authoring evidence gate, not full model generation.",
      "The text below is the production Canvas handoff. Follow its selected radius-app-bicep skill, but stop before authoring files, running scripts, or deploying.",
      appBicepHandoffPrompt("fixture/app", "graph", ["eval"]),
      `User request: ${testCase.request}`,
      "Call radius_generate_app to read the supplied skill and source, then resolve_modeling_evidence to inspect the exact controlled schema and Recipe evidence.",
      "Use only this evidence. Do not assume an Environment contract or registration when it is not supplied. Do not fetch anything.",
      "Decide whether the skill permits authoring to begin. Do not require the downstream checker to have run before authoring. Report ready/none or blocked with registration or recipe_behavior via submit_modeling_decision, with a brief explanation.",
      "Do not infer expected results from case names; they are not part of the evidence."
    ].join("\n\n"),
    result() {
      if (!decision)
        throw new Error("Agent did not submit a modeling decision.");
      return { decision, calls };
    },
    assertExpected() {
      if (!decision)
        throw new Error("Agent did not submit a modeling decision.");
      if (
        decision.status !== testCase.expected.status ||
        decision.blocker !== testCase.expected.blocker
      ) {
        throw new Error(
          `${testCase.id}: expected ${testCase.expected.status}/${testCase.expected.blocker}, received ${decision.status}/${decision.blocker}: ${decision.reason}`
        );
      }
    }
  };
}
