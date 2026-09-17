import { expect, it } from "vitest";
import { access } from "node:fs/promises";
import {
  createAuthoringBoundaryFixture,
  startAuthoringRuntime
} from "./lifecycle-authoring.js";

it("owns isolated fixture roots and fails on unmodeled host work", async () => {
  const first = await createAuthoringBoundaryFixture();
  const second = await createAuthoringBoundaryFixture();
  try {
    expect(first.root).not.toBe(second.root);
    expect(await first.selection()).toEqual(await second.selection());
    expect(() => first.response("foreign-action")).toThrow("No dispatched");
    expect(() => first.reject("unmodeled")).toThrow(
      "Unmodeled authoring boundary"
    );
    expect(first.forbidden).toEqual(["unmodeled"]);
    expect(second.forbidden).toEqual([]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
  await expect(access(first.root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(second.root)).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses the registered real runtime and closes its timers and source ownership", async () => {
  const fixture = await createAuthoringBoundaryFixture();
  const runtime = await startAuthoringRuntime(fixture);
  try {
    expect(
      await runtime.execute({
        operation: "capabilities.get",
        target: { repo: "owner/repo" },
        input: {}
      })
    ).toMatchObject({ operation: "capabilities.get" });
    runtime.extension.attachSession(runtime.session);
    await fixture.expectUnchanged();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.send).not.toHaveBeenCalled();
  } finally {
    await runtime.extension.shutdown("fixture cleanup");
    await fixture.close();
  }
});
