import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ownsWorkspaceGraphOutput,
  stageWorkspaceGraphOutput
} from "./workspace-graph-output.js";

it("rechecks request ownership after awaiting workspace branch verification", async () => {
  let current = true;
  expect(
    await ownsWorkspaceGraphOutput(
      () => current,
      async () => {
        current = false;
        return true;
      }
    )
  ).toBe(false);
});

it("refuses publication when workspace branch verification is unavailable", async () => {
  expect(
    await ownsWorkspaceGraphOutput(
      () => true,
      async () => {
        throw new Error("Checkout metadata unavailable");
      }
    )
  ).toBe(false);
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "radius-workspace-output-test-"));
  cleanup.push(() => rmSync(root, { force: true, recursive: true }));
  const destination = join(root, "app-graph.json");
  const log = vi.fn();
  function stage() {
    const output = stageWorkspaceGraphOutput(destination, log);
    if (!output?.compilerPath) throw new Error("Missing staged compiler path");
    cleanup.push(output.dispose);
    return { ...output, compilerPath: output.compilerPath };
  }
  return { root, destination, log, stage };
}

describe("workspace graph output", () => {
  it("writes the exact staged document and does not let disposal touch the published file", () => {
    const { destination, stage } = fixture();
    const old = stage();
    const current = stage();
    expect(old.compilerPath).not.toBe(current.compilerPath);
    expect(current.compilerPath).not.toBe(destination);
    writeFileSync(destination, "previous");
    writeFileSync(old.compilerPath, "old");
    const projected = '{"application":{"name":"model"},"resources":[]}';
    writeFileSync(current.compilerPath, projected);
    current.publish();
    old.dispose();
    current.dispose();
    expect(existsSync(old.compilerPath)).toBe(false);
    expect(existsSync(current.compilerPath)).toBe(false);
    expect(readFileSync(destination, "utf8")).toBe(projected);
  });

  it("discards a previous artifact for a current build with missing compiler output", () => {
    const { destination, log, stage } = fixture();
    writeFileSync(destination, "previous");
    stage().publish();
    expect(existsSync(destination)).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("read staged graph output")
    );
  });

  it("reports failed publication and removes its exclusive sibling", () => {
    const { destination, root, log, stage } = fixture();
    mkdirSync(destination);
    const output = stage();
    writeFileSync(output.compilerPath, "graph");
    output.publish();
    expect(readdirSync(root)).toEqual(["app-graph.json"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("publish graph output")
    );
  });

  it("does not stage output without a destination", () => {
    expect(stageWorkspaceGraphOutput("", vi.fn())).toBeUndefined();
  });
});
