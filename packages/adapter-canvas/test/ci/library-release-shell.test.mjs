import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../.github/workflows/release-libraries.yml",
        import.meta.url
      )
    ),
    "utf8"
  )
);
const steps = workflow.jobs.publish.steps;
const temporary = [];
const bash =
  process.platform === "win32" ?
    join(process.env.ProgramFiles, "Git", "bin", "bash.exe")
  : "bash";
const fakeCommands = `
export RUNNER_TEMP="$PWD/tmp"
export SOURCE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export GITHUB_REPOSITORY=fixture/repo
mkdir -p "$RUNNER_TEMP"
jq() { printf 'Release notes\\n'; }
gh() {
  printf '%s\\n' "$*" >> calls
  case "$1 $2" in
    "api repos/fixture/repo/commits/"*)
      if [[ -f unverified ]]; then echo false; else echo true; fi ;;
    "api repos/fixture/repo/git/ref/tags/"*)
      [[ -f tag ]] || return 1
      if [[ -f wrong-tag ]]; then echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; else echo "$SOURCE_SHA"; fi ;;
    "api repos/fixture/repo/git/refs")
      touch tag ;;
    "release view")
      [[ -f release ]] || return 1
      if [[ "$*" == *"--json isDraft"* ]]; then
        if [[ -f draft-query-fails ]]; then
          echo "Release state request failed" >&2
          return 1
        fi
        if [[ -f published ]]; then echo false; else echo true; fi
      elif [[ "$*" == *"--json assets"* ]]; then
        echo graph-libraries.tar.gz
        echo radius-project-core.spdx.json
        [[ -f missing-sbom ]] || echo radius-project-graph-react.spdx.json
      fi ;;
    "release create")
      [[ -f tag ]] || return 1
      touch release ;;
    "release upload")
      [[ ! -f upload-fails ]] || return 1
      [[ -f "$RUNNER_TEMP/graph-libraries.tar.gz" ]]
      [[ -f .artifacts/npm-release/libraries/radius-project-core.spdx.json ]]
      [[ -f .artifacts/npm-release/libraries/radius-project-graph-react.spdx.json ]]
      touch uploaded ;;
    "release edit")
      [[ -f uploaded ]] || return 1
      touch published ;;
    *) echo "Unexpected gh command: $*" >&2; return 1 ;;
  esac
  return 0
}
`;

function run(stepName, state = []) {
  const root = mkdtempSync(join(tmpdir(), "radius-npm-shell-"));
  temporary.push(root);
  const candidate = join(root, ".artifacts", "npm-release", "libraries");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(join(candidate, "radius-project-core.spdx.json"), "{}");
  writeFileSync(join(candidate, "radius-project-graph-react.spdx.json"), "{}");
  writeFileSync(join(candidate, "release-plan.json"), "[]");
  for (const file of state) writeFileSync(join(root, file), "");
  const result = spawnSync(bash, ["--noprofile", "--norc", "-s"], {
    cwd: root,
    env: Object.fromEntries(
      ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]])
    ),
    input: `${fakeCommands}\n${steps.find((step) => step.name === stepName).run}`,
    encoding: "utf8",
    timeout: 5000
  });
  if (result.error) throw result.error;
  return {
    ...result,
    root,
    calls: readFileSync(join(root, "calls"), "utf8")
  };
}

afterEach(() => {
  for (const root of temporary.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("npm release shell boundaries", () => {
  const release =
    "Attach packages, SPDX inventory and qualification to a source release";

  it.each([
    ["verified", [], 0],
    ["unverified", ["unverified"], 1]
  ])("requires a verified source: %s", (_name, files, status) => {
    const result = run("Require a verified release source", files);
    expect(result.status).toBe(status);
    expect(result.calls).toContain(
      "commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("creates the source tag before the draft, uploads assets, then publishes", () => {
    const result = run(release);
    expect(result.status, result.stderr).toBe(0);
    expect(
      result.calls.indexOf("api repos/fixture/repo/git/refs")
    ).toBeLessThan(result.calls.indexOf("release create"));
    expect(result.calls.indexOf("release upload")).toBeLessThan(
      result.calls.indexOf("release edit")
    );
    expect(existsSync(join(result.root, "published"))).toBe(true);
  });

  it("resumes a draft release without recreating the tag or release", () => {
    const result = run(release, ["tag", "release"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain("release create");
    expect(result.calls).not.toContain("api repos/fixture/repo/git/refs ");
    expect(existsSync(join(result.root, "published"))).toBe(true);
  });

  it("stops recovery when the draft-state request fails despite uploaded assets", () => {
    const result = run(release, [
      "tag",
      "release",
      "uploaded",
      "draft-query-fails"
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Release state request failed");
    expect(result.calls).not.toContain("release upload");
    expect(result.calls).not.toContain("release edit");
    expect(result.calls).not.toContain("--json assets");
    expect(existsSync(join(result.root, "published"))).toBe(false);
  });

  it("checks a completed release without replacing its assets", () => {
    const result = run(release, ["tag", "release", "published"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).not.toContain("release upload");
    expect(result.calls).not.toContain("release edit");
    expect(result.calls).toContain("--json assets");
  });

  it("refuses a tag that points at another source commit", () => {
    const result = run(release, ["tag", "wrong-tag"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("does not match the qualified source");
    expect(result.calls).not.toContain("release create");
    expect(result.calls).not.toContain("release upload");
  });

  it("keeps the release as a draft when uploading assets fails", () => {
    const result = run(release, ["upload-fails"]);
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("release edit");
    expect(existsSync(join(result.root, "published"))).toBe(false);
  });

  it("rejects a completed release with no SPDX asset", () => {
    const result = run(release, [
      "tag",
      "release",
      "published",
      "missing-sbom"
    ]);
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("release edit");
  });
});
