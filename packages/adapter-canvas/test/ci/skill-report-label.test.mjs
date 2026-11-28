import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = new URL("../../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, REPO_ROOT), "utf8");

const workflow = parse(read(".github/workflows/skill-report-label.yml"));
const job = workflow.jobs.label;
const [findMarker, addLabel] = job.steps;
const MARKER =
  "Reported with: radius-report-issue skill, Radius plugin <version>";
const marker = (version) => MARKER.replace("<version>", version);
const bash =
  process.platform === "win32" ?
    join(process.env.ProgramFiles, "Git", "bin", "bash.exe")
  : "bash";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "skill-report-label-"));
  roots.push(root);
  return root;
}

// Runs a step's script the way GitHub runs `shell: bash`.
function runStep(script, root, env) {
  return spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-s"], {
    input: script,
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5_000
  });
}

function findsMarker(body, root = tempRoot()) {
  const output = join(root, "output.txt");
  writeFileSync(output, "");
  const result = runStep(findMarker.run, root, {
    GITHUB_OUTPUT: output,
    ISSUE_BODY: body
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(output, "utf8");
}

function addsLabel(ghStatus) {
  const root = tempRoot();
  const calls = join(root, "gh-calls.txt");
  const fakeGh = `gh() { printf '%s\\n' "$@" >>"$GH_CALLS"; return ${ghStatus}; }\n`;
  const result = runStep(fakeGh + addLabel.run, root, {
    GH_CALLS: calls,
    GITHUB_REPOSITORY: "radius-project/ai-extensions",
    ISSUE_NUMBER: "1268"
  });
  expect(result.error).toBeUndefined();
  return {
    status: result.status,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n") : []
  };
}

function section(markdown, heading) {
  return markdown.split(/^### /mu).find((part) => part.startsWith(heading));
}

const skillReport = [
  "### Summary",
  "Deploying the application fails during recipe resolution.",
  "### Version and environment",
  "Radius plugin: 0.6.1",
  "OS: Linux x64",
  marker("0.6.1")
].join("\n");
const webFormReport = [
  "### Summary",
  "",
  "Deploying the application fails during recipe resolution.",
  "",
  "### Version and environment",
  "",
  "Version: 0.6.1",
  "OS: macOS 15"
].join("\r\n");

describe("skill report label workflow", () => {
  it("labels only new issues with an issue-scoped token and keeps the body out of script text", () => {
    expect(workflow.on).toEqual({ issues: { types: ["opened"] } });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(["label"]);
    expect(job.permissions).toEqual({ issues: "write" });
    expect(job["timeout-minutes"]).toBe(5);
    expect(job.steps).toHaveLength(2);
    expect(findMarker).toMatchObject({
      id: "marker",
      shell: "bash",
      env: { ISSUE_BODY: "${{ github.event.issue.body }}" }
    });
    expect(findMarker).not.toHaveProperty("if");
    expect(addLabel).toMatchObject({
      if: "steps.marker.outputs.found == 'true'",
      shell: "bash",
      env: {
        GH_TOKEN: "${{ github.token }}",
        ISSUE_NUMBER: "${{ github.event.issue.number }}"
      }
    });
    for (const step of job.steps) expect(step.run).not.toContain("${{");
  });

  it.each([
    ["a skill report", skillReport],
    [
      "a skill report with CRLF line endings",
      skillReport.replace(/\n/gu, "\r\n")
    ],
    ["an unknown plugin version", marker("unknown")],
    ["a prerelease plugin version", marker("0.7.0-rc.1")],
    ["trailing whitespace", `${marker("0.6.1")}  `]
  ])("finds the marker in %s", (_name, body) => {
    expect(findsMarker(body)).toBe("found=true\n");
  });

  it.each([
    ["a web form report", webFormReport],
    ["an empty body", ""],
    ["a quoted marker", `> ${marker("0.6.1")}`],
    [
      "an inline mention",
      `I copied \`${marker("0.6.1")}\` from another issue.`
    ],
    ["an HTML comment", `<!-- ${marker("0.6.1")} -->`],
    ["a missing version", marker("").trimEnd()],
    ["text after the version", `${marker("0.6.1")} and a manual edit`]
  ])("does not find the marker in %s", (_name, body) => {
    expect(findsMarker(body)).toBe("found=false\n");
  });

  it("matches the untrusted body as data without running it", () => {
    const root = tempRoot();
    const body = [
      "$(touch substituted)",
      "`touch backticked`",
      '"; touch quoted; echo "',
      marker("0.6.1")
    ].join("\n");

    expect(findsMarker(body, root)).toBe("found=true\n");
    expect(existsSync(join(root, "substituted"))).toBe(false);
    expect(existsSync(join(root, "backticked"))).toBe(false);
    expect(existsSync(join(root, "quoted"))).toBe(false);
  });

  it("adds the reported-by-skill label to the opened issue", () => {
    expect(addsLabel(0)).toEqual({
      status: 0,
      calls: [
        "api",
        "--method",
        "POST",
        "repos/radius-project/ai-extensions/issues/1268/labels",
        "-f",
        "labels[]=reported-by-skill",
        ""
      ]
    });
  });

  it("fails the run when GitHub rejects the label", () => {
    expect(addsLabel(1).status).not.toBe(0);
  });
});

describe("radius-report-issue marker line", () => {
  const skill = read("extensions/radius/skills/radius-report-issue/SKILL.md");
  const fallback = read(
    "extensions/radius/skills/radius-report-issue/references/bug-report.md"
  );

  it.each([
    ["SKILL.md", skill],
    ["the packaged bug report template", fallback]
  ])(
    "is described in %s with a format the workflow recognizes",
    (_name, guidance) => {
      const templates = [
        ...guidance.matchAll(/^```text\n(Reported with: .*)\n```$/gmu)
      ].map((match) => match[1]);
      expect(templates).toEqual([MARKER]);
      for (const version of ["0.6.1", "unknown"]) {
        expect(findsMarker(templates[0].replace("<version>", version))).toBe(
          "found=true\n"
        );
      }
    }
  );

  it("ends the Version and environment section of the packaged template", () => {
    expect(section(fallback, "Version and environment").trimEnd()).toMatch(
      /```text\nReported with: .*\n```$/u
    );
  });

  it("is not part of the bug report web form", () => {
    expect(read(".github/ISSUE_TEMPLATE/bug-report.yml")).not.toContain(
      "Reported with:"
    );
  });
});
