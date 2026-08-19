// Opt-in live regression test. Fetches the CURRENT deploy workflow templates
// from radius-project/radius `.github/extension/` and asserts that, once the
// extension fills them, every generated file parses as valid YAML.
//
// Why this matters: the extension renders templates fetched from
// radius-project/radius at RUNTIME (RADIUS_REF, currently `main`) — it bundles
// no copy. `generateDeployWorkflow` injects GitHub Actions expressions whose
// string defaults are single-quoted (`${{ vars.RADIUS_BUILD_ARCH_MODE ||
// 'detect' }}`). If an upstream template wraps such a placeholder in a
// single-quoted YAML scalar, the injected quotes nest and the rendered file
// becomes invalid YAML — every deploy dispatch then fails upstream with
// `HTTP 422: failed to parse workflow`. That is exactly issue #407
// (radius-project/ai-extensions#407), caused by radius-project/radius#12640 and
// fixed by radius-project/radius#12721. The hermetic tests in deploy.test.ts use
// inline fixtures, so only a LIVE render of the real templates catches an
// upstream quoting regression.
//
// This hits the network and depends on an external repo's moving ref, so it is
// NOT part of the default hermetic suite: it runs only when
// RUN_LIVE_WORKFLOW_TESTS is set (e.g. locally or in a scheduled job), never in
// normal CI.
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  RADIUS_REF,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DEPLOY_AWS_FILE,
  generateDeployWorkflow
} from "./deploy.js";

const LIVE = !!process.env.RUN_LIVE_WORKFLOW_TESTS;

async function fetchWorkflow(file: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${RADIUS_WORKFLOW_REPO}/${RADIUS_REF}/${RADIUS_WORKFLOW_DIR}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

describe.skipIf(!LIVE)(
  "live deploy-workflow YAML validity (opt-in: set RUN_LIVE_WORKFLOW_TESTS)",
  () => {
    // Render the three real upstream templates through the extension and assert
    // every generated file parses as valid YAML. This is the only test that
    // would have caught the radius#12640 quoting regression, because the
    // extension renders templates fetched from `main` at runtime.
    it(
      "renders valid YAML from the current upstream deploy templates",
      async () => {
        const files = [
          DEPLOY_DISPATCHER_FILE,
          DEPLOY_AZURE_FILE,
          DEPLOY_AWS_FILE
        ];
        const bodies = await Promise.all(files.map((f) => fetchWorkflow(f)));
        const templates: Record<string, string> = {};
        files.forEach((f, i) => {
          templates[f] = bodies[i];
        });

        const generated = generateDeployWorkflow(
          "prod",
          ".radius/app.bicep",
          templates
        );

        for (const [name, body] of Object.entries(generated)) {
          expect(
            () => parseYaml(body),
            `${name} rendered from upstream ${RADIUS_REF} should parse as valid YAML`
          ).not.toThrow();
        }
      },
      30_000
    );
  }
);
