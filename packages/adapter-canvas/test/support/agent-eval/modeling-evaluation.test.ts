import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODELING_CASES } from "./modeling-cases.js";
import { createModelingEvaluation } from "./modeling-evaluation.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

function evaluation() {
  return createModelingEvaluation(
    MODELING_CASES[0],
    root,
    fileURLToPath(new URL("./fixture-workspace", import.meta.url)),
    { skill: "controlled skill text", runtimeContract: "controlled contract" }
  );
}

describe("modeling evaluation tool boundary", () => {
  it("uses the production prompt and skill handoff without exposing expectations", () => {
    const run = evaluation();
    expect(run.prompt).toContain(
      "Only when no Environment is named and no contract is supplied"
    );
    expect(run.prompt).not.toContain("expected:");
    expect(run.prompt).not.toContain("no-environment");
    const handoff = run.call("radius_generate_app", {}) as {
      handoff: { skill: string; skillBase: string; nodeCommand: string };
      skillText: string;
      environment: unknown;
    };
    expect(handoff.handoff.skill).toBe("radius-app-bicep");
    expect(handoff.handoff.skillBase).toContain("radius-app-bicep");
    expect(handoff.handoff.nodeCommand).toBe(process.execPath);
    expect(handoff.skillText).toBe("controlled skill text");
    expect(handoff.environment).toMatchObject(MODELING_CASES[0].environment);
  });

  it.each(MODELING_CASES)(
    "records and verifies $id without model access",
    (testCase) => {
      const run = createModelingEvaluation(testCase, root, root, {
        skill: "fixture",
        runtimeContract: "fixture"
      });
      run.call("radius_generate_app", {});
      const evidence = run.call("resolve_modeling_evidence", {}) as {
        resources: Array<{ recipe: { status: string } }>;
      };
      expect(evidence.resources[0].recipe.status).toBe(
        testCase.recipe === "azure" ? "available" : "unavailable"
      );
      run.call("submit_modeling_decision", {
        ...testCase.expected,
        reason: "Controlled test of the recorder, not an agent evaluation."
      });
      expect(() => run.assertExpected()).not.toThrow();
      expect(run.result().calls.map((entry) => entry.name)).toEqual([
        "radius_generate_app",
        "resolve_modeling_evidence",
        "submit_modeling_decision"
      ]);
      expect(() => run.call("radius_generate_app", {})).toThrow("already has");
    }
  );

  it("fails if the agent blocks the no-Environment case on registration", () => {
    const run = evaluation();
    run.call("radius_generate_app", {});
    run.call("resolve_modeling_evidence", {});
    run.call("submit_modeling_decision", {
      status: "blocked",
      blocker: "registration",
      reason: "The old gate requires registration."
    });
    expect(() => run.assertExpected()).toThrow(
      "expected ready/none, received blocked/registration"
    );
  });

  it("fails incomplete runs instead of treating CLI exit zero as success", () => {
    const run = evaluation();
    expect(() => run.assertExpected()).toThrow("did not submit");
    expect(() => run.result()).toThrow("did not submit");
  });

  it("requires reading both guidance and evidence before deciding", () => {
    const run = evaluation();
    expect(() => run.call("resolve_modeling_evidence", {})).toThrow(
      "Read the skill"
    );
    run.call("radius_generate_app", {});
    expect(() => run.call("submit_modeling_decision", {})).toThrow(
      "Resolve Recipe evidence"
    );
  });

  it("rejects malformed input, unknown tools and inconsistent decisions", () => {
    const run = evaluation();
    for (const args of [null, [], "text"]) {
      expect(() => run.call("radius_generate_app", args)).toThrow(
        "must be an object"
      );
    }
    expect(() => run.call("radius_generate_app", { unexpected: true })).toThrow(
      "takes no arguments"
    );
    run.call("radius_generate_app", {});
    expect(() => run.call("unknown", {})).toThrow("Unknown evaluation tool");
    expect(() =>
      run.call("resolve_modeling_evidence", { extra: true })
    ).toThrow("takes no arguments");
    run.call("resolve_modeling_evidence", {});
    for (const args of [
      {},
      { status: "ready", blocker: "registration", reason: "wrong" },
      { status: "blocked", blocker: "none", reason: "wrong" },
      { status: "ready", blocker: "none", reason: " " },
      { status: "ready", blocker: "none", reason: "ok", extra: true }
    ]) {
      expect(() => run.call("submit_modeling_decision", args)).toThrow(
        "Invalid or inconsistent"
      );
    }
  });
});
