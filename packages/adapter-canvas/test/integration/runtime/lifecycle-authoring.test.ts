import { afterEach, expect, it, vi } from "vitest";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRadiusAppBicepSkill } from "../../../src/skill.js";
import {
  authorCommit,
  authorDefinition,
  createAuthoringBoundaryFixture,
  startAuthoringRuntime
} from "../../support/lifecycle-authoring.js";

afterEach(() => vi.unstubAllEnvs());
const validationInput = { policyVersion: "github-radius/validation/v1" };

it("retains the real legacy skill bootstrap without claiming current-host canonical authority", async () => {
  const fixture = await createAuthoringBoundaryFixture();
  const runtime = await startAuthoringRuntime(fixture);
  try {
    runtime.fake.deps.radiusAppBicepSkill = createRadiusAppBicepSkill({
      moduleDir: resolve("packages/adapter-canvas/src"),
      homeDir: fixture.root,
      pathExists: existsSync,
      generatorVersion: () => "fixture"
    });
    vi.mocked(runtime.fake.deps.workspace.fetchWorkspaceTree).mockResolvedValue(
      ["Dockerfile"]
    );
    const generation = runtime.extension.tools.find(
      (tool) => tool.name === "radius_generate_app"
    );
    if (!generation) throw new Error("Missing retained tool registration");
    const execute = vi.spyOn(fixture.binding, "execute");
    expect(JSON.parse(String(await generation.handler({})))).toMatchObject({
      skill: "radius-app-bicep",
      skillVersion: "fixture",
      skillBase: expect.stringContaining("radius-app-bicep")
    });
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.host.dispatch).not.toHaveBeenCalled();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
    fixture.binding.routing.transition("definition", {
      writer: "lifecycle",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    expect(JSON.parse(String(await generation.handler({})))).toMatchObject({
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(execute).toHaveBeenCalledOnce();
    await fixture.expectUnchanged();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it.each([
  { schema: true, warning: false, expected: "passed" },
  { schema: false, warning: false, expected: "incomplete" },
  { schema: true, warning: true, expected: "failed" }
])(
  "executes standalone validation rules and isolated compiler transport: $expected",
  async (options) => {
    vi.stubEnv("GH_TOKEN", "fixture-inherited-must-not-reach-compiler");
    const fixture = await createAuthoringBoundaryFixture(options);
    const runtime = await startAuthoringRuntime(fixture);
    try {
      const response = await runtime.execute({
        operation: "definition.validate",
        target: { repo: "owner/repo", definition: authorDefinition },
        input: validationInput
      });
      expect(response).toMatchObject({
        operation: "definition.validate",
        result: {
          provenance: {
            kind: "workspace",
            branch: "feature/author",
            baseCommit: authorCommit
          },
          report: { status: options.expected }
        }
      });
      expect(createLifecycleValidators().validateResponse(response).valid).toBe(
        true
      );
      expect(fixture.runProcess).toHaveBeenCalledTimes(2);
      expect(fixture.runProcess.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining(["--validate-json"])
      );
      for (const invocation of fixture.runProcess.mock.calls)
        expect(invocation[2]).toMatchObject({ inheritEnv: false });
      expect(fixture.binding.routing.selection("definition").writer).toBe(
        "legacy"
      );
      expect(
        await runtime.execute({
          operation: "definition.author",
          target: { repo: "owner/repo", definition: authorDefinition },
          input: {
            intent: "Update the model without deployment.",
            provider: "azure"
          }
        })
      ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
      expect(fixture.host.dispatch).not.toHaveBeenCalled();
      expect(fixture.calls).toEqual([]);
      expect(runtime.open).not.toHaveBeenCalled();
      expect(runtime.send).not.toHaveBeenCalled();
      await fixture.expectUnchanged();
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);

it("authorizes pinned remote provenance and fences stale workspace and remote expectations without compiler work", async () => {
  const fixture = await createAuthoringBoundaryFixture();
  const runtime = await startAuthoringRuntime(fixture);
  try {
    const target = {
      repo: "fork/repo",
      definition: authorDefinition,
      source: {
        kind: "git",
        ref: "feature/remote",
        expectedCommit: authorCommit
      }
    };
    expect(
      await runtime.execute({
        operation: "definition.validate",
        target,
        input: validationInput
      })
    ).toMatchObject({
      result: {
        provenance: {
          kind: "git",
          repo: "fork/repo",
          ref: "feature/remote",
          commit: authorCommit
        },
        report: { status: "passed" }
      }
    });
    expect(fixture.authorizations).toContainEqual(
      expect.objectContaining({
        operation: "definition.validate",
        target
      })
    );
    expect(fixture.calls).toEqual(["resolveCommit", "materializeCommit"]);
    const local = await fixture.selection();
    for (const stale of [
      {
        ...target,
        source: { ...target.source, expectedCommit: "b".repeat(40) }
      },
      {
        ...local,
        source: {
          ...local.source,
          expectedFingerprint: `sha256:${"b".repeat(64)}`
        }
      }
    ]) {
      expect(
        await runtime.execute({
          operation: "definition.validate",
          target: stale,
          input: validationInput
        })
      ).toMatchObject({ error: { code: "SOURCE_CHANGED" } });
    }
    expect(fixture.runProcess).toHaveBeenCalledTimes(2);
    await fixture.expectUnchanged();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it("cuts over only the guarded definition writer and retains addressable operations through rollback", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  try {
    const intent = {
      operation: "definition.author",
      target: await fixture.selection(),
      input: {
        intent: "Update the model without deployment.",
        provider: "azure"
      }
    };
    expect(fixture.binding.routing.selection("definition")).toEqual({
      writer: "lifecycle",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });

    expect(fixture.binding.routing.address("legacy-author", true)).toBe(
      "legacy"
    );
    expect(() =>
      fixture.binding.routing.transition("definition", {
        writer: "lifecycle",
        readers: ["lifecycle"],
        controllers: ["lifecycle"]
      })
    ).toThrow("orphan");
    fixture.binding.routing.transition("definition", {
      writer: "legacy",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    expect(await fixture.binding.execute(intent)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(fixture.host.dispatch).not.toHaveBeenCalled();
    expect(
      await fixture.binding.execute({
        operation: "definition.validate",
        target: intent.target,
        input: validationInput
      })
    ).toMatchObject({ result: { report: { status: "passed" } } });
  } finally {
    await fixture.close();
  }
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("fences a cancelled in-flight validation after panel close without opening a panel or claiming remote cancellation", async () => {
  const fixture = await createAuthoringBoundaryFixture();
  const runtime = await startAuthoringRuntime(fixture);
  const started = deferred();
  const proceed = deferred();
  const transport = fixture.runProcess.getMockImplementation();
  if (!transport) throw new Error("Missing real compiler transport");
  fixture.runProcess.mockImplementation(async (...args) => {
    if (args[1][0] === "build") {
      started.resolve();
      await proceed.promise;
    }
    return transport(...args);
  });
  const pending = runtime.execute({
    operation: "definition.validate",
    target: { repo: "owner/repo", definition: authorDefinition },
    input: validationInput
  });
  try {
    await started.promise;
    const canvas = runtime.extension.canvases[0];
    if (!canvas) throw new Error("Missing registered canvas");
    await canvas.onClose({
      instanceId: "closed-panel",
      extensionId: "fixture",
      canvasId: "radius"
    });
    expect(fixture.binding.hasActiveOperations()).toBe(true);
    await runtime.extension.shutdown("session cancelled");
    proceed.resolve();
    expect(await pending).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(fixture.host.cancel).not.toHaveBeenCalled();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
    await fixture.expectUnchanged();
  } finally {
    proceed.resolve();
    await pending;
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it("hands an approved fixture assignment through real validation and promotion, refusing an unisolatable Windows cache", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  const runtime = await startAuthoringRuntime(fixture);
  try {
    const response = createLifecycleValidators().validateResponse(
      await runtime.execute({
        operation: "definition.author",
        target: await fixture.selection(),
        input: {
          intent: "Update the model without deployment.",
          provider: "azure"
        }
      })
    );
    if (
      !response.valid ||
      !("operation" in response.value) ||
      response.value.operation !== "definition.author" ||
      response.value.result.state !== "action_required"
    )
      throw new Error(
        `Expected an owned authoring assignment: ${JSON.stringify(response)}`
      );
    const { operationId, requiredAction } = response.value.result;
    expect(fixture.host.dispatch).toHaveBeenCalledOnce();
    expect(fixture.binding.routing.address(operationId, true)).toBe(
      "lifecycle"
    );
    const intent = fixture.response(requiredAction.actionId);
    const completed = await runtime.execute(intent);
    expect(completed).toMatchObject({
      operation: "operation.respond",
      result: {
        operationId,
        state: process.platform === "win32" ? "failed" : "succeeded",
        result: {
          kind: "definition",
          proposal: {
            promotion: process.platform === "win32" ? "refused" : "promoted",
            validation: {
              status: process.platform === "win32" ? "incomplete" : "passed"
            }
          }
        }
      }
    });
    expect(fixture.runProcess).toHaveBeenCalledTimes(
      process.platform === "win32" ? 0 : 2
    );
    expect(fixture.host.verifyOutcome).toHaveBeenCalledTimes(2);
    expect(await runtime.execute(intent)).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(fixture.host.dispatch).toHaveBeenCalledOnce();
    expect(
      await readFile(join(fixture.workspace, authorDefinition), "utf8")
    ).toBe(fixture.inputs.get(authorDefinition));
    expect(await readdir(join(fixture.workspace, ".radius"))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.staging-/)])
    );
    expect(fixture.calls).toEqual([]);
    expect(fixture.forbidden).toEqual([]);
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it.each(["source changed", "approval revoked", "foreign agent"] as const)(
  "refuses a fixture outcome after %s without promoting or consuming a newer assignment",
  async (mode) => {
    const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
    const runtime = await startAuthoringRuntime(fixture);
    try {
      const response = createLifecycleValidators().validateResponse(
        await runtime.execute({
          operation: "definition.author",
          target: await fixture.selection(),
          input: { intent: "Update without deployment.", provider: "azure" }
        })
      );
      if (
        !response.valid ||
        !("operation" in response.value) ||
        response.value.operation !== "definition.author" ||
        response.value.result.state !== "action_required"
      )
        throw new Error(
          `Expected an owned authoring assignment: ${JSON.stringify(response)}`
        );
      const intent = fixture.response(
        response.value.result.requiredAction.actionId
      );
      if (mode === "source changed")
        await writeFile(
          join(fixture.workspace, "Dockerfile"),
          "FROM changed\n"
        );
      if (mode === "approval revoked") fixture.revokeApproval();
      if (mode === "foreign agent")
        fixture.setCaller({ ...fixture.caller, agentBindingRef: "foreign" });
      const result = await runtime.execute(intent);
      expect(result).toMatchObject({
        error: {
          code: mode === "source changed" ? "SOURCE_CHANGED" : "FORBIDDEN"
        }
      });
      expect(
        await readFile(join(fixture.workspace, authorDefinition), "utf8")
      ).toBe(fixture.inputs.get(authorDefinition));
      expect(fixture.host.dispatch).toHaveBeenCalledOnce();
      expect(fixture.forbidden).toEqual([]);
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);
