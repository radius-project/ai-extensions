// Opt-in live contract test. Fetches the CURRENT deploy/verify workflow
// templates from radius-project/ai-extensions `.github/extension/` and asserts that the
// jobs which mint the Azure OIDC token are still bound to a GitHub Environment.
//
// Why this matters: the extension computes each federated-identity subject as
// `repo:{owner}/{repo}:environment:{env}` (buildEnvironmentSuffix), but the
// workflows that actually exchange that token live UPSTREAM and are fetched at
// commit time — the extension bundles no copy. GitHub only adds the
// `environment` claim to the Actions OIDC token when the job calling
// `azure/login` declares a job-level `environment:`. If upstream ever drops that
// binding (or the dispatcher stops forwarding `environment:` to the provider
// workflow), the token's `sub` silently loses `environment:{env}`, no federated
// credential matches, and every deploy fails with AADSTS700213 — with nothing in
// this repo to catch it. A hermetic test cannot guard this: the extension holds
// no template copy, so it would only assert against a fixture we wrote here.
//
// This hits the network and depends on an external repo's moving ref, so it is
// NOT part of the default hermetic suite. A separate non-required CI workflow
// sets RUN_LIVE_WORKFLOW_TESTS on pull requests, pushes to main, and nightly.
// Runtime day-to-day protection is the verify-credentials flow, which fails
// loudly if the FIC does not match; this test catches the drift earlier.
import { describe, it, expect } from "vitest";
import {
  RADIUS_WORKFLOW_REPO,
  RADIUS_WORKFLOW_DIR,
  RADIUS_REF,
  DEPLOY_AZURE_FILE,
  DEPLOY_DISPATCHER_FILE
} from "./deploy.js";
import { VERIFY_AZURE_FILE } from "./verify.js";

const LIVE = !!process.env.RUN_LIVE_WORKFLOW_TESTS;

async function fetchWorkflow(file: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${RADIUS_WORKFLOW_REPO}/${RADIUS_REF}/${RADIUS_WORKFLOW_DIR}/${file}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

// Return the body of the top-level job (a 2-space-indented `name:` header under
// `jobs:`) that contains `marker`, so an assertion can be bound to THAT job
// rather than matching anywhere in the file. Returns "" when no job contains the
// marker.
function jobBlockContaining(src: string, marker: string): string {
  const lines = src.split("\n");
  const at = lines.findIndex((l) => l.includes(marker));
  if (at === -1) return "";
  const isJobHeader = (l: string) => /^ {2}\S.*:\s*$/.test(l); // e.g. "  deploy:"
  let start = at;
  while (start >= 0 && !isJobHeader(lines[start])) start--;
  let end = at + 1;
  while (end < lines.length && !isJobHeader(lines[end])) end++;
  return lines.slice(Math.max(start, 0), end).join("\n");
}

const jobLevelEnvironment = /^ {4}environment:/m; // job key
const forwardedEnvironment = /^ {6}environment:/m; // under the caller job's `with:`

describe.skipIf(!LIVE)(
  "live workflow OIDC-environment contract (opt-in: set RUN_LIVE_WORKFLOW_TESTS)",
  () => {
    // The job that runs azure/login must bind a GitHub Environment, or the OIDC
    // token drops the `environment` claim and the environment-scoped FIC fails.
    it.each([DEPLOY_AZURE_FILE, VERIFY_AZURE_FILE])(
      "%s binds its azure/login job to a GitHub Environment",
      async (file) => {
        const body = await fetchWorkflow(file);
        const job = jobBlockContaining(body, "azure/login");
        expect(job, `${file}: no job runs azure/login`).not.toBe("");
        expect(
          jobLevelEnvironment.test(job),
          `${file}: the azure/login job has no job-level environment: binding`
        ).toBe(true);
      },
      30_000
    );

    // The dispatcher's azure job calls the reusable provider workflow. A `uses:`
    // job cannot bind an environment itself, so it must forward `environment:` in
    // its `with:` — otherwise inputs.environment is empty downstream and the
    // provider's `environment: ${{ inputs.environment }}` binds to nothing.
    it(`${DEPLOY_DISPATCHER_FILE} forwards environment: to the azure provider job`, async () => {
      const body = await fetchWorkflow(DEPLOY_DISPATCHER_FILE);
      const job = jobBlockContaining(body, `workflows/${DEPLOY_AZURE_FILE}`);
      expect(
        job,
        `${DEPLOY_DISPATCHER_FILE}: no job calls ${DEPLOY_AZURE_FILE}`
      ).not.toBe("");
      expect(
        forwardedEnvironment.test(job),
        `${DEPLOY_DISPATCHER_FILE}: azure job does not forward environment: to the provider workflow`
      ).toBe(true);
    }, 30_000);

    // The deploy preflight reads AZURE_CLIENT_ID and AZURE_TENANT_ID as GitHub
    // Actions variables and treats an empty client id as "Azure login is
    // deliberately off". All three facts live upstream, so a rename or a change
    // to the gate would silently turn the preflight into a check of the wrong
    // thing — reading a variable the workflow no longer uses, or warning about
    // a non-OIDC cluster on every deploy.
    it(`${DEPLOY_AZURE_FILE} still gates azure/login on a non-empty vars.AZURE_CLIENT_ID`, async () => {
      const body = await fetchWorkflow(DEPLOY_AZURE_FILE);
      const job = jobBlockContaining(body, "azure/login");
      expect(job, `${DEPLOY_AZURE_FILE}: no job runs azure/login`).not.toBe("");
      expect(
        /if:\s*\$\{\{\s*vars\.AZURE_CLIENT_ID\s*!=\s*''\s*\}\}/.test(job),
        `${DEPLOY_AZURE_FILE}: azure/login is no longer gated on vars.AZURE_CLIENT_ID != ''`
      ).toBe(true);
      expect(
        job.includes("${{ vars.AZURE_CLIENT_ID }}"),
        `${DEPLOY_AZURE_FILE}: azure/login no longer reads vars.AZURE_CLIENT_ID`
      ).toBe(true);
      expect(
        job.includes("${{ vars.AZURE_TENANT_ID }}"),
        `${DEPLOY_AZURE_FILE}: azure/login no longer reads vars.AZURE_TENANT_ID`
      ).toBe(true);
    }, 30_000);
  }
);
