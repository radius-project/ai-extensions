import fs from "node:fs/promises";
import path from "node:path";
import { parseRepoFromRemote } from "../../../src/workspace.js";
import { MODEL_FILES, type ModelFileTimes } from "./copilot-app-modeling.js";

type GitReader = (args: readonly string[]) => Promise<string>;

function requireChild(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      `The app workspace must be inside its disposable profile: ${child}`
    );
}

async function lstatOrMissing(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

export async function prepareModelWorkspace(
  input: {
    readonly workspacePath: string;
    readonly profileDir: string;
    readonly repository: string;
    readonly baselineSha: string;
  },
  git: GitReader
): Promise<number> {
  const workspace = await fs.realpath(input.workspacePath);
  requireChild(await fs.realpath(input.profileDir), workspace);
  const topLevel = await fs.realpath(
    (await git(["rev-parse", "--show-toplevel"])).trim()
  );
  if (topLevel !== workspace)
    throw new Error("The session path is not the repository root.");
  if (
    parseRepoFromRemote((await git(["remote", "get-url", "origin"])).trim()) !==
    input.repository
  )
    throw new Error("The session origin is not the fixture repository.");
  if ((await git(["rev-parse", "HEAD"])).trim() !== input.baselineSha)
    throw new Error("The session is not at the fixture baseline.");
  if ((await git(["status", "--porcelain"])).trim())
    throw new Error("The session workspace is not clean before modeling.");
  const modelDir = path.join(workspace, ".radius");
  const entry = await lstatOrMissing(modelDir);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
    throw new Error(
      "Refusing to remove a .radius path that is not a normal directory."
    );
  await fs.rm(modelDir, { recursive: true, force: true });
  if (await lstatOrMissing(modelDir))
    throw new Error("The baseline model directory was not removed.");
  return Date.now();
}

export async function readModelSnapshot(
  workspacePath: string,
  readText: (file: string) => Promise<string> = (file) =>
    fs.readFile(file, "utf8")
): Promise<{
  times: ModelFileTimes;
  model: string | undefined;
  originText: string | undefined;
}> {
  const directory = path.join(workspacePath, ".radius");
  const directoryEntry = await lstatOrMissing(directory);
  if (
    directoryEntry &&
    (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink())
  )
    throw new Error(
      "The generated model directory must be a normal directory."
    );
  const times: Record<string, number | undefined> = {};
  const text: Record<string, string | undefined> = {};
  for (const file of MODEL_FILES) {
    const fullPath = path.join(workspacePath, file);
    const entry = await lstatOrMissing(fullPath);
    if (entry && (!entry.isFile() || entry.isSymbolicLink()))
      throw new Error(
        `The generated model file must be a regular file: ${file}`
      );
    times[file] = entry?.mtimeMs;
    try {
      text[file] = entry ? await readText(fullPath) : undefined;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        times[file] = undefined;
        text[file] = undefined;
      } else throw error;
    }
  }
  return {
    times: {
      ".radius/app.bicep": times[".radius/app.bicep"],
      ".radius/bicepconfig.json": times[".radius/bicepconfig.json"],
      ".radius/app.origin.json": times[".radius/app.origin.json"]
    },
    model: text[".radius/app.bicep"],
    originText: text[".radius/app.origin.json"]
  };
}
