// Opt-in live regression test. Fetches the CURRENT workflow templates from
// radius-project/ai-extensions `.github/extension/` and asserts that, once the
// extension fills them, every generated file parses as valid YAML.
//
// Why this matters: the extension renders templates fetched from
// radius-project/ai-extensions at RUNTIME (RADIUS_REF, currently `main`) — it
// bundles no copy. `generateDeployWorkflow` injects GitHub Actions expressions
// whose string defaults are single-quoted (`${{ vars.RADIUS_BUILD_ARCH_MODE ||
// 'detect' }}`). If an upstream template wraps such a placeholder in a
// single-quoted YAML scalar, the injected quotes nest and the rendered file
// becomes invalid YAML — every deploy dispatch then fails upstream with
// `HTTP 422: failed to parse workflow`. That is exactly issue #407
// (radius-project/ai-extensions#407), caused by radius-project/radius#12640 and
// fixed by radius-project/radius#12721. The hermetic tests in deploy.test.ts use
// inline fixtures, so only a LIVE render of the real templates catches an
// upstream quoting (or any other YAML) regression.
//
// Coverage is not limited to the deploy workflows: every generator the
// extension ships (deploy, delete, verify) is rendered from its real upstream
// templates and asserted to produce valid YAML, so a malformed scalar,
// indentation, or quoting change in ANY of those upstream templates is caught.
//
// This hits the network and depends on a repo's moving ref, so it is NOT part
// of the default hermetic suite. A separate non-required CI workflow sets
// RUN_LIVE_WORKFLOW_TESTS on pull requests, pushes to main, and nightly. It also
// sets RADIUS_LIVE_REF to the ref under test (the PR head on pull requests) so a
// PR validates ITS OWN templates; runs without the override fall back to
// RADIUS_REF (`main`).
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { azure } from "../platforms/azure.js";
import { aws } from "../platforms/aws.js";
import {
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  RADIUS_REF,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeployWorkflow
} from "./deploy.js";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_ENV_AZURE_FILE,
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_AZURE_FILE,
  DELETE_AWS_FILE,
  generateDeleteWorkflow
} from "./delete.js";
import {
  VERIFY_AZURE_FILE,
  VERIFY_AWS_FILE,
  generateVerifyWorkflow
} from "./verify.js";

const LIVE = !!process.env.RUN_LIVE_WORKFLOW_TESTS;

// The ref whose templates are validated. CI sets this to the PR head on pull
// requests so a PR checks its own `.github/extension/` templates; otherwise it
// falls back to RADIUS_REF (`main`).
const LIVE_REF = process.env.RADIUS_LIVE_REF?.trim() || RADIUS_REF;

// radius-project/ai-extensions is an internal repo, so the templates are not
// reachable over anonymous raw.githubusercontent.com. Fetch them through the
// authenticated GitHub contents API (raw media type) using the CI token.
async function fetchWorkflow(file: string, ref: string): Promise<string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const url = `https://api.github.com/repos/${RADIUS_WORKFLOW_REPO}/contents/${RADIUS_WORKFLOW_DIR}/${file}?ref=${encodeURIComponent(ref)}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw",
    "User-Agent": "radius-ai-extensions-live-tests"
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function fetchTemplates(
  files: string[],
  ref: string
): Promise<Record<string, string>> {
  const bodies = await Promise.all(files.map((f) => fetchWorkflow(f, ref)));
  const templates: Record<string, string> = {};
  files.forEach((f, i) => {
    templates[f] = bodies[i];
  });
  return templates;
}

async function readLocalDeleteTemplates(): Promise<Record<string, string>> {
  const files = [DELETE_ENV_DISPATCHER_FILE, DELETE_ENV_AZURE_FILE];
  const bodies = await Promise.all(
    files.map((file) =>
      readFile(
        new URL(`../../../../.github/extension/${file}`, import.meta.url),
        "utf8"
      )
    )
  );
  return Object.fromEntries(files.map((file, index) => [file, bodies[index]]));
}

function assertAllValidYaml(
  generated: Record<string, string>,
  ref: string
): void {
  for (const [name, body] of Object.entries(generated)) {
    expect(
      () => parseYaml(body),
      `${name} rendered from upstream ${ref} should parse as valid YAML`
    ).not.toThrow();
  }
}

describe.skipIf(!LIVE)(
  "live workflow YAML validity (opt-in: set RUN_LIVE_WORKFLOW_TESTS)",
  () => {
    // The deploy workflows are the ones that inject single-quoted GHA arch
    // expressions, so this is the case that would have caught radius#12640.
    it("renders valid YAML from the current upstream deploy templates", async () => {
      const templates = await fetchTemplates(
        [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE, DEPLOY_AWS_FILE],
        LIVE_REF
      );
      const generated = generateDeployWorkflow(
        "prod",
        ".radius/app.bicep",
        templates
      );
      assertAllValidYaml(generated, LIVE_REF);
    }, 30_000);

    it("renders valid YAML from the current upstream delete templates", async () => {
      const templates = await fetchTemplates(
        [DELETE_APP_DISPATCHER_FILE, DELETE_AZURE_FILE, DELETE_AWS_FILE],
        LIVE_REF
      );
      const generated = generateDeleteWorkflow("prod", {
        ...templates,
        ...(await readLocalDeleteTemplates())
      });
      assertAllValidYaml(generated, LIVE_REF);
    }, 30_000);

    it("renders valid YAML from the current upstream verify templates", async () => {
      for (const [platform, file] of [
        [azure, VERIFY_AZURE_FILE],
        [aws, VERIFY_AWS_FILE]
      ] as const) {
        const template = await fetchWorkflow(file, LIVE_REF);
        const rendered = generateVerifyWorkflow("prod", platform, template);
        assertAllValidYaml({ [file]: rendered }, LIVE_REF);
      }
    }, 30_000);
  }
);
