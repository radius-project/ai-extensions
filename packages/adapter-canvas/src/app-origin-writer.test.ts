import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateAppModelFreshness,
  parseAppOrigin,
  stagesBeforeDeploy
} from "@radius-project/core";
import { RADIUS_EXTENSION_REGISTRY } from "@radius-project/adapter-shared";
import { hashAppBicep } from "./app-bicep-hash.js";

// Each modeling skill writes `.radius/app.origin.json` with `writeOrigin` in its
// `scripts/common.mjs`, which re-implements the model hash because it ships
// inside the installed plugin, where the workspace packages are unavailable.
// These tests are the contract between that writer and the canvas reader: if
// they drift, the canvas reports every freshly generated model as hand-edited.

const SKILLS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../extensions/radius/skills"
);
const STAGE_SKILLS = [
  "radius-app-model",
  "radius-app-plan",
  "radius-app-complete"
] as const;

const MODEL =
  "resource app 'Radius.Core/applications@2025-08-01-preview' = {}\n";

type WriteOrigin = (
  file: string,
  options: { stage: string; provider?: string; start?: string }
) => string;

async function loadWriteOrigin(skill: string): Promise<WriteOrigin> {
  const loaded: unknown = await import(
    pathToFileURL(path.join(SKILLS, skill, "scripts", "common.mjs")).href
  );
  if (
    typeof loaded !== "object" ||
    loaded === null ||
    !("writeOrigin" in loaded) ||
    typeof loaded.writeOrigin !== "function"
  )
    throw new Error(`${skill} common.mjs does not export writeOrigin.`);
  // Checked above to be a function; its parameters are the skill's contract.
  return loaded.writeOrigin as WriteOrigin;
}

const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function checkout(model = MODEL, withCommit = true) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "app-origin-"))
  );
  temporaryDirectories.add(root);
  fs.mkdirSync(path.join(root, ".radius"));
  const appPath = path.join(root, ".radius", "app.bicep");
  fs.writeFileSync(appPath, model);
  // The pin a 0.60 Radius CLI writes. Built from the adapter's own registry
  // constant, so a writer whose copy of the registry drifted stops finding it.
  fs.writeFileSync(
    path.join(root, ".radius", "bicepconfig.json"),
    JSON.stringify({
      extensions: { radius: `${RADIUS_EXTENSION_REGISTRY}:0.60` }
    })
  );
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.email", "radius@example.invalid"]);
  git(root, ["config", "user.name", "Radius Test"]);
  let commit = "";
  if (withCommit) {
    git(root, ["add", "."]);
    git(root, ["commit", "--quiet", "-m", "model"]);
    commit = git(root, ["rev-parse", "HEAD"]);
  }
  const originPath = path.join(root, ".radius", "app.origin.json");
  return {
    root,
    appPath,
    commit,
    origin: () => fs.readFileSync(originPath, "utf8"),
    hasOrigin: () => fs.existsSync(originPath)
  };
}

describe("writeOrigin in the modeling skills", () => {
  it.each(STAGE_SKILLS)(
    "writes a record that the canvas reads back as up to date: %s",
    async (skill) => {
      const writeOrigin = await loadWriteOrigin(skill);
      const repo = checkout();

      writeOrigin(repo.appPath, { stage: "model" });

      const text = repo.origin();
      expect(Object.keys(JSON.parse(text) as object)).toEqual([
        "generatedAt",
        "sourceCommit",
        "radiusVersion",
        "appBicepHash",
        "stage"
      ]);
      expect(text.endsWith("}\n")).toBe(true);
      expect(parseAppOrigin(text)).toEqual({
        generatedAt: expect.any(String),
        sourceCommit: repo.commit,
        radiusVersion: "0.60",
        appBicepHash: hashAppBicep(MODEL),
        stage: "model"
      });
      expect(
        evaluateAppModelFreshness({
          model: MODEL,
          originText: text,
          headCommit: repo.commit,
          radiusVersion: "0.60",
          hashAppBicep
        }).status
      ).toBe("up-to-date");
    }
  );

  it("hashes a CRLF checkout the same as its LF original", async () => {
    const writeOrigin = await loadWriteOrigin("radius-app-model");
    const repo = checkout(MODEL.replace(/\n/gu, "\r\n"));

    writeOrigin(repo.appPath, { stage: "model" });

    expect(parseAppOrigin(repo.origin())?.appBicepHash).toBe(
      hashAppBicep(MODEL)
    );
  });

  it("carries the source commit and provider through the later stages until the model deploys", async () => {
    const repo = checkout();
    (await loadWriteOrigin("radius-app-model"))(repo.appPath, {
      stage: "model"
    });
    fs.writeFileSync(path.join(repo.root, "later.txt"), "later\n");
    git(repo.root, ["add", "."]);
    git(repo.root, ["commit", "--quiet", "-m", "later"]);
    const planned = `${MODEL}// planned\n`;
    fs.writeFileSync(repo.appPath, planned);

    (await loadWriteOrigin("radius-app-plan"))(repo.appPath, {
      stage: "plan",
      provider: "azure",
      start: MODEL
    });
    const afterPlan = parseAppOrigin(repo.origin());
    const completed = `${planned}// completed\n`;
    fs.writeFileSync(repo.appPath, completed);
    (await loadWriteOrigin("radius-app-complete"))(repo.appPath, {
      stage: "complete",
      start: planned
    });
    const afterComplete = parseAppOrigin(repo.origin());

    expect(afterPlan).toMatchObject({
      sourceCommit: repo.commit,
      stage: "plan",
      provider: "azure"
    });
    expect(
      stagesBeforeDeploy(afterPlan, hashAppBicep(planned), "azure")
    ).toEqual(["complete"]);
    expect(afterComplete).toMatchObject({
      sourceCommit: repo.commit,
      stage: "complete",
      provider: "azure"
    });
    expect(
      stagesBeforeDeploy(afterComplete, hashAppBicep(completed), "azure")
    ).toEqual([]);
  });

  it("writes no record outside a git checkout with a commit", async () => {
    const writeOrigin = await loadWriteOrigin("radius-app-model");
    const repo = checkout(MODEL, false);

    expect(writeOrigin(repo.appPath, { stage: "model" })).toContain(
      "was not written"
    );
    expect(repo.hasOrigin()).toBe(false);
  });
});
